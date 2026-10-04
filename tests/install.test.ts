import { describe, expect, it } from 'vitest';
import { checkTools, installLayout, locateInstall, preflight } from '../src/install.js';
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
  it('rejects unsupported platforms', async () => {
    await expect(locateInstall({ platform: 'freebsd', home: '/home/a', env: {}, exists: async () => true })).rejects.toMatchObject({ exitCode: ExitCode.Preflight });
  });
});

describe('preflight', () => {
  it('needs the ROM, and wine.sh only on macOS', async () => {
    const mac = installLayout(MAC_ROOT, 'darwin');
    const win = installLayout(WIN_ROOT, 'win32');
    await expect(preflight(mac, { exists: async () => true, which: async () => '/usr/bin/x' })).resolves.toBeUndefined();
    await expect(preflight(win, { exists: async (p) => !p.endsWith('wine.sh'), which: async () => '/usr/bin/x' })).resolves.toBeUndefined();
    await expect(preflight(mac, { exists: async (p) => !p.endsWith('wine.sh'), which: async () => '/usr/bin/x' })).rejects.toMatchObject({ message: expect.stringMatching(/wine\.sh/) });
    await expect(preflight(win, { exists: async (p) => !p.endsWith('sfiii3nr1.zip'), which: async () => '/usr/bin/x' })).rejects.toMatchObject({ message: expect.stringMatching(/ROM not found/) });
  });
});

describe('Linux Fightcade files not found', () => {
  it('lists the folders it checked, including FC2MP4_FIGHTCADE_DIR', async () => {
    const env = { FC2MP4_FIGHTCADE_DIR: '/mnt/c/Fightcade' };
    await expect(locateInstall({ platform: 'linux', home: '/home/a', env, exists: async () => false })).rejects.toMatchObject({
      hint: expect.stringContaining('Checked: /mnt/c/Fightcade, /home/a/Fightcade, /home/a/fightcade, /opt/fightcade'),
    });
  });
});

describe('Linux Fightcade files', () => {
  const home = '/home/a';
  const which = async (cmd: string) => `/usr/bin/${cmd}`;

  it('accepts a Fightcade root (official install or a copy)', async () => {
    const root = '/srv/fightcade';
    const i = await locateInstall({ platform: 'linux', home, env: {}, override: root, exists: async (p) => p === `${root}/emulator/fbneo/ggponet.dll` });
    expect(i).toMatchObject({ platform: 'linux', root, fbneoDir: `${root}/emulator/fbneo`, launcher: null, rom: `${root}/emulator/fbneo/ROMs/sfiii3nr1.zip` });
  });
  it('accepts the fbneo folder itself (files-only server folder)', async () => {
    const dir = '/srv/fbneo-files';
    const i = await locateInstall({ platform: 'linux', home, env: {}, override: dir, exists: async (p) => p === `${dir}/ggponet.dll` });
    expect(i).toMatchObject({ fbneoDir: dir, ggponet: `${dir}/ggponet.dll`, romsDir: `${dir}/ROMs` });
  });
  it('reads FC2MP4_FIGHTCADE_DIR, then the usual install places', async () => {
    const env = { FC2MP4_FIGHTCADE_DIR: '/mnt/c/Users/Coccis/Documents/Fightcade' };
    const i = await locateInstall({ platform: 'linux', home, env, exists: async (p) => p.startsWith(env.FC2MP4_FIGHTCADE_DIR) && p.endsWith('/emulator/fbneo/ggponet.dll') });
    expect(i.root).toBe(env.FC2MP4_FIGHTCADE_DIR);
    const fallback = await locateInstall({ platform: 'linux', home, env: {}, exists: async (p) => p === '/opt/fightcade/emulator/fbneo/ggponet.dll' });
    expect(fallback.root).toBe('/opt/fightcade');
  });
  it('explains both accepted layouts when the folder is wrong', async () => {
    await expect(locateInstall({ platform: 'linux', home, env: {}, override: '/srv/fightcade/ROMs', exists: async () => false })).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      hint: expect.stringMatching(/emulator\/fbneo\/ggponet\.dll.*ggponet\.dll/),
    });
  });
  it('needs wine on Linux, with the apt hint', async () => {
    const i = installLayout('/srv/fightcade', 'linux');
    await expect(preflight(i, { exists: async () => true, which })).resolves.toBeUndefined();
    await expect(preflight(i, { exists: async () => true, which: async (c) => (c === 'wine' ? null : `/usr/bin/${c}`) })).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: expect.stringContaining('wine'),
      hint: 'sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 ffmpeg',
    });
  });
});

describe('checkTools', () => {
  it('needs only wine on Linux, with the apt hint', async () => {
    await expect(checkTools('linux', async (c) => (c === 'wine' ? null : `/usr/bin/${c}`))).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: 'Missing on this system: wine',
      hint: 'sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 ffmpeg',
    });
    // Xvfb and PulseAudio are no longer needed.
    await expect(checkTools('linux', async (c) => (c === 'wine' ? '/usr/bin/wine' : null))).resolves.toBeUndefined();
    await expect(checkTools('darwin', async () => null)).resolves.toBeUndefined();
    await expect(checkTools('win32', async () => null)).resolves.toBeUndefined();
  });
});
