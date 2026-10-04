import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal; detached?: boolean },
) => Promise<RunResult>;

export const run: RunFn = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: opts.detached ?? false });
    // A detached child gets its own process group, so timeouts and Ctrl-C stop its whole tree.
    const kill = () => {
      if (opts.detached && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          // fall through
        }
      }
      child.kill('SIGKILL');
    };
    opts.signal?.addEventListener('abort', kill, { once: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : undefined;
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

export async function which(cmd: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const result = await run(platform === 'win32' ? 'where' : 'which', [cmd]).catch(() => null);
  if (!result || result.code !== 0) return null;
  return result.stdout.split(/\r?\n/)[0]!.trim() || null;
}
