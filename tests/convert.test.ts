import { describe, expect, it } from 'vitest';
import { buildEmulatorLocally, convert, notWritableHint, prepare, updateEmulator, type ConvertDeps, type ConvertOptions } from '../src/convert.js';
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
    checkWritable: async (dir) => {
      calls.push(`writable:${dir}`);
    },
    checkTools: async () => {
      calls.push('tools');
    },
    locateFfmpeg: async (_install, signal) => {
      calls.push(signal ? 'ffmpeg:signal' : 'ffmpeg');
      return '/usr/bin/ffmpeg';
    },
    ensureEmulator: async (_install, opts) => {
      calls.push(`ensure:${opts.force}:${opts.local}`);
      return { updated: false };
    },
    prepareRuntime: async (_install, refreshDlls) => {
      calls.push(`runtime:${refreshDlls}`);
    },
    prepareWine: async (_install, onSetup) => {
      calls.push('wine');
      onSetup();
    },
    makeTempDir: async () => {
      calls.push('tmp');
      return '/tmp/run';
    },
    capture: async (_install, quarkId, _ffmpeg, opts) => {
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
      'lock', 'preflight', 'writable:/out', 'ffmpeg', 'ensure:false:false', 'runtime:false', 'wine', 'tmp', `capture:${ID}:/tmp/run`,
      'mkdir:/out', `mux:/out/${ID}.mp4`, 'rmdir:/tmp/run', 'unlock',
    ]);
  });

  it('fails before capturing when the output folder is not writable', async () => {
    const { deps, calls } = harness({
      checkWritable: async (dir) => {
        throw new ConvertError(ExitCode.Preflight, `Cannot write to ${dir}`);
      },
    });
    await expect(convert(ID, baseOptions, deps)).rejects.toMatchObject({ exitCode: ExitCode.Preflight, message: 'Cannot write to /out' });
    expect(calls).toEqual(['lock', 'preflight', 'unlock']);
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

  it('refreshes the runtime DLLs only after a successful rebuild', async () => {
    const { deps, calls } = harness({ ensureEmulator: async () => ({ updated: true }) });
    await convert(ID, baseOptions, deps);
    expect(calls).toContain('runtime:true');
  });

  it('keeps the real error and releases the lock when the temp dir cannot be removed (Windows EBUSY)', async () => {
    const { deps, calls } = harness({
      capture: async () => {
        throw new ConvertError(ExitCode.Interrupted, 'Interrupted');
      },
      removeDir: async () => {
        calls.push('rmdir-failed');
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      },
    });
    await expect(convert(ID, baseOptions, deps)).rejects.toMatchObject({ exitCode: ExitCode.Interrupted });
    expect(calls.slice(-2)).toEqual(['rmdir-failed', 'unlock']);
  });

  it('announces the preparation step before downloading ffmpeg and passes Ctrl-C to it', async () => {
    const { deps, calls } = harness();
    const controller = new AbortController();
    await convert(ID, { ...baseOptions, signal: controller.signal, onProgress: (e) => calls.push(`progress:${e.phase}`) }, deps);
    expect(calls.indexOf('progress:preparing')).toBeLessThan(calls.indexOf('ffmpeg:signal'));
    expect(calls.indexOf('progress:preparing')).toBeGreaterThan(-1);
  });

  it('reports any failure after Ctrl-C as Interrupted', async () => {
    const controller = new AbortController();
    const { deps } = harness({
      mux: async () => {
        controller.abort();
        throw new ConvertError(ExitCode.Encode, 'ffmpeg failed (exit 255)');
      },
    });
    await expect(convert(ID, { ...baseOptions, signal: controller.signal }, deps)).rejects.toMatchObject({ exitCode: ExitCode.Interrupted });
  });

  it('announces the one-time Wine setup', async () => {
    const { deps, calls } = harness();
    await convert(ID, { ...baseOptions, onProgress: (e) => calls.push(`progress:${e.phase}`) }, deps);
    const at = calls.indexOf('progress:setting-up-wine');
    expect(at).toBeGreaterThan(calls.indexOf('wine'));
    expect(calls.indexOf('wine')).toBeGreaterThan(-1);
    expect(at).toBeLessThan(calls.indexOf('tmp'));
  });

  it('logs the emulator warning and carries on', async () => {
    const logs: string[] = [];
    const { deps } = harness({ ensureEmulator: async () => ({ updated: false, warning: 'using the previous build' }) });
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

describe('emulator commands', () => {
  it('update-emulator forces a release check under the lock', async () => {
    const { deps, calls } = harness({
      ensureEmulator: async (_install, opts) => {
        calls.push(`ensure:${opts.force}:${opts.local}`);
        return { updated: true };
      },
    });
    expect(await updateEmulator({}, deps)).toEqual({ updated: true });
    expect(calls).toEqual(['lock', 'ensure:true:false', 'unlock']);
  });
  it('rebuild-emulator builds locally', async () => {
    const { deps, calls } = harness({
      ensureEmulator: async (_install, opts) => {
        calls.push(`ensure:${opts.force}:${opts.local}`);
        return { updated: true };
      },
    });
    await buildEmulatorLocally({}, deps);
    expect(calls).toEqual(['lock', 'ensure:false:true', 'unlock']);
  });
});

describe('prepare', () => {
  it('prepares tools, ffmpeg, a fresh emulator check and Wine, without Fightcade files', async () => {
    const { deps, calls } = harness({
      locateInstall: async () => {
        throw new ConvertError(ExitCode.Preflight, 'Fightcade files not found');
      },
    });
    const phases: string[] = [];
    await expect(prepare({ onProgress: (e) => phases.push(e.phase) }, deps)).resolves.toEqual({ emulatorUpdated: false, warning: undefined });
    expect(calls).toEqual(['lock', 'tools', 'ffmpeg', 'ensure:true:false', 'wine', 'unlock']);
    expect(phases).toEqual(['preparing', 'setting-up-wine']);
  });

  it('passes on the emulator warning (offline, previous build kept)', async () => {
    const { deps } = harness({ ensureEmulator: async () => ({ updated: false, warning: 'GitHub unreachable; using the current emulator' }) });
    const logs: string[] = [];
    const result = await prepare({ log: (m) => logs.push(m) }, deps);
    expect(result.warning).toBe('GitHub unreachable; using the current emulator');
    expect(logs).toEqual(['Warning: GitHub unreachable; using the current emulator']);
  });

  it('releases the lock and reports Interrupted when stopped during Wine setup', async () => {
    const controller = new AbortController();
    const { deps, calls } = harness({
      prepareWine: async () => {
        controller.abort();
        throw new Error('wineboot killed');
      },
    });
    await expect(prepare({ signal: controller.signal }, deps)).rejects.toMatchObject({ exitCode: ExitCode.Interrupted });
    expect(calls.at(-1)).toBe('unlock');
  });

  it('stops at missing tools with the install hint, before any download', async () => {
    const { deps, calls } = harness({
      checkTools: async () => {
        throw new ConvertError(ExitCode.Preflight, 'Missing on this system: wine', 'sudo apt install wine');
      },
    });
    await expect(prepare({}, deps)).rejects.toMatchObject({ exitCode: ExitCode.Preflight, message: 'Missing on this system: wine' });
    expect(calls).toEqual(['lock', 'unlock']);
  });
});

describe('prepare without a forced update (serve startup)', () => {
  it('uses the daily emulator check', async () => {
    const { deps, calls } = harness();
    await prepare({ forceUpdate: false }, deps);
    expect(calls).toContain('ensure:false:false');
  });
});

describe('notWritableHint', () => {
  it('mentions -o only for the CLI, and Docker only inside Docker', () => {
    expect(notWritableHint(false, false)).toBe('Choose another folder with -o, or make this one writable');
    expect(notWritableHint(false, true)).toBe('Choose another folder with -o, or make this one writable (in Docker: the folder mounted at /videos must be writable by uid 1000)');
    expect(notWritableHint(true, false)).toBe('Make it writable, or set FC2MP4_OUTPUT_DIR to another folder');
    expect(notWritableHint(true, true)).toBe('Make it writable, or set FC2MP4_OUTPUT_DIR to another folder (in Docker: the folder mounted at /videos must be writable by uid 1000)');
  });
});

describe('prepare details', () => {
  it('reports Interrupted when stopped during the emulator download (not a warning)', async () => {
    const controller = new AbortController();
    const { deps, calls } = harness({
      ensureEmulator: async () => {
        controller.abort();
        return { updated: false, warning: 'Could not check for emulator updates (aborted); using the installed build' };
      },
    });
    await expect(prepare({ signal: controller.signal }, deps)).rejects.toMatchObject({ exitCode: ExitCode.Interrupted });
    expect(calls).not.toContain('wine');
    expect(calls.at(-1)).toBe('unlock');
  });

  it('tells what it did with -v', async () => {
    const { deps } = harness();
    const debugs: string[] = [];
    await prepare({ debug: (m) => debugs.push(m) }, deps);
    expect(debugs).toEqual(['ffmpeg: /usr/bin/ffmpeg', 'Emulator: up to date', 'Wine: ready']);
  });
});
