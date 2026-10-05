import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConvertError, ExitCode } from '../../src/errors.js';
import { externalAddresses, resetAdmin, serve, type ServeDeps } from '../../src/server/serve.js';

function fakeDeps(over: Partial<ServeDeps> = {}): ServeDeps & { runs: string[] } {
  const runs: string[] = [];
  return {
    runs,
    outputDir: '/videos',
    exists: async () => false,
    startup: async () => {},
    checkWritable: async () => {},
    cleanup: { list: async () => [], mtimeMs: async () => 0, remove: async () => {}, now: () => 0 },
    schedule: () => () => {},
    addresses: () => [],
    dataFile: join(tmpdir(), `fc2mp4-serve-${process.pid}-${Math.random()}.json`),
    inDocker: false,
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
      let startedUp = false;
      const deps = fakeDeps({ startup: async () => void (startedUp = true) });
      await expect(serve({ port, host: '127.0.0.1', signal: new AbortController().signal, log: () => {} }, deps)).rejects.toMatchObject({
        exitCode: ExitCode.Preflight,
        message: `Port ${port} is already in use`,
        hint: expect.stringContaining('--port'),
      });
      expect(startedUp).toBe(false); // checked before the (possibly minute-long) startup
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
    const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: 'password1' }) });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    for (const url of ['1700000000000-1111', '1700000000000-2222']) {
      await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ url }) });
    }
    controller.abort();
    await running;
    expect(runs).toEqual(['1700000000000-1111']);
  });

  it('cleans the output folder at startup and every hour when --keep is set', async () => {
    const DAY = 24 * 60 * 60_000;
    const NOW = Date.parse('2026-10-10T12:00:00Z');
    const files: Record<string, number> = { '1700000000000-1111.mp4': NOW - 8 * DAY };
    const removed: string[] = [];
    let tick: (() => void) | undefined;
    let every = 0;
    const logs: string[] = [];
    const controller = new AbortController();
    const deps = fakeDeps({
      cleanup: {
        list: async () => Object.keys(files),
        mtimeMs: async (p) => files[p.split('/').at(-1)!]!,
        remove: async (p) => {
          removed.push(p.split('/').at(-1)!);
          delete files[p.split('/').at(-1)!];
        },
        now: () => NOW,
      },
      schedule: (fn, ms) => {
        tick = fn;
        every = ms;
        return () => (tick = undefined);
      },
    });
    const running = serve({ port: 0, host: '127.0.0.1', keepMs: 7 * DAY, signal: controller.signal, log: (m) => logs.push(m) }, deps);
    await started(logs);
    await expect.poll(() => removed).toEqual(['1700000000000-1111.mp4']);
    expect(logs).toContain('Deleted 1700000000000-1111.mp4 (8 days old)');
    expect(every).toBe(60 * 60_000);
    files['1700000000000-2222.mp4'] = NOW - 9 * DAY;
    tick!();
    await expect.poll(() => removed).toEqual(['1700000000000-1111.mp4', '1700000000000-2222.mp4']);
    controller.abort();
    await running;
    expect(tick).toBeUndefined();
  });

  it('never deletes anything without --keep', async () => {
    const listed: string[] = [];
    let scheduled = false;
    const logs: string[] = [];
    const controller = new AbortController();
    const deps = fakeDeps({
      cleanup: { list: async (d) => (listed.push(d), []), mtimeMs: async () => 0, remove: async () => {}, now: () => 0 },
      schedule: () => ((scheduled = true), () => {}),
    });
    const running = serve({ port: 0, host: '127.0.0.1', signal: controller.signal, log: (m) => logs.push(m) }, deps);
    await started(logs);
    controller.abort();
    await running;
    expect(listed).toEqual([]);
    expect(scheduled).toBe(false);
  });

  it('explains an address that is not on this machine', async () => {
    await expect(serve({ port: 0, host: '203.0.113.1', signal: new AbortController().signal, log: () => {} }, fakeDeps())).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: 'This machine has no address 203.0.113.1',
      hint: expect.stringContaining('--host'),
    });
  });

  it('shows the network addresses other devices can use when listening on all of them', async () => {
    const logs: string[] = [];
    const controller = new AbortController();
    const running = serve({ port: 0, host: '0.0.0.0', signal: controller.signal, log: (m) => logs.push(m) }, fakeDeps({ addresses: () => ['192.168.1.20'] }));
    const base = await started(logs);
    const port = base.split(':').at(-1);
    expect(logs).toContain(`Other devices: http://192.168.1.20:${port}`);
    controller.abort();
    await running;
  });

  it('in Docker, points other devices to the computer address instead of the container one', async () => {
    const logs: string[] = [];
    const controller = new AbortController();
    const running = serve({ port: 0, host: '0.0.0.0', signal: controller.signal, log: (m) => logs.push(m) }, fakeDeps({ addresses: () => ['172.17.0.2'], inDocker: true }));
    const base = await started(logs);
    const port = base.split(':').at(-1);
    expect(logs).toContain(`Other devices: use this computer's network address, port ${port}`);
    expect(logs.some((l) => l.includes('172.17.0.2'))).toBe(false);
    controller.abort();
    await running;
  });

  it('gives a serve hint (no -o) when the output folder is not writable', async () => {
    const deps = fakeDeps({
      checkWritable: async () => {
        throw new ConvertError(ExitCode.Preflight, 'Cannot write to /videos', 'Choose another folder with -o, or make this one writable');
      },
    });
    const err = await serve({ port: 0, host: '127.0.0.1', signal: new AbortController().signal, log: () => {} }, deps).catch((e: ConvertError) => e);
    expect(err).toMatchObject({ message: 'Cannot write to /videos', hint: expect.stringContaining('FC2MP4_OUTPUT_DIR') });
    expect((err as ConvertError).hint).not.toContain('-o');
  });

  it('answers "starting" during startup, and a failed startup frees the port and reports its error', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));

    let fail!: (err: unknown) => void;
    const deps = fakeDeps({ startup: () => new Promise<void>((_resolve, reject) => (fail = reject)) });
    const running = serve({ port, host: '127.0.0.1', signal: new AbortController().signal, log: () => {} }, deps);
    let res: Response | undefined;
    for (let i = 0; i < 50 && !res; i++) {
      res = await fetch(`http://127.0.0.1:${port}/api/jobs/1-2`).catch(() => undefined);
      if (!res) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(res!.status).toBe(503);
    expect(await res!.json()).toEqual({ error: 'fc2mp4 is starting, try again in a moment' });

    fail(new ConvertError(ExitCode.Preflight, 'Fightcade files not found'));
    await expect(running).rejects.toMatchObject({ message: 'Fightcade files not found' });
    const again = createServer();
    await new Promise<void>((resolve, reject) => {
      again.once('error', reject);
      again.listen(port, '127.0.0.1', resolve);
    });
    again.close();
  });
  it('refuses to start on a damaged data file, and names it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-data-'));
    const dataFile = join(dir, 'fc2mp4-data.json');
    await writeFile(dataFile, '{ broken');
    await expect(serve({ port: 0, host: '127.0.0.1', signal: new AbortController().signal, log: () => {} }, fakeDeps({ dataFile }))).rejects.toMatchObject({
      message: `The data file is damaged: ${dataFile}`,
    });
  });

  it('reset-admin removes the admin so /admin offers the setup again', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-data-'));
    const dataFile = join(dir, 'fc2mp4-data.json');
    const logs: string[] = [];
    const controller = new AbortController();
    const running = serve({ port: 0, host: '127.0.0.1', signal: controller.signal, log: (m) => logs.push(m) }, fakeDeps({ dataFile }));
    const base = (await started(logs)).replace('localhost', '127.0.0.1');
    await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: 'password1' }) });
    expect(await resetAdmin(dataFile)).toBe(true);
    expect(await (await fetch(`${base}/api/state`)).json()).toEqual({ setUp: false, user: null });
    controller.abort();
    await running;
  });

  it('removes deleted MP4s from the shared list when --keep cleans the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-data-'));
    const dataFile = join(dir, 'fc2mp4-data.json');
    const DAY = 24 * 60 * 60_000;
    const NOW = Date.now();
    const files: Record<string, number> = {};
    let tick: (() => void) | undefined;
    const logs: string[] = [];
    const controller = new AbortController();
    const deps = fakeDeps({
      dataFile,
      cleanup: {
        list: async () => Object.keys(files),
        mtimeMs: async (p) => files[p.split('/').at(-1)!]!,
        remove: async (p) => void delete files[p.split('/').at(-1)!],
        now: () => NOW,
      },
      schedule: (fn) => ((tick = fn), () => (tick = undefined)),
    });
    const running = serve({ port: 0, host: '127.0.0.1', keepMs: 7 * DAY, signal: controller.signal, log: (m) => logs.push(m) }, deps);
    const base = (await started(logs)).replace('localhost', '127.0.0.1');
    const setup = await fetch(`${base}/api/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'admin', password: 'password1' }) });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie }, body: JSON.stringify({ url: '1700000000000-1111' }) });
    await expect.poll(async () => ((await (await fetch(`${base}/api/conversions`, { headers: { cookie } })).json()) as { conversions: { state: string }[] }).conversions[0]?.state).toBe('done');
    files['1700000000000-1111.mp4'] = NOW - 8 * DAY;
    tick!();
    await expect.poll(async () => ((await (await fetch(`${base}/api/conversions`, { headers: { cookie } })).json()) as { conversions: unknown[] }).conversions.length).toBe(0);
    controller.abort();
    await running;
  });

  it('keeps running when the hourly cleanup hits a store error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-data-'));
    const dataFile = join(dir, 'fc2mp4-data.json');
    const DAY = 24 * 60 * 60_000;
    const NOW = Date.now();
    const files: Record<string, number> = { '1700000000000-1111.mp4': NOW - 8 * DAY };
    let tick: (() => void) | undefined;
    const logs: string[] = [];
    const controller = new AbortController();
    const deps = fakeDeps({
      dataFile,
      cleanup: { list: async () => Object.keys(files), mtimeMs: async () => NOW - 8 * DAY, remove: async (p) => void delete files[p.split('/').at(-1)!], now: () => NOW },
      schedule: (fn) => ((tick = fn), () => (tick = undefined)),
    });
    const running = serve({ port: 0, host: '127.0.0.1', keepMs: 7 * DAY, signal: controller.signal, log: (m) => logs.push(m) }, deps);
    const base = (await started(logs)).replace('localhost', '127.0.0.1');
    await expect.poll(() => logs.some((l) => l.startsWith('Deleted'))).toBe(true);
    await fetch(`${base}/api/state`); // queued behind the first cleanup's save: it has finished
    await writeFile(dataFile, '{ broken');
    files['1700000000000-2222.mp4'] = NOW - 8 * DAY;
    tick!();
    await expect.poll(() => logs.some((l) => l.startsWith('Cleanup failed'))).toBe(true);
    expect((await fetch(`${base}/`)).status).toBe(200);
    controller.abort();
    await running;
  });
});

describe('externalAddresses', () => {
  it('keeps the Wi-Fi/Ethernet addresses, not loopback, IPv6 or virtual networks (Docker, VMs, VPNs)', () => {
    const v4 = (address: string, internal = false) => ({ address, family: 'IPv4' as const, internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null });
    const v6 = (address: string) => ({ address, family: 'IPv6' as const, internal: false, netmask: 'ffff::', mac: '00:00:00:00:00:00', scopeid: 0, cidr: null });
    expect(
      externalAddresses({
        lo0: [v4('127.0.0.1', true)],
        en0: [v6('fe80::1'), v4('192.168.1.14')],
        bridge100: [v4('192.168.64.1')],
        docker0: [v4('172.17.0.1')],
        'br-1a2b3c': [v4('172.18.0.1')],
        veth12ab: [v4('169.254.1.1')],
        vmnet8: [v4('192.168.100.1')],
        vboxnet0: [v4('192.168.56.1')],
        utun3: [v4('10.8.0.2')],
        tun0: [v4('10.9.0.2')],
        tap0: [v4('10.10.0.2')],
        wg0: [v4('10.11.0.2')],
        zt0: [v4('10.12.0.2')],
        eth0: [v4('10.0.0.5')],
      }),
    ).toEqual(['192.168.1.14', '10.0.0.5']);
  });
});
