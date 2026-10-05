import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConvertError } from '../errors.js';
import { parseReplayRef } from '../replayRef.js';
import type { Jobs } from './jobs.js';
import { PAGE } from './page.js';
import { AccountError, DEFAULT_LIMIT, type Accounts, type PublicUser } from './accounts.js';
import { ADMIN_PAGE } from './adminPage.js';
import { clearSessionCookie, clientIp, isSecure, readSessionCookie, sessionCookie, type LoginThrottle } from './auth.js';

const MAX_BODY = 4096;
const QUARK_ID = /^\d+-\d+$/;
const JOB_ROUTE = /^\/api\/jobs\/([^/]+)(\/file)?$/;

// On every answer: the pages use only their own inline styles/scripts and talk only to this server;
// no MIME sniffing, no embedding in other sites, no referrer sent elsewhere.
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

// The body as text, or null as soon as it is larger than MAX_BODY (reading stops there).
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.off('data', onData);
        req.pause();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const CONVERSION_ROUTE = /^\/api\/conversions\/([^/]+)$/;
const USER_ROUTE = /^\/api\/admin\/users\/([^/]+)$/;

export interface App {
  jobs: Jobs;
  accounts: Accounts;
  throttle: LoginThrottle;
  removeFile(path: string): Promise<void>;
  // Trust X-Forwarded-* from any peer (only reachable through a proxy: Docker + Caddy).
  trustProxy: boolean;
  log?: (msg: string) => void;
}

// The JSON body as an object, or null after answering 415 / 413 / 400 itself.
async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  // JSON only: a form or text/plain request from another website (no CORS preflight) is refused.
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') {
    json(res, 415, { error: 'Send JSON (Content-Type: application/json)' });
    return null;
  }
  const body = await readBody(req);
  if (body === null) {
    // Answer now and close the connection instead of reading the rest.
    res.setHeader('Connection', 'close');
    res.on('finish', () => req.destroy());
    json(res, 413, { error: 'Request too large' });
    return null;
  }
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // answered below
  }
  json(res, 400, { error: 'Send a JSON object' });
  return null;
}

const text = (v: unknown) => (typeof v === 'string' ? v : '');

async function createJob(app: App, user: PublicUser, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, res);
  if (!body) return;
  if (typeof body.url !== 'string') return json(res, 400, { error: 'Send {"url": "<Fightcade replay link>"}' });
  let id: string;
  try {
    id = parseReplayRef(body.url).quarkId;
  } catch (err) {
    if (err instanceof ConvertError) return json(res, 400, { error: err.message, hint: err.hint });
    throw err;
  }
  const outcome = await app.jobs.submit(id, { beforeQueue: () => app.accounts.claim(id, user.name) });
  if (outcome === 'refused') return json(res, 429, { error: `You've used your ${user.limit} replays for today`, hint: 'Back tomorrow' });
  if (outcome === 'stopped') return json(res, 503, { error: 'The server is stopping' });
  if (outcome === 'done') await app.accounts.recordExisting(id, user.name);
  json(res, 200, { id });
}

// Served from the folder (not the in-memory queue), so the shared list's downloads work after a restart.
async function sendFile(jobs: Jobs, id: string, res: ServerResponse): Promise<void> {
  if (jobs.isBusy(id)) return json(res, 404, { error: 'Not ready' });
  const file = jobs.filePath(id);
  let size: number;
  try {
    ({ size } = await stat(file));
  } catch {
    return json(res, 404, { error: 'There is no MP4 for this replay in the folder; paste the link again' });
  }
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'video/mp4', 'Content-Length': size, 'Content-Disposition': `attachment; filename="${id}.mp4"` });
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

async function login(app: App, req: IncomingMessage, res: ServerResponse, setup: boolean): Promise<void> {
  const ip = clientIp(req, app.trustProxy);
  if (!setup) {
    if (app.throttle.blocked(ip)) return json(res, 429, { error: 'Too many attempts', hint: 'Wait a minute and try again' });
    app.throttle.fail(ip); // counted before checking: a burst of parallel attempts cannot get past the limit
  }
  const body = await readJson(req, res);
  if (!body) return;
  const token = setup ? await app.accounts.setup(text(body.name), text(body.password)) : await app.accounts.login(text(body.name), text(body.password));
  if (!token) return json(res, 401, { error: 'Wrong username or password' });
  if (!setup) app.throttle.forgive(ip);
  res.setHeader('Set-Cookie', sessionCookie(token, isSecure(req, app.trustProxy)));
  json(res, 200, { ok: true });
}

async function conversions(app: App, url: URL, res: ServerResponse): Promise<void> {
  const by = url.searchParams.get('by') || undefined;
  const list = await app.accounts.conversions(by);
  // Live state from the queue when the replay is waiting or converting.
  json(res, 200, { conversions: list.map((c) => ({ ...c, state: app.jobs.isBusy(c.id) ? app.jobs.view(c.id)!.state : c.state })) });
}

