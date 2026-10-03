import { describe, expect, it } from 'vitest';
import { ensureEmulator, pickRelease, type EmulatorManifest, type Release, type ReleaseDeps } from '../src/emulatorRelease.js';
import { ExitCode } from '../src/errors.js';

const HASH = 'abcdef123456' + '0'.repeat(52);
const NOW = new Date('2026-10-04T12:00:00.000Z');
const exeAsset = (tag: string) => ({ name: 'fcadefbneo-fc2mp4.exe', url: `https://x/${tag}/exe`, size: 1000 });
const rel = (tag: string, publishedAt: string): Release => ({ tag, publishedAt, assets: [exeAsset(tag)] });

describe('pickRelease', () => {
  it('picks the newest release built for our patch set', () => {
    const releases = [
      rel('emulator-aaaaaaaaaaaa-abcdef123456', '2026-10-01T00:00:00Z'),
      rel('emulator-bbbbbbbbbbbb-abcdef123456', '2026-10-03T00:00:00Z'),
      rel('emulator-cccccccccccc-999999999999', '2026-10-04T00:00:00Z'),
      rel('v0.3.0', '2026-10-04T00:00:00Z'),
    ];
    expect(pickRelease(releases, HASH)?.tag).toBe('emulator-bbbbbbbbbbbb-abcdef123456');
  });
  it('ignores releases without the exe and returns null when nothing matches', () => {
    expect(pickRelease([{ tag: 'emulator-aaaaaaaaaaaa-abcdef123456', publishedAt: '2026-10-01T00:00:00Z', assets: [] }], HASH)).toBeNull();
    expect(pickRelease([], HASH)).toBeNull();
  });
});

function harness(world: {
  manifest?: EmulatorManifest | null;
  exeExists?: boolean;
  releases?: Release[] | Error;
  downloadFails?: boolean;
  badFile?: boolean;
  local?: boolean;
}) {
  const calls: string[] = [];
  let written: EmulatorManifest | null = null;
  const deps: ReleaseDeps = {
    listReleases: async () => {
      calls.push('list');
      if (world.releases instanceof Error) throw world.releases;
      return world.releases ?? [rel('emulator-bbbbbbbbbbbb-abcdef123456', '2026-10-03T00:00:00Z')];
    },
    download: async (url, dest) => {
      calls.push(`download:${url}->${dest}`);
      if (world.downloadFails) throw new Error('connection reset');
    },
    readManifest: async () => (world.manifest === undefined ? null : world.manifest),
    writeManifest: async (m) => {
      written = m;
    },
    exeExists: async () => world.exeExists ?? false,
    tempDownloadPath: () => 'download',
    verifyDownload: async () => {
      if (world.badFile) throw new Error('downloaded file is incomplete or not a Windows executable');
    },
    installExe: async (tmp) => {
      calls.push(`install:${tmp}`);
    },
    removeFile: async (p) => {
      calls.push(`rm:${p}`);
    },
    localBuild: world.local
      ? async () => {
          calls.push('local-build');
          return { sourceCommit: 'c'.repeat(40) };
        }
      : null,
    now: () => NOW,
  };
  return { deps, calls, written: () => written };
}

const installed = (over: Partial<EmulatorManifest> = {}): EmulatorManifest => ({
  source: 'release',
  tag: 'emulator-aaaaaaaaaaaa-abcdef123456',
  sourceCommit: 'aaaaaaaaaaaa',
  patchSetHash: HASH,
  installedAt: '2026-10-01T00:00:00.000Z',
  checkedAt: '2026-10-04T06:00:00.000Z',
  ...over,
});

