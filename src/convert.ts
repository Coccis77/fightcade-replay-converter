import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { capture, defaultCaptureDeps, type CaptureOptions, type CaptureResult } from './capture.js';
import { emulatorDir, localBuild } from './emulatorBuild.js';
import { defaultReleaseDeps, ensureEmulator, type EnsureResult } from './emulatorRelease.js';
import { currentPatchSetHash } from './patchSet.js';
import { mux, type ScaleMode } from './ffmpeg.js';
import { defaultFfmpegDeps, locateFfmpeg } from './ffmpegLocator.js';
import { pathExists } from './fsUtil.js';
import { locateInstall, preflight, type FightcadeInstall } from './install.js';
import { acquireLock } from './lock.js';
import { resolveOutputPath } from './outputPath.js';
import { appPaths, supportedPlatform } from './platform.js';
import { parseReplayRef } from './replayRef.js';
import { prepareRuntime } from './runtime.js';

export type ProgressEvent =
  | { phase: 'preparing-emulator' }
  | { phase: 'connecting' }
  | { phase: 'capturing'; frames: number; elapsedMs: number }
  | { phase: 'finalizing' };

export interface ConvertOptions {
  output?: string;
  scale: ScaleMode;
  maxDurationMs: number;
  fightcadeDir?: string;
  signal?: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
  log?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface ConvertResult {
  output: string;
  frames: number;
  endReason: CaptureResult['endReason'];
}

export interface ConvertDeps {
  locateInstall(override?: string): Promise<FightcadeInstall>;
  resolveOutput(quarkId: string, output?: string): Promise<string>;
  acquireLock(): Promise<() => Promise<void>>;
  preflight(install: FightcadeInstall): Promise<void>;
  locateFfmpeg(install: FightcadeInstall): Promise<string>;
  ensureEmulator(install: FightcadeInstall, opts: { force: boolean; local: boolean }): Promise<EnsureResult>;
  prepareRuntime(install: FightcadeInstall, refreshDlls: boolean): Promise<void>;
  makeTempDir(): Promise<string>;
  capture(install: FightcadeInstall, quarkId: string, ffmpeg: string, opts: CaptureOptions): Promise<CaptureResult>;
  mkdir(dir: string): Promise<void>;
  mux(args: { video: string; audio: string; output: string }, ffmpeg: string): Promise<void>;
  removeDir(dir: string): Promise<void>;
}

export function defaultDeps(): ConvertDeps {
  const home = homedir();
  const platform = supportedPlatform(process.platform);
  const app = appPaths(platform, home, process.env);
  return {
    locateInstall: (override) => locateInstall({ platform: process.platform, home, env: process.env, override, exists: pathExists }),
    resolveOutput: (quarkId, output) => resolveOutputPath(quarkId, output, app.outputDir),
    acquireLock: () => acquireLock(),
    preflight: (install) => preflight(install, { exists: pathExists }),
    locateFfmpeg: () => locateFfmpeg(platform, app.ffmpegDir, defaultFfmpegDeps(platform)),
    ensureEmulator: async (install, opts) => {
      const dir = emulatorDir();
      const hash = await currentPatchSetHash(emulatorDir);
      const local =
        install.platform === 'darwin' && dir !== null
          ? () => localBuild(install, { emulatorDir: dir, sourceDir: app.sourceDir, runtimeDir: app.runtimeDir })
          : null;
      return ensureEmulator({ patchSetHash: hash, force: opts.force, local: opts.local }, defaultReleaseDeps(app.runtimeDir, local));
    },
    prepareRuntime: (install, refreshDlls) => prepareRuntime(install, app.runtimeDir, refreshDlls),
    makeTempDir: () => mkdtemp(join(tmpdir(), 'fc2mp4-')),
    capture: (install, quarkId, ffmpeg, opts) => capture(defaultCaptureDeps(install, app.runtimeDir, quarkId, ffmpeg), opts),
    mkdir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    mux: (args, ffmpeg) => mux(args, ffmpeg),
    removeDir: (dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }),
  };
}

export async function convert(input: string, options: ConvertOptions, deps: ConvertDeps = defaultDeps()): Promise<ConvertResult> {
  const ref = parseReplayRef(input);
  const log = options.log ?? (() => {});
  const debug = options.debug ?? (() => {});
  const install = await deps.locateInstall(options.fightcadeDir);
  const output = await deps.resolveOutput(ref.quarkId, options.output);
  debug(`Fightcade: ${install.root}`);
  debug(`Output: ${output}`);

  const release = await deps.acquireLock();
  let dir: string | undefined;
  try {
    await deps.preflight(install);
    const ffmpeg = await deps.locateFfmpeg(install);
    debug(`ffmpeg: ${ffmpeg}`);
    options.onProgress?.({ phase: 'preparing-emulator' });
    const ensured = await deps.ensureEmulator(install, { force: false, local: false });
    if (ensured.warning) log(`Warning: ${ensured.warning}`);
    if (ensured.updated) debug('Emulator updated');
    await deps.prepareRuntime(install, ensured.updated);

    dir = await deps.makeTempDir();
    options.onProgress?.({ phase: 'connecting' });
    const captured = await deps.capture(install, ref.quarkId, ffmpeg, {
      dir,
      scale: options.scale,
      maxDurationMs: options.maxDurationMs,
      signal: options.signal,
      onProgress: (frames, elapsedMs) => options.onProgress?.({ phase: 'capturing', frames, elapsedMs }),
    });
    if (captured.endReason === 'max-duration') log('Warning: reached --max-duration; the video may be cut short');

    options.onProgress?.({ phase: 'finalizing' });
    await deps.mkdir(dirname(output));
    await deps.mux({ video: captured.video, audio: captured.audio, output }, ffmpeg);
    return { output, frames: captured.frames, endReason: captured.endReason };
  } finally {
    // Cleanup must never replace the real error (Windows keeps files locked briefly after a kill).
    if (dir !== undefined) await deps.removeDir(dir).catch((err: unknown) => debug(`Could not remove ${dir}: ${String(err)}`));
    await release();
  }
}

async function runEmulatorCommand(
  opts: { force: boolean; local: boolean },
  options: { fightcadeDir?: string; log?: (msg: string) => void },
  deps: ConvertDeps,
): Promise<EnsureResult> {
  const install = await deps.locateInstall(options.fightcadeDir);
  const release = await deps.acquireLock();
  try {
    const result = await deps.ensureEmulator(install, opts);
    if (result.warning) options.log?.(`Warning: ${result.warning}`);
    return result;
  } finally {
    await release();
  }
}

export function updateEmulator(options: { fightcadeDir?: string; log?: (msg: string) => void }, deps: ConvertDeps = defaultDeps()): Promise<EnsureResult> {
  return runEmulatorCommand({ force: true, local: false }, options, deps);
}

export function buildEmulatorLocally(options: { fightcadeDir?: string; log?: (msg: string) => void }, deps: ConvertDeps = defaultDeps()): Promise<EnsureResult> {
  return runEmulatorCommand({ force: false, local: true }, options, deps);
}
