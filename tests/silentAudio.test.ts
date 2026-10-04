import { describe, expect, it } from 'vitest';
import { pulseCommand, startSilentAudio, type SilentAudioDeps } from '../src/silentAudio.js';
import { ExitCode } from '../src/errors.js';

const DIR = '/tmp/fc2mp4-x';

function fake(world: { socketAfterMs?: number; exitsAfterMs?: number }) {
  let t = 0;
  const log: string[] = [];
  const deps: SilentAudioDeps = {
    mkdir: async (dir) => {
      log.push(`mkdir:${dir}`);
    },
    spawn: (command, args, env) => {
      log.push(`spawn:${command}:${env.XDG_RUNTIME_DIR}`);
      return {
        get exited() {
          return world.exitsAfterMs !== undefined && t >= world.exitsAfterMs;
        },
        kill: async () => {
          log.push('kill');
        },
      };
    },
    exists: async () => world.socketAfterMs !== undefined && t >= world.socketAfterMs,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return { deps, log, time: () => t };
}

describe('silent sound device (Linux)', () => {
  it('runs a private PulseAudio with only a null sink and a socket in the run folder', () => {
    expect(pulseCommand(DIR)).toEqual({
      command: 'pulseaudio',
      args: [
        '--daemonize=no', '-n', '--exit-idle-time=-1', '--use-pid-file=no', '--disable-shm=yes', '--log-target=stderr',
        '--load=module-null-sink',
        `--load=module-native-protocol-unix socket=${DIR}/pulse/native auth-anonymous=1`,
      ],
      env: { XDG_RUNTIME_DIR: `${DIR}/pulse`, PULSE_RUNTIME_PATH: `${DIR}/pulse` },
      socket: `${DIR}/pulse/native`,
    });
  });

  it('gives Wine the socket once PulseAudio is listening, and stops it afterwards', async () => {
    const { deps, log } = fake({ socketAfterMs: 300 });
    const audio = await startSilentAudio(DIR, deps);
    expect(audio.env).toEqual({ PULSE_SERVER: `unix:${DIR}/pulse/native` });
    expect(log).toEqual([`mkdir:${DIR}/pulse`, `spawn:pulseaudio:${DIR}/pulse`]);
    await audio.stop();
    expect(log.at(-1)).toBe('kill');
  });

  it('fails clearly when PulseAudio exits instead of listening', async () => {
    const { deps, log } = fake({ exitsAfterMs: 200 });
    await expect(startSilentAudio(DIR, deps)).rejects.toMatchObject({ exitCode: ExitCode.Recording, message: expect.stringContaining('silent sound device') });
    expect(log.at(-1)).toBe('kill');
  });

  it('gives up after the timeout and stops PulseAudio', async () => {
    const { deps, log, time } = fake({});
    await expect(startSilentAudio(DIR, deps, 2_000)).rejects.toMatchObject({ exitCode: ExitCode.Recording });
    expect(time()).toBe(2_000);
    expect(log.at(-1)).toBe('kill');
  });
});
