import { createWriteStream } from 'node:fs';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EMULATOR_EXE } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import { pathExists } from './fsUtil.js';

export const REPO = 'Coccis77/fightcade-replay-converter';
const DAY_MS = 24 * 60 * 60_000;

export interface Release {
  tag: string;
  publishedAt: string;
  assets: { name: string; url: string; size: number }[];
}

export interface EmulatorManifest {
  source: 'release' | 'local';
  tag: string | null;
  sourceCommit: string;
  patchSetHash: string;
  installedAt: string;
  checkedAt: string;
}

export interface ReleaseDeps {
  listReleases(): Promise<Release[]>;
  download(url: string, dest: string): Promise<void>;
  readManifest(): Promise<EmulatorManifest | null>;
  writeManifest(m: EmulatorManifest): Promise<void>;
  exeExists(): Promise<boolean>;
  tempDownloadPath(): string;
  verifyDownload(tmp: string, expectedSize: number): Promise<void>;
  installExe(tmp: string): Promise<void>;
  removeFile(p: string): Promise<void>;
  localBuild: (() => Promise<{ sourceCommit: string }>) | null;
  now(): Date;
}

export interface EnsureResult {
  updated: boolean;
  warning?: string;
}

export function pickRelease(releases: Release[], patchSetHash: string): Release | null {
  const suffix = `-${patchSetHash.slice(0, 12)}`;
  const matching = releases.filter(
    (r) => r.tag.startsWith('emulator-') && r.tag.endsWith(suffix) && r.assets.some((a) => a.name === EMULATOR_EXE),
  );
  matching.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return matching[0] ?? null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function ensureEmulator(opts: { patchSetHash: string; force: boolean; local: boolean }, deps: ReleaseDeps): Promise<EnsureResult> {
  const manifest = await deps.readManifest();
  const exe = await deps.exeExists();
  const usable = exe && manifest !== null && manifest.patchSetHash === opts.patchSetHash;
  const now = deps.now();

  const buildLocally = async (): Promise<EnsureResult> => {
    if (!deps.localBuild) {
      throw new ConvertError(ExitCode.Usage, 'Local emulator builds are only available when running fc2mp4 from source on macOS');
    }
    const { sourceCommit } = await deps.localBuild();
    await deps.writeManifest({ source: 'local', tag: null, sourceCommit, patchSetHash: opts.patchSetHash, installedAt: now.toISOString(), checkedAt: now.toISOString() });
    return { updated: true };
  };

  if (opts.local) return buildLocally();
  if (usable && !opts.force && now.getTime() - Date.parse(manifest.checkedAt) < DAY_MS) return { updated: false };

  let releases: Release[];
  try {
    releases = await deps.listReleases();
  } catch (err) {
    if (usable) return { updated: false, warning: `Could not check for emulator updates (${message(err)}); using the installed build` };
    throw new ConvertError(ExitCode.Emulator, `Could not download the emulator: ${message(err)}`, 'Check your internet connection and retry');
  }

  const release = pickRelease(releases, opts.patchSetHash);
  if (!release) {
    // Keep a working build even if its release is gone or no longer on the first page.
    if (usable) {
      await deps.writeManifest({ ...manifest, checkedAt: now.toISOString() });
      return { updated: false };
    }
    if (deps.localBuild) {
      const result = await buildLocally();
      return { ...result, warning: 'No published emulator build for this fc2mp4 version; built it locally' };
    }
    throw new ConvertError(ExitCode.Emulator, 'No emulator build is published for this fc2mp4 version yet', 'Wait for the GitHub Actions emulator build to finish, then retry');
  }

  if (usable && manifest.tag === release.tag) {
    await deps.writeManifest({ ...manifest, checkedAt: now.toISOString() });
    return { updated: false };
  }

  const asset = release.assets.find((a) => a.name === EMULATOR_EXE)!;
  const tmp = deps.tempDownloadPath();
  try {
    await deps.download(asset.url, tmp);
    await deps.verifyDownload(tmp, asset.size);
    await deps.installExe(tmp);
  } catch (err) {
    await deps.removeFile(tmp);
    if (usable) return { updated: false, warning: `Could not download the emulator update (${message(err)}); using the installed build` };
    throw new ConvertError(ExitCode.Emulator, `Could not download the emulator: ${message(err)}`, 'Check your internet connection and retry');
  }
  const sourceCommit = release.tag.split('-')[1] ?? '';
  await deps.writeManifest({ source: 'release', tag: release.tag, sourceCommit, patchSetHash: opts.patchSetHash, installedAt: now.toISOString(), checkedAt: now.toISOString() });
  return { updated: true };
}

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

export function defaultReleaseDeps(runtimeDir: string, localBuild: ReleaseDeps['localBuild']): ReleaseDeps {
  const manifestPath = join(runtimeDir, 'manifest.json');
  const exePath = join(runtimeDir, EMULATOR_EXE);
  const headers = { 'User-Agent': 'fc2mp4', Accept: 'application/vnd.github+json' };
  return {
    listReleases: async () => {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const body = (await res.json()) as GitHubRelease[];
      return body.map((r) => ({
        tag: r.tag_name,
        publishedAt: r.published_at,
        assets: r.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
      }));
    },
    download: async (url, dest) => {
      const res = await fetch(url, { headers: { 'User-Agent': 'fc2mp4' }, signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest));
    },
    readManifest: async () => {
      try {
        const m = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<EmulatorManifest>;
        return m.source && m.patchSetHash && m.checkedAt ? (m as EmulatorManifest) : null;
      } catch {
        return null;
      }
    },
    writeManifest: (m) => writeFile(manifestPath, `${JSON.stringify(m, null, 2)}\n`),
    exeExists: () => pathExists(exePath),
    tempDownloadPath: () => `${exePath}.download`,
    verifyDownload: async (tmp, expectedSize) => {
      const size = (await stat(tmp)).size;
      const handle = await open(tmp, 'r');
      const header = Buffer.alloc(2);
      await handle.read(header, 0, 2, 0);
      await handle.close();
      if (size !== expectedSize || header.toString('latin1') !== 'MZ') {
        throw new Error('downloaded file is incomplete or not a Windows executable');
      }
    },
    installExe: (tmp) => rename(tmp, exePath),
    removeFile: (p) => rm(p, { force: true }),
    localBuild,
    now: () => new Date(),
  };
}
