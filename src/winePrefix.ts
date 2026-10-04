import { join } from 'node:path';
import { ConvertError, ExitCode } from './errors.js';
import type { RunFn } from './exec.js';
import { APT_HINT } from './install.js';

export { APT_HINT } from './install.js';

// Our own 32-bit prefix: the user's WINEPREFIX (if any) is never used or modified. Mono/Gecko are
// disabled so Wine never opens their installer dialogs, which nobody can click on a virtual display.
export function wineEnv(prefix: string): Record<string, string> {
  return { WINEARCH: 'win32', WINEPREFIX: prefix, WINEDEBUG: '-all', WINEDLLOVERRIDES: 'mscoree,mshtml=' };
}

const READY_MARKER = '.fc2mp4-ready';

// Wine's virtual desktop, set once in our prefix: the emulator then runs directly under `wine`, so its
// exit code reaches us (`wine explorer /desktop=…` would report explorer's instead).
const SETUP_STEPS: string[][] = [
  ['wine', 'wineboot', '-i'],
  ['wine', 'reg', 'add', 'HKCU\\Software\\Wine\\Explorer', '/v', 'Desktop', '/d', 'Default', '/f'],
  ['wine', 'reg', 'add', 'HKCU\\Software\\Wine\\Explorer\\Desktops', '/v', 'Default', '/d', '1024x768', '/f'],
];

export async function ensureWinePrefix(
  prefix: string,
  deps: {
    exists(p: string): Promise<boolean>;
    writeMarker(p: string): Promise<void>;
    run: RunFn;
    onSetup?: () => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const marker = join(prefix, READY_MARKER);
  if (await deps.exists(marker)) return;
  deps.onSetup?.();

  const env = { ...process.env, ...wineEnv(prefix) };
  const stopWine = () => deps.run('wineserver', ['-k'], { env, timeoutMs: 15_000 }).catch(() => undefined);
  const fail = async (error: ConvertError): Promise<never> => {
    await stopWine();
    throw error;
  };

  for (const step of SETUP_STEPS) {
    const result = await deps.run('xvfb-run', ['-a', ...step], { env, timeoutMs: 5 * 60_000, signal: deps.signal, detached: true });
    if (deps.signal?.aborted) await fail(new ConvertError(ExitCode.Interrupted, 'Interrupted'));
    const output = `${result.stdout}\n${result.stderr}`;
    if (/wine32 is missing|ELFCLASS32|wrong ELF class/i.test(output)) {
      await fail(new ConvertError(ExitCode.Preflight, '32-bit Wine is missing (needed by the Fightcade emulator)', APT_HINT));
    }
    if (result.code !== 0) {
      const tail = output.trim().split('\n').slice(-3).join(' ');
      await fail(new ConvertError(ExitCode.Emulator, `Could not set up Wine (${step[1]}, exit ${result.code}): ${tail}`, 'Run with -v and check your Wine installation'));
    }
  }
  // Wine saves its registry lazily: wait until the wineserver has written everything.
  await deps.run('wineserver', ['-w'], { env, timeoutMs: 60_000 });
  await deps.writeMarker(marker);
}
