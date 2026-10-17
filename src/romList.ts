import { ConvertError, ExitCode } from './errors.js';
import type { FightcadeInstall } from './install.js';
import { pathFor } from './platform.js';

// Fightcade's fbneo_roms.json: every FBNeo arcade game it can download, with the ROM sets it needs
// besides its own (parent, BIOS). Game name → required names.
export type RomList = ReadonlyMap<string, readonly string[]>;

export function parseRomList(text: string): RomList | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const list = new Map<string, readonly string[]>();
  for (const [name, entry] of Object.entries(data as Record<string, unknown>)) {
    const require = entry !== null && typeof entry === 'object' ? (entry as { require?: unknown }).require : undefined;
    list.set(name, Array.isArray(require) ? require.filter((r): r is string => typeof r === 'string') : []);
  }
  return list;
}

// Where Fightcade keeps it (next to the fbneo folder), then inside the fbneo folder (copied server folders).
export function romListPaths(install: FightcadeInstall): string[] {
  const p = pathFor(install.platform);
  return [p.join(p.dirname(install.fbneoDir), 'fbneo_roms.json'), p.join(install.fbneoDir, 'fbneo_roms.json')];
}

export async function loadRomList(install: FightcadeInstall, readText: (p: string) => Promise<string | null>): Promise<RomList | null> {
  for (const file of romListPaths(install)) {
    const text = await readText(file);
    const list = text === null ? null : parseRomList(text);
    if (list) return list;
  }
  return null;
}

// The game's zip and everything it requires, recursively, each once. Without a list: its zip only.
export function requiredRoms(game: string, list: RomList | null): string[] {
  if (list && !list.has(game)) throw new ConvertError(ExitCode.Usage, `Unknown game "${game}": it is not in Fightcade's FBNeo game list`);
  const seen = new Set<string>();
  const zips: string[] = [];
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    zips.push(`${name}.zip`);
    for (const required of list?.get(name) ?? []) visit(required);
  };
  visit(game);
  return zips;
}
