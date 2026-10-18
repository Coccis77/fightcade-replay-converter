import { spawn } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import type { FrameFormat } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';

export type ScaleMode = 'sharp' | 'smooth';

// Converting to planar YUV at native size first makes the upscale ~4x faster than scaling
// packed RGB (the scaler, not x264, was the bottleneck); the output is YUV anyway.
export const VIDEO_FILTERS: Record<ScaleMode, string> = {
  sharp: 'format=yuv444p,scale=iw*4:ih*4:flags=neighbor,scale=1440:1080:flags=lanczos,setsar=1',
  smooth: 'format=yuv444p,scale=1440:1080:flags=lanczos,setsar=1',
};

// x264 runs on the CPU everywhere; the others are hardware encoders (NVIDIA, Intel QuickSync, AMD,
// Windows Media Foundation, macOS), each set for about the same quality as x264's crf 20.
export const ENCODERS = ['x264', 'nvenc', 'qsv', 'amf', 'mf', 'videotoolbox'] as const;
export type EncoderName = (typeof ENCODERS)[number];

export function encoderArgs(encoder: EncoderName, env: Record<string, string | undefined> = process.env): string[] {
  switch (encoder) {
    case 'x264':
      // veryfast/crf 20: no visible loss vs medium/crf 18.
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
    case 'nvenc':
      {
        // TEMPORARY (testing file sizes on Windows): FC2MP4_NVENC_CQ overrides the quality value.
        const cq = /^\d{1,2}$/.test(env.FC2MP4_NVENC_CQ ?? '') ? env.FC2MP4_NVENC_CQ! : '20';
        return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', cq, '-b:v', '0', '-pix_fmt', 'yuv420p'];
      }
    case 'qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'faster', '-global_quality', '20', '-pix_fmt', 'nv12'];
    case 'amf':
      return ['-c:v', 'h264_amf', '-quality', 'speed', '-rc', 'cqp', '-qp_i', '20', '-qp_p', '20', '-pix_fmt', 'nv12'];
    case 'mf':
      return ['-c:v', 'h264_mf', '-hw_encoding', '1', '-rate_control', 'quality', '-quality', '80', '-pix_fmt', 'nv12'];
    case 'videotoolbox':
      return ['-c:v', 'h264_videotoolbox', '-q:v', '65', '-pix_fmt', 'nv12'];
  }
}

// ffmpeg ends a failure with "Conversion failed!": the useful reason is the first error line before it.
export function ffmpegFailureReason(stderrLines: readonly string[]): string {
  const lines = stderrLines.map((l) => l.trim()).filter((l) => l && l !== 'Conversion failed!');
  return lines.find((l) => /error|unknown encoder|not found|no device|cannot|could not/i.test(l)) ?? lines.at(-1) ?? '';
}

export function videoEncodeArgs({ input, output, scale, format, encoder = 'x264' }: { input: string; output: string; scale: ScaleMode; format: FrameFormat; encoder?: EncoderName }): string[] {
  return [
    '-hide_banner', '-nostats', '-progress', 'pipe:1', '-y',
    // Read up to 256 frames ahead: the emulator keeps running while a frame is encoded (measured
    // about 10% faster overall than ffmpeg's default queue).
    '-thread_queue_size', '256',
    '-f', 'rawvideo', '-pix_fmt', 'bgr0', '-s', `${format.width}x${format.height}`, '-r', String(format.fpsX100 / 100), '-i', input,
    '-vf', VIDEO_FILTERS[scale],
    ...encoderArgs(encoder),
    '-an',
    output,
  ];
}

// The emulator writes a whole number of samples per frame (rounded as in fc2mp4_headless.cpp), so the
// audio really runs at samples-per-frame x fps. Read at the nominal rate it drifts from the video.
export function audioInputRate(format: FrameFormat): number {
  const samplesPerFrame = Math.floor((format.sampleRate * 100 + (format.fpsX100 >> 1)) / format.fpsX100);
  return Math.round((samplesPerFrame * format.fpsX100) / 100);
}

export function muxArgs({ video, audio, output, format }: { video: string; audio: string; output: string; format: FrameFormat }): string[] {
  return [
    '-hide_banner', '-nostats', '-y',
    '-i', video,
    '-f', 's16le', '-ar', String(audioInputRate(format)), '-ac', '2', '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', String(format.sampleRate),
    '-movflags', '+faststart', output,
  ];
}

export function parseProgressFrames(chunk: string): number | null {
  const matches = [...chunk.matchAll(/^frame=(\d+)$/gm)];
  return matches.length > 0 ? Number(matches.at(-1)![1]) : null;
}

export function parseInfo(text: string): FrameFormat {
  const values = new Map(text.split(/\r?\n/).filter(Boolean).map((line) => line.split('=', 2) as [string, string]));
  const read = (key: string) => {
    const value = Number(values.get(key));
    if (!Number.isFinite(value)) throw new ConvertError(ExitCode.Recording, `Emulator info file is missing "${key}"`);
    return value;
  };
  return { width: read('width'), height: read('height'), bpp: read('bpp'), fpsX100: read('fps_x100'), sampleRate: read('sample_rate') };
}

const describeFormat = (f: FrameFormat) => `${f.width}x${f.height} bpp ${f.bpp} @ ${f.fpsX100 / 100} fps, ${f.sampleRate} Hz`;

// What the emulator reported for this game. Vertical games report their upright size (taller than
// wide) but draw sideways: not supported (they would need the emulator's orientation flags).
export function validateFormat(info: FrameFormat, game: string): void {
  if (info.bpp !== 4 || info.width <= 0 || info.height <= 0 || info.fpsX100 <= 0 || info.sampleRate <= 0) {
    throw new ConvertError(
      ExitCode.Recording,
      `Unexpected frame format from the emulator: ${describeFormat(info)}`,
      'The emulator build may not match this fc2mp4 version; run fc2mp4 rebuild-emulator',
    );
  }
  if (info.height > info.width) {
    throw new ConvertError(ExitCode.Usage, `${game} is a vertical game; vertical games are not supported yet`, 'Only horizontal games can be converted for now');
  }
}

export function partPath(output: string): string {
  return `${output.replace(/\.mp4$/i, '')}.part.mp4`;
}

export function runFfmpeg(args: string[], ffmpeg = 'ffmpeg'): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4_000)));
    child.on('error', (err) => reject(new ConvertError(ExitCode.Encode, `Could not run ffmpeg: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new ConvertError(ExitCode.Encode, `ffmpeg failed (exit ${code})`, stderr.trim().split('\n').slice(-5).join('\n')));
    });
  });
}

export async function mux(args: { video: string; audio: string; output: string; format: FrameFormat }, ffmpeg = 'ffmpeg'): Promise<void> {
  const part = partPath(args.output);
  try {
    await runFfmpeg(muxArgs({ video: args.video, audio: args.audio, output: part, format: args.format }), ffmpeg);
    await rename(part, args.output);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}
