import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sha256File } from '../src/fsUtil.js';

describe('sha256File', () => {
  it('hashes file contents', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'fc2mp4-hash-')), 'a.txt');
    await writeFile(file, 'abc');
    expect(await sha256File(file)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
