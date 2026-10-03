import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function resolveOutputPath(
  quarkId: string,
  output: string | undefined,
  defaultDir: string,
  isDir: (p: string) => Promise<boolean> = isDirectory,
): Promise<string> {
  const fileName = `${quarkId}.mp4`;
  if (output === undefined) return join(defaultDir, fileName);
  if (output.endsWith('/') || output.endsWith(sep) || (await isDir(output))) return resolve(output, fileName);
  return resolve(output);
}
