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
  it('accepts macOS and Windows only', () => {
    expect(supportedPlatform('darwin')).toBe('darwin');
    expect(supportedPlatform('win32')).toBe('win32');
    expect(thrown(() => supportedPlatform('linux'))).toMatchObject({ exitCode: ExitCode.Preflight });
  });

  it('places macOS files under Library/Caches and Movies', () => {
    expect(appPaths('darwin', '/Users/fran', {})).toEqual({
      cacheDir: '/Users/fran/Library/Caches/fc2mp4',
      runtimeDir: '/Users/fran/Library/Caches/fc2mp4/runtime',
      sourceDir: '/Users/fran/Library/Caches/fc2mp4/fightcade-fbneo',
      ffmpegDir: '/Users/fran/Library/Caches/fc2mp4/ffmpeg',
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
      outputDir: 'C:\\Users\\Jean Pierre\\Videos\\Fightcade',
    });
  });
});
