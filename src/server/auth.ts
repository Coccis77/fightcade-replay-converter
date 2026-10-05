import type { IncomingMessage } from 'node:http';

export const SESSION_COOKIE = 'fc2mp4_session';
const MAX_AGE_S = 30 * 24 * 60 * 60;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function readSessionCookie(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === SESSION_COOKIE) return rest.join('=') || undefined;
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_S}${secure ? '; Secure' : ''}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

// X-Forwarded-* are only trusted from a proxy on this machine (Caddy in front of fc2mp4).
const fromLocalProxy = (req: IncomingMessage) => LOOPBACK.has(req.socket.remoteAddress ?? '');

// trustProxy: fc2mp4 only reachable through a proxy (Docker + Caddy, where Caddy is not on loopback).
export function isSecure(req: IncomingMessage, trustProxy = false): boolean {
  return (trustProxy || fromLocalProxy(req)) && req.headers['x-forwarded-proto'] === 'https';
}

export function clientIp(req: IncomingMessage, trustProxy = false): string {
  const forwarded = req.headers['x-forwarded-for'];
  if ((trustProxy || fromLocalProxy(req)) && typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();
  private lastPrune = 0;

  constructor(
    private readonly max = 10,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(ip: string): number[] {
    const since = this.now() - this.windowMs;
    const list = (this.failures.get(ip) ?? []).filter((t) => t > since);
    if (list.length > 0) this.failures.set(ip, list);
    else this.failures.delete(ip);
    return list;
  }

  get size(): number {
    return this.failures.size;
  }

  // Addresses with no recent attempt are dropped once per window, so many visitors cannot grow the map.
  private prune(): void {
    const now = this.now();
    if (now - this.lastPrune < this.windowMs) return;
    this.lastPrune = now;
    for (const ip of [...this.failures.keys()]) this.recent(ip);
  }

  blocked(ip: string): boolean {
    return this.recent(ip).length >= this.max;
  }

  fail(ip: string): void {
    this.prune();
    this.failures.set(ip, [...this.recent(ip), this.now()]);
  }

  // A successful login gives back the attempt counted before checking it.
  forgive(ip: string): void {
    const list = this.recent(ip);
    list.pop();
    if (list.length > 0) this.failures.set(ip, list);
    else this.failures.delete(ip);
  }
}
