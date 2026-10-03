import { describe, expect, it } from 'vitest';
import { parseCli, parseDuration } from '../src/cliArgs.js';
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
  it('parses the rebuild-emulator command', () => {
    expect(parseCli(['rebuild-emulator', '--fightcade-dir', '/F'])).toEqual({ command: 'rebuild-emulator', fightcadeDir: '/F', verbose: false });
  });
  it('returns help', () => {
    expect(parseCli(['--help'])).toEqual({ command: 'help' });
  });
  it.each([[[]], [['a', 'b']], [['--scale', 'blurry', '1-2']], [['--bogus', '1-2']], [['rebuild-emulator', 'x']]])('rejects %j', (argv) => {
    expect(usageError(argv)).toMatchObject({ exitCode: ExitCode.Usage });
  });
});
