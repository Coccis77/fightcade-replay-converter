import { describe, expect, it } from 'vitest';
import { formatReplayLength, parseCli, parseDuration } from '../src/cliArgs.js';
import { ExitCode } from '../src/errors.js';
import { DEFAULT_MAX_DURATION_MS } from '../src/constants.js';

function usageError(argv: string[]): unknown {
  try {
    parseCli(argv);
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('parseDuration', () => {
  it.each([
    ['90s', 90_000],
    ['45m', 2_700_000],
    ['1h', 3_600_000],
    ['30', 1_800_000],
    ['1.5h', 5_400_000],
    ['2d', 172_800_000],
  ])('%s → %d ms', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });
  it.each([['abc'], ['0'], ['-5m'], ['10x']])('rejects %s', (text) => {
    expect(() => parseDuration(text)).toThrow(/Invalid duration/);
  });
});

describe('parseCli', () => {
  it('applies defaults', () => {
    expect(parseCli(['1-2'])).toEqual({
      command: 'convert',
      input: '1-2',
      output: undefined,
      scale: 'sharp',
      maxDurationMs: DEFAULT_MAX_DURATION_MS,
      fightcadeDir: undefined,
      verbose: false,
    });
  });
  it('reads every option', () => {
    expect(parseCli(['-o', '/tmp/x.mp4', '--scale', 'smooth', '--max-duration', '20m', '--fightcade-dir', '/F', '-v', '1-2'])).toEqual({
      command: 'convert',
      input: '1-2',
      output: '/tmp/x.mp4',
      scale: 'smooth',
      maxDurationMs: 1_200_000,
      fightcadeDir: '/F',
      verbose: true,
    });
  });
  it('parses the emulator commands', () => {
    expect(parseCli(['update-emulator'])).toEqual({ command: 'update-emulator', fightcadeDir: undefined, verbose: false });
    expect(parseCli(['rebuild-emulator', '--fightcade-dir', '/F'])).toEqual({ command: 'rebuild-emulator', fightcadeDir: '/F', verbose: false });
  });
  it('parses prepare', () => {
    expect(parseCli(['prepare'])).toEqual({ command: 'prepare', verbose: false });
    expect(parseCli(['prepare', '-v'])).toEqual({ command: 'prepare', verbose: true });
  });
  it('parses serve, with FC2MP4_HOST as the default host', () => {
    expect(parseCli(['serve'], {})).toEqual({ command: 'serve', port: 8080, host: '127.0.0.1', fightcadeDir: undefined, keepMs: undefined, verbose: false });
    expect(parseCli(['serve', '--port', '9000', '--host', '0.0.0.0', '--fightcade-dir', '/F', '-v'], {})).toEqual({
      command: 'serve', port: 9000, host: '0.0.0.0', fightcadeDir: '/F', keepMs: undefined, verbose: true,
    });
    expect(parseCli(['serve'], { FC2MP4_HOST: '0.0.0.0' })).toMatchObject({ host: '0.0.0.0' });
    expect(parseCli(['serve', '--keep', '7d'], {})).toMatchObject({ keepMs: 7 * 24 * 60 * 60_000 });
    expect(parseCli(['serve', '--keep', '12h'], {})).toMatchObject({ keepMs: 12 * 60 * 60_000 });
  });
  it('returns help', () => {
    expect(parseCli(['--help'])).toEqual({ command: 'help' });
  });
  it.each([[[]], [['a', 'b']], [['--scale', 'blurry', '1-2']], [['--bogus', '1-2']], [['rebuild-emulator', 'x']], [['update-emulator', 'x']], [['prepare', 'x']], [['serve', 'x']], [['serve', '--port', '0']], [['serve', '--port', 'abc']], [['serve', '--keep', '7']], [['serve', '--keep', '0d']], [['serve', '--keep', 'abc']], [['--keep', '7d', '1-2']]])('rejects %j', (argv) => {
    expect(usageError(argv)).toMatchObject({ exitCode: ExitCode.Usage });
  });
});

describe('formatReplayLength', () => {
  it('turns a frame count into m:ss of replay', () => {
    expect(formatReplayLength(8220)).toBe('2:18');
    expect(formatReplayLength(32760)).toBe('9:10');
    expect(formatReplayLength(0)).toBe('0:00');
  });
});
