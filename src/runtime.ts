import { copyFile, mkdir, readdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EMULATOR_EXE, RUNTIME_INI } from './constants.js';
import { pathExists } from './fsUtil.js';
import { setIniValue } from './iniPatch.js';
import type { FightcadeInstall } from './install.js';

// FBNeo reads config/<exe name>.ini (CreateConfigName in cona.cpp).
export const RUNTIME_INI_NAME = EMULATOR_EXE.replace(/\.exe$/i, '.ini');

export function runtimeIni(base: string): string {
  return RUNTIME_INI.reduce((text, [key, value]) => setIniValue(text, key, value), base);
}

export async function prepareRuntime(install: FightcadeInstall, runtimeDir: string): Promise<void> {
  await mkdir(join(runtimeDir, 'config'), { recursive: true });

  for (const name of await readdir(install.fbneoDir)) {
    if (/\.dll$/i.test(name)) await copyFile(join(install.fbneoDir, name), join(runtimeDir, name));
  }

  const romsLink = join(runtimeDir, 'ROMs');
  try {
    await unlink(romsLink);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await symlink(install.romsDir, romsLink);

  const base = (await pathExists(install.mainIni)) ? await readFile(install.mainIni, 'latin1') : '';
  await writeFile(join(runtimeDir, 'config', RUNTIME_INI_NAME), runtimeIni(base), 'latin1');
}
