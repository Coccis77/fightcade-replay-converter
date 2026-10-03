import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { checkInfo, mux, muxArgs, parseInfo, parseProgressFrames, partPath, runFfmpeg, videoEncodeArgs } from '../src/ffmpeg.js';
import { ExitCode } from '../src/errors.js';
import { pathExists } from '../src/fsUtil.js';

const exec = promisify(execFile);
const hasFfmpeg = await exec('ffmpeg', ['-version']).then(() => true, () => false);

describe('ffmpeg arguments', () => {
  it('encodes raw BGRA frames to 1440x1080 H.264 without audio', () => {
    expect(videoEncodeArgs({ input: '/t/video.fifo', output: '/t/video.mp4', scale: 'sharp' })).toEqual([
      '-hide_banner', '-nostats', '-progress', 'pipe:1', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'bgr0', '-s', '384x224', '-r', '59.59', '-i', '/t/video.fifo',
      '-vf', 'scale=iw*4:ih*4:flags=neighbor,scale=1440:1080:flags=lanczos,setsar=1',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-an',
      '/t/video.mp4',
    ]);
    expect(videoEncodeArgs({ input: 'i', output: 'o', scale: 'smooth' })).toContain('scale=1440:1080:flags=lanczos,setsar=1');
  });

  it('muxes the video with the raw audio', () => {
    expect(muxArgs({ video: '/t/video.mp4', audio: '/t/audio.raw', output: '/o/x.part.mp4' })).toEqual([
      '-hide_banner', '-nostats', '-y',
      '-i', '/t/video.mp4',
      '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', '/t/audio.raw',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', '/o/x.part.mp4',
    ]);
  });

  it('reads the last frame count from progress output', () => {
    expect(parseProgressFrames('frame=10\nfps=0\nframe=42\nprogress=continue\n')).toBe(42);
    expect(parseProgressFrames('progress=continue\n')).toBeNull();
  });

  it('derives a .part.mp4 path', () => {
    expect(partPath('/o/1-2.mp4')).toBe('/o/1-2.part.mp4');
  });
});

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('emulator info', () => {
  const good = 'width=384\nheight=224\nbpp=4\nfps_x100=5959\nsample_rate=44100\n';
  it('parses and accepts the expected format', () => {
    const info = parseInfo(good);
    expect(info).toEqual({ width: 384, height: 224, bpp: 4, fpsX100: 5959, sampleRate: 44100 });
    expect(() => checkInfo(info)).not.toThrow();
  });
  it('rejects another format with a Recording error describing both', () => {
    expect(thrown(() => checkInfo(parseInfo(good.replace('bpp=4', 'bpp=2'))))).toMatchObject({
      exitCode: ExitCode.Recording,
      message: expect.stringContaining('bpp 2'),
    });
  });
  it('rejects an incomplete info file', () => {
    expect(thrown(() => parseInfo('width=384\n'))).toMatchObject({ exitCode: ExitCode.Recording });
  });
});

describe.skipIf(!hasFfmpeg)('encode + mux (real ffmpeg)', () => {
  async function rawInputs(dir: string) {
    const video = join(dir, 'video.raw');
    const audio = join(dir, 'audio.raw');
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=384x224:rate=59.59', '-t', '1', '-f', 'rawvideo', '-pix_fmt', 'bgr0', video]);
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1', '-ac', '2', '-f', 's16le', audio]);
    return { video, audio };
  }

  it('produces a 1440x1080 h264/aac MP4 with matching durations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-ff-'));
    const raw = await rawInputs(dir);
    const videoMp4 = join(dir, 'video.mp4');
    const output = join(dir, 'out.mp4');
    await runFfmpeg(videoEncodeArgs({ input: raw.video, output: videoMp4, scale: 'sharp' }));
    await mux({ video: videoMp4, audio: raw.audio, output });

    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,duration', '-of', 'json', output]);
    const streams = (JSON.parse(stdout) as { streams: Record<string, string | number>[] }).streams;
    const v = streams.find((s) => s.codec_type === 'video')!;
    const a = streams.find((s) => s.codec_type === 'audio')!;
    expect(v).toMatchObject({ codec_name: 'h264', width: 1440, height: 1080 });
    expect(a).toMatchObject({ codec_name: 'aac' });
    expect(Math.abs(Number(v.duration) - Number(a.duration))).toBeLessThan(0.05);
    expect(await pathExists(partPath(output))).toBe(false);
  }, 60_000);

  it('keeps an existing MP4 and leaves no part file when muxing fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-ff-'));
    const output = join(dir, 'out.mp4');
    await writeFile(output, 'OLD VIDEO');
    await expect(mux({ video: join(dir, 'missing.mp4'), audio: join(dir, 'missing.raw'), output })).rejects.toMatchObject({ exitCode: ExitCode.Encode });
    expect(await readFile(output, 'utf8')).toBe('OLD VIDEO');
    expect(await pathExists(partPath(output))).toBe(false);
  }, 60_000);
});