describe('ensureEmulator', () => {
  const opts = { patchSetHash: HASH, force: false, local: false };

  it('downloads the matching release on first run', async () => {
    const { deps, calls, written } = harness({});
    expect(await ensureEmulator(opts, deps)).toEqual({ updated: true });
    expect(calls).toEqual(['list', 'download:https://x/emulator-bbbbbbbbbbbb-abcdef123456/exe->download', 'install:download']);
    expect(written()).toMatchObject({ source: 'release', tag: 'emulator-bbbbbbbbbbbb-abcdef123456', sourceCommit: 'bbbbbbbbbbbb', patchSetHash: HASH });
  });

  it('does not contact GitHub again within 24 hours', async () => {
    const { deps, calls } = harness({ manifest: installed(), exeExists: true });
    expect(await ensureEmulator(opts, deps)).toEqual({ updated: false });
    expect(calls).toEqual([]);
  });

  it('updates to a newer release after 24 hours', async () => {
    const { deps, calls } = harness({ manifest: installed({ checkedAt: '2026-10-03T06:00:00.000Z' }), exeExists: true });
    expect((await ensureEmulator(opts, deps)).updated).toBe(true);
    expect(calls).toContain('install:download');
  });

  it('only refreshes the check time when already on the newest release', async () => {
    const { deps, calls, written } = harness({ manifest: installed({ tag: 'emulator-bbbbbbbbbbbb-abcdef123456', checkedAt: '2026-10-01T00:00:00.000Z' }), exeExists: true });
    expect(await ensureEmulator(opts, deps)).toEqual({ updated: false });
    expect(calls).toEqual(['list']);
    expect(written()?.checkedAt).toBe(NOW.toISOString());
  });

  it('keeps the installed build when GitHub is unreachable', async () => {
    const { deps } = harness({ manifest: installed({ checkedAt: '2026-10-01T00:00:00.000Z' }), exeExists: true, releases: new Error('getaddrinfo ENOTFOUND api.github.com') });
    const result = await ensureEmulator(opts, deps);
    expect(result.updated).toBe(false);
    expect(result.warning).toContain('ENOTFOUND');
  });

  it('fails clearly when GitHub is unreachable and nothing is installed', async () => {
    const { deps } = harness({ releases: new Error('getaddrinfo ENOTFOUND api.github.com') });
    await expect(ensureEmulator(opts, deps)).rejects.toMatchObject({ exitCode: ExitCode.Emulator });
  });

  it('a truncated download never replaces the installed exe', async () => {
    const { deps, calls } = harness({ manifest: installed({ checkedAt: '2026-10-01T00:00:00.000Z' }), exeExists: true, badFile: true });
    const result = await ensureEmulator(opts, deps);
    expect(result.updated).toBe(false);
    expect(result.warning).toContain('incomplete');
    expect(calls).not.toContain('install:download');
    expect(calls).toContain('rm:download');
  });

  it('builds locally on macOS when no release matches our patch set', async () => {
    const { deps, calls, written } = harness({ releases: [], local: true });
    const result = await ensureEmulator(opts, deps);
    expect(result.updated).toBe(true);
    expect(calls).toContain('local-build');
    expect(written()).toMatchObject({ source: 'local', tag: null, patchSetHash: HASH });
  });

  it('keeps a working installed build when its release is no longer listed', async () => {
    const { deps, written } = harness({ manifest: installed({ checkedAt: '2026-10-01T00:00:00.000Z' }), exeExists: true, releases: [] });
    expect((await ensureEmulator(opts, deps)).updated).toBe(false);
    expect(written()?.checkedAt).toBe(NOW.toISOString());
  });

  it('explains on Windows that no build is published yet', async () => {
    const { deps } = harness({ releases: [] });
    await expect(ensureEmulator(opts, deps)).rejects.toMatchObject({ exitCode: ExitCode.Emulator, message: expect.stringContaining('No emulator build') });
  });

  it('never runs an exe built for another patch set', async () => {
    const { deps } = harness({ manifest: installed({ patchSetHash: 'f'.repeat(64) }), exeExists: true, releases: new Error('offline') });
    await expect(ensureEmulator(opts, deps)).rejects.toMatchObject({ exitCode: ExitCode.Emulator });
  });

  it('force skips the 24-hour cache; local forces a local build', async () => {
    const forced = harness({ manifest: installed(), exeExists: true });
    await ensureEmulator({ ...opts, force: true }, forced.deps);
    expect(forced.calls).toContain('list');
    const local = harness({ manifest: installed(), exeExists: true, local: true });
    await ensureEmulator({ ...opts, local: true }, local.deps);
    expect(local.calls).toEqual(['local-build']);
    const noToolchain = harness({});
    await expect(ensureEmulator({ ...opts, local: true }, noToolchain.deps)).rejects.toMatchObject({ exitCode: ExitCode.Usage });
  });
});
