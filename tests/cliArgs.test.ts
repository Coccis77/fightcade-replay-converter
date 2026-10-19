import { describe, expect, it } from 'vitest';
import { formatReplayLength, parseCli, parseDuration, prepareMessage, USAGE } from '../src/cliArgs.js';
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
      stopOnStdinClose: false,
      encoder: 'auto',
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
      stopOnStdinClose: false,
      encoder: 'auto',
      verbose: true,
    });
  });
  it('reads --encoder, auto by default', () => {
    expect(parseCli(['1-2'])).toMatchObject({ encoder: 'auto' });
    expect(parseCli(['1-2', '--encoder', 'nvenc'])).toMatchObject({ encoder: 'nvenc' });
    expect(usageError(['1-2', '--encoder', 'divx'])).toMatchObject({ exitCode: ExitCode.Usage, message: 'Invalid --encoder "divx"', hint: 'Use auto, x264, nvenc, qsv, amf, mf or videotoolbox' });
    expect(USAGE).toContain('--encoder <name>');
  });
  it('reads --stop-on-stdin-close for a conversion only', () => {
    expect(parseCli(['1-2', '--stop-on-stdin-close'])).toMatchObject({ command: 'convert', stopOnStdinClose: true });
    expect(usageError(['update-emulator', '--stop-on-stdin-close'])).toMatchObject({ exitCode: ExitCode.Usage, message: '--stop-on-stdin-close only works when converting a replay' });
    expect(usageError(['prepare', '--stop-on-stdin-close'])).toMatchObject({ exitCode: ExitCode.Usage });
  });
  it('documents --stop-on-stdin-close', () => {
    expect(USAGE).toContain('--stop-on-stdin-close Stop cleanly when standard input closes (for programs that run fc2mp4)');
  });
  it('parses the emulator commands', () => {
    expect(parseCli(['update-emulator'])).toEqual({ command: 'update-emulator', fightcadeDir: undefined, verbose: false });
    expect(parseCli(['rebuild-emulator', '--fightcade-dir', '/F'])).toEqual({ command: 'rebuild-emulator', fightcadeDir: '/F', verbose: false });
  });
  it('parses prepare', () => {
    expect(parseCli(['prepare'])).toEqual({ command: 'prepare', verbose: false });
    expect(parseCli(['prepare', '-v'])).toEqual({ command: 'prepare', verbose: true });
  });
  it('has no web server any more', () => {
    for (const option of ['--port', '--host', '--keep']) expect(usageError(['1-2', option, '1'])).toMatchObject({ exitCode: ExitCode.Usage });
    expect(USAGE).not.toMatch(/serve|reset-admin|--port|--host|--keep/);
  });
  it('returns help', () => {
    expect(parseCli(['--help'])).toEqual({ command: 'help' });
  });
  it.each([[[]], [['a', 'b']], [['--scale', 'blurry', '1-2']], [['--bogus', '1-2']], [['rebuild-emulator', 'x']], [['update-emulator', 'x']], [['prepare', 'x']]])('rejects %j', (argv) => {
    expect(usageError(argv)).toMatchObject({ exitCode: ExitCode.Usage });
  });
});

describe('formatReplayLength', () => {
  it('formats seconds of replay as m:ss', () => {
    expect(formatReplayLength(137.9)).toBe('2:18');
    expect(formatReplayLength(549.7)).toBe('9:10');
    expect(formatReplayLength(600)).toBe('10:00');
    expect(formatReplayLength(0)).toBe('0:00');
  });
});

describe('prepareMessage', () => {
  it('says Ready only when nothing went wrong', () => {
    expect(prepareMessage({ emulatorUpdated: true })).toBe('Ready (emulator downloaded).');
    expect(prepareMessage({ emulatorUpdated: false })).toBe('Ready.');
    expect(prepareMessage({ emulatorUpdated: false, warning: 'Could not check' })).toBeNull();
  });
});

describe('USAGE', () => {
  it('describes any FBNeo game and says a bare quark ID is 3rd Strike', () => {
    expect(USAGE).toContain('Records a Fightcade FBNeo replay to MP4 (macOS, Windows and Linux).');
    expect(USAGE).toContain('a quark ID alone means 3rd Strike');
    expect(USAGE).toContain('Vertical games are not supported yet.');
  });
});
