import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/server/passwords.js';

describe('passwords', () => {
  it('verifies the right password only, with a different salt each time', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(await verifyPassword('correct horse', a.hash, a.salt)).toBe(true);
    expect(await verifyPassword('wrong horse', a.hash, a.salt)).toBe(false);
  });
});
