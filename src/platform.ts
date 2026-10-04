import path from 'node:path';
import { ConvertError, ExitCode } from './errors.js';

export type Platform = 'darwin' | 'win32' | 'linux';

export function supportedPlatform(p: NodeJS.Platform): Platform {
  if (p === 'darwin' || p === 'win32' || p === 'linux') return p;
  throw new ConvertError(ExitCode.Preflight, `fc2mp4 supports macOS, Windows and Linux (this is ${p})`);
}

export function pathFor(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

export interface AppPaths {
  cacheDir: string;
  runtimeDir: string;
  sourceDir: string;
  ffmpegDir: string;
  wineprefixDir: string;
  outputDir: string;
}

export function appPaths(platform: Platform, home: string, env: Record<string, string | undefined>): AppPaths {
  const p = pathFor(platform);
  let cacheDir: string;
  let outputDir: string;
  if (platform === 'win32') {
    cacheDir = p.join(env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local'), 'fc2mp4');
    outputDir = p.join(env.USERPROFILE ?? home, 'Videos', 'Fightcade');
  } else if (platform === 'linux') {
    cacheDir = p.join(env.XDG_CACHE_HOME ?? p.join(home, '.cache'), 'fc2mp4');
    outputDir = p.join(home, 'Videos', 'Fightcade');
  } else {
    cacheDir = p.join(home, 'Library', 'Caches', 'fc2mp4');
    outputDir = p.join(home, 'Movies', 'Fightcade');
  }
  // Docker and servers choose the output folder without passing -o on every run.
  const custom = env.FC2MP4_OUTPUT_DIR;
  if (custom && p.isAbsolute(custom)) outputDir = custom;
  return {
    cacheDir,
    runtimeDir: p.join(cacheDir, 'runtime'),
    sourceDir: p.join(cacheDir, 'fightcade-fbneo'),
    ffmpegDir: p.join(cacheDir, 'ffmpeg'),
    wineprefixDir: p.join(cacheDir, 'wineprefix'),
    outputDir,
  };
}
