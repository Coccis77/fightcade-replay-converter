import { describe, expect, it } from 'vitest';
import { installLayout } from '../src/install.js';
import { loadRomList, parseRomList, requiredRoms, romListPaths } from '../src/romList.js';
import { ExitCode } from '../src/errors.js';

const JSON_LIST = JSON.stringify({
  garou: { download: 'x', require: ['neogeo'] },
  neogeo: { download: 'x' },
  kof98a: { download: 'x', require: ['kof98', 'neogeo'] },
  kof98: { download: 'x', require: ['neogeo'] },
  loopa: { require: ['loopb'] },
  loopb: { require: ['loopa'] },
  mk: { download: 'x' },
});

describe('parseRomList', () => {
  it('reads each game and what it requires', () => {
    const list = parseRomList(JSON_LIST)!;
    expect(list.get('garou')).toEqual(['neogeo']);
    expect(list.get('mk')).toEqual([]);
  });
  it.each([['not json'], ['[]'], ['null'], ['42']])('gives no list for %j', (text) => {
    expect(parseRomList(text)).toBeNull();
  });
});

describe('requiredRoms', () => {
  const list = parseRomList(JSON_LIST);
  it('adds parents and BIOS, each once', () => {
    expect(requiredRoms('garou', list)).toEqual(['garou.zip', 'neogeo.zip']);
    expect(requiredRoms('kof98a', list)).toEqual(['kof98a.zip', 'kof98.zip', 'neogeo.zip']);
    expect(requiredRoms('mk', list)).toEqual(['mk.zip']);
  });
  it('survives a cycle', () => {
    expect(requiredRoms('loopa', list)).toEqual(['loopa.zip', 'loopb.zip']);
  });
  it.each([['kof99'], ['constructor'], ['__proto__']])('refuses %j when it is not in the list', (game) => {
    expect(() => requiredRoms(game, list)).toThrow(expect.objectContaining({ exitCode: ExitCode.Usage, message: `Unknown game "${game}": it is not in Fightcade's FBNeo game list` }));
  });
  it('without a list, checks only the game zip', () => {
    expect(requiredRoms('anything', null)).toEqual(['anything.zip']);
  });
});

describe('loadRomList', () => {
  const mac = installLayout('/Applications/FightCade2.app', 'darwin');
  it('looks next to the fbneo folder, then inside it', () => {
    expect(romListPaths(mac)).toEqual([
      '/Applications/FightCade2.app/Contents/MacOS/emulator/fbneo_roms.json',
      '/Applications/FightCade2.app/Contents/MacOS/emulator/fbneo/fbneo_roms.json',
    ]);
  });
  it('uses the first readable list, and none when no file is readable', async () => {
    const files: Record<string, string> = { [romListPaths(mac)[1]!]: JSON_LIST };
    const list = await loadRomList(mac, async (p) => files[p] ?? null);
    expect(list?.get('garou')).toEqual(['neogeo']);
    expect(await loadRomList(mac, async () => null)).toBeNull();
    expect(await loadRomList(mac, async () => 'garbage')).toBeNull();
  });
});
