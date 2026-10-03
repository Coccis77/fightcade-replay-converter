import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

// Defined by scripts/bundle.mjs in the single-executable build (no emulator/ folder there).
declare const __FC2MP4_PATCH_SET__: string | undefined;

async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name.startsWith('test_')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}

// Same definition as emulator/patchset.py: relative paths with "/" so every OS agrees.
export async function patchSetHash(emulatorDir: string): Promise<string> {
  const hash = createHash('sha256');
  const files = (await listFiles(emulatorDir)).map((f) => relative(emulatorDir, f).split(sep).join('/')).sort();
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    // CRLF checkouts (Windows CI with core.autocrlf) must hash like LF ones.
    hash.update((await readFile(join(emulatorDir, file), 'latin1')).replace(/\r\n/g, '\n'), 'latin1');
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function currentPatchSetHash(emulatorDir: () => string | null): Promise<string> {
  if (typeof __FC2MP4_PATCH_SET__ === 'string') return __FC2MP4_PATCH_SET__;
  const dir = emulatorDir();
  if (dir === null) throw new Error('No patch-set hash: not bundled and no emulator folder');
  return patchSetHash(dir);
}
