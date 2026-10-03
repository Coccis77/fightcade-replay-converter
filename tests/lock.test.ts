import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock } from '../src/lock.js';
import { ExitCode } from '../src/errors.js';
import { pathExists } from '../src/fsUtil.js';

async function lockFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'fc2mp4-lock-')), 'fc2mp4.lock');
}

describe('acquireLock', () => {
  it('writes our pid and removes the file on release', async () => {
    const file = await lockFile();
    const release = await acquireLock(file);
    expect(await readFile(file, 'utf8')).toBe(String(process.pid));
    await release();
    expect(await pathExists(file)).toBe(false);
  });
  it('refuses while another live process holds it', async () => {
    const file = await lockFile();
    await writeFile(file, '424242');
    await expect(acquireLock(file, () => true)).rejects.toMatchObject({ exitCode: ExitCode.Busy, message: expect.stringContaining('424242') });
  });
  it('takes over a stale lock', async () => {
    const file = await lockFile();
    await writeFile(file, '424242');
    const release = await acquireLock(file, () => false);
    expect(await readFile(file, 'utf8')).toBe(String(process.pid));
    await release();
  });
});
