import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export function defaultOutputDir(home: string): string {
  return join(home, 'Movies', 'Fightcade');
}

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
  home: string,
  isDir: (p: string) => Promise<boolean> = isDirectory,
): Promise<string> {
  const fileName = `${quarkId}.mp4`;
  if (output === undefined) return join(defaultOutputDir(home), fileName);
  if (output.endsWith('/') || output.endsWith(sep) || (await isDir(output))) return resolve(output, fileName);
  return resolve(output);
}
