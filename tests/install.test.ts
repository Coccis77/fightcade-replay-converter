import { describe, expect, it } from 'vitest';
import { installLayout, locateInstall, preflight } from '../src/install.js';
import { ExitCode } from '../src/errors.js';

const MAC_ROOT = '/Applications/FightCade2.app';
const WIN_ROOT = 'C:\\Users\\Jean Pierre\\Documents\\Fightcade';

describe('installLayout', () => {
  it('maps the macOS app bundle with wine.sh as launcher', () => {
    const i = installLayout(MAC_ROOT, 'darwin');
    expect(i.platform).toBe('darwin');
    expect(i.fbneoDir).toBe(`${MAC_ROOT}/Contents/MacOS/emulator/fbneo`);
    expect(i.exe).toBe(`${i.fbneoDir}/fcadefbneo.exe`);
    expect(i.ggponet).toBe(`${i.fbneoDir}/ggponet.dll`);
    expect(i.romsDir).toBe(`${i.fbneoDir}/ROMs`);
    expect(i.rom).toBe(`${i.fbneoDir}/ROMs/sfiii3nr1.zip`);
    expect(i.mainIni).toBe(`${i.fbneoDir}/config/fcadefbneo.ini`);
    expect(i.launcher).toBe(`${MAC_ROOT}/Contents/Resources/wine.sh`);
  });
  it('maps a Windows folder (with spaces) and runs the exe directly', () => {
    const i = installLayout(WIN_ROOT, 'win32');
    expect(i.fbneoDir).toBe(`${WIN_ROOT}\\emulator\\fbneo`);
    expect(i.exe).toBe(`${WIN_ROOT}\\emulator\\fbneo\\fcadefbneo.exe`);
    expect(i.rom).toBe(`${WIN_ROOT}\\emulator\\fbneo\\ROMs\\sfiii3nr1.zip`);
    expect(i.launcher).toBeNull();
  });
});

describe('locateInstall', () => {
  it('finds the macOS user Applications install', async () => {
    const home = '/Users/fran';
    const root = `${home}/Applications/FightCade2.app`;
    const i = await locateInstall({ platform: 'darwin', home, env: {}, exists: async (p) => p.startsWith(root) });
    expect(i.root).toBe(root);
  });
  it('finds Fightcade in Documents on Windows', async () => {
    const env = { USERPROFILE: 'C:\\Users\\Jean Pierre', LOCALAPPDATA: 'C:\\Users\\Jean Pierre\\AppData\\Local' };
    const i = await locateInstall({ platform: 'win32', home: env.USERPROFILE, env, exists: async (p) => p.startsWith(WIN_ROOT) });
    expect(i.root).toBe(WIN_ROOT);
    expect(i.platform).toBe('win32');
  });
  it('finds Fightcade in a Documents folder redirected to OneDrive', async () => {
    const env = { USERPROFILE: 'C:\\Users\\a', OneDrive: 'C:\\Users\\a\\OneDrive' };
    const root = 'C:\\Users\\a\\OneDrive\\Documents\\Fightcade';
    const i = await locateInstall({ platform: 'win32', home: env.USERPROFILE, env, exists: async (p) => p.startsWith(root) });
    expect(i.root).toBe(root);
  });
  it('tries C:\\Fightcade and Programs too', async () => {
    const env = { USERPROFILE: 'C:\\Users\\a', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
    const programs = 'C:\\Users\\a\\AppData\\Local\\Programs\\Fightcade';
    const i = await locateInstall({ platform: 'win32', home: env.USERPROFILE, env, exists: async (p) => p.startsWith(programs) });
    expect(i.root).toBe(programs);
  });
  it('explains a wrong --fightcade-dir per platform', async () => {
    await expect(locateInstall({ platform: 'win32', home: 'C:\\Users\\a', env: {}, override: 'D:\\nope', exists: async () => false })).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      hint: expect.stringContaining('D:\\nope'),
    });
  });
  it('rejects Linux for now', async () => {
    await expect(locateInstall({ platform: 'linux', home: '/home/a', env: {}, exists: async () => true })).rejects.toMatchObject({ exitCode: ExitCode.Preflight });
  });
});

describe('preflight', () => {
  it('needs the ROM, and wine.sh only on macOS', async () => {
    const mac = installLayout(MAC_ROOT, 'darwin');
    const win = installLayout(WIN_ROOT, 'win32');
    await expect(preflight(mac, { exists: async () => true })).resolves.toBeUndefined();
    await expect(preflight(win, { exists: async (p) => !p.endsWith('wine.sh') })).resolves.toBeUndefined();
    await expect(preflight(mac, { exists: async (p) => !p.endsWith('wine.sh') })).rejects.toMatchObject({ message: expect.stringMatching(/wine\.sh/) });
    await expect(preflight(win, { exists: async (p) => !p.endsWith('sfiii3nr1.zip') })).rejects.toMatchObject({ message: expect.stringMatching(/ROM not found/) });
  });
});
