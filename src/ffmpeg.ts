import { spawn } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { FRAME_FORMAT } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';

export type ScaleMode = 'sharp' | 'smooth';

// Converting to planar YUV at native size first makes the upscale ~4x faster than scaling
// packed RGB (the scaler, not x264, was the bottleneck); the output is YUV anyway.
export const VIDEO_FILTERS: Record<ScaleMode, string> = {
  sharp: 'format=yuv444p,scale=iw*4:ih*4:flags=neighbor,scale=1440:1080:flags=lanczos,setsar=1',
  smooth: 'format=yuv444p,scale=1440:1080:flags=lanczos,setsar=1',
};

const FPS = String(FRAME_FORMAT.fpsX100 / 100);

export function videoEncodeArgs({ input, output, scale }: { input: string; output: string; scale: ScaleMode }): string[] {
  return [
    '-hide_banner', '-nostats', '-progress', 'pipe:1', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'bgr0', '-s', `${FRAME_FORMAT.width}x${FRAME_FORMAT.height}`, '-r', FPS, '-i', input,
    '-vf', VIDEO_FILTERS[scale],
    // veryfast/crf 20: ~5x real time (keeps pace with capture), no visible loss vs medium/crf 18.
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-an',
    output,
  ];
}

export function muxArgs({ video, audio, output }: { video: string; audio: string; output: string }): string[] {
  return [
    '-hide_banner', '-nostats', '-y',
    '-i', video,
    '-f', 's16le', '-ar', String(FRAME_FORMAT.sampleRate), '-ac', '2', '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', output,
  ];
}

export function parseProgressFrames(chunk: string): number | null {
  const matches = [...chunk.matchAll(/^frame=(\d+)$/gm)];
  return matches.length > 0 ? Number(matches.at(-1)![1]) : null;
}

export interface FrameInfo {
  width: number;
  height: number;
  bpp: number;
  fpsX100: number;
  sampleRate: number;
}

export function parseInfo(text: string): FrameInfo {
  const values = new Map(text.split(/\r?\n/).filter(Boolean).map((line) => line.split('=', 2) as [string, string]));
  const read = (key: string) => {
    const value = Number(values.get(key));
    if (!Number.isFinite(value)) throw new ConvertError(ExitCode.Recording, `Emulator info file is missing "${key}"`);
    return value;
  };
  return { width: read('width'), height: read('height'), bpp: read('bpp'), fpsX100: read('fps_x100'), sampleRate: read('sample_rate') };
}

export function checkInfo(info: FrameInfo): void {
  const e = FRAME_FORMAT;
  if (info.width !== e.width || info.height !== e.height || info.bpp !== e.bpp || info.fpsX100 !== e.fpsX100 || info.sampleRate !== e.sampleRate) {
    const describe = (f: FrameInfo) => `${f.width}x${f.height} bpp ${f.bpp} @ ${f.fpsX100 / 100} fps, ${f.sampleRate} Hz`;
    throw new ConvertError(
      ExitCode.Recording,
      `Unexpected frame format from the emulator: ${describe(info)} (expected ${describe(e)})`,
      'The emulator build may not match this fc2mp4 version; run fc2mp4 rebuild-emulator',
    );
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

export async function mux(args: { video: string; audio: string; output: string }, ffmpeg = 'ffmpeg'): Promise<void> {
  const part = partPath(args.output);
  try {
    await runFfmpeg(muxArgs({ video: args.video, audio: args.audio, output: part }), ffmpeg);
    await rename(part, args.output);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}
