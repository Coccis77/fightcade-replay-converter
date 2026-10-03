import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConvertError, ExitCode } from './errors.js';
import { run, which, type RunFn } from './exec.js';
import type { FightcadeInstall } from './install.js';

declare const __FC2MP4_BUNDLED__: boolean | undefined;

// The emulator/ folder ships with the source checkout, not with the single executable.
export function emulatorDir(): string | null {
  if (typeof __FC2MP4_BUNDLED__ === 'boolean' && __FC2MP4_BUNDLED__) return null;
  return fileURLToPath(new URL('../emulator', import.meta.url));
}

const TOOLCHAIN = ['git', 'perl', 'python3', 'i686-w64-mingw32-g++'];

export async function localBuild(
  install: FightcadeInstall,
  paths: { emulatorDir: string; sourceDir: string; runtimeDir: string },
  runFn: RunFn = run,
): Promise<{ sourceCommit: string }> {
  const missing: string[] = [];
  for (const tool of TOOLCHAIN) if ((await which(tool)) === null) missing.push(tool);
  if (missing.length > 0) {
    throw new ConvertError(ExitCode.Preflight, `Missing tools to build the emulator: ${missing.join(', ')}`, 'brew install mingw-w64 git');
  }
  const result = await runFn(
    'python3',
    [join(paths.emulatorDir, 'build.py'), '--source-dir', paths.sourceDir, '--out-dir', paths.runtimeDir, '--ggponet', install.ggponet],
    { timeoutMs: 30 * 60_000 },
  );
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').slice(-3).join(' ');
    throw new ConvertError(ExitCode.Emulator, `Emulator build failed (exit ${result.code}): ${detail}`, `Build log: ${join(paths.runtimeDir, 'build.log')}`);
  }
  const lastLine = result.stdout.trim().split('\n').at(-1) ?? '{}';
  return { sourceCommit: (JSON.parse(lastLine) as { sourceCommit: string }).sourceCommit };
}
