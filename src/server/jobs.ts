import { join } from 'node:path';
import { FRAME_FORMAT } from '../constants.js';
import { ConvertError } from '../errors.js';

export type JobView =
  | { state: 'queued'; position: number }
  | { state: 'converting'; seconds: number; speed: number }
  | { state: 'done' }
  | { state: 'failed'; error: string; hint?: string };

export type JobRunner = (quarkId: string, output: string, onProgress: (frames: number, elapsedMs: number) => void) => Promise<void>;

export type SubmitOutcome = 'queued' | 'joined' | 'done' | 'refused' | 'stopped';

export interface JobsDeps {
  outputDir: string;
  exists(p: string): Promise<boolean>;
  run: JobRunner;
  log?: (msg: string) => void;
  onFinish?: (id: string, view: JobView) => void;
}

// One conversion at a time, in arrival order. Jobs are keyed by quark ID, so the same replay is never
// converted twice; an MP4 already in the output folder is done at once (also after a restart).
export class Jobs {
  private readonly views = new Map<string, JobView>();
  private readonly queue: string[] = [];
  private current: string | null = null;
  private stopped = false;
  private worker: Promise<void> = Promise.resolve();

  constructor(private readonly deps: JobsDeps) {}

  filePath(id: string): string {
    return join(this.deps.outputDir, `${id}.mp4`);
  }

  async submit(id: string, options: { beforeQueue?: () => Promise<boolean> } = {}): Promise<SubmitOutcome> {
    if (this.stopped) {
      this.views.set(id, { state: 'failed', error: 'The server stopped' });
      return 'stopped';
    }
    if (this.isBusy(id)) return 'joined';
    // Checked every time: a finished MP4 deleted from the folder is converted again.
    if (await this.deps.exists(this.filePath(id))) {
      this.views.set(id, { state: 'done' });
      return 'done';
    }
    if (this.isBusy(id)) return 'joined'; // queued by another request while we checked the folder
    if (this.stopped) {
      this.views.set(id, { state: 'failed', error: 'The server stopped' });
      return 'stopped';
    }
    // Reserved before asking, so a second request for the same replay joins instead of asking again.
    const previous = this.views.get(id);
    this.views.set(id, { state: 'queued', position: 0 });
    if (options.beforeQueue && !(await options.beforeQueue())) {
      if (previous) this.views.set(id, previous);
      else this.views.delete(id);
      return 'refused';
    }
    if (this.stopped) {
      this.views.set(id, { state: 'failed', error: 'The server stopped' });
      return 'stopped';
    }
    this.queue.push(id);
    this.deps.log?.(`Queued ${id}`);
    if (this.current === null) this.worker = this.drain();
    return 'queued';
  }

  // An entry deleted by the admin: its old "done" view must not linger.
  forget(id: string): void {
    if (!this.isBusy(id)) this.views.delete(id);
  }

  view(id: string): JobView | null {
    const view = this.views.get(id);
    if (view?.state === 'queued') return { state: 'queued', position: this.queue.indexOf(id) + (this.current === null ? 0 : 1) };
    return view ?? null;
  }

  // Server stopping: queued replays are never started (the current conversion is aborted by the signal).
  stop(): void {
    this.stopped = true;
    for (const id of this.queue.splice(0)) this.views.set(id, { state: 'failed', error: 'The server stopped' });
  }

  idle(): Promise<void> {
    return this.worker;
  }

  isBusy(id: string): boolean {
    const state = this.views.get(id)?.state;
    return state === 'queued' || state === 'converting';
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.stopped) {
      const id = this.queue.shift()!;
      this.current = id;
      this.views.set(id, { state: 'converting', seconds: 0, speed: 0 });
      this.deps.log?.(`Converting ${id}`);
      try {
        await this.deps.run(id, this.filePath(id), (frames, elapsedMs) => {
          const seconds = (frames * 100) / FRAME_FORMAT.fpsX100;
          const speed = elapsedMs > 0 ? Math.round((seconds * 10_000) / elapsedMs) / 10 : 0;
          this.views.set(id, { state: 'converting', seconds: Math.floor(seconds), speed });
        });
        this.views.set(id, { state: 'done' });
        this.deps.onFinish?.(id, { state: 'done' });
        this.deps.log?.(`Done ${id}`);
      } catch (err) {
        const failed: Extract<JobView, { state: 'failed' }> =
          err instanceof ConvertError
            ? { state: 'failed', error: err.message, hint: err.hint }
            : { state: 'failed', error: err instanceof Error ? err.message : String(err) };
        this.views.set(id, failed);
        this.deps.onFinish?.(id, failed);
        this.deps.log?.(`Failed ${id}: ${failed.error}`);
      }
    }
    this.current = null;
  }
}
