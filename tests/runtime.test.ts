import { mkdir, mkdtemp, readFile, readlink, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setIniValue } from '../src/iniPatch.js';
import { prepareRuntime, runtimeIni } from '../src/runtime.js';
import { installLayout } from '../src/install.js';

describe('setIniValue', () => {
  it('replaces, appends, keeps CRLF and ignores comments and prefixes', () => {
    expect(setIniValue('a 1\nnVidSelect 4\n', 'nVidSelect', '0')).toBe('a 1\nnVidSelect 0\n');
    expect(setIniValue('a 1', 'k', 'v')).toBe('a 1\nk v\n');
    expect(setIniValue('bAutoPause 1\r\nx 2\r\n', 'bAutoPause', '0')).toBe('bAutoPause 0\r\nx 2\r\n');
    expect(setIniValue('// bAutoPause x\nbAutoPause 1\n', 'bAutoPause', '0')).toBe('// bAutoPause x\nbAutoPause 0\n');
    expect(setIniValue('nVidSelectX 5\n', 'nVidSelect', '0')).toBe('nVidSelectX 5\nnVidSelect 0\n');
  });
});

describe('runtimeIni', () => {
  it('forces the DirectDraw renderer, full stretch and no auto-pause', () => {
    expect(runtimeIni('nVidSelect 4\nbVidFullStretch 0\nbAutoPause 1\nnAudSampleRate[0] 44100\n')).toBe(
      'nVidSelect 0\nbVidFullStretch 1\nbAutoPause 0\nnAudSampleRate[0] 44100\n',
    );
    expect(runtimeIni('')).toBe('nVidSelect 0\nbVidFullStretch 1\nbAutoPause 0\n');
  });
});

describe('prepareRuntime', () => {
  it('copies DLLs, links ROMs and writes our ini, idempotently', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fc2mp4-rt-'));
    const install = installLayout(join(base, 'FightCade2.app'));
    await mkdir(join(install.fbneoDir, 'config'), { recursive: true });
    await mkdir(install.romsDir);
    await writeFile(join(install.fbneoDir, 'ggponet.dll'), 'g');
    await writeFile(join(install.fbneoDir, 'LUA51.DLL'), 'l');
    await writeFile(join(install.fbneoDir, 'notes.txt'), 'n');
    await writeFile(install.mainIni, 'nVidSelect 4\n');
    const runtime = join(base, 'runtime');

    await prepareRuntime(install, runtime);
    await prepareRuntime(install, runtime);

    expect((await readdir(runtime)).sort()).toEqual(['LUA51.DLL', 'ROMs', 'config', 'ggponet.dll']);
    expect(await readlink(join(runtime, 'ROMs'))).toBe(install.romsDir);
    expect(await readFile(join(runtime, 'config', 'fcadefbneo-fc2mp4.ini'), 'latin1')).toBe(
      'nVidSelect 0\nbVidFullStretch 1\nbAutoPause 0\n',
    );
  });
});
