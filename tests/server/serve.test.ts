import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { ConvertError, ExitCode } from '../../src/errors.js';
import { serve, type ServeDeps } from '../../src/server/serve.js';

function fakeDeps(over: Partial<ServeDeps> = {}): ServeDeps & { runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    outputDir: '/videos',
    exists: async () => false,
    startup: async () => {},
    checkWritable: async () => {},
    run: async (id) => {
      runs.push(id);
    },
    ...over,
  };
}

async function started(logs: string[]): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const line = logs.find((l) => l.startsWith('Open http://'));
    if (line) return line.slice('Open '.length);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('server never started');
}

describe('serve', () => {
  it('checks everything before listening, then serves until stopped', async () => {
    const order: string[] = [];
    const logs: string[] = [];
    const controller = new AbortController();
    const deps = fakeDeps({ startup: async () => void order.push('startup') });
    const running = serve({ port: 0, host: '127.0.0.1', signal: controller.signal, log: (m) => logs.push(m) }, deps);
    const base = await started(logs);
    order.push('listening');
    expect(base).toMatch(/^http:\/\/localhost:\d+$/);
    expect((await fetch(`${base.replace('localhost', '127.0.0.1')}/`)).status).toBe(200);
    controller.abort();
    await running;
    expect(order).toEqual(['startup', 'listening']);
  });

  it('fails before listening when the startup checks fail', async () => {
    const logs: string[] = [];
    const deps = fakeDeps({
      startup: async () => {
        throw new ConvertError(ExitCode.Preflight, 'Fightcade files not found');
      },
    });
    await expect(serve({ port: 0, host: '127.0.0.1', signal: new AbortController().signal, log: (m) => logs.push(m) }, deps)).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
    });
    expect(logs.some((l) => l.startsWith('Open'))).toBe(false);
  });

  it('fails before listening when the output folder is not writable', async () => {
    const logs: string[] = [];
    const deps = fakeDeps({
      checkWritable: async (dir) => {
        throw new ConvertError(ExitCode.Preflight, `Cannot write to ${dir}`);
      },
    });
    await expect(serve({ port: 0, host: '127.0.0.1', signal: new AbortController().signal, log: (m) => logs.push(m) }, deps)).rejects.toMatchObject({
      message: 'Cannot write to /videos',
    });
    expect(logs.some((l) => l.startsWith('Open'))).toBe(false);
  });

  it('reports a port already in use', async () => {
    const other = createServer();
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const port = (other.address() as AddressInfo).port;
    try {
      await expect(serve({ port, host: '127.0.0.1', signal: new AbortController().signal, log: () => {} }, fakeDeps())).rejects.toMatchObject({
        exitCode: ExitCode.Preflight,
        message: `Port ${port} is already in use`,
        hint: expect.stringContaining('--port'),
      });
    } finally {
      other.close();
    }
  });

  it('stops the conversion and drops the queue on Ctrl-C', async () => {
    const logs: string[] = [];
    const controller = new AbortController();
    const runs: string[] = [];
    const deps = fakeDeps({
      run: (id) =>
        new Promise<void>((_resolve, reject) => {
          runs.push(id);
          controller.signal.addEventListener('abort', () => reject(new ConvertError(ExitCode.Interrupted, 'Interrupted')));
        }),
    });
    const running = serve({ port: 0, host: '127.0.0.1', signal: controller.signal, log: (m) => logs.push(m) }, deps);
    const base = (await started(logs)).replace('localhost', '127.0.0.1');
    for (const url of ['1700000000000-1111', '1700000000000-2222']) {
      await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
    }
    controller.abort();
    await running;
    expect(runs).toEqual(['1700000000000-1111']);
  });
});
