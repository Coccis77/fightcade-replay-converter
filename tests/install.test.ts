import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installLayout, locateInstall, preflight, type PreflightDeps } from '../src/install.js';
import { sha256File } from '../src/fsUtil.js';
import { ExitCode } from '../src/errors.js';

const ROOT = '/Applications/FightCade2.app';

describe('installLayout', () => {
  it('maps the macOS app bundle', () => {
    const i = installLayout(ROOT);
    expect(i.fbneoDir).toBe(`${ROOT}/Contents/MacOS/emulator/fbneo`);
    expect(i.exe).toBe(`${i.fbneoDir}/fcadefbneo.exe`);
    expect(i.ggponet).toBe(`${i.fbneoDir}/ggponet.dll`);
    expect(i.romsDir).toBe(`${i.fbneoDir}/ROMs`);
    expect(i.rom).toBe(`${i.fbneoDir}/ROMs/sfiii3nr1.zip`);
    expect(i.mainIni).toBe(`${i.fbneoDir}/config/fcadefbneo.ini`);
    expect(i.wineSh).toBe(`${ROOT}/Contents/Resources/wine.sh`);
  });
});

describe('locateInstall', () => {
  const home = '/Users/fran';
  it('finds the first candidate with the emulator and ggponet.dll', async () => {
    const userRoot = `${home}/Applications/FightCade2.app`;
    const exists = async (p: string) => p.startsWith(userRoot);
    expect((await locateInstall({ platform: 'darwin', home, exists })).root).toBe(userRoot);
  });
  it('explains a wrong --fightcade-dir', async () => {
    await expect(locateInstall({ platform: 'darwin', home, override: '/nope', exists: async () => false })).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      hint: expect.stringContaining('/nope'),
    });
  });
  it('rejects platforms other than macOS', async () => {
    await expect(locateInstall({ platform: 'linux', home, exists: async () => true })).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: expect.stringContaining('macOS'),
    });
  });
});

describe('preflight', () => {
  const install = installLayout(ROOT);
  const ok: PreflightDeps = { exists: async () => true, which: async () => '/opt/homebrew/bin/ffmpeg' };

  it('passes when everything is present', async () => {
    await expect(preflight(install, ok)).resolves.toBeUndefined();
  });
  it.each([
    ['ROM', { exists: async (p: string) => !p.endsWith('sfiii3nr1.zip') }, /ROM not found/],
    ['wine.sh', { exists: async (p: string) => !p.endsWith('wine.sh') }, /wine\.sh not found/],
    ['ffmpeg', { which: async () => null }, /ffmpeg not found/],
  ])('fails when %s is missing', async (_name, override, message) => {
    await expect(preflight(install, { ...ok, ...override })).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: expect.stringMatching(message),
    });
  });
});

describe('sha256File', () => {
  it('hashes file contents', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'fc2mp4-hash-')), 'a.txt');
    await writeFile(file, 'abc');
    expect(await sha256File(file)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
