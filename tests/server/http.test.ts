import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathExists } from '../../src/fsUtil.js';
import { Accounts } from '../../src/server/accounts.js';
import { LoginThrottle } from '../../src/server/auth.js';
import { createHandler } from '../../src/server/http.js';
import { Jobs, type JobRunner } from '../../src/server/jobs.js';
import { DataStore } from '../../src/server/store.js';

const ID = '1791006077129-2245';
const ID2 = '1790980205888-4792';
const ID3 = '1700000000000-3333';
const LINK = `https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}`;
let server: Server | undefined;
const logs: string[] = [];

const writesMp4: JobRunner = async (_id, output) => {
  await writeFile(output, 'MP4DATA');
};

async function start(run: JobRunner = writesMp4, existingDir?: string, removeFile?: (p: string, jobs: Jobs, accounts: Accounts) => Promise<void>) {
  const dir = existingDir ?? (await mkdtemp(join(tmpdir(), 'fc2mp4-http-')));
  const accounts = new Accounts(new DataStore(join(dir, 'fc2mp4-data.json')));
  const jobs = new Jobs({
    outputDir: dir,
    exists: pathExists,
    run,
    onFinish: (id, view) => void accounts.finish(id, view.state === 'done', view.state === 'failed' ? view.error : undefined),
  });
  server = createServer(createHandler({ jobs, accounts, throttle: new LoginThrottle(), removeFile: removeFile ? (p) => removeFile(p, jobs, accounts) : (p) => rm(p, { force: true }), trustProxy: false, log: (m) => logs.push(m) }));
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, dir, jobs, accounts };
}

// A browser-like client that keeps its session cookie.
function client(base: string) {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0]!.endsWith('=') ? '' : set.split(';')[0]!;
    return res;
  };
  return {
    get: (path: string) => call('GET', path),
    post: (path: string, body: unknown) => call('POST', path, body),
    patch: (path: string, body: unknown) => call('PATCH', path, body),
    del: (path: string) => call('DELETE', path),
  };
}

async function withAdmin() {
  const ctx = await start();
  const admin = client(ctx.base);
  expect((await admin.post('/api/setup', { name: 'Coccis', password: 'password1' })).status).toBe(200);
  return { ...ctx, admin };
}

async function withUser(limit = 3) {
  const ctx = await withAdmin();
  await ctx.admin.post('/api/admin/users', { name: 'bob', password: 'temporary1', limit });
  const bob = client(ctx.base);
  await bob.post('/api/login', { name: 'bob', password: 'temporary1' });
  await bob.post('/api/password', { current: 'temporary1', password: 'bobs-password' });
  return { ...ctx, bob };
}

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

describe('pages and setup', () => {
  it('serves both pages, and their scripts are valid JavaScript', async () => {
    const { base } = await start();
    for (const path of ['/', '/admin']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const scripts = [...(await res.text()).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
      for (const script of scripts) expect(() => new Function(script)).not.toThrow();
    }
  });

  it('creates the admin once, then only offers the login', async () => {
    const { base } = await start();
    const anyone = client(base);
    expect(await (await anyone.get('/api/state')).json()).toEqual({ setUp: false, user: null });
    const admin = client(base);
    expect((await admin.post('/api/setup', { name: 'Coccis', password: 'password1' })).status).toBe(200);
    expect(await (await admin.get('/api/state')).json()).toMatchObject({ setUp: true, user: { name: 'Coccis', admin: true, limit: null } });
    const late = await anyone.post('/api/setup', { name: 'mallory', password: 'password2' });
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: 'The admin account already exists' });
  });

  it('nothing works before logging in', async () => {
    const { base } = await withAdmin();
    const anyone = client(base);
    expect((await anyone.post('/api/jobs', { url: LINK })).status).toBe(401);
    expect((await anyone.get(`/api/jobs/${ID}`)).status).toBe(401);
    expect((await anyone.get(`/api/jobs/${ID}/file`)).status).toBe(401);
    expect((await anyone.get('/api/conversions')).status).toBe(401);
    expect((await anyone.get('/api/admin/users')).status).toBe(401);
  });
});

