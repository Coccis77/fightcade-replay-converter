import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMULATOR_EXE } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import { run, which, type RunFn } from './exec.js';
import { pathExists, sha256File } from './fsUtil.js';
import type { FightcadeInstall } from './install.js';

export interface Fingerprint {
  fightcadeExeSha256: string;
  ggponetSha256: string;
  patchSetHash: string;
}

export interface BuildManifest extends Fingerprint {
  sourceCommit: string;
  builtAt: string;
}

export function needsRebuild(manifest: BuildManifest | null, current: Fingerprint, exeExists: boolean): boolean {
  if (!manifest || !exeExists) return true;
  return (
    manifest.fightcadeExeSha256 !== current.fightcadeExeSha256 ||
    manifest.ggponetSha256 !== current.ggponetSha256 ||
    manifest.patchSetHash !== current.patchSetHash
  );
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '__pycache__' || entry.name.startsWith('test_')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}

export async function patchSetHash(emulatorDir: string): Promise<string> {
  const hash = createHash('sha256');
  const files = (await listFiles(emulatorDir)).map((f) => relative(emulatorDir, f)).sort();
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(join(emulatorDir, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export interface EnsureDeps {
  fingerprint(): Promise<Fingerprint>;
  readManifest(): Promise<BuildManifest | null>;
  writeManifest(m: BuildManifest): Promise<void>;
  exeExists(): Promise<boolean>;
  checkToolchain(): Promise<void>;
  runBuild(): Promise<{ sourceCommit: string }>;
  now(): Date;
}

export interface EnsureResult {
  rebuilt: boolean;
  warning?: string;
}

export async function ensureEmulator(force: boolean, deps: EnsureDeps): Promise<EnsureResult> {
  const current = await deps.fingerprint();
  const manifest = await deps.readManifest();
  const exeExists = await deps.exeExists();
  if (!force && !needsRebuild(manifest, current, exeExists)) return { rebuilt: false };

  try {
    await deps.checkToolchain();
    const { sourceCommit } = await deps.runBuild();
    await deps.writeManifest({ ...current, sourceCommit, builtAt: deps.now().toISOString() });
    return { rebuilt: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (manifest && exeExists) {
      return { rebuilt: false, warning: `Could not rebuild the emulator (${message}); using the previous build from ${manifest.builtAt}` };
    }
    throw err instanceof ConvertError ? err : new ConvertError(ExitCode.Emulator, `Could not build the emulator: ${message}`);
  }
}

export interface EmulatorPaths {
  emulatorDir: string;
  sourceDir: string;
  runtimeDir: string;
}

export function defaultEmulatorPaths(home: string): EmulatorPaths {
  const cache = join(home, 'Library', 'Caches', 'fc2mp4');
  return {
    emulatorDir: fileURLToPath(new URL('../emulator', import.meta.url)),
    sourceDir: join(cache, 'fightcade-fbneo'),
    runtimeDir: join(cache, 'runtime'),
  };
}

const TOOLCHAIN = ['git', 'perl', 'python3', 'i686-w64-mingw32-g++'];

export function defaultEnsureDeps(install: FightcadeInstall, paths: EmulatorPaths, runFn: RunFn = run): EnsureDeps {
  const manifestPath = join(paths.runtimeDir, 'manifest.json');
  return {
    fingerprint: async () => ({
      fightcadeExeSha256: await sha256File(install.exe),
      ggponetSha256: await sha256File(install.ggponet),
      patchSetHash: await patchSetHash(paths.emulatorDir),
    }),
    readManifest: async () => {
      try {
        return JSON.parse(await readFile(manifestPath, 'utf8')) as BuildManifest;
      } catch {
        return null;
      }
    },
    writeManifest: (m) => writeFile(manifestPath, `${JSON.stringify(m, null, 2)}\n`),
    exeExists: () => pathExists(join(paths.runtimeDir, EMULATOR_EXE)),
    checkToolchain: async () => {
      const missing: string[] = [];
      for (const tool of TOOLCHAIN) if ((await which(tool)) === null) missing.push(tool);
      if (missing.length > 0) {
        throw new ConvertError(ExitCode.Preflight, `Missing tools to build the emulator: ${missing.join(', ')}`, 'brew install mingw-w64 git');
      }
    },
    runBuild: async () => {
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
    },
    now: () => new Date(),
  };
}
