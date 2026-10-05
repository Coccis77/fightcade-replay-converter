import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_MAX_DURATION_MS } from '../constants.js';
import { convert, defaultDeps, notWritableHint, prepare } from '../convert.js';
import { ConvertError, ExitCode } from '../errors.js';
import { pathExists } from '../fsUtil.js';
import { appPaths, supportedPlatform } from '../platform.js';
import { Accounts } from './accounts.js';
import { LoginThrottle } from './auth.js';
import { cleanOutputFolder, defaultCleanupDeps, type CleanupDeps } from './cleanup.js';
import { createHandler } from './http.js';
import { Jobs, type JobRunner } from './jobs.js';
import { DataStore } from './store.js';

export interface ServeOptions {
  port: number;
  host: string;
  fightcadeDir?: string;
  // Delete fc2mp4's MP4s older than this from the output folder (off when undefined).
  keepMs?: number;
  // FC2MP4_TRUST_PROXY=1: trust X-Forwarded-* from any peer (Docker + Caddy).
  trustProxy?: boolean;
  signal: AbortSignal;
  log: (msg: string) => void;
}

export interface ServeDeps {
  startup(): Promise<void>;
  checkWritable(dir: string): Promise<void>;
  run: JobRunner;
  outputDir: string;
  exists(p: string): Promise<boolean>;
  cleanup: CleanupDeps;
  schedule(fn: () => void, ms: number): () => void;
  // This machine's network addresses, shown to reach the page from other devices.
  addresses(): string[];
  inDocker: boolean;
  // Users, sessions and the shared list (fc2mp4-data.json in the output folder).
  dataFile: string;
}

// Virtual networks (Docker, VM bridges, VPN tunnels) are not reachable by other devices on the LAN.
const VIRTUAL_INTERFACE = /^(docker|br-|veth|bridge|vmnet|vboxnet|utun|tun|tap|wg|zt)/;

