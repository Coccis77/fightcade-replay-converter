import { connect } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { fifoTransport, pipeName, pipeTransport, relay } from '../src/transport.js';

// On macOS a Unix domain socket stands in for \\.\pipe\…: same node:net API.
async function socketPath(): Promise<string> {
  if (process.platform === 'win32') return pipeName(process.pid, String(Math.random()).slice(2, 8));
  return join(await mkdtemp(join(tmpdir(), 'fc2mp4-pipe-')), 'video.sock');
}

function slowSink() {
  const chunks: Buffer[] = [];
  let finished = false;
  const sink = new Writable({
    highWaterMark: 1024,
    write(chunk, _enc, done) {
      chunks.push(chunk);
      // Asynchronous ack keeps back-pressure; setImmediate, not setTimeout (≈15 ms ticks on Windows).
      setImmediate(done);
    },
    final(done) {
      finished = true;
      done();
    },
  });
  return { sink, data: () => Buffer.concat(chunks), finished: () => finished };
}

describe('pipeTransport', () => {
  it('relays every byte in order into the encoder input and ends it when the emulator closes', async () => {
    const transport = await pipeTransport(await socketPath());
    expect(transport.encoderInput).toBe('pipe:0');
    const { sink, data, finished } = slowSink();
    // Listen before any byte flows: with fast acks the sink can finish before the client closes.
    const sinkFinished = new Promise<void>((resolve) => sink.on('finish', () => resolve()));
    transport.attach(sink);

    const payload = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    await new Promise<void>((resolve) => {
      const client = connect(transport.emulatorPath, () => client.end(payload));
      client.on('close', () => resolve());
    });
    await sinkFinished;

    expect(finished()).toBe(true);
    expect(data().equals(payload)).toBe(true);
    await transport.close();
  }, 20_000);

  it('works when the encoder is attached after the emulator connected', async () => {
    const transport = await pipeTransport(await socketPath());
    const client = connect(transport.emulatorPath);
    await new Promise((resolve) => client.on('connect', resolve));
    client.write(Buffer.from('frame-1'));
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (c) => chunks.push(c));
    transport.attach(out);
    client.end(Buffer.from('frame-2'));
    await new Promise((resolve) => out.on('end', resolve));
    expect(Buffer.concat(chunks).toString()).toBe('frame-1frame-2');
    await transport.close();
  });

  it('close() releases the pipe even if the emulator never connected', async () => {
    const path = await socketPath();
    const transport = await pipeTransport(path);
    await transport.close();
    const again = await pipeTransport(path);
    await again.close();
  });
});

describe('fifoTransport', () => {
  it('makes the FIFO and maps it onto Wine drive Z:', async () => {
    const made: string[] = [];
    const t = await fifoTransport('/tmp/run x', async (p) => {
      made.push(p);
    });
    expect(made).toEqual(['/tmp/run x/video.fifo']);
    expect(t.emulatorPath).toBe('Z:\\tmp\\run x\\video.fifo');
    expect(t.encoderInput).toBe('/tmp/run x/video.fifo');
  });
});

describe('pipeName', () => {
  it('builds a Windows named pipe path', () => {
    expect(pipeName(1234, 'ab12')).toBe('\\\\.\\pipe\\fc2mp4-1234-ab12');
  });
});

describe('relay', () => {
  it('ends the encoder input instead of crashing when the emulator connection errors', async () => {
    const source = new PassThrough();
    const target = new PassThrough();
    const chunks: Buffer[] = [];
    target.on('data', (c) => chunks.push(c));
    relay(source, target);
    source.write('partial frame');
    source.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    await new Promise((resolve) => target.on('end', resolve));
    expect(Buffer.concat(chunks).toString()).toBe('partial frame');
  });
});
