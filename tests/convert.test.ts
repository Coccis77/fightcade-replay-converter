import { describe, expect, it } from 'vitest';
import { convert, rebuildEmulator, type ConvertDeps, type ConvertOptions } from '../src/convert.js';
import { installLayout } from '../src/install.js';
import { ConvertError, ExitCode } from '../src/errors.js';

const install = installLayout('/Apps/FightCade2.app');
const ID = '1700000000000-1234';
const baseOptions: ConvertOptions = { scale: 'sharp', maxDurationMs: 3_600_000 };

function harness(over: Partial<ConvertDeps> = {}) {
  const calls: string[] = [];
  const deps: ConvertDeps = {
    locateInstall: async () => install,
    resolveOutput: async (quarkId) => `/out/${quarkId}.mp4`,
    acquireLock: async () => {
      calls.push('lock');
      return async () => {
        calls.push('unlock');
      };
    },
    preflight: async () => {
      calls.push('preflight');
    },
    ensureEmulator: async (_install, force) => {
      calls.push(`ensure:${force}`);
      return { rebuilt: false };
    },
    prepareRuntime: async () => {
      calls.push('runtime');
    },
    makeTempDir: async () => {
      calls.push('tmp');
      return '/tmp/run';
    },
    capture: async (_install, quarkId, opts) => {
      calls.push(`capture:${quarkId}:${opts.dir}`);
      return { video: '/tmp/run/video.mp4', audio: '/tmp/run/audio.raw', frames: 8220, endReason: 'ended' };
    },
    mkdir: async (dir) => {
      calls.push(`mkdir:${dir}`);
    },
    mux: async ({ output }) => {
      calls.push(`mux:${output}`);
    },
    removeDir: async (dir) => {
      calls.push(`rmdir:${dir}`);
    },
    ...over,
  };
  return { deps, calls };
}

describe('convert', () => {
  it('runs the pipeline in order', async () => {
    const { deps, calls } = harness();
    const result = await convert(`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}`, baseOptions, deps);
    expect(result).toEqual({ output: `/out/${ID}.mp4`, frames: 8220, endReason: 'ended' });
    expect(calls).toEqual([
      'lock', 'preflight', 'ensure:false', 'runtime', 'tmp', `capture:${ID}:/tmp/run`,
      'mkdir:/out', `mux:/out/${ID}.mp4`, 'rmdir:/tmp/run', 'unlock',
    ]);
  });

  it('removes the temp dir and releases the lock when capture fails, without muxing', async () => {
    const { deps, calls } = harness({
      capture: async () => {
        throw new ConvertError(ExitCode.Recording, 'The replay stream never started');
      },
    });
    await expect(convert(ID, baseOptions, deps)).rejects.toMatchObject({ exitCode: ExitCode.Recording });
    expect(calls.slice(-2)).toEqual(['rmdir:/tmp/run', 'unlock']);
    expect(calls.some((c) => c.startsWith('mux'))).toBe(false);
  });

  it('logs the emulator warning and carries on', async () => {
    const logs: string[] = [];
    const { deps } = harness({ ensureEmulator: async () => ({ rebuilt: false, warning: 'using the previous build' }) });
    await convert(ID, { ...baseOptions, log: (m) => logs.push(m) }, deps);
    expect(logs).toContain('Warning: using the previous build');
  });

  it('warns when max-duration cut the capture short', async () => {
    const logs: string[] = [];
    const { deps } = harness({
      capture: async () => ({ video: 'v', audio: 'a', frames: 10, endReason: 'max-duration' }),
    });
    await convert(ID, { ...baseOptions, log: (m) => logs.push(m) }, deps);
    expect(logs.some((m) => m.includes('--max-duration'))).toBe(true);
  });

  it('does nothing else when another conversion holds the lock', async () => {
    const { deps, calls } = harness({
      acquireLock: async () => {
        throw new ConvertError(ExitCode.Busy, 'Another fc2mp4 conversion is running (pid 1)');
      },
    });
    await expect(convert(ID, baseOptions, deps)).rejects.toMatchObject({ exitCode: ExitCode.Busy });
    expect(calls).toEqual([]);
  });

  it('rejects a bad link before touching anything', async () => {
    const { deps, calls } = harness();
    await expect(convert('hello', baseOptions, deps)).rejects.toMatchObject({ exitCode: ExitCode.Usage });
    expect(calls).toEqual([]);
  });
});

describe('rebuildEmulator', () => {
  it('forces a rebuild under the lock', async () => {
    const { deps, calls } = harness({
      ensureEmulator: async (_install, force) => {
        calls.push(`ensure:${force}`);
        return { rebuilt: true };
      },
    });
    expect(await rebuildEmulator({}, deps)).toEqual({ rebuilt: true });
    expect(calls).toEqual(['lock', 'ensure:true', 'unlock']);
  });
});
