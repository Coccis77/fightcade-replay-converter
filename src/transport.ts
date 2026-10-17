import { closeSync, constants, createReadStream, openSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

// Under Wine, POSIX paths are reachable through drive Z:.
export function winPath(p: string): string {
  return `Z:${p.replace(/\//g, '\\')}`;
}

export interface VideoTransport {
  emulatorPath: string; // what FC2MP4_VIDEO is set to
  encoderInput: string; // ffmpeg -i argument
  attach(stdin: Writable): void; // connect the encoder's stdin (named pipe only)
  close(): Promise<void>;
}

// fc2mp4 reads the FIFO itself and relays it to ffmpeg's stdin (as on Windows), so the emulator's
// open of the FIFO never waits for ffmpeg: fc2mp4 can read the game's format before starting it.
// Until attach() the stream is not read; the emulator waits on the full pipe and nothing is lost.
export async function fifoTransport(dir: string, makeFifo: (p: string) => Promise<void>): Promise<VideoTransport> {
  const fifo = join(dir, 'video.fifo');
  await makeFifo(fifo);
  let opened = false;
  const stream = createReadStream(fifo); // the open completes when the emulator opens its end
  stream.on('open', () => (opened = true));
  stream.on('error', () => {});
  return {
    emulatorPath: winPath(fifo),
    encoderInput: 'pipe:0',
    attach: (stdin) => relay(stream, stdin),
    close: async () => {
      // No writer ever came: open the write end once so the pending read-side open returns
      // (otherwise it blocks a libuv thread and Node never exits).
      if (!opened) {
        try {
          closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
        } catch {
          // already unblocked
        }
      }
      stream.destroy();
    },
  };
}

// Pipe the emulator's bytes into the encoder. A broken connection (emulator killed or crashed)
// ends the encoder input instead of crashing Node with an unhandled 'error' event.
export function relay(source: Readable, target: Writable): void {
  source.on('error', () => target.end());
  source.pipe(target);
}

export function pipeName(pid: number, random: string): string {
  return `\\\\.\\pipe\\fc2mp4-${pid}-${random}`;
}

// Node serves the pipe; the emulator fopen()s it as a client; bytes are relayed to ffmpeg's stdin.
export async function pipeTransport(pipePath: string): Promise<VideoTransport> {
  let socket: Socket | null = null;
  let target: Writable | null = null;
  const server = createServer((incoming) => {
    if (socket) {
      incoming.destroy();
      return;
    }
    socket = incoming;
    if (target) relay(incoming, target);
  });
  if (!pipePath.startsWith('\\\\.\\pipe\\')) await rm(pipePath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, () => resolve());
  });
  return {
    emulatorPath: pipePath,
    encoderInput: 'pipe:0',
    attach(stdin) {
      target = stdin;
      if (socket) relay(socket, stdin);
    },
    close: () =>
      new Promise((resolve) => {
        socket?.destroy();
        server.close(() => resolve());
      }),
  };
}
