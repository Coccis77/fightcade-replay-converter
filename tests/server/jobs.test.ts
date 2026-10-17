import { describe, expect, it } from 'vitest';
import { Jobs } from '../../src/server/jobs.js';
import { ConvertError, ExitCode } from '../../src/errors.js';

const A = '1700000000000-1111';
const B = '1700000000000-2222';
const C = '1700000000000-3333';
const ref = (quarkId: string) => ({ game: 'sfiii3nr1', quarkId });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((ok, ko) => {
    resolve = ok;
    reject = ko;
  });
  return { promise, resolve, reject };
}

function harness(files: string[] = []) {
  const runs: { id: string; game: string; output: string; progress: (seconds: number, ms: number) => void; done: ReturnType<typeof deferred> }[] = [];
  const disk = new Set(files);
  const jobs = new Jobs({
    outputDir: '/videos',
    exists: async (p) => disk.has(p),
    run: (r, output, progress) => {
      const done = deferred();
      runs.push({ id: r.quarkId, game: r.game, output, progress, done });
      return done.promise;
    },
  });
  return { jobs, runs, disk };
}

describe('Jobs', () => {
  it('converts one replay at a time, in order, reporting the queue position', async () => {
    const { jobs, runs } = harness();
    await jobs.submit(ref(A));
    await jobs.submit(ref(B));
    await jobs.submit(ref(C));
    expect(runs.map((r) => [r.id, r.output])).toEqual([[A, `/videos/${A}.mp4`]]);
    expect(jobs.view(A)).toEqual({ state: 'converting', seconds: 0, speed: 0 });
    expect(jobs.view(B)).toEqual({ state: 'queued', position: 1 });
    expect(jobs.view(C)).toEqual({ state: 'queued', position: 2 });
    runs[0]!.done.resolve();
    await flush();
    expect(jobs.view(A)).toEqual({ state: 'done' });
    expect(jobs.view(B)).toMatchObject({ state: 'converting' });
    expect(jobs.view(C)).toEqual({ state: 'queued', position: 1 });
  });

  it('reports progress as seconds of replay and speed', async () => {
    const { jobs, runs } = harness();
    await jobs.submit(ref(A));
    runs[0]!.progress(100, 10_000); // 100 s of replay in 10 s
    expect(jobs.view(A)).toEqual({ state: 'converting', seconds: 100, speed: 10 });
  });

  it('joins an existing job instead of converting twice', async () => {
    const { jobs, runs } = harness();
    await jobs.submit(ref(A));
    await jobs.submit(ref(B));
    await jobs.submit(ref(A));
    await jobs.submit(ref(B));
    runs[0]!.done.resolve();
    await flush();
    expect(runs.map((r) => r.id)).toEqual([A, B]);
  });

  it('serves an MP4 already in the folder without converting (also after a restart)', async () => {
    const { jobs, runs } = harness([`/videos/${A}.mp4`]);
    await jobs.submit(ref(A));
    expect(jobs.view(A)).toEqual({ state: 'done' });
    expect(runs).toEqual([]);
  });

  it('keeps going after a failure, with the message and hint; pasting again retries', async () => {
    const { jobs, runs } = harness();
    await jobs.submit(ref(A));
    await jobs.submit(ref(B));
    runs[0]!.done.reject(new ConvertError(ExitCode.Recording, 'The replay stream never started', 'Check the quark ID'));
    await flush();
    expect(jobs.view(A)).toEqual({ state: 'failed', error: 'The replay stream never started', hint: 'Check the quark ID' });
    expect(jobs.view(B)).toMatchObject({ state: 'converting' });
    await jobs.submit(ref(A));
    expect(jobs.view(A)).toEqual({ state: 'queued', position: 1 });
    runs[1]!.done.resolve();
    await flush();
    expect(runs.map((r) => r.id)).toEqual([A, B, A]);
  });

  it('stop() drops queued jobs; the current one ends on its own', async () => {
    const { jobs, runs } = harness();
    await jobs.submit(ref(A));
    await jobs.submit(ref(B));
    jobs.stop();
    expect(jobs.view(B)).toEqual({ state: 'failed', error: 'The server stopped' });
    runs[0]!.done.reject(new ConvertError(ExitCode.Interrupted, 'Interrupted'));
    await jobs.idle();
    expect(runs.map((r) => r.id)).toEqual([A]);
  });

  it('converts again when a finished MP4 was deleted from the folder', async () => {
    const { jobs, runs, disk } = harness([`/videos/${A}.mp4`]);
    await jobs.submit(ref(A));
    disk.delete(`/videos/${A}.mp4`);
    await jobs.submit(ref(A));
    expect(jobs.view(A)).toMatchObject({ state: 'converting' });
    expect(runs.map((r) => r.id)).toEqual([A]);
  });

  it('accepts nothing new once stopped', async () => {
    const { jobs, runs } = harness();
    jobs.stop();
    await jobs.submit(ref(A));
    expect(jobs.view(A)).toEqual({ state: 'failed', error: 'The server stopped' });
    expect(runs).toEqual([]);
  });

  it('asks before queueing a new conversion, never for one already done or running', async () => {
    const { jobs } = harness([`/videos/${B}.mp4`]);
    let asked = 0;
    const beforeQueue = async () => (asked++, true);
    expect(await jobs.submit(ref(A), { beforeQueue })).toBe('queued');
    expect(await jobs.submit(ref(A), { beforeQueue })).toBe('joined');
    expect(await jobs.submit(ref(B), { beforeQueue })).toBe('done');
    expect(asked).toBe(1);
  });

  it('refuses when beforeQueue says no, leaving nothing queued', async () => {
    const { jobs, runs } = harness();
    expect(await jobs.submit(ref(A), { beforeQueue: async () => false })).toBe('refused');
    expect(jobs.view(A)).toBeNull();
    expect(runs).toEqual([]);
  });

  it('two requests for the same new replay ask once', async () => {
    const { jobs, runs } = harness();
    let asked = 0;
    const beforeQueue = () => new Promise<boolean>((resolve) => setTimeout(() => resolve((asked++, true)), 20));
    const outcomes = await Promise.all([jobs.submit(ref(A), { beforeQueue }), jobs.submit(ref(A), { beforeQueue })]);
    expect(outcomes.sort()).toEqual(['joined', 'queued']);
    expect(asked).toBe(1);
    expect(runs.map((r) => r.id)).toEqual([A]);
  });

  it('tells when a conversion finished, and forgets a finished one on request', async () => {
    const finished: string[] = [];
    const disk = new Set<string>();
    let fail = false;
    const jobs = new Jobs({
      outputDir: '/videos',
      exists: async (p) => disk.has(p),
      run: async () => {
        if (fail) throw new ConvertError(ExitCode.Recording, 'The replay stream never started');
      },
      onFinish: (id, view) => finished.push(`${id}:${view.state}`),
    });
    await jobs.submit(ref(A));
    await jobs.idle();
    fail = true;
    await jobs.submit(ref(B));
    await jobs.idle();
    expect(finished).toEqual([`${A}:done`, `${B}:failed`]);
    jobs.forget(A);
    expect(jobs.view(A)).toBeNull();
  });

  it('undoes the reservation when the limit check fails (e.g. disk full)', async () => {
    const { jobs } = harness();
    await expect(jobs.submit(ref(A), { beforeQueue: async () => { throw new Error('ENOSPC'); } })).rejects.toThrow('ENOSPC');
    expect(jobs.view(A)).toBeNull();
    expect(await jobs.submit(ref(A), { beforeQueue: async () => true })).toBe('queued');
  });

  it('reports replays dropped by stop() as failed, so they are refunded', async () => {
    const finished: string[] = [];
    const jobs = new Jobs({ outputDir: '/videos', exists: async () => false, run: () => new Promise(() => {}), onFinish: (id, v) => finished.push(`${id}:${v.state}`) });
    await jobs.submit(ref(A));
    await jobs.submit(ref(B));
    jobs.stop();
    expect(finished).toEqual([`${B}:failed`]);
  });

  it('hands the runner the replay game', async () => {
    const { jobs, runs } = harness();
    await jobs.submit({ game: 'garou', quarkId: A });
    expect(runs.map((r) => [r.id, r.game])).toEqual([[A, 'garou']]);
  });

  it('shows a ROM error from the runner as the failed view', async () => {
    const { jobs, runs } = harness();
    await jobs.submit({ game: 'garou', quarkId: A });
    runs[0]!.done.reject(new ConvertError(ExitCode.Preflight, 'Garou: Mark of the Wolves ROM not found: /f/ROMs/garou.zip', 'Open Garou once in Fightcade so it downloads the ROM'));
    await flush();
    expect(jobs.view(A)).toEqual({ state: 'failed', error: 'Garou: Mark of the Wolves ROM not found: /f/ROMs/garou.zip', hint: 'Open Garou once in Fightcade so it downloads the ROM' });
  });

  it('knows nothing about replays never submitted', () => {
    expect(harness().jobs.view(A)).toBeNull();
  });
});
