import { describe, expect, it } from 'vitest';
import { appPaths, supportedPlatform } from '../src/platform.js';
import { ExitCode } from '../src/errors.js';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('platform', () => {
  it('accepts macOS and Windows', () => {
    expect(supportedPlatform('darwin')).toBe('darwin');
    expect(supportedPlatform('win32')).toBe('win32');
    expect(thrown(() => supportedPlatform('aix'))).toMatchObject({ exitCode: ExitCode.Preflight });
  });

  it('places macOS files under Library/Caches and Movies', () => {
    expect(appPaths('darwin', '/Users/fran', {})).toEqual({
      cacheDir: '/Users/fran/Library/Caches/fc2mp4',
      runtimeDir: '/Users/fran/Library/Caches/fc2mp4/runtime',
      sourceDir: '/Users/fran/Library/Caches/fc2mp4/fightcade-fbneo',
      ffmpegDir: '/Users/fran/Library/Caches/fc2mp4/ffmpeg',
      wineprefixDir: '/Users/fran/Library/Caches/fc2mp4/wineprefix',
      outputDir: '/Users/fran/Movies/Fightcade',
    });
  });

  it('places Windows files under LOCALAPPDATA and Videos', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\Jean Pierre\\AppData\\Local', USERPROFILE: 'C:\\Users\\Jean Pierre' };
    expect(appPaths('win32', 'C:\\Users\\Jean Pierre', env)).toEqual({
      cacheDir: 'C:\\Users\\Jean Pierre\\AppData\\Local\\fc2mp4',
      runtimeDir: 'C:\\Users\\Jean Pierre\\AppData\\Local\\fc2mp4\\runtime',
      sourceDir: 'C:\\Users\\Jean Pierre\\AppData\\Local\\fc2mp4\\fightcade-fbneo',
      ffmpegDir: 'C:\\Users\\Jean Pierre\\AppData\\Local\\fc2mp4\\ffmpeg',
      wineprefixDir: 'C:\\Users\\Jean Pierre\\AppData\\Local\\fc2mp4\\wineprefix',
      outputDir: 'C:\\Users\\Jean Pierre\\Videos\\Fightcade',
    });
  });
});

describe('platform (Linux)', () => {
  it('accepts Linux', () => {
    expect(supportedPlatform('linux')).toBe('linux');
    expect(thrown(() => supportedPlatform('freebsd'))).toMatchObject({ exitCode: ExitCode.Preflight, message: expect.stringContaining('Linux') });
  });
  it('uses XDG_CACHE_HOME when set, ~/.cache otherwise, and ~/Videos', () => {
    expect(appPaths('linux', '/home/a', { XDG_CACHE_HOME: '/data/cache' })).toEqual({
      cacheDir: '/data/cache/fc2mp4',
      runtimeDir: '/data/cache/fc2mp4/runtime',
      sourceDir: '/data/cache/fc2mp4/fightcade-fbneo',
      ffmpegDir: '/data/cache/fc2mp4/ffmpeg',
      wineprefixDir: '/data/cache/fc2mp4/wineprefix',
      outputDir: '/home/a/Videos/Fightcade',
    });
    expect(appPaths('linux', '/home/a', {}).cacheDir).toBe('/home/a/.cache/fc2mp4');
  });
});

describe('FC2MP4_OUTPUT_DIR', () => {
  it('replaces the default output folder on every platform when absolute', () => {
    expect(appPaths('linux', '/home/a', { FC2MP4_OUTPUT_DIR: '/videos' }).outputDir).toBe('/videos');
    expect(appPaths('darwin', '/Users/a', { FC2MP4_OUTPUT_DIR: '/Volumes/Clips' }).outputDir).toBe('/Volumes/Clips');
    expect(appPaths('win32', 'C:\\Users\\a', { FC2MP4_OUTPUT_DIR: 'D:\\Clips' }).outputDir).toBe('D:\\Clips');
  });
  it('ignores an empty or relative value', () => {
    expect(appPaths('linux', '/home/a', { FC2MP4_OUTPUT_DIR: '' }).outputDir).toBe('/home/a/Videos/Fightcade');
    expect(appPaths('linux', '/home/a', { FC2MP4_OUTPUT_DIR: 'videos' }).outputDir).toBe('/home/a/Videos/Fightcade');
  });
});
