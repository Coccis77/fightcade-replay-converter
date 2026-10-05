import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { clientIp, isSecure, LoginThrottle, readSessionCookie, sessionCookie } from '../../src/server/auth.js';

const req = (remote: string, headers: Record<string, string> = {}) => ({ socket: { remoteAddress: remote }, headers }) as unknown as IncomingMessage;

describe('auth helpers', () => {
  it('reads and writes the session cookie', () => {
    expect(readSessionCookie(req('1.2.3.4', { cookie: 'a=1; fc2mp4_session=abc; b=2' }))).toBe('abc');
    expect(readSessionCookie(req('1.2.3.4'))).toBeUndefined();
    expect(sessionCookie('abc', false)).toBe('fc2mp4_session=abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000');
    expect(sessionCookie('abc', true)).toBe('fc2mp4_session=abc; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000; Secure');
  });

  it('trusts X-Forwarded-* only from a proxy on this machine (Caddy)', () => {
    expect(clientIp(req('127.0.0.1', { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }))).toBe('9.9.9.9');
    expect(clientIp(req('5.6.7.8', { 'x-forwarded-for': '9.9.9.9' }))).toBe('5.6.7.8');
    expect(isSecure(req('::1', { 'x-forwarded-proto': 'https' }))).toBe(true);
    expect(isSecure(req('5.6.7.8', { 'x-forwarded-proto': 'https' }))).toBe(false);
  });

  it('trusts X-Forwarded-* from any peer when told it runs behind a proxy (Docker + Caddy)', () => {
    const docker = req('172.17.0.1', { 'x-forwarded-for': '9.9.9.9', 'x-forwarded-proto': 'https' });
    expect(clientIp(docker)).toBe('172.17.0.1');
    expect(clientIp(docker, true)).toBe('9.9.9.9');
    expect(isSecure(docker)).toBe(false);
    expect(isSecure(docker, true)).toBe(true);
  });

  it('blocks an address after 10 failed logins in a minute', () => {
    let now = 0;
    const throttle = new LoginThrottle(10, 60_000, () => now);
    for (let i = 0; i < 10; i++) throttle.fail('1.1.1.1');
    expect(throttle.blocked('1.1.1.1')).toBe(true);
    expect(throttle.blocked('2.2.2.2')).toBe(false);
    now = 60_001;
    expect(throttle.blocked('1.1.1.1')).toBe(false);
  });

  it('forgets addresses whose attempts are older than a minute', () => {
    let now = 0;
    const throttle = new LoginThrottle(10, 60_000, () => now);
    for (let i = 0; i < 500; i++) throttle.fail(`10.0.${Math.floor(i / 250)}.${i % 250}`);
    expect(throttle.size).toBe(500);
    now = 120_000;
    throttle.fail('1.1.1.1');
    expect(throttle.size).toBe(1);
  });
});
