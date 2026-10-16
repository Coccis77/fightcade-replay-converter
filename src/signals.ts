import type { EventEmitter } from 'node:events';
import { ExitCode } from './errors.js';

// First Ctrl-C stops cleanly (emulator, Wine, ffmpeg, temp files); a second one forces the exit.
// SIGHUP (SSH session closed) and SIGTERM stop cleanly too, so a server never keeps Wine around.
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

// fc2mp4-ui.exe cannot send Ctrl-C on Windows: it closes our stdin instead (a crashed window closes it
// too). Same as the first Ctrl-C. The returned function stops watching and releases stdin, so the
// process can exit after a conversion although the window still holds the pipe open.
export function stopOnStdinClose(
  stdin: EventEmitter & { resume(): unknown; destroy(): unknown },
  controller: AbortController,
  write: (msg: string) => void,
): () => void {
  const stop = () => {
    if (controller.signal.aborted) return;
    write('\nStopping…\n');
    controller.abort();
  };
  stdin.on('end', stop);
  stdin.on('close', stop);
  stdin.on('error', stop);
  stdin.resume();
  return () => {
    stdin.off('end', stop);
    stdin.off('close', stop);
    stdin.off('error', stop);
    stdin.destroy();
  };
}
