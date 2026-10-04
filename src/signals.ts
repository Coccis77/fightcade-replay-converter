import type { EventEmitter } from 'node:events';
import { ExitCode } from './errors.js';

// First Ctrl-C stops cleanly (emulator, Wine, ffmpeg, temp files); a second one forces the exit.
// SIGHUP (SSH session closed) and SIGTERM stop cleanly too, so a server never keeps Xvfb/Wine around.
export function installSignalHandlers(
  proc: EventEmitter,
  controller: AbortController,
  write: (msg: string) => void,
  exit: (code: number) => void,
): void {
  let interrupts = 0;
  proc.on('SIGINT', () => {
    interrupts += 1;
    if (interrupts > 1) {
      exit(ExitCode.Interrupted);
      return;
    }
    write('\nStopping (Ctrl-C again to force quit)…\n');
    controller.abort();
  });
  proc.on('SIGTERM', () => controller.abort());
  proc.on('SIGHUP', () => controller.abort());
}
