import { describe, expect, it } from 'vitest';
import { APT_HINT, ensureWinePrefix, wineEnv } from '../src/winePrefix.js';
import type { RunFn } from '../src/exec.js';
import { ExitCode } from '../src/errors.js';

const PREFIX = '/home/a/.cache/fc2mp4/wineprefix';

describe('wineEnv', () => {
  it('always uses our own 32-bit prefix, whatever the user has set', () => {
    expect(wineEnv(PREFIX)).toEqual({ WINEARCH: 'win32', WINEPREFIX: PREFIX, WINEDEBUG: '-all' });
  });
});

describe('ensureWinePrefix', () => {
  function fake(result: { code: number; stdout?: string; stderr?: string }, createdAfterRun = true) {
    const calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    let created = false;
    const run: RunFn = async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts?.env });
      created = createdAfterRun;
      return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    const exists = async () => created;
    return { calls, run, exists, setExisting: () => (created = true) };
  }

  it('does nothing when the prefix exists', async () => {
    const f = fake({ code: 0 });
    f.setExisting();
    let announced = false;
    await ensureWinePrefix(PREFIX, { exists: f.exists, run: f.run, onSetup: () => (announced = true) });
    expect(f.calls).toEqual([]);
    expect(announced).toBe(false);
  });

  it('creates it headless on first run with our environment', async () => {
    const f = fake({ code: 0 });
    let announced = false;
    await ensureWinePrefix(PREFIX, { exists: f.exists, run: f.run, onSetup: () => (announced = true) });
    expect(announced).toBe(true);
    expect(f.calls[0]).toMatchObject({ cmd: 'xvfb-run', args: ['-a', 'wineboot', '-i'] });
    expect(f.calls[0]!.env).toMatchObject({ WINEARCH: 'win32', WINEPREFIX: PREFIX });
  });

  it('turns "wine32 is missing" into the apt hint', async () => {
    const f = fake({ code: 1, stderr: 'it looks like wine32 is missing, you should install it.' }, false);
    await expect(ensureWinePrefix(PREFIX, { exists: f.exists, run: f.run })).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: expect.stringContaining('32-bit Wine'),
      hint: APT_HINT,
    });
  });

  it('reports any other failure', async () => {
    const f = fake({ code: 3, stderr: 'boom' }, false);
    await expect(ensureWinePrefix(PREFIX, { exists: f.exists, run: f.run })).rejects.toMatchObject({ exitCode: ExitCode.Emulator, message: expect.stringContaining('exit 3') });
  });
});
