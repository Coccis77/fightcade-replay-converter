import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ConvertError } from '../errors.js';
import { parseReplayRef } from '../replayRef.js';
import type { Jobs } from './jobs.js';
import { PAGE } from './page.js';

const MAX_BODY = 4096;
const QUARK_ID = /^\d+-\d+$/;
const JOB_ROUTE = /^\/api\/jobs\/([^/]+)(\/file)?$/;

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
}

// The body as text, or null when it is larger than MAX_BODY (the rest is drained, not kept).
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function createJob(jobs: Jobs, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // JSON only: a form or text/plain request from another website (no CORS preflight) cannot queue jobs.
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/json') return json(res, 415, { error: 'Send JSON (Content-Type: application/json)' });
  const body = await readBody(req);
  if (body === null) return json(res, 413, { error: 'Request too large' });
  let url: unknown;
  try {
    url = (JSON.parse(body) as { url?: unknown }).url;
  } catch {
    url = undefined;
  }
  if (typeof url !== 'string') return json(res, 400, { error: 'Send {"url": "<Fightcade replay link>"}' });
  let id: string;
  try {
    id = parseReplayRef(url).quarkId;
  } catch (err) {
    if (err instanceof ConvertError) return json(res, 400, { error: err.message, hint: err.hint });
    throw err;
  }
  await jobs.submit(id);
  json(res, 200, { id });
}

async function sendFile(jobs: Jobs, id: string, res: ServerResponse): Promise<void> {
  if (jobs.view(id)?.state !== 'done') return json(res, 404, { error: 'Not ready' });
  const file = jobs.filePath(id);
  let size: number;
  try {
    ({ size } = await stat(file));
  } catch {
    return json(res, 404, { error: 'The MP4 is no longer in the folder; paste the link again' });
  }
  res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': size, 'Content-Disposition': `attachment; filename="${id}.mp4"` });
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}

async function handle(jobs: Jobs, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?')[0]!;
  if (req.method === 'GET' && path === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
  if (req.method === 'POST' && path === '/api/jobs') return createJob(jobs, req, res);
  const route = JOB_ROUTE.exec(path);
  // Only a quark ID ever reaches the file system (as <outputDir>/<id>.mp4).
  if (req.method === 'GET' && route && QUARK_ID.test(route[1]!)) {
    const id = route[1]!;
    if (route[2]) return sendFile(jobs, id, res);
    const view = jobs.view(id);
    return view ? json(res, 200, view) : json(res, 404, { error: 'Unknown replay' });
  }
  json(res, 404, { error: 'Not found' });
}

export function createHandler(jobs: Jobs): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handle(jobs, req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else json(res, 500, { error: 'Internal error' });
    });
  };
}
