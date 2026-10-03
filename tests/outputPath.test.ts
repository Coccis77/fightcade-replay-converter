import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultOutputDir, resolveOutputPath } from '../src/outputPath.js';

const HOME = '/Users/fran';
const never = async () => false;

describe('output path', () => {
  it('defaults to ~/Movies/Fightcade/<quarkId>.mp4', async () => {
    expect(defaultOutputDir(HOME)).toBe('/Users/fran/Movies/Fightcade');
    expect(await resolveOutputPath('1-2', undefined, HOME, never)).toBe('/Users/fran/Movies/Fightcade/1-2.mp4');
  });
  it('treats an existing directory as the target folder', async () => {
    expect(await resolveOutputPath('1-2', '/tmp/out', HOME, async (p) => p === '/tmp/out')).toBe('/tmp/out/1-2.mp4');
  });
  it('treats a trailing slash as a folder', async () => {
    expect(await resolveOutputPath('1-2', '/tmp/new/', HOME, never)).toBe('/tmp/new/1-2.mp4');
  });
  it('keeps an explicit file path and makes relative paths absolute', async () => {
    expect(await resolveOutputPath('1-2', '/tmp/final.mp4', HOME, never)).toBe('/tmp/final.mp4');
    expect(await resolveOutputPath('1-2', 'clips/a.mp4', HOME, never)).toBe(resolve('clips/a.mp4'));
  });
});