describe('logins', () => {
  it('logs in and out', async () => {
    const { base } = await withAdmin();
    const c = client(base);
    expect((await c.post('/api/login', { name: 'coccis', password: 'wrong-password' })).status).toBe(401);
    expect((await c.post('/api/login', { name: 'coccis', password: 'password1' })).status).toBe(200);
    expect((await c.get('/api/conversions')).status).toBe(200);
    await c.post('/api/logout', {});
    expect((await c.get('/api/conversions')).status).toBe(401);
  });

  it('counts login attempts before checking them, so a burst cannot get past the limit', async () => {
    const { base } = await withAdmin();
    const c = client(base);
    const answers = await Promise.all(Array.from({ length: 40 }, (_, i) => c.post('/api/login', { name: 'coccis', password: `burst-${i}xx` })));
    expect(answers.filter((r) => r.status !== 429).length).toBeLessThanOrEqual(10);
  });

  it('blocks password guessing after 10 failures a minute', async () => {
    const { base } = await withAdmin();
    const c = client(base);
    for (let i = 0; i < 10; i++) await c.post('/api/login', { name: 'coccis', password: `guess-${i}xx` });
    expect((await c.post('/api/login', { name: 'coccis', password: 'password1' })).status).toBe(429);
  });

  it('users must choose their password before converting', async () => {
    const { base, admin } = await withAdmin();
    await admin.post('/api/admin/users', { name: 'bob', password: 'temporary1' });
    const bob = client(base);
    await bob.post('/api/login', { name: 'bob', password: 'temporary1' });
    expect(await (await bob.get('/api/state')).json()).toMatchObject({ user: { name: 'bob', mustChangePassword: true, limit: 3 } });
    const blocked = await bob.post('/api/jobs', { url: LINK });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: 'Choose your password first' });
    expect((await bob.post('/api/password', { current: 'temporary1', password: 'bobs-password' })).status).toBe(200);
    expect((await bob.post('/api/jobs', { url: LINK })).status).toBe(200);
  });

  it('a disabled user is logged out at once', async () => {
    const { admin, bob } = await withUser();
    await admin.patch('/api/admin/users/bob', { disabled: true });
    expect((await bob.get('/api/conversions')).status).toBe(401);
  });
});

describe('conversions', () => {
  it('converts a pasted link and serves the MP4 as a download', async () => {
    const { admin, jobs } = await withAdmin();
    const created = await admin.post('/api/jobs', { url: LINK });
    expect(await created.json()).toEqual({ id: ID });
    await jobs.idle();
    expect(await (await admin.get(`/api/jobs/${ID}`)).json()).toEqual({ state: 'done' });
    const file = await admin.get(`/api/jobs/${ID}/file`);
    expect(file.headers.get('content-disposition')).toBe(`attachment; filename="${ID}.mp4"`);
    expect(await file.text()).toBe('MP4DATA');
  });

  it('limits new conversions only, and never the admin', async () => {
    const { admin, bob, jobs } = await withUser(2);
    for (const id of [ID, ID2]) expect((await bob.post('/api/jobs', { url: id })).status).toBe(200);
    await jobs.idle();
    const refused = await bob.post('/api/jobs', { url: ID3 });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "You've used your 2 replays for today", hint: 'Back tomorrow' });
    expect((await bob.post('/api/jobs', { url: ID })).status).toBe(200); // already converted: free
    expect(await (await bob.get('/api/state')).json()).toMatchObject({ user: { usedToday: 2, limit: 2 } });
    for (const id of ['1700000000000-1', '1700000000000-2', '1700000000000-3']) expect((await admin.post('/api/jobs', { url: id })).status).toBe(200);
  });

  it('shows one shared list, newest first, filtered by uploader', async () => {
    const { admin, bob, jobs } = await withUser();
    await admin.post('/api/jobs', { url: ID });
    await jobs.idle();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await bob.post('/api/jobs', { url: ID2 });
    await jobs.idle();
    const all = (await (await bob.get('/api/conversions')).json()) as { conversions: { id: string; by: string; state: string }[] };
    expect(all.conversions.map((c) => [c.id, c.by, c.state])).toEqual([
      [ID2, 'bob', 'done'],
      [ID, 'Coccis', 'done'],
    ]);
    const mine = (await (await bob.get('/api/conversions?by=bob')).json()) as { conversions: { id: string }[] };
    expect(mine.conversions.map((c) => c.id)).toEqual([ID2]);
  });

  it('serves the shared list downloads after a restart', async () => {
    const { admin, jobs, dir } = await withAdmin();
    await admin.post('/api/jobs', { url: ID });
    await jobs.idle();
    await new Promise((resolve) => server!.close(resolve));
    const again = await start(writesMp4, dir);
    const relogged = client(again.base);
    await relogged.post('/api/login', { name: 'Coccis', password: 'password1' });
    const file = await relogged.get(`/api/jobs/${ID}/file`);
    expect(file.status).toBe(200);
    expect(await file.text()).toBe('MP4DATA');
  });

  it('lets only the admin delete a conversion (the MP4 and the entry)', async () => {
    const { admin, bob, jobs, dir } = await withUser();
    await bob.post('/api/jobs', { url: ID });
    await jobs.idle();
    expect((await bob.del(`/api/conversions/${ID}`)).status).toBe(403);
    expect((await admin.del(`/api/conversions/${ID}`)).status).toBe(200);
    expect(await pathExists(join(dir, `${ID}.mp4`))).toBe(false);
    expect(((await (await admin.get('/api/conversions')).json()) as { conversions: unknown[] }).conversions).toEqual([]);
    expect((await admin.del(`/api/conversions/${ID}`)).status).toBe(404);
  });

  it('refuses to delete a conversion that is still running', async () => {
    let finish!: () => void;
    const ctx = await start(() => new Promise<void>((resolve) => (finish = resolve)));
    const admin = client(ctx.base);
    await admin.post('/api/setup', { name: 'Coccis', password: 'password1' });
    await admin.post('/api/jobs', { url: ID });
    expect((await admin.del(`/api/conversions/${ID}`)).status).toBe(409);
    finish();
  });
});

