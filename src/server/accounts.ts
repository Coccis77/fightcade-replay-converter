import { createHash, randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword } from './passwords.js';
import type { Data, DataStore, UserRecord } from './store.js';

export const DEFAULT_LIMIT = 3;
const SESSION_MS = 30 * 24 * 60 * 60_000;
const NAME = /^[A-Za-z0-9_.-]{1,32}$/;

// An expected refusal, shown to the person with its HTTP status.
export class AccountError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

export interface PublicUser {
  name: string;
  admin: boolean;
  disabled: boolean;
  mustChangePassword: boolean;
  limit: number | null; // null: unlimited (the admin)
  usedToday: number;
}

export interface ConversionEntry {
  id: string;
  by: string;
  requestedAt: string;
  state: 'queued' | 'done' | 'failed';
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

function checkName(name: string): void {
  if (!NAME.test(name)) throw new AccountError(400, 'Usernames are 1–32 letters, digits, _ . or -');
}

function checkPassword(password: string): void {
  if (password.length < 8) throw new AccountError(400, 'Passwords need at least 8 characters');
}

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0 || limit > 1000) throw new AccountError(400, 'The daily limit must be a whole number from 0 to 1000');
}

export class Accounts {
  constructor(
    private readonly store: DataStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // Server local date: the day resets at local midnight (TZ in Docker).
  private today(): string {
    const d = this.now();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  private publicUser(d: Readonly<Data>, u: UserRecord): PublicUser {
    const day = this.today();
    const used = d.usage.find((x) => same(x.name, u.name) && x.day === day)?.count ?? 0;
    return { name: u.name, admin: u.admin, disabled: u.disabled, mustChangePassword: u.mustChangePassword, limit: u.admin ? null : u.limit, usedToday: used };
  }

  private newSession(d: Data, name: string): string {
    const token = randomBytes(32).toString('base64url');
    const now = this.now().getTime();
    d.sessions = d.sessions.filter((s) => Date.parse(s.expiresAt) > now);
    d.sessions.push({ tokenHash: tokenHash(token), name, expiresAt: new Date(now + SESSION_MS).toISOString() });
    return token;
  }

  isSetUp(): Promise<boolean> {
    return this.store.read((d) => d.users.some((u) => u.admin));
  }

  async setup(name: string, password: string): Promise<string> {
    checkName(name);
    checkPassword(password);
    const { hash, salt } = await hashPassword(password);
    return this.store.update((d) => {
      if (d.users.some((u) => u.admin)) throw new AccountError(409, 'The admin account already exists');
      d.users = d.users.filter((u) => !same(u.name, name));
      d.users.push({ name, admin: true, passwordHash: hash, salt, mustChangePassword: false, limit: 0, disabled: false, createdAt: this.now().toISOString() });
      return this.newSession(d, name);
    });
  }

  async login(name: string, password: string): Promise<string | null> {
    const user = await this.store.read((d) => d.users.find((u) => same(u.name, name)));
    if (!user || user.disabled || !(await verifyPassword(password, user.passwordHash, user.salt))) return null;
    return this.store.update((d) => this.newSession(d, user.name));
  }

  async logout(token: string): Promise<void> {
    const hash = tokenHash(token);
    await this.store.update((d) => void (d.sessions = d.sessions.filter((s) => s.tokenHash !== hash)));
  }

  userFor(token: string | undefined): Promise<PublicUser | null> {
    if (!token) return Promise.resolve(null);
    const hash = tokenHash(token);
    return this.store.read((d) => {
      const session = d.sessions.find((s) => s.tokenHash === hash);
      if (!session || Date.parse(session.expiresAt) <= this.now().getTime()) return null;
      const user = d.users.find((u) => same(u.name, session.name));
      return user && !user.disabled ? this.publicUser(d, user) : null;
    });
  }

  async changePassword(name: string, current: string, next: string): Promise<void> {
    checkPassword(next);
    const user = await this.store.read((d) => d.users.find((u) => same(u.name, name)));
    if (!user || !(await verifyPassword(current, user.passwordHash, user.salt))) throw new AccountError(403, 'The current password is wrong');
    const { hash, salt } = await hashPassword(next);
    await this.store.update((d) => {
      const u = d.users.find((x) => same(x.name, name))!;
      Object.assign(u, { passwordHash: hash, salt, mustChangePassword: false });
    });
  }

  listUsers(): Promise<PublicUser[]> {
    return this.store.read((d) => d.users.map((u) => this.publicUser(d, u)));
  }

  async addUser(name: string, password: string, limit: number): Promise<void> {
    checkName(name);
    checkPassword(password);
    checkLimit(limit);
    const { hash, salt } = await hashPassword(password);
    await this.store.update((d) => {
      if (d.users.some((u) => same(u.name, name))) throw new AccountError(409, 'That username is taken');
      d.users.push({ name, admin: false, passwordHash: hash, salt, mustChangePassword: true, limit, disabled: false, createdAt: this.now().toISOString() });
    });
  }

  async updateUser(name: string, change: { limit?: number; disabled?: boolean; password?: string }): Promise<void> {
    if (change.limit !== undefined) checkLimit(change.limit);
    if (change.password !== undefined) checkPassword(change.password);
    const secret = change.password !== undefined ? await hashPassword(change.password) : null;
    await this.store.update((d) => {
      const u = d.users.find((x) => same(x.name, name));
      if (!u) throw new AccountError(404, 'No such user');
      if (u.admin && change.disabled) throw new AccountError(400, 'The admin account cannot be disabled');
      if (change.limit !== undefined) u.limit = change.limit;
      if (change.disabled !== undefined) {
        u.disabled = change.disabled;
        if (u.disabled) d.sessions = d.sessions.filter((s) => !same(s.name, u.name));
      }
      if (secret) Object.assign(u, { passwordHash: secret.hash, salt: secret.salt, mustChangePassword: true });
    });
  }

  async deleteUser(name: string): Promise<void> {
    await this.store.update((d) => {
      const u = d.users.find((x) => same(x.name, name));
      if (!u) throw new AccountError(404, 'No such user');
      if (u.admin) throw new AccountError(400, 'The admin account cannot be deleted');
      d.users = d.users.filter((x) => x !== u);
      d.sessions = d.sessions.filter((s) => !same(s.name, u.name));
    });
  }

  // Called just before a NEW conversion is queued: checks and counts the daily limit atomically.
  claim(id: string, name: string): Promise<boolean> {
    return this.store.update((d) => {
      const u = d.users.find((x) => same(x.name, name));
      if (!u) return false;
      const day = this.today();
      if (!u.admin) {
        const usage = d.usage.find((x) => same(x.name, u.name) && x.day === day);
        if ((usage?.count ?? 0) >= u.limit) return false;
        if (usage) usage.count += 1;
        else d.usage.push({ name: u.name, day, count: 1 });
        d.usage = d.usage.filter((x) => x.day === day); // only today matters
      }
      d.conversions = d.conversions.filter((c) => c.id !== id);
      d.conversions.push({ id, by: u.name, requestedAt: this.now().toISOString(), state: 'queued', counted: !u.admin, day });
      return true;
    });
  }

  // An MP4 already on disk (older version, or deleted from the list): listed under its first requester, free.
  async recordExisting(id: string, name: string): Promise<void> {
    await this.store.update((d) => {
      if (d.conversions.some((c) => c.id === id)) return;
      const u = d.users.find((x) => same(x.name, name));
      const now = this.now().toISOString();
      d.conversions.push({ id, by: u?.name ?? name, requestedAt: now, state: 'done', counted: false, day: this.today(), finishedAt: now });
    });
  }

  async finish(id: string, ok: boolean, error?: string): Promise<void> {
    await this.store.update((d) => {
      const c = d.conversions.find((x) => x.id === id);
      if (!c) return;
      c.state = ok ? 'done' : 'failed';
      c.finishedAt = this.now().toISOString();
      if (!ok) {
        c.error = error;
        if (c.counted) {
          const usage = d.usage.find((x) => same(x.name, c.by) && x.day === c.day);
          if (usage && usage.count > 0) usage.count -= 1;
          c.counted = false;
        }
      }
    });
  }

  conversions(by?: string): Promise<ConversionEntry[]> {
    return this.store.read((d) =>
      d.conversions
        .filter((c) => by === undefined || same(c.by, by))
        .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
        .map(({ id, by: who, requestedAt, state }) => ({ id, by: who, requestedAt, state })),
    );
  }

  hasConversion(id: string): Promise<boolean> {
    return this.store.read((d) => d.conversions.some((c) => c.id === id));
  }

  async removeConversion(id: string): Promise<void> {
    await this.store.update((d) => void (d.conversions = d.conversions.filter((c) => c.id !== id)));
  }

  // fc2mp4 reset-admin: /admin offers the setup again. Nothing is written when there is no admin.
  async removeAdmin(): Promise<boolean> {
    if (!(await this.isSetUp())) return false;
    return this.store.update((d) => {
      const admin = d.users.find((u) => u.admin);
      if (!admin) return false;
      d.users = d.users.filter((u) => u !== admin);
      d.sessions = d.sessions.filter((s) => !same(s.name, admin.name));
      return true;
    });
  }
}
