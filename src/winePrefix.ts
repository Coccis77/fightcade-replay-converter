import { join } from 'node:path';
import { ConvertError, ExitCode } from './errors.js';
import type { RunFn } from './exec.js';
import { APT_HINT } from './install.js';

export { APT_HINT } from './install.js';

// Our own 32-bit prefix: the user's WINEPREFIX (if any) is never used or modified.
export function wineEnv(prefix: string): Record<string, string> {
  return { WINEARCH: 'win32', WINEPREFIX: prefix, WINEDEBUG: '-all' };
}

export async function ensureWinePrefix(
  prefix: string,
  deps: { exists(p: string): Promise<boolean>; run: RunFn; onSetup?: () => void },
): Promise<void> {
  const marker = join(prefix, 'system.reg');
  if (await deps.exists(marker)) return;
  deps.onSetup?.();
  const result = await deps.run('xvfb-run', ['-a', 'wineboot', '-i'], { env: { ...process.env, ...wineEnv(prefix) }, timeoutMs: 5 * 60_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  if (/wine32 is missing|ELFCLASS32|wrong ELF class/i.test(output)) {
    throw new ConvertError(ExitCode.Preflight, '32-bit Wine is missing (needed by the Fightcade emulator)', APT_HINT);
  }
  if (result.code !== 0 || !(await deps.exists(marker))) {
    const tail = output.trim().split('\n').slice(-3).join(' ');
    throw new ConvertError(ExitCode.Emulator, `Could not set up Wine (exit ${result.code}): ${tail}`, 'Run with -v and check your Wine installation');
  }
}
