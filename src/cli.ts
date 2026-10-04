#!/usr/bin/env node
import { formatReplayLength, parseCli, USAGE } from './cliArgs.js';
import { buildEmulatorLocally, convert, prepare, updateEmulator, type ProgressEvent } from './convert.js';
import { ConvertError, ExitCode } from './errors.js';
import { serve } from './server/serve.js';
import { installSignalHandlers } from './signals.js';

declare const __FC2MP4_VERSION__: string | undefined;

function progressLine(e: ProgressEvent): string {
  switch (e.phase) {
    case 'preparing':
      return 'Preparing ffmpeg and the emulator (the first run downloads them)…';
    case 'setting-up-wine':
      return 'Setting up Wine (first run, about a minute)…';
    case 'connecting':
      return 'Connecting to the replay stream…';
    case 'capturing': {
      const seconds = e.frames / 59.59;
      const speed = e.elapsedMs > 0 ? (seconds * 1000) / e.elapsedMs : 0;
      return `Capturing… ${Math.round(seconds)}s of replay (${e.frames} frames, ×${speed.toFixed(1)})`;
    }
    case 'finalizing':
      return 'Finalizing the MP4…';
  }
}

async function main(): Promise<number> {
  const controller = new AbortController();
  installSignalHandlers(process, controller, (msg) => process.stderr.write(msg), (code) => process.exit(code));

  const tty = process.stderr.isTTY;
  const log = (msg: string) => process.stderr.write(`${tty ? '\n' : ''}${msg}\n`);
  if (process.argv.includes('--version')) {
    process.stdout.write(`${typeof __FC2MP4_VERSION__ === 'string' ? __FC2MP4_VERSION__ : 'dev'}\n`);
    return 0;
  }
  try {
    const request = parseCli(process.argv.slice(2));
    if (request.command === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const debug = request.verbose ? (msg: string) => process.stderr.write(`[debug] ${msg}\n`) : undefined;
    if (request.command === 'serve') {
      await serve({ port: request.port, host: request.host, fightcadeDir: request.fightcadeDir, signal: controller.signal, log: (msg) => process.stderr.write(`${msg}\n`) });
      return controller.signal.aborted ? ExitCode.Interrupted : 0;
    }
    if (request.command === 'prepare') {
      const result = await prepare({ signal: controller.signal, log, onProgress: (e) => process.stderr.write(`${progressLine(e)}\n`) });
      process.stdout.write(result.emulatorUpdated ? 'Ready (emulator downloaded).\n' : 'Ready.\n');
      return result.warning ? ExitCode.Emulator : 0;
    }
    if (request.command !== 'convert') {
      const run = request.command === 'update-emulator' ? updateEmulator : buildEmulatorLocally;
      const result = await run({ fightcadeDir: request.fightcadeDir, log });
      process.stdout.write(result.updated ? 'Emulator updated.\n' : 'Emulator already up to date.\n');
      return result.warning ? ExitCode.Emulator : 0;
    }
    const result = await convert(request.input, {
      output: request.output,
      scale: request.scale,
      maxDurationMs: request.maxDurationMs,
      fightcadeDir: request.fightcadeDir,
      signal: controller.signal,
      log,
      debug,
      onProgress: (e) => process.stderr.write(tty ? `\r\x1b[K${progressLine(e)}` : `${progressLine(e)}\n`),
    });
    if (tty) process.stderr.write('\n');
    process.stderr.write(`Captured ${formatReplayLength(result.frames)} of replay.\n`);
    process.stdout.write(`${result.output}\n`);
    return 0;
  } catch (err) {
    if (tty) process.stderr.write('\n');
    if (err instanceof ConvertError) {
      process.stderr.write(`Error: ${err.message}\n`);
      if (err.hint) process.stderr.write(`Hint: ${err.hint}\n`);
      return err.exitCode;
    }
    process.stderr.write(`Unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 1;
  }
}

main().then((code) => {
  process.exitCode = code;
});
