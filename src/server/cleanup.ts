import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface CleanupDeps {
  list(dir: string): Promise<string[]>;
  mtimeMs(path: string): Promise<number>;
  remove(path: string): Promise<void>;
  now(): number;
}

// Only fc2mp4's own output: <quarkId>.mp4, or <quarkId>.part.mp4 left by an interrupted run.
const OUTPUT = /^(\d+-\d+)(\.part)?\.mp4$/;

// Deletes fc2mp4 MP4s older than maxAgeMs from the output folder; any other file is left alone, and so
// is the replay being converted. Returns what was deleted.
export async function cleanOutputFolder(
  dir: string,
  maxAgeMs: number,
  isBusy: (quarkId: string) => boolean,
  deps: CleanupDeps,
): Promise<{ name: string; ageMs: number }[]> {
  let names: string[];
  try {
    names = await deps.list(dir);
  } catch {
    return []; // no folder yet: nothing to clean
  }
  const deleted: { name: string; ageMs: number }[] = [];
  for (const name of names.sort()) {
    const match = OUTPUT.exec(name);
    if (!match || isBusy(match[1]!)) continue;
    const path = join(dir, name);
    try {
      const ageMs = deps.now() - (await deps.mtimeMs(path));
      if (ageMs < maxAgeMs) continue;
      await deps.remove(path);
      deleted.push({ name, ageMs });
    } catch {
      // gone already, or in use (Windows): try again next time
    }
  }
  return deleted;
}

export function defaultCleanupDeps(): CleanupDeps {
  return {
    list: (dir) => readdir(dir),
    mtimeMs: async (path) => (await stat(path)).mtimeMs,
    remove: (path) => rm(path, { force: true }),
    now: () => Date.now(),
  };
}
