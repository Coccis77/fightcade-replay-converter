// Run by tests/transport.test.ts in a real process: the emulator's end of the FIFO stays open (as when
// killing the emulator failed) while fc2mp4 relays it; close() must still let the process exit.
import { execFileSync } from 'node:child_process';
import { constants, mkdtempSync, openSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { fifoTransport } from '../../src/transport.js';

const dir = mkdtempSync(join(tmpdir(), 'fc2mp4-fifo-close-'));
const transport = await fifoTransport(dir, async (p) => {
  execFileSync('mkfifo', [p]);
});
const emulatorEnd = openSync(join(dir, 'video.fifo'), constants.O_WRONLY); // never closed
writeSync(emulatorEnd, Buffer.alloc(1024));
const encoder = new PassThrough();
encoder.resume();
transport.attach(encoder);
setTimeout(() => {
  void transport.close().then(() => process.stdout.write('closed\n'));
}, 200);
