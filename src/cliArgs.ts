import { parseArgs } from 'node:util';
import { DEFAULT_MAX_DURATION_MS, FRAME_FORMAT } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import type { ScaleMode } from './ffmpeg.js';

export const USAGE = `Usage: fc2mp4 <replay-link-or-quarkId> [options]
       fc2mp4 update-emulator [--fightcade-dir <p>] [-v]
       fc2mp4 rebuild-emulator [--fightcade-dir <p>] [-v]
       fc2mp4 prepare [-v]
       fc2mp4 serve [--port <n>] [--host <addr>] [--keep <d>] [--fightcade-dir <p>] [-v]

Records a Fightcade Street Fighter III: 3rd Strike replay to MP4 (macOS, Windows and Linux).

  -o, --output <path>       MP4 file, or an existing folder
                            (default: FC2MP4_OUTPUT_DIR, else ~/Movies/Fightcade, %USERPROFILE%\\Videos\\Fightcade or ~/Videos/Fightcade)
      --scale sharp|smooth  Upscaling style (default: sharp)
      --max-duration <d>    Stop capturing after this long: 90s, 45m, 1h (default: 60m)
      --fightcade-dir <p>   Fightcade install (FightCade2.app on macOS, the Fightcade folder on Windows;
                            on Linux a Fightcade folder or its emulator/fbneo folder, also FC2MP4_FIGHTCADE_DIR)
  -v, --verbose             Print debug details
  -h, --help                Show this help

update-emulator checks GitHub for a newer emulator build now (otherwise once a day).
rebuild-emulator builds the emulator locally (macOS, from a source checkout; needs mingw-w64).
prepare downloads the emulator and sets up Wine ahead of time (no Fightcade files needed; used by the Docker image).
serve starts a small web page to convert replays from a browser (default http://localhost:8080; --host 0.0.0.0 or FC2MP4_HOST lets other devices in;
--keep 7d deletes its MP4s older than 7 days from the output folder, checked every hour).`;

export type CliRequest =
  | { command: 'help' }
  | { command: 'convert'; input: string; output?: string; scale: ScaleMode; maxDurationMs: number; fightcadeDir?: string; verbose: boolean }
  | { command: 'update-emulator' | 'rebuild-emulator'; fightcadeDir?: string; verbose: boolean }
  | { command: 'prepare'; verbose: boolean }
  | { command: 'serve'; port: number; host: string; fightcadeDir?: string; keepMs?: number; verbose: boolean };

export function prepareMessage(result: { emulatorUpdated: boolean; warning?: string }): string | null {
  if (result.warning) return null; // the warning was printed; the exit code says it failed
  return result.emulatorUpdated ? 'Ready (emulator downloaded).' : 'Ready.';
}

export function formatReplayLength(frames: number): string {
  const total = Math.round((frames * 100) / FRAME_FORMAT.fpsX100);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
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
        'max-duration': { type: 'string' },
        'fightcade-dir': { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        keep: { type: 'string' },
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
  if (command === 'prepare') {
    if (positionals.length !== 1) throw usage('prepare takes no arguments');
    return { command, verbose };
  }
  if (command === 'serve') {
    if (positionals.length !== 1) throw usage('serve takes no arguments');
    const port = values.port === undefined ? 8080 : Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw usage(`Invalid --port "${values.port}"`);
    let keepMs: number | undefined;
    if (values.keep !== undefined) {
      // A unit is required: a bare "7" would mean 7 minutes and delete far too early.
      if (!/[smhd]$/.test(values.keep.trim())) throw new ConvertError(ExitCode.Usage, `Invalid --keep "${values.keep}"`, 'Give a unit, e.g. 7d or 12h');
      keepMs = parseDuration(values.keep);
    }
    return { command, port, host: values.host || env.FC2MP4_HOST || '127.0.0.1', fightcadeDir: values['fightcade-dir'], keepMs, verbose };
  }
  for (const option of ['port', 'host', 'keep'] as const) {
    if (values[option] !== undefined) throw usage(`--${option} only works with fc2mp4 serve`);
  }
  if (command === 'update-emulator' || command === 'rebuild-emulator') {
    if (positionals.length !== 1) throw usage(`${command} takes no arguments`);
    return { command, fightcadeDir: values['fightcade-dir'], verbose };
  }
  if (positionals.length !== 1) throw usage('Expected exactly one replay link or quark ID');
  const scale = values.scale ?? 'sharp';
  if (scale !== 'sharp' && scale !== 'smooth') throw new ConvertError(ExitCode.Usage, `Invalid --scale "${scale}"`, 'Use sharp or smooth');
  return {
    command: 'convert',
    input: positionals[0]!,
    output: values.output,
    scale,
    maxDurationMs: values['max-duration'] ? parseDuration(values['max-duration']) : DEFAULT_MAX_DURATION_MS,
    fightcadeDir: values['fightcade-dir'],
    verbose,
  };
}
