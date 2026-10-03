import path from 'node:path';
import { ConvertError, ExitCode } from './errors.js';

export type Platform = 'darwin' | 'win32';

export function supportedPlatform(p: NodeJS.Platform): Platform {
  if (p === 'darwin' || p === 'win32') return p;
  throw new ConvertError(ExitCode.Preflight, `fc2mp4 supports macOS and Windows (this is ${p})`);
}

export function pathFor(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

export interface AppPaths {
  cacheDir: string;
  runtimeDir: string;
  sourceDir: string;
  ffmpegDir: string;
  outputDir: string;
}

export function appPaths(platform: Platform, home: string, env: Record<string, string | undefined>): AppPaths {
  const p = pathFor(platform);
  const cacheDir =
    platform === 'win32' ? p.join(env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local'), 'fc2mp4') : p.join(home, 'Library', 'Caches', 'fc2mp4');
  const outputDir = platform === 'win32' ? p.join(env.USERPROFILE ?? home, 'Videos', 'Fightcade') : p.join(home, 'Movies', 'Fightcade');
  return {
    cacheDir,
    runtimeDir: p.join(cacheDir, 'runtime'),
    sourceDir: p.join(cacheDir, 'fightcade-fbneo'),
    ffmpegDir: p.join(cacheDir, 'ffmpeg'),
    outputDir,
  };
}
