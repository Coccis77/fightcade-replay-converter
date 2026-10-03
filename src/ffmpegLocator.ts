import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { REPO } from './emulatorRelease.js';
import { ConvertError, ExitCode } from './errors.js';
import { which } from './exec.js';
import { pathExists } from './fsUtil.js';
import { pathFor, type Platform } from './platform.js';

// Pinned static ffmpeg mirrored into our releases by .github/workflows/tools.yml.
export const FFMPEG_MIRROR = { tag: 'tools-ffmpeg-9.0.2', exe: 'ffmpeg.exe', checksum: 'ffmpeg.exe.sha256' } as const;

export interface FfmpegDeps {
  which(cmd: string): Promise<string | null>;
  exists(p: string): Promise<boolean>;
  readText(url: string): Promise<string>;
  download(url: string, dest: string): Promise<void>;
  sha256(p: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  remove(p: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
}

export async function locateFfmpeg(platform: Platform, ffmpegDir: string, deps: FfmpegDeps): Promise<string> {
  const onPath = await deps.which(platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (onPath) return onPath;
  if (platform === 'darwin') throw new ConvertError(ExitCode.Preflight, 'ffmpeg not found on PATH', 'brew install ffmpeg');

  const target = pathFor(platform).join(ffmpegDir, FFMPEG_MIRROR.exe);
  if (await deps.exists(target)) return target;

  const base = `https://github.com/${REPO}/releases/download/${FFMPEG_MIRROR.tag}`;
  const tmp = `${target}.download`;
  try {
    const expected = (await deps.readText(`${base}/${FFMPEG_MIRROR.checksum}`)).trim().split(/\s+/)[0]!.toLowerCase();
    await deps.mkdir(ffmpegDir);
    await deps.download(`${base}/${FFMPEG_MIRROR.exe}`, tmp);
    if ((await deps.sha256(tmp)).toLowerCase() !== expected) throw new Error('downloaded ffmpeg failed its checksum check');
    await deps.rename(tmp, target);
    return target;
  } catch (err) {
    await deps.remove(tmp);
    const message = err instanceof Error ? err.message : String(err);
    throw new ConvertError(ExitCode.Preflight, `Could not get ffmpeg: ${message}`, 'Check your internet connection, or install ffmpeg and put it on PATH');
  }
}

export function defaultFfmpegDeps(platform: Platform, signal?: AbortSignal): FfmpegDeps {
  const within = (ms: number) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));
  return {
    which: (cmd) => which(cmd, platform),
    exists: pathExists,
    readText: async (url) => {
      const res = await fetch(url, { headers: { 'User-Agent': 'fc2mp4' }, signal: within(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.text();
    },
    download: async (url, dest) => {
      const res = await fetch(url, { headers: { 'User-Agent': 'fc2mp4' }, signal: within(15 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest));
    },
    sha256: (p) =>
      new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(p).on('data', (c) => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
      }),
    rename: (from, to) => rename(from, to),
    remove: (p) => rm(p, { force: true }),
    mkdir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
  };
}
