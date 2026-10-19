import { parseArgs } from 'node:util';
import { DEFAULT_MAX_DURATION_MS } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import { ENCODER_CHOICES, type EncoderChoice, type ScaleMode } from './ffmpeg.js';

export const USAGE = `Usage: fc2mp4 <replay-link-or-quarkId> [options]
       fc2mp4 update-emulator [--fightcade-dir <p>] [-v]
       fc2mp4 rebuild-emulator [--fightcade-dir <p>] [-v]
       fc2mp4 prepare [-v]

Records a Fightcade FBNeo replay to MP4 (macOS, Windows and Linux).
Pass the replay link; a quark ID alone means 3rd Strike. Vertical games are not supported yet.

  -o, --output <path>       MP4 file, or an existing folder
                            (default: FC2MP4_OUTPUT_DIR, else ~/Movies/Fightcade, %USERPROFILE%\\Videos\\Fightcade or ~/Videos/Fightcade)
      --scale sharp|smooth  Upscaling style (default: sharp)
      --encoder <name>      Video encoder: auto (default: NVIDIA's nvenc on Windows when available, else x264),
                            x264 (CPU), nvenc (NVIDIA), qsv (Intel), amf (AMD), mf (Windows, any GPU),
                            videotoolbox (macOS)
      --max-duration <d>    Stop capturing after this long: 90s, 45m, 1h (default: 60m)
      --fightcade-dir <p>   Fightcade install (FightCade2.app on macOS, the Fightcade folder on Windows;
                            on Linux a Fightcade folder or its emulator/fbneo folder, also FC2MP4_FIGHTCADE_DIR)
      --stop-on-stdin-close Stop cleanly when standard input closes (for programs that run fc2mp4)
  -v, --verbose             Print debug details
  -h, --help                Show this help

update-emulator checks GitHub for a newer emulator build now (otherwise once a day).
rebuild-emulator builds the emulator locally (macOS, from a source checkout; needs mingw-w64).
prepare downloads the emulator and sets up Wine ahead of time (no Fightcade files needed; used by the Docker image).`;

export type CliRequest =
  | { command: 'help' }
  | { command: 'convert'; input: string; output?: string; scale: ScaleMode; maxDurationMs: number; fightcadeDir?: string; stopOnStdinClose: boolean; encoder: EncoderChoice; verbose: boolean }
  | { command: 'update-emulator' | 'rebuild-emulator'; fightcadeDir?: string; verbose: boolean }
  | { command: 'prepare'; verbose: boolean };

export function prepareMessage(result: { emulatorUpdated: boolean; warning?: string }): string | null {
  if (result.warning) return null; // the warning was printed; the exit code says it failed
  return result.emulatorUpdated ? 'Ready (emulator downloaded).' : 'Ready.';
}

export function formatReplayLength(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

// The last line of a conversion: the whole run's time (startup included) and its speed.
export function doneLine(replaySeconds: number, elapsedMs: number): string {
  const took = `Captured ${formatReplayLength(replaySeconds)} of replay in ${formatReplayLength(elapsedMs / 1000)}`;
  return elapsedMs > 0 ? `${took} (${((replaySeconds * 1000) / elapsedMs).toFixed(1)}× real time).` : `${took}.`;
}

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)([smhd])?$/.exec(text.trim());
  const ms = match ? Number(match[1]) * UNIT_MS[(match[2] ?? 'm') as keyof typeof UNIT_MS] : NaN;
  if (!(ms > 0)) throw new ConvertError(ExitCode.Usage, `Invalid duration "${text}"`, 'Use e.g. 90s, 45m or 1h');
  return ms;
}

function usage(message: string): ConvertError {
  return new ConvertError(ExitCode.Usage, message, 'Run fc2mp4 --help');
}

export function parseCli(argv: string[], env: Record<string, string | undefined> = process.env): CliRequest {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: 'string', short: 'o' },
        scale: { type: 'string' },
        encoder: { type: 'string' },
        'max-duration': { type: 'string' },
        'fightcade-dir': { type: 'string' },
        'stop-on-stdin-close': { type: 'boolean' },
        verbose: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    throw usage((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { command: 'help' };
  const verbose = values.verbose ?? false;

  const command = positionals[0];
  const nonConvert = ['prepare', 'update-emulator', 'rebuild-emulator'];
  if (values['stop-on-stdin-close'] && command !== undefined && nonConvert.includes(command)) {
    throw usage('--stop-on-stdin-close only works when converting a replay');
  }
  if (command === 'prepare') {
    if (positionals.length !== 1) throw usage('prepare takes no arguments');
    return { command, verbose };
  }
  if (command === 'update-emulator' || command === 'rebuild-emulator') {
    if (positionals.length !== 1) throw usage(`${command} takes no arguments`);
    return { command, fightcadeDir: values['fightcade-dir'], verbose };
  }
  if (positionals.length !== 1) throw usage('Expected exactly one replay link or quark ID');
  const scale = values.scale ?? 'sharp';
  const encoder = (values.encoder ?? 'auto') as EncoderChoice;
  if (!ENCODER_CHOICES.includes(encoder)) {
    throw new ConvertError(ExitCode.Usage, `Invalid --encoder "${values.encoder}"`, `Use ${ENCODER_CHOICES.slice(0, -1).join(', ')} or ${ENCODER_CHOICES.at(-1)}`);
  }
  if (scale !== 'sharp' && scale !== 'smooth') throw new ConvertError(ExitCode.Usage, `Invalid --scale "${scale}"`, 'Use sharp or smooth');
  return {
    command: 'convert',
    input: positionals[0]!,
    output: values.output,
    scale,
    maxDurationMs: values['max-duration'] ? parseDuration(values['max-duration']) : DEFAULT_MAX_DURATION_MS,
    fightcadeDir: values['fightcade-dir'],
    stopOnStdinClose: values['stop-on-stdin-close'] ?? false,
    encoder,
    verbose,
  };
}
