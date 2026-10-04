import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { DEFAULT_MAX_DURATION_MS } from '../constants.js';
import { convert, defaultDeps, prepare } from '../convert.js';
import { ConvertError, ExitCode } from '../errors.js';
import { pathExists } from '../fsUtil.js';
import { appPaths, supportedPlatform } from '../platform.js';
import { createHandler } from './http.js';
import { Jobs, type JobRunner } from './jobs.js';

export interface ServeOptions {
  port: number;
  host: string;
  fightcadeDir?: string;
  signal: AbortSignal;
  log: (msg: string) => void;
}

export interface ServeDeps {
  startup(): Promise<void>;
  run: JobRunner;
  outputDir: string;
  exists(p: string): Promise<boolean>;
}

export function defaultServeDeps(options: ServeOptions): ServeDeps {
  const convertDeps = defaultDeps();
  return {
    outputDir: appPaths(supportedPlatform(process.platform), homedir(), process.env).outputDir,
    exists: pathExists,
    // Everything the first conversion needs, checked before listening: problems show at once.
    startup: async () => {
      const install = await convertDeps.locateInstall(options.fightcadeDir);
      await convertDeps.preflight(install);
      await prepare(
        {
          signal: options.signal,
          log: options.log,
          onProgress: (e) => {
            if (e.phase === 'setting-up-wine') options.log('Setting up Wine (first run, about a minute)…');
          },
        },
        convertDeps,
      );
    },
    run: async (quarkId, output, onProgress) => {
      await convert(quarkId, {
        output,
        scale: 'sharp',
        maxDurationMs: DEFAULT_MAX_DURATION_MS,
        fightcadeDir: options.fightcadeDir,
        signal: options.signal,
        log: options.log,
        onProgress: (e) => {
          if (e.phase === 'capturing') onProgress(e.frames, e.elapsedMs);
        },
      });
    },
  };
}

function shownHost(host: string): string {
  return host === '0.0.0.0' || host === '127.0.0.1' || host === '::' ? 'localhost' : host;
}

// Runs until the signal aborts (Ctrl-C, SIGTERM, SIGHUP): the current conversion is aborted by the same
// signal, queued replays are dropped, and the server closes.
export async function serve(options: ServeOptions, deps: ServeDeps = defaultServeDeps(options)): Promise<void> {
  await deps.startup();
  if (options.signal.aborted) throw new ConvertError(ExitCode.Interrupted, 'Interrupted');

  const jobs = new Jobs({ outputDir: deps.outputDir, exists: deps.exists, run: deps.run, log: options.log });
  const server = createServer(createHandler(jobs));
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(
        err.code === 'EADDRINUSE'
          ? new ConvertError(ExitCode.Preflight, `Port ${options.port} is already in use`, 'Stop the other program, or choose another port with --port')
          : err,
      ),
    );
    server.listen(options.port, options.host, () => resolve());
  });
  options.log(`Open http://${shownHost(options.host)}:${(server.address() as AddressInfo).port}`);

  await new Promise<void>((resolve) => {
    const stop = () => {
      jobs.stop();
      server.close(() => resolve());
      server.closeAllConnections();
    };
    if (options.signal.aborted) stop();
    else options.signal.addEventListener('abort', stop, { once: true });
  });
  await jobs.idle();
}
