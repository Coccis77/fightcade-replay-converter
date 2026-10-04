import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { EMULATOR_EXE, TIMEOUTS } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import { run } from './exec.js';
import { checkInfo, parseInfo, parseProgressFrames, videoEncodeArgs, type ScaleMode } from './ffmpeg.js';
import type { FightcadeInstall } from './install.js';
import { pathFor } from './platform.js';
import { streamArg } from './replayRef.js';
import { wineEnv } from './winePrefix.js';
import { fifoTransport, pipeName, pipeTransport, winPath, type VideoTransport } from './transport.js';

export { winPath } from './transport.js';

export interface CaptureProcess {
  readonly exited: boolean;
  wait(): Promise<number | null>;
  kill(): Promise<void>;
}

export interface CaptureDeps {
  openTransport(dir: string): Promise<VideoTransport>;
  toEmulatorPath(p: string): string;
  startEncoder(args: string[], onFrames: (frames: number) => void, attach: ((stdin: Writable) => void) | null): CaptureProcess;
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

export function emulatorCommand(install: FightcadeInstall, runtimeDir: string, quarkId: string): { command: string; args: string[] } {
  const exe = pathFor(install.platform).join(runtimeDir, EMULATOR_EXE);
  if (install.platform === 'linux') {
    // Always headless. Wine's virtual desktop (bare Xvfb fails: X_UnmapWindow BadWindow) is set in our
    // prefix's registry at setup, so the emulator runs directly and its exit code comes back.
    return { command: 'xvfb-run', args: ['-a', '-s', '-screen 0 1024x768x24', 'wine', exe, streamArg(quarkId)] };
  }
  if (install.launcher !== null) return { command: install.launcher, args: [exe, streamArg(quarkId)] };
  return { command: exe, args: [streamArg(quarkId)] };
}

export function killCommand(install: FightcadeInstall, winePrefix: string | null): { command: string; args: string[]; env?: Record<string, string> } {
  if (install.platform === 'linux' && winePrefix !== null) return { command: 'wineserver', args: ['-k'], env: wineEnv(winePrefix) };
  const args = ['/IM', EMULATOR_EXE, '/F'];
  return install.launcher !== null ? { command: install.launcher, args: ['taskkill', ...args] } : { command: 'taskkill', args };
}

export function emulatorSpawnOptions(
  install: FightcadeInstall,
  runtimeDir: string,
  env: Record<string, string>,
  winePrefix: string | null,
  base: NodeJS.ProcessEnv = process.env,
): { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: 'ignore' } {
  const linux = install.platform === 'linux' && winePrefix !== null;
  return {
    cwd: runtimeDir,
    env: { ...base, ...(linux ? wineEnv(winePrefix) : {}), ...env },
    detached: linux, // own process group, so Xvfb and Wine are stopped together
    stdio: 'ignore',
  };
}

// Stop whatever is left in a process group once its leader is gone. If xvfb-run itself is killed,
// its Xvfb would otherwise keep running, orphaned.
export function sweepProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // group already empty
  }
}

export async function capture(deps: CaptureDeps, opts: CaptureOptions): Promise<CaptureResult> {
  const video = join(opts.dir, 'video.mp4');
  const audio = join(opts.dir, 'audio.raw');
  const info = join(opts.dir, 'info.txt');

  const transport = await deps.openTransport(opts.dir);
  let frames = 0;
  const attach = transport.encoderInput === 'pipe:0' ? (stdin: Writable) => transport.attach(stdin) : null;
  const encoder = deps.startEncoder(videoEncodeArgs({ input: transport.encoderInput, output: video, scale: opts.scale }), (n) => (frames = n), attach);
  const emulator = deps.startEmulator({
    FC2MP4_VIDEO: transport.emulatorPath,
    FC2MP4_AUDIO: deps.toEmulatorPath(audio),
    FC2MP4_INFO: deps.toEmulatorPath(info),
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
    await transport.close().catch(() => {});
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
    // Wait (bounded) for the process to really exit, so its files are released before cleanup.
    kill: async () => {
      await kill();
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, TIMEOUTS.killMs))]);
    },
  };
}

export function defaultCaptureDeps(
  install: FightcadeInstall,
  runtimeDir: string,
  quarkId: string,
  ffmpeg: string,
  winePrefix: string | null,
): CaptureDeps {
  return {
    openTransport: (dir) =>
      install.platform === 'win32'
        ? pipeTransport(pipeName(process.pid, randomBytes(4).toString('hex')))
        : fifoTransport(dir, async (path) => {
            const result = await run('mkfifo', [path]);
            if (result.code !== 0) throw new ConvertError(ExitCode.Recording, `mkfifo failed: ${result.stderr.trim()}`);
          }),
    toEmulatorPath: (p) => (install.platform === 'win32' ? p : winPath(p)),
    startEncoder: (args, onFrames, attach) => {
      const child = spawn(ffmpeg, args, { stdio: [attach ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
      if (attach && child.stdin) {
        child.stdin.on('error', () => {}); // ffmpeg exiting early must not crash Node (EPIPE)
        attach(child.stdin);
      }
      child.stdout!.on('data', (d) => {
        const frames = parseProgressFrames(String(d));
        if (frames !== null) onFrames(frames);
      });
      return wrap(child, async () => {
        child.kill('SIGKILL');
      });
    },
    startEmulator: (env) => {
      // FBNeo divides by the screen size while sizing its window: a sleeping Mac display (size 0)
      // crashes it. Keep the display awake for as long as this process runs.
      const awake = install.platform === 'darwin' ? spawn('caffeinate', ['-d', '-u', '-w', String(process.pid)], { stdio: 'ignore' }) : null;
      awake?.on('error', () => {});
      const { command, args } = emulatorCommand(install, runtimeDir, quarkId);
      const options = emulatorSpawnOptions(install, runtimeDir, env, winePrefix);
      const child = spawn(command, args, options);
      child.on('exit', () => {
        awake?.kill();
        if (options.detached && child.pid !== undefined) sweepProcessGroup(child.pid);
      });
      return wrap(child, async () => {
        const kill = killCommand(install, winePrefix);
        await run(kill.command, kill.args, { cwd: runtimeDir, timeoutMs: TIMEOUTS.killMs, env: kill.env ? { ...process.env, ...kill.env } : undefined }).catch(() => {});
        if (options.detached && child.pid !== undefined) sweepProcessGroup(child.pid);
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
