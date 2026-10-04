import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { installSignalHandlers } from '../src/signals.js';

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
