import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensureEmulator,
  needsRebuild,
  patchSetHash,
  type BuildManifest,
  type EnsureDeps,
  type Fingerprint,
} from '../src/emulatorBuild.js';
import { ConvertError, ExitCode } from '../src/errors.js';

const current: Fingerprint = { fightcadeExeSha256: 'exe1', ggponetSha256: 'dll1', patchSetHash: 'p1' };
const manifest: BuildManifest = { ...current, sourceCommit: 'abc', builtAt: '2026-10-01T00:00:00.000Z' };

describe('needsRebuild', () => {
  it('is false when nothing changed', () => {
    expect(needsRebuild(manifest, current, true)).toBe(false);
  });
  it.each([
    ['no manifest', null, current, true],
    ['exe missing', manifest, current, false],
    ['Fightcade emulator updated', manifest, { ...current, fightcadeExeSha256: 'exe2' }, true],
    ['ggponet updated', manifest, { ...current, ggponetSha256: 'dll2' }, true],
    ['patch set changed', manifest, { ...current, patchSetHash: 'p2' }, true],
  ] as const)('is true when %s', (_name, m, fp, exists) => {
    expect(needsRebuild(m, fp, exists)).toBe(true);
  });
});

function fakeDeps(opts: { manifest?: BuildManifest | null; exeExists?: boolean; build?: () => Promise<{ sourceCommit: string }>; toolchain?: () => Promise<void> }) {
  const calls: string[] = [];
  let written: BuildManifest | null = null;
  const deps: EnsureDeps = {
    fingerprint: async () => current,
    readManifest: async () => (opts.manifest === undefined ? manifest : opts.manifest),
    writeManifest: async (m) => {
      written = m;
    },
    exeExists: async () => opts.exeExists ?? true,
    checkToolchain: opts.toolchain ?? (async () => {}),
    runBuild: async () => {
      calls.push('build');
      return (opts.build ?? (async () => ({ sourceCommit: 'def' })))();
    },
    now: () => new Date('2026-10-03T12:00:00.000Z'),
  };
  return { deps, calls, written: () => written };
}

describe('ensureEmulator', () => {
  it('does nothing when the build is current', async () => {
    const { deps, calls } = fakeDeps({});
    expect(await ensureEmulator(false, deps)).toEqual({ rebuilt: false });
    expect(calls).toEqual([]);
  });

  it('rebuilds and records the new fingerprint when Fightcade changed', async () => {
    const { deps, calls, written } = fakeDeps({ manifest: { ...manifest, fightcadeExeSha256: 'old' } });
    expect(await ensureEmulator(false, deps)).toEqual({ rebuilt: true });
    expect(calls).toEqual(['build']);
    expect(written()).toEqual({ ...current, sourceCommit: 'def', builtAt: '2026-10-03T12:00:00.000Z' });
  });

  it('rebuilds when forced', async () => {
    const { deps, calls } = fakeDeps({});
    expect((await ensureEmulator(true, deps)).rebuilt).toBe(true);
    expect(calls).toEqual(['build']);
  });

  it('keeps the previous build with a warning when the rebuild fails', async () => {
    const { deps, written } = fakeDeps({
      manifest: { ...manifest, patchSetHash: 'old' },
      build: async () => {
        throw new ConvertError(ExitCode.Emulator, 'patch exit-when-stream-idle: anchor not found in src/burner/win32/run.cpp');
      },
    });
    const result = await ensureEmulator(false, deps);
    expect(result.rebuilt).toBe(false);
    expect(result.warning).toContain('exit-when-stream-idle');
    expect(result.warning).toContain('2026-10-01');
    expect(written()).toBeNull();
  });

  it('fails when the first build fails', async () => {
    const { deps } = fakeDeps({
      manifest: null,
      exeExists: false,
      build: async () => {
        throw new ConvertError(ExitCode.Emulator, 'BUILD FAILED');
      },
    });
    await expect(ensureEmulator(false, deps)).rejects.toMatchObject({ exitCode: ExitCode.Emulator });
  });

  it('reports a missing toolchain when there is no previous build', async () => {
    const { deps } = fakeDeps({
      manifest: null,
      exeExists: false,
      toolchain: async () => {
        throw new ConvertError(ExitCode.Preflight, 'Missing tools to build the emulator: i686-w64-mingw32-g++');
      },
    });
    await expect(ensureEmulator(false, deps)).rejects.toMatchObject({ exitCode: ExitCode.Preflight });
  });
});

describe('patchSetHash', () => {
  it('changes with patch files but ignores tests and caches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-patchset-'));
    await mkdir(join(dir, 'src'));
    await mkdir(join(dir, '__pycache__'));
    await writeFile(join(dir, 'patches.py'), 'A');
    await writeFile(join(dir, 'src', 'fc2mp4_dump.cpp'), 'B');
    const first = await patchSetHash(dir);

    await writeFile(join(dir, 'test_patcher.py'), 'tests');
    await writeFile(join(dir, '__pycache__', 'x.pyc'), 'cache');
    expect(await patchSetHash(dir)).toBe(first);

    await writeFile(join(dir, 'src', 'fc2mp4_dump.cpp'), 'C');
    expect(await patchSetHash(dir)).not.toBe(first);
  });
});
