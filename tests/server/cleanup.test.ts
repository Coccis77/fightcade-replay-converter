import { describe, expect, it } from 'vitest';
import { cleanOutputFolder, type CleanupDeps } from '../../src/server/cleanup.js';

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse('2026-10-10T12:00:00Z');

function folder(files: Record<string, number>) {
  const removed: string[] = [];
  const deps: CleanupDeps = {
    list: async () => Object.keys(files),
    mtimeMs: async (p) => files[p.split('/').at(-1)!]!,
    remove: async (p) => {
      removed.push(p);
    },
    now: () => NOW,
  };
  return { deps, removed };
}

describe('cleanOutputFolder', () => {
  it('deletes only fc2mp4 MP4s older than the limit, and reports them', async () => {
    const { deps, removed } = folder({
      '1700000000000-1111.mp4': NOW - 8 * DAY,
      '1700000000000-2222.mp4': NOW - 2 * DAY,
      '1700000000000-3333.part.mp4': NOW - 8 * DAY, // left by an interrupted run
      'my-edit.mp4': NOW - 30 * DAY,
      'notes.txt': NOW - 30 * DAY,
    });
    const deleted = await cleanOutputFolder('/videos', 7 * DAY, () => false, deps);
    expect(removed).toEqual(['/videos/1700000000000-1111.mp4', '/videos/1700000000000-3333.part.mp4']);
    expect(deleted).toEqual([
      { name: '1700000000000-1111.mp4', ageMs: 8 * DAY },
      { name: '1700000000000-3333.part.mp4', ageMs: 8 * DAY },
    ]);
  });

  it('never touches the replay being converted', async () => {
    const { deps, removed } = folder({ '1700000000000-1111.part.mp4': NOW - 8 * DAY, '1700000000000-1111.mp4': NOW - 8 * DAY });
    await cleanOutputFolder('/videos', 7 * DAY, (id) => id === '1700000000000-1111', deps);
    expect(removed).toEqual([]);
  });

  it('does nothing when the folder does not exist yet', async () => {
    const deps: CleanupDeps = {
      list: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      mtimeMs: async () => 0,
      remove: async () => {},
      now: () => NOW,
    };
    await expect(cleanOutputFolder('/videos', DAY, () => false, deps)).resolves.toEqual([]);
  });

  it('keeps going when one file cannot be deleted', async () => {
    const { deps, removed } = folder({ '1700000000000-1111.mp4': NOW - 8 * DAY, '1700000000000-2222.mp4': NOW - 8 * DAY });
    const remove = deps.remove;
    deps.remove = async (p) => {
      if (p.endsWith('1111.mp4')) throw new Error('EBUSY');
      await remove(p);
    };
    const deleted = await cleanOutputFolder('/videos', DAY, () => false, deps);
    expect(removed).toEqual(['/videos/1700000000000-2222.mp4']);
    expect(deleted.map((d) => d.name)).toEqual(['1700000000000-2222.mp4']);
  });
});
