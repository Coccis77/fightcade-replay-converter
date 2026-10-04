import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathExists } from '../../src/fsUtil.js';
import { createHandler } from '../../src/server/http.js';
import { Jobs, type JobRunner } from '../../src/server/jobs.js';

const ID = '1791006077129-2245';
const LINK = `https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}`;
let server: Server | undefined;

async function start(run: JobRunner) {
  const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-http-'));
  const jobs = new Jobs({ outputDir: dir, exists: pathExists, run });
  server = createServer(createHandler(jobs));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: string) => fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  return { base, jobs, post };
}

const writesMp4: JobRunner = async (_id, output) => {
  await writeFile(output, 'MP4DATA');
};

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

describe('web page routes', () => {
  it('serves the page, and its script is valid JavaScript', async () => {
    const { base } = await start(writesMp4);
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('Paste a Fightcade replay link');
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1]!;
    expect(() => new Function(script)).not.toThrow();
  });

  it('converts a pasted link and serves the MP4 as a download', async () => {
    const { base, jobs, post } = await start(writesMp4);
    const created = await post(JSON.stringify({ url: LINK }));
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ id: ID });
    await jobs.idle();
    expect(await (await fetch(`${base}/api/jobs/${ID}`)).json()).toEqual({ state: 'done' });
    const file = await fetch(`${base}/api/jobs/${ID}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('video/mp4');
    expect(file.headers.get('content-disposition')).toBe(`attachment; filename="${ID}.mp4"`);
    expect(file.headers.get('content-length')).toBe('7');
    expect(await file.text()).toBe('MP4DATA');
  });

  it('answers "not ready" while converting', async () => {
    let finish!: () => void;
    const { base, post } = await start(() => new Promise<void>((resolve) => (finish = resolve)));
    await post(JSON.stringify({ url: ID }));
    expect(await (await fetch(`${base}/api/jobs/${ID}`)).json()).toMatchObject({ state: 'converting' });
    expect((await fetch(`${base}/api/jobs/${ID}/file`)).status).toBe(404);
    finish();
  });

  it('refuses an invalid link with the same message as the CLI', async () => {
    const { post } = await start(writesMp4);
    const res = await post(JSON.stringify({ url: 'hello' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('Not a Fightcade replay link'), hint: expect.any(String) });
  });

  it('refuses malformed requests and keeps running', async () => {
    const { base, post } = await start(writesMp4);
    expect((await post('not json')).status).toBe(400);
    expect((await post(JSON.stringify({ link: LINK }))).status).toBe(400);
    expect((await post(JSON.stringify({ url: 'x'.repeat(5000) }))).status).toBe(413);
    expect((await fetch(`${base}/`)).status).toBe(200);
  });

  it('never lets a request reach other files', async () => {
    const { base } = await start(writesMp4);
    for (const path of ['/api/jobs/..%2F..%2Fetc%2Fpasswd/file', '/api/jobs/../../etc/passwd', `/api/jobs/${ID}/file`, '/api/jobs/abc', '/nope']) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    }
  });
});
