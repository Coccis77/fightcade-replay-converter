#!/usr/bin/env node
import { parseCli, USAGE } from './cliArgs.js';
import { convert, rebuildEmulator, type ProgressEvent } from './convert.js';
import { ConvertError, ExitCode } from './errors.js';

function progressLine(e: ProgressEvent): string {
  switch (e.phase) {
    case 'preparing-emulator':
      return 'Preparing the emulator (a rebuild takes about a minute)…';
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
  let interrupts = 0;
  process.on('SIGINT', () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(ExitCode.Interrupted);
    process.stderr.write('\nStopping (Ctrl-C again to force quit)…\n');
    controller.abort();
  });
  process.on('SIGTERM', () => controller.abort());

  const tty = process.stderr.isTTY;
  const log = (msg: string) => process.stderr.write(`${tty ? '\n' : ''}${msg}\n`);
  try {
    const request = parseCli(process.argv.slice(2));
    if (request.command === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const debug = request.verbose ? (msg: string) => process.stderr.write(`[debug] ${msg}\n`) : undefined;
    if (request.command === 'rebuild-emulator') {
      const result = await rebuildEmulator({ fightcadeDir: request.fightcadeDir, log });
      process.stdout.write(result.rebuilt ? 'Emulator rebuilt.\n' : 'Kept the previous emulator build.\n');
      return 0;
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

process.exitCode = await main();
