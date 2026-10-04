import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { ConvertError, ExitCode } from './errors.js';
import { pathExists } from './fsUtil.js';

// FBNeo only produces sound when Wine has an audio device. Headless Linux (Docker, a VPS) has none,
// so each run gets a private PulseAudio with a null sink: sound is generated, played nowhere.
export interface SilentAudio {
  env: Record<string, string>;
  stop(): Promise<void>;
}

export interface SilentAudioDeps {
  mkdir(dir: string): Promise<void>;
  spawn(command: string, args: string[], env: Record<string, string>): { readonly exited: boolean; kill(): Promise<void> };
  exists(p: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

export function pulseCommand(dir: string): { command: string; args: string[]; env: Record<string, string>; socket: string } {
  const runtime = `${dir}/pulse`;
  const socket = `${runtime}/native`;
  return {
    command: 'pulseaudio',
    args: [
      '--daemonize=no', '-n', '--exit-idle-time=-1', '--use-pid-file=no', '--disable-shm=yes', '--log-target=stderr',
      '--load=module-null-sink',
      `--load=module-native-protocol-unix socket=${socket} auth-anonymous=1`,
    ],
    env: { XDG_RUNTIME_DIR: runtime, PULSE_RUNTIME_PATH: runtime },
    socket,
  };
}

export async function startSilentAudio(dir: string, deps: SilentAudioDeps, timeoutMs = 10_000): Promise<SilentAudio> {
  const cmd = pulseCommand(dir);
  await deps.mkdir(cmd.env.XDG_RUNTIME_DIR!);
  const proc = deps.spawn(cmd.command, cmd.args, cmd.env);
  for (let waited = 0; ; waited += 100) {
    if (await deps.exists(cmd.socket)) return { env: { PULSE_SERVER: `unix:${cmd.socket}` }, stop: () => proc.kill() };
    if (proc.exited || waited >= timeoutMs) {
      await proc.kill();
      throw new ConvertError(ExitCode.Recording, 'Could not start the silent sound device (pulseaudio)', 'Check that pulseaudio is installed and works for this user');
    }
    await deps.sleep(100);
  }
}

export function defaultSilentAudioDeps(): SilentAudioDeps {
  return {
    mkdir: async (dir) => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
    },
    spawn: (command, args, env) => {
      const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: 'ignore' });
      let exited = false;
      const done = new Promise<void>((resolve) => {
        child.on('exit', () => {
          exited = true;
          resolve();
        });
        child.on('error', () => {
          exited = true;
          resolve();
        });
      });
      return {
        get exited() {
          return exited;
        },
        kill: async () => {
          if (exited) return;
          child.kill('SIGTERM');
          const timer = setTimeout(() => child.kill('SIGKILL'), 3_000);
          await done;
          clearTimeout(timer);
        },
      };
    },
    exists: pathExists,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
