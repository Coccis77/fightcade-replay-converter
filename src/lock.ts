import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConvertError, ExitCode } from './errors.js';

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function acquireLock(
  file = join(tmpdir(), 'fc2mp4.lock'),
  isAlive: (pid: number) => boolean = pidAlive,
): Promise<() => Promise<void>> {
  try {
    await writeFile(file, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const pid = Number((await readFile(file, 'utf8')).trim());
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      throw new ConvertError(ExitCode.Busy, `Another fc2mp4 conversion is running (pid ${pid})`, 'Wait for it to finish');
    }
    await rm(file, { force: true });
    await writeFile(file, String(process.pid), { flag: 'wx' });
  }
  return async () => {
    await rm(file, { force: true });
  };
}
