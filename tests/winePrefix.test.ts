import { describe, expect, it, vi } from 'vitest';
import { APT_HINT, ensureWinePrefix, wineEnv } from '../src/winePrefix.js';
import type { RunFn } from '../src/exec.js';
import { ExitCode } from '../src/errors.js';

const PREFIX = '/home/a/.cache/fc2mp4/wineprefix';
const READY = `${PREFIX}/.fc2mp4-ready-2`;

describe('wineEnv', () => {
  it('uses our own 32-bit prefix and never prompts for Mono/Gecko', () => {
    expect(wineEnv(PREFIX)).toEqual({ WINEARCH: 'win32', WINEPREFIX: PREFIX, WINEDEBUG: '-all', WINEDLLOVERRIDES: 'mscoree,mshtml=' });
  });
});

describe('ensureWinePrefix', () => {
  function fake(fail?: { code: number; stderr?: string }) {
    const calls: string[] = [];
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const files = new Set<string>();
    const run: RunFn = async (cmd, args, opts) => {
      calls.push([cmd, ...args].join(' '));
      envs.push(opts?.env);
      if (fail && args.includes('wineboot')) return { code: fail.code, stdout: '', stderr: fail.stderr ?? '' };
      return { code: 0, stdout: '', stderr: '' };
    };
    const deps = {
      exists: async (p: string) => files.has(p),
      writeMarker: async (p: string) => {
        files.add(p);
      },
      removeDir: async (p: string) => {
        calls.push(`rm ${p}`);
      },
      run,
    };
    return { calls, envs, files, deps };
  }

  it('does nothing when our ready marker exists', async () => {
    const f = fake();
    f.files.add(READY);
    let announced = false;
    await ensureWinePrefix(PREFIX, { ...f.deps, onSetup: () => (announced = true) });
    expect(f.calls).toEqual([]);
    expect(announced).toBe(false);
  });

  it('starts from an empty prefix, sets the null display driver, waits for Wine, then marks it ready', async () => {
    const f = fake();
    let announced = false;
    await ensureWinePrefix(PREFIX, { ...f.deps, onSetup: () => (announced = true) });
    expect(announced).toBe(true);
    expect(f.calls).toEqual([
      `rm ${PREFIX}`,
      'wine wineboot -i',
      'wine reg add HKCU\\Software\\Wine\\Drivers /v Graphics /d null /f',
      'wineserver -w',
    ]);
    expect(f.envs[0]).toMatchObject({ WINEPREFIX: PREFIX, WINEDLLOVERRIDES: 'mscoree,mshtml=' });
    expect(f.files.has(READY)).toBe(true);
  });

  it('recreates a prefix set up by an older fc2mp4 (virtual desktop, old marker)', async () => {
    const f = fake();
    f.files.add(`${PREFIX}/.fc2mp4-ready`);
    await ensureWinePrefix(PREFIX, f.deps);
    expect(f.calls[0]).toBe(`rm ${PREFIX}`);
    expect(f.files.has(READY)).toBe(true);
  });

  it('never needs a display: no xvfb-run anywhere', async () => {
    const f = fake();
    await ensureWinePrefix(PREFIX, f.deps);
    expect(f.calls.some((c) => c.includes('xvfb-run'))).toBe(false);
  });

  it('turns "wine32 is missing" into the apt hint and does not mark the prefix ready', async () => {
    const f = fake({ code: 1, stderr: 'it looks like wine32 is missing, you should install it.' });
    await expect(ensureWinePrefix(PREFIX, f.deps)).rejects.toMatchObject({ exitCode: ExitCode.Preflight, message: expect.stringContaining('32-bit Wine'), hint: APT_HINT });
    expect(f.files.has(READY)).toBe(false);
  });

  it('reports any other failure, stops Wine, and does not mark the prefix ready', async () => {
    const f = fake({ code: 3, stderr: 'boom' });
    await expect(ensureWinePrefix(PREFIX, f.deps)).rejects.toMatchObject({ exitCode: ExitCode.Emulator, message: expect.stringContaining('exit 3') });
    expect(f.calls.at(-1)).toBe('wineserver -k');
    expect(f.files.has(READY)).toBe(false);
  });

  it('stops Wine and reports Interrupted when Ctrl-C arrives during setup', async () => {
    const f = fake();
    const controller = new AbortController();
    const run: RunFn = async (cmd, args, opts) => {
      if (args.includes('wineboot')) controller.abort();
      return f.deps.run(cmd, args, opts);
    };
    await expect(ensureWinePrefix(PREFIX, { ...f.deps, run, signal: controller.signal })).rejects.toMatchObject({ exitCode: ExitCode.Interrupted });
    expect(f.calls.at(-1)).toBe('wineserver -k');
    expect(f.files.has(READY)).toBe(false);
  });

  it('stops at once when Ctrl-C arrives while the old prefix is being deleted', async () => {
    const f = fake();
    const controller = new AbortController();
    const removeDir = async () => {
      controller.abort();
    };
    await expect(ensureWinePrefix(PREFIX, { ...f.deps, removeDir, signal: controller.signal })).rejects.toMatchObject({ exitCode: ExitCode.Interrupted });
    expect(f.calls).not.toContain('wine wineboot -i');
    expect(f.files.has(READY)).toBe(false);
  });

  it('hides any display from Wine, so a desktop or WSLg never gets a window', async () => {
    vi.stubEnv('DISPLAY', ':0');
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    try {
      const f = fake();
      await ensureWinePrefix(PREFIX, f.deps);
      expect(f.envs[0]).not.toHaveProperty('DISPLAY');
      expect(f.envs[0]).not.toHaveProperty('WAYLAND_DISPLAY');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
