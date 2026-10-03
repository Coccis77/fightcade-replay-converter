import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveOutputPath } from '../src/outputPath.js';

const DEFAULT = '/Users/fran/Movies/Fightcade';
const never = async () => false;

describe('resolveOutputPath', () => {
  it('defaults to <defaultDir>/<quarkId>.mp4', async () => {
    expect(await resolveOutputPath('1-2', undefined, DEFAULT, never)).toBe(`${DEFAULT}/1-2.mp4`);
  });
  it('treats an existing directory as the target folder', async () => {
    expect(await resolveOutputPath('1-2', '/tmp/out', DEFAULT, async (p) => p === '/tmp/out')).toBe('/tmp/out/1-2.mp4');
  });
  it('treats a trailing separator as a folder', async () => {
    expect(await resolveOutputPath('1-2', '/tmp/new/', DEFAULT, never)).toBe('/tmp/new/1-2.mp4');
  });
  it('keeps an explicit file path and makes relative paths absolute', async () => {
    expect(await resolveOutputPath('1-2', '/tmp/final.mp4', DEFAULT, never)).toBe('/tmp/final.mp4');
    expect(await resolveOutputPath('1-2', 'clips/a.mp4', DEFAULT, never)).toBe(resolve('clips/a.mp4'));
  });
});
