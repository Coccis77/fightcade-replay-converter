import { describe, expect, it } from 'vitest';
import { DataStore, type StoreFs } from '../../src/server/store.js';

function memoryFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const mtimes = new Map<string, number>([...files.keys()].map((k) => [k, 1]));
  let clock = 1;
  const log: string[] = [];
  const fs: StoreFs = {
    readFile: async (p) => {
      const text = files.get(p);
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
    writeFile: async (p, text) => {
      log.push(`write ${p}`);
      files.set(p, text);
      mtimes.set(p, ++clock);
    },
    rename: async (from, to) => {
      log.push(`rename ${from} -> ${to}`);
      files.set(to, files.get(from)!);
      mtimes.set(to, ++clock);
      files.delete(from);
      mtimes.delete(from);
    },
    version: async (p) => (mtimes.has(p) ? String(mtimes.get(p)) : null),
  };
  return { fs, files, log };
}

const FILE = '/videos/fc2mp4-data.json';
const user = (name: string) => ({ name, admin: false, passwordHash: 'h', salt: 's', mustChangePassword: false, limit: 3, disabled: false, createdAt: '2026-10-05T00:00:00.000Z' });

describe('DataStore', () => {
  it('starts empty without a file, and saves through a temporary file then a rename', async () => {
    const { fs, files, log } = memoryFs();
    const store = new DataStore(FILE, fs);
    expect(await store.read((d) => d.users.length)).toBe(0);
    await store.update((d) => void d.users.push(user('bob')));
    expect(log).toHaveLength(2);
    expect(log[0]).toMatch(/^write \/videos\/fc2mp4-data\.json\.\d+\.[0-9a-f]+\.tmp$/);
    expect(log[1]).toBe(`rename ${log[0]!.slice('write '.length)} -> ${FILE}`);
    expect(JSON.parse(files.get(FILE)!)).toMatchObject({ version: 1, users: [{ name: 'bob' }] });
  });

  it('rereads the file when another process changed it (reset-admin while serving)', async () => {
    const { fs } = memoryFs();
    const server = new DataStore(FILE, fs);
    await server.update((d) => void d.users.push(user('admin'), user('bob')));
    const command = new DataStore(FILE, fs);
    await command.update((d) => void (d.users = d.users.filter((u) => u.name !== 'admin')));
    await server.update((d) => void d.usage.push({ name: 'bob', day: '2026-10-05', count: 1 }));
    expect(await new DataStore(FILE, fs).read((d) => d.users.map((u) => u.name))).toEqual(['bob']);
  });

  it('refuses a damaged file instead of overwriting it', async () => {
    const { fs, files, log } = memoryFs({ [FILE]: 'not json' });
    const store = new DataStore(FILE, fs);
    await expect(store.update((d) => void d.users.push(user('bob')))).rejects.toMatchObject({ message: `The data file is damaged: ${FILE}` });
    expect(files.get(FILE)).toBe('not json');
    expect(log).toEqual([]);
  });

  it('keeps the data untouched when a change fails', async () => {
    const { fs, log } = memoryFs();
    const store = new DataStore(FILE, fs);
    await expect(
      store.update((d) => {
        d.users.push(user('bob'));
        throw new Error('invalid');
      }),
    ).rejects.toThrow('invalid');
    expect(await store.read((d) => d.users.length)).toBe(0);
    expect(log).toEqual([]);
  });

  it('notices an outside change even when the file time did not move (coarse timestamps)', async () => {
    const files = new Map<string, string>();
    const inodes = new Map<string, number>();
    let inode = 0;
    const fs: StoreFs = {
      readFile: async (p) => files.get(p)!,
      writeFile: async (p, text) => void (files.set(p, text), inodes.set(p, ++inode)),
      rename: async (from, to) => void (files.set(to, files.get(from)!), inodes.set(to, inodes.get(from)!), files.delete(from), inodes.delete(from)),
      version: async (p) => (files.has(p) ? `${inodes.get(p)}:${files.get(p)!.length}:1000` : null), // same time, always
    };
    const server = new DataStore(FILE, fs);
    await server.update((d) => void d.users.push(user('admin'), user('bob')));
    await new DataStore(FILE, fs).update((d) => void (d.users = d.users.filter((u) => u.name !== 'admin')));
    await server.update((d) => void d.usage.push({ name: 'bob', day: '2026-10-05', count: 1 }));
    expect(await new DataStore(FILE, fs).read((d) => d.users.map((u) => u.name))).toEqual(['bob']);
  });
});