async function deleteConversion(app: App, id: string, res: ServerResponse): Promise<void> {
  if (app.jobs.isBusy(id)) return json(res, 409, { error: 'Wait until it has finished' });
  if (!(await app.accounts.hasConversion(id))) return json(res, 404, { error: 'Unknown replay' });
  await app.removeFile(app.jobs.filePath(id));
  // Someone asked for it again while the file was being removed: keep their new request and its entry.
  if (app.jobs.isBusy(id)) return json(res, 409, { error: 'Wait until it has finished' });
  await app.accounts.removeConversion(id);
  app.jobs.forget(id);
  json(res, 200, { ok: true });
}

async function adminUsers(app: App, method: string, name: string | null, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (name === null && method === 'GET') return json(res, 200, { users: await app.accounts.listUsers() });
  if (name === null && method === 'POST') {
    const body = await readJson(req, res);
    if (!body) return;
    await app.accounts.addUser(text(body.name), text(body.password), body.limit === undefined ? DEFAULT_LIMIT : Number(body.limit));
    return json(res, 200, { ok: true });
  }
  if (name !== null && method === 'PATCH') {
    const body = await readJson(req, res);
    if (!body) return;
    await app.accounts.updateUser(name, {
      limit: body.limit === undefined ? undefined : Number(body.limit),
      disabled: typeof body.disabled === 'boolean' ? body.disabled : undefined,
      password: typeof body.password === 'string' ? body.password : undefined,
    });
    return json(res, 200, { ok: true });
  }
  if (name !== null && method === 'DELETE') {
    await app.accounts.deleteUser(name);
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: 'Not found' });
}

async function handle(app: App, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = req.method ?? 'GET';
  if (method === 'GET' && path === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
  if (method === 'GET' && path === '/admin') return send(res, 200, 'text/html; charset=utf-8', ADMIN_PAGE);

  const user = await app.accounts.userFor(readSessionCookie(req));
  if (method === 'GET' && path === '/api/state') return json(res, 200, { setUp: await app.accounts.isSetUp(), user });
  if (method === 'POST' && path === '/api/setup') return login(app, req, res, true);
  if (method === 'POST' && path === '/api/login') return login(app, req, res, false);

  if (!path.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
  if (!user) return json(res, 401, { error: 'Log in first' });

  if (method === 'POST' && path === '/api/logout') {
    const token = readSessionCookie(req);
    if (token) await app.accounts.logout(token);
    res.setHeader('Set-Cookie', clearSessionCookie());
    return json(res, 200, { ok: true });
  }
  if (method === 'POST' && path === '/api/password') {
    const body = await readJson(req, res);
    if (!body) return;
    await app.accounts.changePassword(user.name, text(body.current), text(body.password), readSessionCookie(req));
    return json(res, 200, { ok: true });
  }
  if (user.mustChangePassword) return json(res, 403, { error: 'Choose your password first' });

  if (method === 'POST' && path === '/api/jobs') return createJob(app, user, req, res);
  const job = JOB_ROUTE.exec(path);
  // Only a quark ID ever reaches the file system (as <outputDir>/<id>.mp4).
  if (method === 'GET' && job && QUARK_ID.test(job[1]!)) {
    const id = job[1]!;
    if (job[2]) return sendFile(app.jobs, id, res);
    const view = app.jobs.view(id);
    return view ? json(res, 200, view) : json(res, 404, { error: 'Unknown replay' });
  }
  if (method === 'GET' && path === '/api/conversions') return conversions(app, url, res);

  const conversion = CONVERSION_ROUTE.exec(path);
  const userRoute = USER_ROUTE.exec(path);
  const isAdminRoute = (method === 'DELETE' && conversion !== null) || path === '/api/admin/users' || userRoute !== null;
  if (isAdminRoute && !user.admin) return json(res, 403, { error: 'For the admin only' });
  if (method === 'DELETE' && conversion && QUARK_ID.test(conversion[1]!)) return deleteConversion(app, conversion[1]!, res);
  if (path === '/api/admin/users') return adminUsers(app, method, null, req, res);
  if (userRoute) {
    let name: string;
    try {
      name = decodeURIComponent(userRoute[1]!);
    } catch {
      return json(res, 400, { error: 'Bad username in the address' });
    }
    return adminUsers(app, method, name, req, res);
  }
  json(res, 404, { error: 'Not found' });
}

export function createHandler(app: App): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handle(app, req, res).catch((err: unknown) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof AccountError) return json(res, err.status, { error: err.message, hint: err.hint });
      // Details (e.g. the data file's path) go to the server log, never to visitors.
      app.log?.(`Error on ${req.method} ${req.url}: ${err instanceof Error ? err.message : String(err)}`);
      json(res, 500, { error: 'Internal error' });
    });
  };
}
