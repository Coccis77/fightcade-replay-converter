import { randomBytes } from 'node:crypto';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { ConvertError, ExitCode } from '../errors.js';

export interface UserRecord {
  name: string;
  admin: boolean;
  passwordHash: string;
  salt: string;
  mustChangePassword: boolean;
  limit: number;
  disabled: boolean;
  createdAt: string;
}

export interface SessionRecord {
  tokenHash: string;
  name: string;
  expiresAt: string;
}

export interface ConversionRecord {
  id: string;
  by: string;
  requestedAt: string;
  state: 'queued' | 'done' | 'failed';
  counted: boolean;
  day: string;
  finishedAt?: string;
  error?: string;
}

export interface UsageRecord {
  name: string;
  day: string;
  count: number;
}

export interface Data {
  version: 1;
  users: UserRecord[];
  sessions: SessionRecord[];
  conversions: ConversionRecord[];
  usage: UsageRecord[];
}

export interface StoreFs {
  readFile(p: string): Promise<string>;
  writeFile(p: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  // Changes whenever the file is replaced: inode, size and time (some mounts only keep coarse times).
  version(p: string): Promise<string | null>;
}

function emptyData(): Data {
  return { version: 1, users: [], sessions: [], conversions: [], usage: [] };
}

function isData(value: unknown): value is Data {
  const d = value as Partial<Data> | null;
  return (
    typeof d === 'object' && d !== null && d.version === 1 &&
    Array.isArray(d.users) && Array.isArray(d.sessions) && Array.isArray(d.conversions) && Array.isArray(d.usage)
  );
}

export function defaultStoreFs(): StoreFs {
  return {
    readFile: (p) => readFile(p, 'utf8'),
    writeFile: (p, text) => writeFile(p, text),
    rename: (from, to) => rename(from, to),
    version: async (p) => {
      try {
        const s = await stat(p);
        return `${s.ino}:${s.size}:${s.mtimeMs}`;
      } catch {
        return null;
      }
    },
  };
}

// Users, sessions and history in one small JSON file. Every read and change runs one after the other,
// after rereading the file if someone else changed it (fc2mp4 reset-admin while serve runs). A change is
// written to <file>.tmp then renamed, so a crash never leaves a half-written file.
export class DataStore {
  private data: Data = emptyData();
  private version: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    private readonly fs: StoreFs = defaultStoreFs(),
  ) {}

  read<T>(fn: (d: Readonly<Data>) => T): Promise<T> {
    return this.enqueue(async () => {
      await this.refresh();
      return fn(this.data);
    });
  }

  update<T>(fn: (d: Data) => T): Promise<T> {
    return this.enqueue(async () => {
      await this.refresh();
      const draft = structuredClone(this.data);
      const result = fn(draft); // a throw leaves this.data and the file untouched
      // A temp name of our own: serve and reset-admin never write the same temp file.
      const tmp = `${this.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      await this.fs.writeFile(tmp, `${JSON.stringify(draft, null, 2)}\n`);
      await this.fs.rename(tmp, this.path);
      this.data = draft;
      this.version = await this.fs.version(this.path);
      return result;
    });
  }

  private async refresh(): Promise<void> {
    const version = await this.fs.version(this.path);
    if (version === this.version) return;
    if (version === null) {
      this.data = emptyData();
      this.version = null;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await this.fs.readFile(this.path));
    } catch {
      parsed = undefined;
    }
    if (!isData(parsed)) {
      throw new ConvertError(ExitCode.Preflight, `The data file is damaged: ${this.path}`, 'Restore a backup, or move it away to start fresh (users and history would be lost)');
    }
    this.data = parsed;
    this.version = version;
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job, job);
    this.chain = next.catch(() => undefined);
    return next;
  }
}