describe('admin routes', () => {
  it('are for the admin only', async () => {
    const { bob } = await withUser();
    expect((await bob.get('/api/admin/users')).status).toBe(403);
    expect((await bob.post('/api/admin/users', { name: 'eve', password: 'temporary1' })).status).toBe(403);
  });

  it('add, change, reset and delete users, with clear errors', async () => {
    const { admin } = await withAdmin();
    expect((await admin.post('/api/admin/users', { name: 'bob', password: 'temporary1' })).status).toBe(200);
    const taken = await admin.post('/api/admin/users', { name: 'Bob', password: 'temporary1' });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: 'That username is taken' });
    expect((await admin.patch('/api/admin/users/bob', { limit: 7 })).status).toBe(200);
    expect((await admin.patch('/api/admin/users/bob', { password: 'new-temp-1' })).status).toBe(200);
    const users = (await (await admin.get('/api/admin/users')).json()) as { users: { name: string; limit: number | null; mustChangePassword: boolean }[] };
    expect(users.users.find((u) => u.name === 'bob')).toMatchObject({ limit: 7, mustChangePassword: true });
    expect((await admin.del('/api/admin/users/coccis')).status).toBe(400);
    expect((await admin.del('/api/admin/users/bob')).status).toBe(200);
  });
});

describe('requests', () => {
  it('refuses an invalid link with the same message as the CLI', async () => {
    const { admin } = await withAdmin();
    const res = await admin.post('/api/jobs', { url: 'hello' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining('Not a Fightcade replay link') });
  });

  it('refuses malformed and non-JSON requests and keeps running', async () => {
    const { base } = await withAdmin();
    const raw = (body: string, type = 'application/json') => fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': type }, body });
    expect((await raw('not json')).status).toBe(400);
    expect((await raw(JSON.stringify({ name: 'x', password: 'y' }), 'text/plain')).status).toBe(415);
    expect((await raw(JSON.stringify({ name: 'x'.repeat(5000) }))).status).toBe(413);
    expect((await fetch(`${base}/`)).status).toBe(200);
  });

  it('never lets a request reach other files, even logged in', async () => {
    const { admin, dir } = await withAdmin();
    for (const path of ['/api/jobs/..%2F..%2Fetc%2Fpasswd/file', '/api/jobs/../../etc/passwd', `/api/jobs/${ID}/file`, '/api/jobs/abc', '/nope', '/fc2mp4-data.json']) {
      expect((await admin.get(path)).status, path).toBe(404);
    }
    expect(await pathExists(join(dir, 'fc2mp4-data.json'))).toBe(true);
  });
});

describe('small fixes', () => {
  it('a delete that races a new request for the same replay keeps the new request', async () => {
    const ctx = await start(writesMp4, undefined, async (p, jobs, accounts) => {
      await rm(p, { force: true });
      await jobs.submit(ID, { beforeQueue: () => accounts.claim(ID, 'Coccis') }); // arrives during the delete
    });
    const admin = client(ctx.base);
    await admin.post('/api/setup', { name: 'Coccis', password: 'password1' });
    await admin.post('/api/jobs', { url: ID });
    await ctx.jobs.idle();
    expect((await admin.del(`/api/conversions/${ID}`)).status).toBe(409);
    await ctx.jobs.idle();
    expect(await ctx.accounts.hasConversion(ID)).toBe(true);
  });

  it('answers 400 to a badly encoded username', async () => {
    const { admin } = await withAdmin();
    expect((await admin.patch('/api/admin/users/%E0%A4%A', { limit: 1 })).status).toBe(400);
  });

  it('never shows the data file path to visitors when it breaks while running', async () => {
    const { base, dir } = await withAdmin();
    await writeFile(join(dir, 'fc2mp4-data.json'), '{ broken');
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal error' });
    expect(logs.some((l) => l.includes('The data file is damaged'))).toBe(true);
  });

  it('sends browser security headers', async () => {
    const { base } = await start();
    const page = await fetch(`${base}/`);
    const csp = page.headers.get('content-security-policy') ?? '';
    for (const part of ["default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", "connect-src 'self'", "frame-ancestors 'none'"]) expect(csp).toContain(part);
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await fetch(`${base}/api/state`)).headers.get('x-content-type-options')).toBe('nosniff');
  });
});
