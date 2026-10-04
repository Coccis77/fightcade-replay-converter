import { describe, expect, it } from 'vitest';
import { APT_HINT, ensureWinePrefix, wineEnv } from '../src/winePrefix.js';
import type { RunFn } from '../src/exec.js';
import { ExitCode } from '../src/errors.js';

const PREFIX = '/home/a/.cache/fc2mp4/wineprefix';
const READY = `${PREFIX}/.fc2mp4-ready`;

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

  it('creates the prefix headless, sets the virtual desktop, waits for Wine, then marks it ready', async () => {
    const f = fake();
    let announced = false;
    await ensureWinePrefix(PREFIX, { ...f.deps, onSetup: () => (announced = true) });
    expect(announced).toBe(true);
    expect(f.calls).toEqual([
      'xvfb-run -a wine wineboot -i',
      'xvfb-run -a wine reg add HKCU\\Software\\Wine\\Explorer /v Desktop /d Default /f',
      'xvfb-run -a wine reg add HKCU\\Software\\Wine\\Explorer\\Desktops /v Default /d 1024x768 /f',
      'wineserver -w',
    ]);
    expect(f.envs[0]).toMatchObject({ WINEPREFIX: PREFIX, WINEDLLOVERRIDES: 'mscoree,mshtml=' });
    expect(f.files.has(READY)).toBe(true);
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
});
