import { describe, expect, it } from 'vitest';
import { Jobs } from '../../src/server/jobs.js';
import { ConvertError, ExitCode } from '../../src/errors.js';

const A = '1700000000000-1111';
const B = '1700000000000-2222';
const C = '1700000000000-3333';
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
  const runs: { id: string; output: string; progress: (frames: number, ms: number) => void; done: ReturnType<typeof deferred> }[] = [];
  const disk = new Set(files);
  const jobs = new Jobs({
    outputDir: '/videos',
    exists: async (p) => disk.has(p),
    run: (id, output, progress) => {
      const done = deferred();
      runs.push({ id, output, progress, done });
      return done.promise;
    },
  });
  return { jobs, runs, disk };
}

describe('Jobs', () => {
  it('converts one replay at a time, in order, reporting the queue position', async () => {
    const { jobs, runs } = harness();
    await jobs.submit(A);
    await jobs.submit(B);
    await jobs.submit(C);
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
    await jobs.submit(A);
    runs[0]!.progress(5959, 10_000); // 100 s of replay in 10 s
    expect(jobs.view(A)).toEqual({ state: 'converting', seconds: 100, speed: 10 });
  });

  it('joins an existing job instead of converting twice', async () => {
    const { jobs, runs } = harness();
    await jobs.submit(A);
    await jobs.submit(B);
    await jobs.submit(A);
    await jobs.submit(B);
    runs[0]!.done.resolve();
    await flush();
    expect(runs.map((r) => r.id)).toEqual([A, B]);
  });

  it('serves an MP4 already in the folder without converting (also after a restart)', async () => {
    const { jobs, runs } = harness([`/videos/${A}.mp4`]);
    await jobs.submit(A);
    expect(jobs.view(A)).toEqual({ state: 'done' });
    expect(runs).toEqual([]);
  });

  it('keeps going after a failure, with the message and hint; pasting again retries', async () => {
    const { jobs, runs } = harness();
    await jobs.submit(A);
    await jobs.submit(B);
    runs[0]!.done.reject(new ConvertError(ExitCode.Recording, 'The replay stream never started', 'Check the quark ID'));
    await flush();
    expect(jobs.view(A)).toEqual({ state: 'failed', error: 'The replay stream never started', hint: 'Check the quark ID' });
    expect(jobs.view(B)).toMatchObject({ state: 'converting' });
    await jobs.submit(A);
    expect(jobs.view(A)).toEqual({ state: 'queued', position: 1 });
    runs[1]!.done.resolve();
    await flush();
    expect(runs.map((r) => r.id)).toEqual([A, B, A]);
  });

  it('stop() drops queued jobs; the current one ends on its own', async () => {
    const { jobs, runs } = harness();
    await jobs.submit(A);
    await jobs.submit(B);
    jobs.stop();
    expect(jobs.view(B)).toEqual({ state: 'failed', error: 'The server stopped' });
    runs[0]!.done.reject(new ConvertError(ExitCode.Interrupted, 'Interrupted'));
    await jobs.idle();
    expect(runs.map((r) => r.id)).toEqual([A]);
  });

  it('converts again when a finished MP4 was deleted from the folder', async () => {
    const { jobs, runs, disk } = harness([`/videos/${A}.mp4`]);
    await jobs.submit(A);
    disk.delete(`/videos/${A}.mp4`);
    await jobs.submit(A);
    expect(jobs.view(A)).toMatchObject({ state: 'converting' });
    expect(runs.map((r) => r.id)).toEqual([A]);
  });

  it('accepts nothing new once stopped', async () => {
    const { jobs, runs } = harness();
    jobs.stop();
    await jobs.submit(A);
    expect(jobs.view(A)).toEqual({ state: 'failed', error: 'The server stopped' });
    expect(runs).toEqual([]);
  });

  it('knows nothing about replays never submitted', () => {
    expect(harness().jobs.view(A)).toBeNull();
  });
});
