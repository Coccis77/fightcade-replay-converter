import { GAME } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import { pathFor, supportedPlatform, type Platform } from './platform.js';

export const APT_HINT = 'sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 xvfb pulseaudio ffmpeg';

export interface FightcadeInstall {
  platform: Platform;
  root: string;
  fbneoDir: string;
  exe: string;
  ggponet: string;
  romsDir: string;
  rom: string;
  mainIni: string;
  // wine.sh on macOS; null on Windows (runs directly) and Linux (headless command built in capture.ts).
  launcher: string | null;
}

export function installLayout(root: string, platform: Platform = 'darwin', fbneoDir?: string): FightcadeInstall {
  const p = pathFor(platform);
  const fbneo =
    fbneoDir ?? (platform === 'darwin' ? p.join(root, 'Contents', 'MacOS', 'emulator', 'fbneo') : p.join(root, 'emulator', 'fbneo'));
  return {
    platform,
    root,
    fbneoDir: fbneo,
    exe: p.join(fbneo, 'fcadefbneo.exe'),
    ggponet: p.join(fbneo, 'ggponet.dll'),
    romsDir: p.join(fbneo, 'ROMs'),
    rom: p.join(fbneo, 'ROMs', `${GAME}.zip`),
    mainIni: p.join(fbneo, 'config', 'fcadefbneo.ini'),
    launcher: platform === 'darwin' ? p.join(root, 'Contents', 'Resources', 'wine.sh') : null,
  };
}

export function candidateRoots(platform: Platform, home: string, env: Record<string, string | undefined>): string[] {
  const p = pathFor(platform);
  if (platform === 'darwin') return ['/Applications/FightCade2.app', p.join(home, 'Applications', 'FightCade2.app')];
  if (platform === 'linux') {
    return [env.FC2MP4_FIGHTCADE_DIR, p.join(home, 'Fightcade'), p.join(home, 'fightcade'), '/opt/fightcade'].filter((d): d is string => Boolean(d));
  }
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
    if (platform === 'linux') {
      // Linux: a Fightcade root, or the fbneo folder itself (files-only server folder). No exe needed.
      const asRoot = installLayout(root, 'linux');
      if (await opts.exists(asRoot.ggponet)) return asRoot;
      const asFbneo = installLayout(root, 'linux', root);
      if (await opts.exists(asFbneo.ggponet)) return asFbneo;
      continue;
    }
    const install = installLayout(root, platform);
    if ((await opts.exists(install.exe)) && (await opts.exists(install.ggponet))) return install;
  }
  if (platform === 'linux') {
    throw new ConvertError(
      ExitCode.Preflight,
      'Fightcade files not found',
      `Pass --fightcade-dir (or set FC2MP4_FIGHTCADE_DIR) to a folder containing emulator/fbneo/ggponet.dll, or to the fbneo folder itself containing ggponet.dll and ROMs/${opts.override ? ` (checked ${opts.override})` : ''}`,
    );
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
  which(cmd: string): Promise<string | null>;
}

// Tools fc2mp4 cannot download itself. ffmpeg is checked where it is located (ffmpegLocator).
export async function checkTools(platform: Platform, which: (cmd: string) => Promise<string | null>): Promise<void> {
  if (platform !== 'linux') return;
  const missing: string[] = [];
  for (const tool of ['wine', 'xvfb-run', 'pulseaudio']) if ((await which(tool)) === null) missing.push(tool);
  if (missing.length > 0) throw new ConvertError(ExitCode.Preflight, `Missing on this system: ${missing.join(', ')}`, APT_HINT);
}

export async function preflight(install: FightcadeInstall, deps: PreflightDeps): Promise<void> {
  if (!(await deps.exists(install.rom))) {
    throw new ConvertError(ExitCode.Preflight, `3rd Strike ROM not found: ${install.rom}`, 'Open 3rd Strike once in Fightcade so it downloads the ROM');
  }
  if (install.launcher !== null && !(await deps.exists(install.launcher))) {
    throw new ConvertError(ExitCode.Preflight, `wine.sh not found: ${install.launcher}`, 'Reinstall Fightcade');
  }
  await checkTools(install.platform, deps.which);
}
