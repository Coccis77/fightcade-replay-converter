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

export function isSecure(req: IncomingMessage): boolean {
  return fromLocalProxy(req) && req.headers['x-forwarded-proto'] === 'https';
}

export function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (fromLocalProxy(req) && typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

export class LoginThrottle {
  private readonly failures = new Map<string, number[]>();

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

  blocked(ip: string): boolean {
    return this.recent(ip).length >= this.max;
  }

  fail(ip: string): void {
    this.failures.set(ip, [...this.recent(ip), this.now()]);
  }
}
