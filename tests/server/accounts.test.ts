import { describe, expect, it } from 'vitest';
import { Accounts } from '../../src/server/accounts.js';
import { DataStore, type StoreFs } from '../../src/server/store.js';

function memoryStore(): DataStore {
  const files = new Map<string, string>();
  const mtimes = new Map<string, number>();
  let clock = 0;
  const fs: StoreFs = {
    readFile: async (p) => files.get(p)!,
    writeFile: async (p, t) => void (files.set(p, t), mtimes.set(p, ++clock)),
    rename: async (a, b) => void (files.set(b, files.get(a)!), mtimes.set(b, ++clock), files.delete(a), mtimes.delete(a)),
    version: async (p) => (mtimes.has(p) ? String(mtimes.get(p)) : null),
  };
  return new DataStore('/videos/fc2mp4-data.json', fs);
}

function harness(start = '2026-10-05T10:00:00') {
  let now = new Date(start);
  const accounts = new Accounts(memoryStore(), () => now);
  return { accounts, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const DAY = 24 * 60 * 60_000;

describe('Accounts — admin and logins', () => {
  it('creates the admin once', async () => {
    const { accounts } = harness();
    expect(await accounts.isSetUp()).toBe(false);
    const token = await accounts.setup('Coccis', 'password1');
    expect(await accounts.userFor(token)).toMatchObject({ name: 'Coccis', admin: true, limit: null, mustChangePassword: false });
    await expect(accounts.setup('other', 'password2')).rejects.toMatchObject({ status: 409, message: 'The admin account already exists' });
    expect(await accounts.isSetUp()).toBe(true);
  });

  it('logs in with the right password only, case-insensitive name; sessions last 30 days', async () => {
    const { accounts, advance } = harness();
    await accounts.setup('Coccis', 'password1');
    expect(await accounts.login('coccis', 'nope-nope')).toBeNull();
    expect(await accounts.login('nobody', 'password1')).toBeNull();
    const token = await accounts.login('coccis', 'password1');
    expect(await accounts.userFor(token!)).toMatchObject({ name: 'Coccis' });
    advance(31 * DAY);
    expect(await accounts.userFor(token!)).toBeNull();
  });

  it('logs out', async () => {
    const { accounts } = harness();
    const token = await accounts.setup('Coccis', 'password1');
    await accounts.logout(token);
    expect(await accounts.userFor(token)).toBeNull();
    expect(await accounts.userFor(undefined)).toBeNull();
  });

  it('removeAdmin (reset-admin) removes the admin and its sessions', async () => {
    const { accounts } = harness();
    const token = await accounts.setup('Coccis', 'password1');
    expect(await accounts.removeAdmin()).toBe(true);
    expect(await accounts.isSetUp()).toBe(false);
    expect(await accounts.userFor(token)).toBeNull();
    expect(await accounts.removeAdmin()).toBe(false);
  });
});

describe('Accounts — users', () => {
  it('adds users who must choose a password, with validation', async () => {
    const { accounts } = harness();
    await accounts.setup('Coccis', 'password1');
    await accounts.addUser('bob', 'temporary1', 3);
    await expect(accounts.addUser('BOB', 'temporary1', 3)).rejects.toMatchObject({ status: 409, message: 'That username is taken' });
    await expect(accounts.addUser('bad name', 'temporary1', 3)).rejects.toMatchObject({ status: 400 });
    await expect(accounts.addUser('al', 'short', 3)).rejects.toMatchObject({ status: 400, message: 'Passwords need at least 8 characters' });
    await expect(accounts.addUser('al', 'temporary1', 1.5)).rejects.toMatchObject({ status: 400 });
    const token = await accounts.login('bob', 'temporary1');
    expect(await accounts.userFor(token!)).toMatchObject({ name: 'bob', admin: false, mustChangePassword: true, limit: 3, usedToday: 0 });
    await expect(accounts.changePassword('bob', 'wrong-one', 'mine-mine')).rejects.toMatchObject({ status: 403 });
    await accounts.changePassword('bob', 'temporary1', 'mine-mine', token!);
    expect(await accounts.userFor(token!)).toMatchObject({ mustChangePassword: false });
    expect(await accounts.login('bob', 'mine-mine')).not.toBeNull();
  });

  it('changes limits, resets passwords, disables (logging out) and deletes users; never the admin', async () => {
    const { accounts } = harness();
    await accounts.setup('Coccis', 'password1');
    await accounts.addUser('bob', 'temporary1', 3);
    const bob = await accounts.login('bob', 'temporary1');
    await accounts.updateUser('Bob', { limit: 5 });
    expect((await accounts.listUsers()).find((u) => u.name === 'bob')).toMatchObject({ limit: 5 });
    await accounts.updateUser('bob', { password: 'another-1' });
    expect(await accounts.login('bob', 'another-1')).not.toBeNull();
    await accounts.updateUser('bob', { disabled: true });
    expect(await accounts.userFor(bob!)).toBeNull();
    expect(await accounts.login('bob', 'another-1')).toBeNull();
    await expect(accounts.updateUser('coccis', { disabled: true })).rejects.toMatchObject({ status: 400 });
    await expect(accounts.deleteUser('coccis')).rejects.toMatchObject({ status: 400 });
    await expect(accounts.updateUser('nobody', { limit: 1 })).rejects.toMatchObject({ status: 404 });
    await accounts.deleteUser('bob');
    expect((await accounts.listUsers()).map((u) => u.name)).toEqual(['Coccis']);
  });
});

describe('Accounts — limits and history', () => {
  it('counts new conversions per day, refunds failures, never limits the admin', async () => {
    const { accounts, advance } = harness();
    await accounts.setup('Coccis', 'password1');
    await accounts.addUser('bob', 'temporary1', 2);
    expect(await accounts.claim('1-1', 'bob')).toBe(true);
    expect(await accounts.claim('1-2', 'bob')).toBe(true);
    expect(await accounts.claim('1-3', 'bob')).toBe(false);
    await accounts.finish('1-2', false, 'The replay stream never started');
    expect(await accounts.claim('1-3', 'bob')).toBe(true);
    for (let i = 0; i < 5; i++) expect(await accounts.claim(`2-${i}`, 'Coccis')).toBe(true);
    advance(DAY);
    expect(await accounts.claim('1-4', 'bob')).toBe(true);
    expect((await accounts.listUsers()).find((u) => u.name === 'bob')).toMatchObject({ usedToday: 1 });
  });

  it('keeps a shared history, newest first, filtered by uploader; existing MP4s are free', async () => {
    const { accounts, advance } = harness();
    await accounts.setup('Coccis', 'password1');
    await accounts.addUser('bob', 'temporary1', 1);
    await accounts.claim('1-1', 'Coccis');
    advance(1000);
    await accounts.claim('1-2', 'bob');
    await accounts.finish('1-2', true);
    advance(1000);
    await accounts.recordExisting('1-3', 'bob');
    await accounts.recordExisting('1-3', 'Coccis'); // already listed: unchanged
    expect((await accounts.conversions()).map((c) => [c.id, c.by, c.state])).toEqual([
      ['1-3', 'bob', 'done'],
      ['1-2', 'bob', 'done'],
      ['1-1', 'Coccis', 'queued'],
    ]);
    expect((await accounts.conversions('BOB')).map((c) => c.id)).toEqual(['1-3', '1-2']);
    expect((await accounts.listUsers()).find((u) => u.name === 'bob')).toMatchObject({ usedToday: 1 });
    await accounts.removeConversion('1-2');
    expect(await accounts.hasConversion('1-2')).toBe(false);
  });

  it('keeps the uploader name of a deleted user', async () => {
    const { accounts } = harness();
    await accounts.setup('Coccis', 'password1');
    await accounts.addUser('bob', 'temporary1', 3);
    await accounts.claim('1-1', 'bob');
    await accounts.deleteUser('bob');
    expect((await accounts.conversions()).map((c) => c.by)).toEqual(['bob']);
  });
});

describe('Accounts — review fixes', () => {
  it('setup refuses a name a user already has (their old sessions must not become admin)', async () => {
    const { accounts } = harness();
    await accounts.setup('Coccis', 'password1');
    await accounts.addUser('bob', 'temporary1', 3);
    await accounts.removeAdmin();
    await expect(accounts.setup('BOB', 'password1')).rejects.toMatchObject({ status: 409, message: 'That username is taken' });
  });

  it('a password change logs out the other sessions; an admin reset logs out all of them', async () => {
    const { accounts } = harness();
    await accounts.setup('Coccis', 'password1');
    await accounts.addUser('bob', 'temporary1', 3);
    const here = (await accounts.login('bob', 'temporary1'))!;
    const elsewhere = (await accounts.login('bob', 'temporary1'))!;
    await accounts.changePassword('bob', 'temporary1', 'mine-mine', here);
    expect(await accounts.userFor(here)).not.toBeNull();
    expect(await accounts.userFor(elsewhere)).toBeNull();
    await accounts.updateUser('bob', { password: 'reset-pass' });
    expect(await accounts.userFor(here)).toBeNull();
  });

  it('checks a password even for an unknown user (no guessing names by timing)', async () => {
    let checks = 0;
    const accounts = new Accounts(memoryStore(), () => new Date('2026-10-05T10:00:00'), {
      verify: async () => (checks++, false),
    });
    expect(await accounts.login('nobody', 'whatever1')).toBeNull();
    expect(checks).toBe(1);
  });

  it('settles replays left waiting by a crash: done if the MP4 is there, otherwise failed and refunded', async () => {
    const { accounts } = harness();
    await accounts.setup('Coccis', 'password1');
    await accounts.addUser('bob', 'temporary1', 3);
    await accounts.claim('1-1', 'bob');
    await accounts.claim('1-2', 'bob');
    await accounts.reconcile(async (id) => id === '1-1');
    expect((await accounts.conversions()).map((c) => [c.id, c.state]).sort()).toEqual([
      ['1-1', 'done'],
      ['1-2', 'failed'],
    ]);
    expect((await accounts.listUsers()).find((u) => u.name === 'bob')).toMatchObject({ usedToday: 1 });
  });
});
