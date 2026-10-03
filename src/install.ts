import { GAME } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import { pathFor, supportedPlatform, type Platform } from './platform.js';

export interface FightcadeInstall {
  platform: Platform;
  root: string;
  fbneoDir: string;
  exe: string;
  ggponet: string;
  romsDir: string;
  rom: string;
  mainIni: string;
  // wine.sh on macOS; null on Windows, where the emulator runs directly.
  launcher: string | null;
}

export function installLayout(root: string, platform: Platform = 'darwin'): FightcadeInstall {
  const p = pathFor(platform);
  const fbneoDir = platform === 'darwin' ? p.join(root, 'Contents', 'MacOS', 'emulator', 'fbneo') : p.join(root, 'emulator', 'fbneo');
  return {
    platform,
    root,
    fbneoDir,
    exe: p.join(fbneoDir, 'fcadefbneo.exe'),
    ggponet: p.join(fbneoDir, 'ggponet.dll'),
    romsDir: p.join(fbneoDir, 'ROMs'),
    rom: p.join(fbneoDir, 'ROMs', `${GAME}.zip`),
    mainIni: p.join(fbneoDir, 'config', 'fcadefbneo.ini'),
    launcher: platform === 'darwin' ? p.join(root, 'Contents', 'Resources', 'wine.sh') : null,
  };
}

export function candidateRoots(platform: Platform, home: string, env: Record<string, string | undefined>): string[] {
  const p = pathFor(platform);
  if (platform === 'darwin') return ['/Applications/FightCade2.app', p.join(home, 'Applications', 'FightCade2.app')];
  const profile = env.USERPROFILE ?? home;
  const local = env.LOCALAPPDATA ?? p.join(profile, 'AppData', 'Local');
  // OneDrive folder backup (a Windows 11 default) moves Documents under %OneDrive%.
  const oneDrive = [env.OneDrive, env.OneDriveConsumer].filter((d): d is string => Boolean(d)).map((d) => p.join(d, 'Documents', 'Fightcade'));
  return [p.join(profile, 'Documents', 'Fightcade'), ...oneDrive, p.join(profile, 'Fightcade'), 'C:\\Fightcade', p.join(local, 'Programs', 'Fightcade')];
}

export async function locateInstall(opts: {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  override?: string;
  exists: (p: string) => Promise<boolean>;
}): Promise<FightcadeInstall> {
  const platform = supportedPlatform(opts.platform);
  for (const root of opts.override ? [opts.override] : candidateRoots(platform, opts.home, opts.env)) {
    const install = installLayout(root, platform);
    if ((await opts.exists(install.exe)) && (await opts.exists(install.ggponet))) return install;
  }
  const what = platform === 'darwin' ? 'FightCade2.app' : 'your Fightcade folder';
  throw new ConvertError(
    ExitCode.Preflight,
    'Fightcade install not found',
    opts.override ? `No emulator/fbneo/fcadefbneo.exe + ggponet.dll under ${opts.override}` : `Install Fightcade 2, or pass --fightcade-dir <path to ${what}>`,
  );
}

export interface PreflightDeps {
  exists(p: string): Promise<boolean>;
}

export async function preflight(install: FightcadeInstall, deps: PreflightDeps): Promise<void> {
  if (!(await deps.exists(install.rom))) {
    throw new ConvertError(ExitCode.Preflight, `3rd Strike ROM not found: ${install.rom}`, 'Open 3rd Strike once in Fightcade so it downloads the ROM');
  }
  if (install.launcher !== null && !(await deps.exists(install.launcher))) {
    throw new ConvertError(ExitCode.Preflight, `wine.sh not found: ${install.launcher}`, 'Reinstall Fightcade');
  }
}
