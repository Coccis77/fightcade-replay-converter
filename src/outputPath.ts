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
): Promise<{ path: string; userFile: boolean }> {
  // A folder gets <quarkId>.mp4 for now; the final name (players, date) is known once the replay started.
  const fileName = `${quarkId}.mp4`;
  if (output === undefined) return { path: join(defaultDir, fileName), userFile: false };
  if (output.endsWith('/') || output.endsWith(sep) || (await isDir(output))) return { path: resolve(output, fileName), userFile: false };
  return { path: resolve(output), userFile: true };
}
