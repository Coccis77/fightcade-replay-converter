import { join } from 'node:path';
import { ConvertError, ExitCode } from './errors.js';
import type { RunFn } from './exec.js';
import { APT_HINT } from './install.js';

export { APT_HINT } from './install.js';

// Our own 32-bit prefix: the user's WINEPREFIX (if any) is never used or modified. Mono/Gecko are
// disabled so Wine never opens their installer dialogs, which nobody could click without a display.
export function wineEnv(prefix: string): Record<string, string> {
  return { WINEARCH: 'win32', WINEPREFIX: prefix, WINEDEBUG: '-all', WINEDLLOVERRIDES: 'mscoree,mshtml=' };
}

// Bumped when the prefix setup changes: an older prefix (v0.4–v0.5.1: virtual desktop on Xvfb) is
// deleted and set up again.
const READY_MARKER = '.fc2mp4-ready-2';

// Wine must never see a display (a desktop session, WSLg): with the null driver set in our prefix,
// every Linux run then behaves exactly like a headless server.
export function withoutDisplay(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, ...rest } = env;
  return rest;
}

// Wine's null display driver, set once in our prefix: the emulator (which shows no window while
// recording) runs with plain `wine`, without any display, and its exit code reaches us.
const SETUP_STEPS: string[][] = [
  ['wineboot', '-i'],
  ['reg', 'add', 'HKCU\\Software\\Wine\\Drivers', '/v', 'Graphics', '/d', 'null', '/f'],
];

export async function ensureWinePrefix(
  prefix: string,
  deps: {
    exists(p: string): Promise<boolean>;
    writeMarker(p: string): Promise<void>;
    removeDir(p: string): Promise<void>;
    run: RunFn;
    onSetup?: () => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const marker = join(prefix, READY_MARKER);
  if (await deps.exists(marker)) return;
  deps.onSetup?.();
  const interrupted = () => new ConvertError(ExitCode.Interrupted, 'Interrupted');

  const env = withoutDisplay({ ...process.env, ...wineEnv(prefix) });
  const stopWine = () => deps.run('wineserver', ['-k'], { env, timeoutMs: 15_000 }).catch(() => undefined);
  const fail = async (error: ConvertError): Promise<never> => {
    await stopWine();
    throw error;
  };

  // Our own cache: start clean (also replaces an older fc2mp4's prefix). Wine left running by an earlier
  // crashed run is stopped first, or it would keep using the deleted folder.
  await stopWine();
  try {
    await deps.removeDir(prefix);
  } catch (err) {
    throw new ConvertError(ExitCode.Emulator, `Could not reset the Wine environment: ${err instanceof Error ? err.message : String(err)}`, `Delete ${prefix} and try again`);
  }

  for (const step of SETUP_STEPS) {
    // A signal that is already aborted never fires 'abort': check before starting each step.
    if (deps.signal?.aborted) await fail(interrupted());
    const result = await deps.run('wine', step, { env, timeoutMs: 5 * 60_000, signal: deps.signal, detached: true });
    if (deps.signal?.aborted) await fail(interrupted());
    const output = `${result.stdout}\n${result.stderr}`;
    if (/wine32 is missing|ELFCLASS32|wrong ELF class/i.test(output)) {
      await fail(new ConvertError(ExitCode.Preflight, '32-bit Wine is missing (needed by the Fightcade emulator)', APT_HINT));
    }
    if (result.code !== 0) {
      const tail = output.trim().split('\n').slice(-3).join(' ');
      await fail(new ConvertError(ExitCode.Emulator, `Could not set up Wine (${step[0]}, exit ${result.code}): ${tail}`, 'Run with -v and check your Wine installation'));
    }
  }
  // Wine saves its registry lazily: wait until the wineserver has written everything.
  await deps.run('wineserver', ['-w'], { env, timeoutMs: 60_000 });
  await deps.writeMarker(marker);
}
