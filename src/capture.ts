import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EMULATOR_EXE, TIMEOUTS } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import { run } from './exec.js';
import { checkInfo, parseInfo, parseProgressFrames, videoEncodeArgs, type ScaleMode } from './ffmpeg.js';
import type { FightcadeInstall } from './install.js';
import { streamArg } from './replayRef.js';

export interface CaptureProcess {
  readonly exited: boolean;
  wait(): Promise<number | null>;
  kill(): Promise<void>;
}

export interface CaptureDeps {
  makeFifo(path: string): Promise<void>;
  startEncoder(args: string[], onFrames: (frames: number) => void): CaptureProcess;
  startEmulator(env: Record<string, string>): CaptureProcess;
  readInfo(path: string): Promise<string | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface CaptureOptions {
  dir: string;
  scale: ScaleMode;
  maxDurationMs: number;
  signal?: AbortSignal;
  onProgress?: (frames: number, elapsedMs: number) => void;
}

export interface CaptureResult {
  video: string;
  audio: string;
  frames: number;
  endReason: 'ended' | 'max-duration';
}

export function winPath(p: string): string {
  return `Z:${p.replace(/\//g, '\\')}`;
}

export async function capture(deps: CaptureDeps, opts: CaptureOptions): Promise<CaptureResult> {
  const fifo = join(opts.dir, 'video.fifo');
  const video = join(opts.dir, 'video.mp4');
  const audio = join(opts.dir, 'audio.raw');
  const info = join(opts.dir, 'info.txt');

  await deps.makeFifo(fifo);
  let frames = 0;
  const encoder = deps.startEncoder(videoEncodeArgs({ input: fifo, output: video, scale: opts.scale }), (n) => (frames = n));
  const emulator = deps.startEmulator({
    FC2MP4_VIDEO: winPath(fifo),
    FC2MP4_AUDIO: winPath(audio),
    FC2MP4_INFO: winPath(info),
    FC2MP4_IDLE_MS: String(TIMEOUTS.emulatorIdleMs),
  });

  const start = deps.now();
  let started = false;
  let lastFrames = 0;
  let lastProgressAt = start;
  let endReason: CaptureResult['endReason'] = 'ended';
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new ConvertError(ExitCode.Interrupted, 'Interrupted');
      if (!started) {
        const text = await deps.readInfo(info);
        if (text !== null) {
          checkInfo(parseInfo(text));
          started = true;
          lastProgressAt = deps.now();
        }
      }
      if (emulator.exited) {
        if (!started) {
          throw new ConvertError(ExitCode.Emulator, 'The emulator exited before the replay started', 'Check the quark ID; the replay may no longer exist');
        }
        const code = await emulator.wait();
        if (code !== 0) {
          throw new ConvertError(ExitCode.Emulator, `The emulator stopped unexpectedly (exit ${code}) after ${frames} frames`, 'The replay was not captured completely; try again');
        }
        break;
      }
      if (encoder.exited) throw new ConvertError(ExitCode.Encode, 'The video encoder stopped unexpectedly');
      const now = deps.now();
      const elapsed = now - start;
      if (frames !== lastFrames) {
        lastFrames = frames;
        lastProgressAt = now;
      }
      if (started && now - lastProgressAt >= TIMEOUTS.stallMs) {
        throw new ConvertError(ExitCode.Recording, `The capture stalled: no new frame for ${TIMEOUTS.stallMs / 1000} s`, 'The emulator may be stuck; try again (use -v for details)');
      }
      if (!started && elapsed >= TIMEOUTS.firstFrameMs) {
        throw new ConvertError(ExitCode.Recording, 'The replay stream never started', 'Check the quark ID and that Fightcade replay servers are reachable');
      }
      if (elapsed >= opts.maxDurationMs) {
        endReason = 'max-duration';
        await emulator.kill();
        break;
      }
      opts.onProgress?.(frames, elapsed);
      await deps.sleep(TIMEOUTS.pollMs);
    }
    const code = await encoder.wait();
    if (code !== 0) throw new ConvertError(ExitCode.Encode, `The video encoder failed (exit ${code})`);
    return { video, audio, frames, endReason };
  } finally {
    if (!emulator.exited) await emulator.kill().catch(() => {});
    if (!encoder.exited) await encoder.kill().catch(() => {});
  }
}

function wrap(child: ReturnType<typeof spawn>, kill: () => Promise<void>): CaptureProcess {
  let exited = false;
  let exitCode: number | null = null;
  const done = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      resolve(code);
    });
    child.on('error', () => {
      exited = true;
      resolve(null);
    });
  });
  return {
    get exited() {
      return exited;
    },
    wait: () => (exited ? Promise.resolve(exitCode) : done),
    kill,
  };
}

export function defaultCaptureDeps(install: FightcadeInstall, runtimeDir: string, quarkId: string): CaptureDeps {
  return {
    makeFifo: async (path) => {
      const result = await run('mkfifo', [path]);
      if (result.code !== 0) throw new ConvertError(ExitCode.Recording, `mkfifo failed: ${result.stderr.trim()}`);
    },
    startEncoder: (args, onFrames) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout!.on('data', (d) => {
        const frames = parseProgressFrames(String(d));
        if (frames !== null) onFrames(frames);
      });
      return wrap(child, async () => {
        child.kill('SIGKILL');
      });
    },
    startEmulator: (env) => {
      const child = spawn(install.wineSh, [join(runtimeDir, EMULATOR_EXE), streamArg(quarkId)], {
        cwd: runtimeDir,
        env: { ...process.env, ...env },
        stdio: 'ignore',
      });
      return wrap(child, async () => {
        await run(install.wineSh, ['taskkill', '/IM', EMULATOR_EXE, '/F'], { cwd: runtimeDir, timeoutMs: TIMEOUTS.killMs });
        child.kill('SIGKILL');
      });
    },
    readInfo: async (path) => {
      try {
        const text = await readFile(path, 'utf8');
        return text.includes('sample_rate=') ? text : null;
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}