export function externalAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string[] {
  return Object.entries(interfaces)
    .filter(([name]) => !VIRTUAL_INTERFACE.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

export function dataFilePath(outputDir: string): string {
  return join(outputDir, 'fc2mp4-data.json');
}

// fc2mp4 reset-admin: works while serve runs (the server rereads the file when it changed).
export function resetAdmin(dataFile: string): Promise<boolean> {
  return new Accounts(new DataStore(dataFile)).removeAdmin();
}

export function defaultServeDeps(options: ServeOptions): ServeDeps {
  const convertDeps = defaultDeps();
  const outputDir = appPaths(supportedPlatform(process.platform), homedir(), process.env).outputDir;
  return {
    outputDir,
    dataFile: dataFilePath(outputDir),
    exists: pathExists,
    checkWritable: (dir) => convertDeps.checkWritable(dir),
    cleanup: defaultCleanupDeps(),
    addresses: () => externalAddresses(networkInterfaces()),
    inDocker: Boolean(process.env.FC2MP4_DOCKER),
    schedule: (fn, ms) => {
      const timer = setInterval(fn, ms);
      timer.unref();
      return () => clearInterval(timer);
    },
    // Everything the first conversion needs, checked before any request is served: problems show at once.
    startup: async () => {
      const install = await convertDeps.locateInstall(options.fightcadeDir);
      await convertDeps.preflight(install);
      await prepare(
        {
          signal: options.signal,
          log: options.log,
          forceUpdate: false, // the daily check, as for conversions
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

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

function shownAge(ms: number): string {
  if (ms >= DAY_MS) return `${Math.floor(ms / DAY_MS)} days old`;
  return `${Math.floor(ms / HOUR_MS)} hours old`;
}

function shownHost(host: string): string {
  return host === '0.0.0.0' || host === '127.0.0.1' || host === '::' ? 'localhost' : host;
}

function listenError(err: NodeJS.ErrnoException, options: ServeOptions): Error {
  switch (err.code) {
    case 'EADDRINUSE':
      return new ConvertError(ExitCode.Preflight, `Port ${options.port} is already in use`, 'Stop the other program, or choose another port with --port');
    case 'EACCES':
      return new ConvertError(ExitCode.Preflight, `Not allowed to use port ${options.port}`, 'Use a port above 1024, e.g. --port 8080');
    case 'EADDRNOTAVAIL':
    case 'ENOTFOUND':
      return new ConvertError(ExitCode.Preflight, `This machine has no address ${options.host}`, 'Use --host 0.0.0.0 (all addresses), or leave --host out');
    default:
      return err;
  }
}

// Runs until the signal aborts (Ctrl-C, SIGTERM, SIGHUP): the current conversion is aborted by the same
// signal, queued replays are dropped, and the server closes.
export async function serve(options: ServeOptions, deps: ServeDeps = defaultServeDeps(options)): Promise<void> {
  // The port is taken first: a port already in use shows at once, before the (possibly minute-long)
  // startup. Requests are only answered once the startup is done.
  // Until the startup is done every request gets a quick 503 (the page retries): a request left
  // unanswered would also keep server.close() from ever finishing if the startup fails.
  let handler: ReturnType<typeof createHandler> | null = null;
  const server = createServer((req, res) => {
    if (handler) return handler(req, res);
    const body = JSON.stringify({ error: 'fc2mp4 is starting, try again in a moment' });
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), Connection: 'close', 'Retry-After': '2' });
    res.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => reject(listenError(err, options)));
    server.listen(options.port, options.host, () => resolve());
  });
  let accounts!: Accounts;
  try {
    await deps.startup();
    // A folder fc2mp4 cannot write to (a root-owned Docker mount) shows now, not on the first job.
    await deps.checkWritable(deps.outputDir).catch((err: unknown) => {
      throw err instanceof ConvertError ? new ConvertError(err.exitCode, err.message, notWritableHint(true, deps.inDocker)) : err;
    });
    accounts = new Accounts(new DataStore(deps.dataFile));
    await accounts.isSetUp(); // reads the file: a damaged one stops the startup here, with its path
    await accounts.reconcile((id) => deps.exists(join(deps.outputDir, `${id}.mp4`)));
    if (options.signal.aborted) throw new ConvertError(ExitCode.Interrupted, 'Interrupted');
  } catch (err) {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    throw err;
  }

  const jobs = new Jobs({
    outputDir: deps.outputDir,
    exists: deps.exists,
    run: deps.run,
    log: options.log,
    onFinish: (id, view) => {
      accounts.finish(id, view.state === 'done', view.state === 'failed' ? view.error : undefined).catch((err: unknown) => options.log(`Could not save the result of ${id}: ${String(err)}`));
    },
  });
  handler = createHandler({ jobs, accounts, throttle: new LoginThrottle(), removeFile: (p) => rm(p, { force: true }), trustProxy: options.trustProxy ?? false });
  const port = (server.address() as AddressInfo).port;
  options.log(`Open http://${shownHost(options.host)}:${port}`);
  if (options.host === '0.0.0.0' || options.host === '::') {
    // Inside Docker the addresses are the container's: other devices need the computer's own.
    if (deps.inDocker) options.log(`Other devices: use this computer's network address, port ${port}`);
    else for (const ip of deps.addresses()) options.log(`Other devices: http://${ip}:${port}`);
  }

  let cancelCleanup = () => {};
  if (options.keepMs !== undefined) {
    const keepMs = options.keepMs;
    const sweep = async () => {
      try {
        for (const file of await cleanOutputFolder(deps.outputDir, keepMs, (id) => jobs.isBusy(id), deps.cleanup)) {
          options.log(`Deleted ${file.name} (${shownAge(file.ageMs)})`);
          const id = /^(\d+-\d+)/.exec(file.name)?.[1];
          if (id && !file.name.endsWith('.part.mp4')) {
            await accounts.removeConversion(id);
            jobs.forget(id);
          }
        }
      } catch (err) {
        // An hourly cleanup must never take the server down (disk full, damaged data file).
        options.log(`Cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    void sweep();
    cancelCleanup = deps.schedule(() => void sweep(), HOUR_MS);
  }

  await new Promise<void>((resolve) => {
    const stop = () => {
      cancelCleanup();
      jobs.stop();
      server.close(() => resolve());
      server.closeAllConnections();
    };
    if (options.signal.aborted) stop();
    else options.signal.addEventListener('abort', stop, { once: true });
  });
  await jobs.idle();
}
