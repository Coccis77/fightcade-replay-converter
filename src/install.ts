import { join } from 'node:path';
import { GAME } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';

export interface FightcadeInstall {
  root: string;
  fbneoDir: string;
  exe: string;
  ggponet: string;
  romsDir: string;
  rom: string;
  mainIni: string;
  wineSh: string;
}

export function installLayout(root: string): FightcadeInstall {
  const fbneoDir = join(root, 'Contents', 'MacOS', 'emulator', 'fbneo');
  return {
    root,
    fbneoDir,
    exe: join(fbneoDir, 'fcadefbneo.exe'),
    ggponet: join(fbneoDir, 'ggponet.dll'),
    romsDir: join(fbneoDir, 'ROMs'),
    rom: join(fbneoDir, 'ROMs', `${GAME}.zip`),
    mainIni: join(fbneoDir, 'config', 'fcadefbneo.ini'),
    wineSh: join(root, 'Contents', 'Resources', 'wine.sh'),
  };
}

export function candidateRoots(home: string): string[] {
  return ['/Applications/FightCade2.app', join(home, 'Applications', 'FightCade2.app')];
}

export async function locateInstall(opts: {
  platform: NodeJS.Platform;
  home: string;
  override?: string;
  exists: (p: string) => Promise<boolean>;
}): Promise<FightcadeInstall> {
  if (opts.platform !== 'darwin') {
    throw new ConvertError(ExitCode.Preflight, `fc2mp4 currently supports macOS only (this is ${opts.platform})`);
  }
  for (const root of opts.override ? [opts.override] : candidateRoots(opts.home)) {
    const install = installLayout(root);
    if ((await opts.exists(install.exe)) && (await opts.exists(install.ggponet))) return install;
  }
  throw new ConvertError(
    ExitCode.Preflight,
    'Fightcade install not found',
    opts.override
      ? `No Contents/MacOS/emulator/fbneo/fcadefbneo.exe + ggponet.dll under ${opts.override}`
      : 'Install Fightcade 2, or pass --fightcade-dir <path to FightCade2.app>',
  );
}

export interface PreflightDeps {
  exists(p: string): Promise<boolean>;
  which(cmd: string): Promise<string | null>;
}

export async function preflight(install: FightcadeInstall, deps: PreflightDeps): Promise<void> {
  if (!(await deps.exists(install.rom))) {
    throw new ConvertError(ExitCode.Preflight, `3rd Strike ROM not found: ${install.rom}`, 'Open 3rd Strike once in Fightcade so it downloads the ROM');
  }
  if (!(await deps.exists(install.wineSh))) {
    throw new ConvertError(ExitCode.Preflight, `wine.sh not found: ${install.wineSh}`, 'Reinstall Fightcade');
  }
  if ((await deps.which('ffmpeg')) === null) {
    throw new ConvertError(ExitCode.Preflight, 'ffmpeg not found on PATH', 'brew install ffmpeg');
  }
}
