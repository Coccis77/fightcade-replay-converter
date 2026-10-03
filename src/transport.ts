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

export async function fifoTransport(dir: string, makeFifo: (p: string) => Promise<void>): Promise<VideoTransport> {
  const fifo = join(dir, 'video.fifo');
  await makeFifo(fifo);
  return { emulatorPath: winPath(fifo), encoderInput: fifo, attach: () => {}, close: async () => {} };
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
