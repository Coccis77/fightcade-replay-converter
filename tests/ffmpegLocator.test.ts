import { describe, expect, it } from 'vitest';
import { locateFfmpeg, type FfmpegDeps } from '../src/ffmpegLocator.js';
import { ExitCode } from '../src/errors.js';

const DIR = 'C:\\Users\\a\\AppData\\Local\\fc2mp4\\ffmpeg';
const GOOD = 'a'.repeat(64);

function fakeDeps(world: { onPath?: string; cached?: boolean; actualSha?: string }) {
  const calls: string[] = [];
  const deps: FfmpegDeps = {
    which: async () => world.onPath ?? null,
    exists: async () => world.cached ?? false,
    readText: async (url) => {
      calls.push(`read:${url}`);
      return `${GOOD}  ffmpeg.exe\n`;
    },
    download: async (url, dest) => {
      calls.push(`download:${url}->${dest}`);
    },
    sha256: async () => world.actualSha ?? GOOD,
    rename: async (from, to) => {
      calls.push(`rename:${from}->${to}`);
    },
    remove: async (p) => {
      calls.push(`rm:${p}`);
    },
    mkdir: async () => {},
  };
  return { deps, calls };
}

describe('locateFfmpeg', () => {
  it('prefers ffmpeg on PATH', async () => {
    const { deps, calls } = fakeDeps({ onPath: 'C:\\tools\\ffmpeg.exe' });
    expect(await locateFfmpeg('win32', DIR, deps)).toBe('C:\\tools\\ffmpeg.exe');
    expect(calls).toEqual([]);
  });
  it('uses the cached copy on Windows', async () => {
    const { deps, calls } = fakeDeps({ cached: true });
    expect(await locateFfmpeg('win32', DIR, deps)).toBe(`${DIR}\\ffmpeg.exe`);
    expect(calls).toEqual([]);
  });
  it('downloads and verifies the mirrored build on first use', async () => {
    const { deps, calls } = fakeDeps({});
    expect(await locateFfmpeg('win32', DIR, deps)).toBe(`${DIR}\\ffmpeg.exe`);
    const base = 'https://github.com/Coccis77/fightcade-replay-converter/releases/download/tools-ffmpeg-9.0.2';
    expect(calls).toEqual([
      `read:${base}/ffmpeg.exe.sha256`,
      `download:${base}/ffmpeg.exe->${DIR}\\ffmpeg.exe.download`,
      `rename:${DIR}\\ffmpeg.exe.download->${DIR}\\ffmpeg.exe`,
    ]);
  });
  it('rejects a checksum mismatch and caches nothing', async () => {
    const { deps, calls } = fakeDeps({ actualSha: 'b'.repeat(64) });
    await expect(locateFfmpeg('win32', DIR, deps)).rejects.toMatchObject({ exitCode: ExitCode.Preflight, message: expect.stringContaining('checksum') });
    expect(calls.some((c) => c.startsWith('rename'))).toBe(false);
    expect(calls).toContain(`rm:${DIR}\\ffmpeg.exe.download`);
  });
  it('asks Linux users to install ffmpeg with apt', async () => {
    const { deps } = fakeDeps({});
    await expect(locateFfmpeg('linux', '/x', deps)).rejects.toMatchObject({ exitCode: ExitCode.Preflight, hint: 'sudo apt install ffmpeg' });
  });
  it('asks macOS users to install ffmpeg with Homebrew', async () => {
    const { deps } = fakeDeps({});
    await expect(locateFfmpeg('darwin', '/x', deps)).rejects.toMatchObject({ exitCode: ExitCode.Preflight, hint: 'brew install ffmpeg' });
  });
});
