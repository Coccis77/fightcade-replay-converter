import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installSignalHandlers, stopOnStdinClose } from '../src/signals.js';

describe('installSignalHandlers', () => {
  it('stops cleanly when the SSH session closes (SIGHUP) or on SIGTERM', () => {
    for (const signal of ['SIGHUP', 'SIGTERM']) {
      const proc = new EventEmitter();
      const controller = new AbortController();
      installSignalHandlers(proc, controller, () => {}, () => {});
      proc.emit(signal);
      expect(controller.signal.aborted).toBe(true);
    }
  });

  it('first Ctrl-C stops cleanly, the second forces an exit', () => {
    const proc = new EventEmitter();
    const controller = new AbortController();
    const exits: number[] = [];
    installSignalHandlers(proc, controller, () => {}, (code) => exits.push(code));
    proc.emit('SIGINT');
    expect(controller.signal.aborted).toBe(true);
    expect(exits).toEqual([]);
    proc.emit('SIGINT');
    expect(exits).toEqual([130]);
  });
});

function fakeStdin() {
  const stdin = Object.assign(new EventEmitter(), { resumed: false, destroyed: false, resume() { this.resumed = true; }, destroy() { this.destroyed = true; } });
  return stdin;
}

describe('stopOnStdinClose', () => {
  it('stops like the first Ctrl-C when stdin ends, once', () => {
    const stdin = fakeStdin();
    const controller = new AbortController();
    const written: string[] = [];
    stopOnStdinClose(stdin, controller, (m) => written.push(m));
    expect(stdin.resumed).toBe(true);
    expect(controller.signal.aborted).toBe(false);
    stdin.emit('end');
    stdin.emit('close');
    expect(controller.signal.aborted).toBe(true);
    expect(written).toEqual(['\nStopping…\n']);
  });

  it('stops when stdin fails too', () => {
    const stdin = fakeStdin();
    const controller = new AbortController();
    stopOnStdinClose(stdin, controller, () => {});
    stdin.emit('error', new Error('EPIPE'));
    expect(controller.signal.aborted).toBe(true);
  });

  it('ignores stdin once disposed, and releases it', () => {
    const stdin = fakeStdin();
    const controller = new AbortController();
    const dispose = stopOnStdinClose(stdin, controller, () => {});
    dispose();
    stdin.emit('end');
    expect(controller.signal.aborted).toBe(false);
    expect(stdin.destroyed).toBe(true);
  });
});

describe('stopOnStdinClose in a real process', () => {
  const fixture = join(import.meta.dirname, 'fixtures', 'stdin-stop.ts');
  function run(mode: string, closeStdin: boolean) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, mode], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`still running after 15 s (stdout: ${stdout})`));
      }, 15_000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
      if (closeStdin) child.stdin.end();
    });
  }

  it('stops when the parent closes stdin', async () => {
    const result = await run('watch', true);
    expect(result).toMatchObject({ code: 0, stdout: 'aborted\n' });
    expect(result.stderr).toContain('Stopping…');
  }, 20_000);

  it('exits on its own once disposed, although the parent keeps stdin open', async () => {
    await expect(run('dispose', false)).resolves.toMatchObject({ code: 0, stdout: 'disposed\n' });
  }, 20_000);
});
