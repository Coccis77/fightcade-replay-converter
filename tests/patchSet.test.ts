import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentPatchSetHash, patchSetHash } from '../src/patchSet.js';

const FIXTURE_HASH = 'ad8f4307a17afa05c142df8811f108babff53a3509314d60b5196cd9a54894b4';

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-patchset-'));
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, '__pycache__'));
  await writeFile(join(dir, 'patches.py'), 'A');
  await writeFile(join(dir, 'src', 'fc2mp4_dump.cpp'), 'B');
  await writeFile(join(dir, 'test_x.py'), 'ignored');
  await writeFile(join(dir, '__pycache__', 'x.pyc'), 'ignored');
  return dir;
}

describe('patchSetHash', () => {
  it('matches the value computed by emulator/patchset.py', async () => {
    expect(await patchSetHash(await fixture())).toBe(FIXTURE_HASH);
  });
  it('changes when a patch file changes', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'src', 'fc2mp4_dump.cpp'), 'C');
    expect(await patchSetHash(dir)).not.toBe(FIXTURE_HASH);
  });
  it('falls back to hashing the emulator folder when not bundled', async () => {
    const dir = await fixture();
    expect(await currentPatchSetHash(() => dir)).toBe(FIXTURE_HASH);
  });
});
