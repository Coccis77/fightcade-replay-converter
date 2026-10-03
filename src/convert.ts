import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { capture, defaultCaptureDeps, type CaptureOptions, type CaptureResult } from './capture.js';
import { defaultEmulatorPaths, defaultEnsureDeps, ensureEmulator, type EnsureResult } from './emulatorBuild.js';
import { mux, type ScaleMode } from './ffmpeg.js';
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
  ensureEmulator(install: FightcadeInstall, force: boolean): Promise<EnsureResult>;
  prepareRuntime(install: FightcadeInstall, refreshDlls: boolean): Promise<void>;
  makeTempDir(): Promise<string>;
  capture(install: FightcadeInstall, quarkId: string, opts: CaptureOptions): Promise<CaptureResult>;
  mkdir(dir: string): Promise<void>;
  mux(args: { video: string; audio: string; output: string }): Promise<void>;
  removeDir(dir: string): Promise<void>;
}

export function defaultDeps(): ConvertDeps {
  const home = homedir();
  const platform = supportedPlatform(process.platform);
  const app = appPaths(platform, home, process.env);
  const paths = { ...defaultEmulatorPaths(home), runtimeDir: app.runtimeDir, sourceDir: app.sourceDir };
  return {
    locateInstall: (override) => locateInstall({ platform: process.platform, home, env: process.env, override, exists: pathExists }),
    resolveOutput: (quarkId, output) => resolveOutputPath(quarkId, output, app.outputDir),
    acquireLock: () => acquireLock(),
    preflight: (install) => preflight(install, { exists: pathExists }),
    ensureEmulator: (install, force) => ensureEmulator(force, defaultEnsureDeps(install, paths)),
    prepareRuntime: (install, refreshDlls) => prepareRuntime(install, paths.runtimeDir, refreshDlls),
    makeTempDir: () => mkdtemp(join(tmpdir(), 'fc2mp4-')),
    capture: (install, quarkId, opts) => capture(defaultCaptureDeps(install, paths.runtimeDir, quarkId, 'ffmpeg'), opts),
    mkdir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    mux,
    removeDir: (dir) => rm(dir, { recursive: true, force: true }),
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
    options.onProgress?.({ phase: 'preparing-emulator' });
    const ensured = await deps.ensureEmulator(install, false);
    if (ensured.warning) log(`Warning: ${ensured.warning}`);
    if (ensured.rebuilt) debug('Emulator rebuilt');
    await deps.prepareRuntime(install, ensured.rebuilt);

    dir = await deps.makeTempDir();
    options.onProgress?.({ phase: 'connecting' });
    const captured = await deps.capture(install, ref.quarkId, {
      dir,
      scale: options.scale,
      maxDurationMs: options.maxDurationMs,
      signal: options.signal,
      onProgress: (frames, elapsedMs) => options.onProgress?.({ phase: 'capturing', frames, elapsedMs }),
    });
    if (captured.endReason === 'max-duration') log('Warning: reached --max-duration; the video may be cut short');

    options.onProgress?.({ phase: 'finalizing' });
    await deps.mkdir(dirname(output));
    await deps.mux({ video: captured.video, audio: captured.audio, output });
    return { output, frames: captured.frames, endReason: captured.endReason };
  } finally {
    if (dir !== undefined) await deps.removeDir(dir);
    await release();
  }
}

export async function rebuildEmulator(
  options: { fightcadeDir?: string; log?: (msg: string) => void },
  deps: ConvertDeps = defaultDeps(),
): Promise<EnsureResult> {
  const install = await deps.locateInstall(options.fightcadeDir);
  const release = await deps.acquireLock();
  try {
    const result = await deps.ensureEmulator(install, true);
    if (result.warning) options.log?.(`Warning: ${result.warning}`);
    return result;
  } finally {
    await release();
  }
}
