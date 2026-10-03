import { describe, expect, it } from 'vitest';
import { capture, winPath, type CaptureDeps, type CaptureProcess } from '../src/capture.js';
import { ExitCode } from '../src/errors.js';

const INFO = 'width=384\nheight=224\nbpp=4\nfps_x100=5959\nsample_rate=44100\n';
const DIR = '/tmp/fc2mp4-x';

// Simulated time advances only in sleep(); processes exit at a scripted time or when killed.
function harness(world: { infoAt?: number; info?: string; emulatorExitsAt?: number; encoderExitsAt?: number; encoderCode?: number } = {}) {
  let t = 0;
  const log: string[] = [];
  let emulatorEnv: Record<string, string> = {};
  let onFrames: (n: number) => void = () => {};

  function proc(name: string, exitAt: number | undefined, code = 0): CaptureProcess {
    let done = false;
    let exitCode: number | null = null;
    return {
      get exited() {
        if (!done && exitAt !== undefined && t >= exitAt) {
          done = true;
          exitCode = code;
        }
        return done;
      },
      wait: async () => {
        done = true;
        return exitCode ?? code;
      },
      kill: async () => {
        log.push(`kill:${name}`);
        done = true;
        exitCode = null;
      },
    };
  }

  const deps: CaptureDeps = {
    makeFifo: async (p) => {
      log.push(`fifo:${p}`);
    },
    startEncoder: (args, frames) => {
      log.push(`encoder:${args.at(-1)}`);
      onFrames = frames;
      return proc('encoder', world.encoderExitsAt, world.encoderCode ?? 0);
    },
    startEmulator: (env) => {
      emulatorEnv = env;
      log.push('emulator');
      return proc('emulator', world.emulatorExitsAt);
    },
    readInfo: async () => (world.infoAt !== undefined && t >= world.infoAt ? (world.info ?? INFO) : null),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      if (world.infoAt !== undefined && t >= world.infoAt) onFrames(Math.round((t - world.infoAt) / 16.78));
    },
  };
  return { deps, log, env: () => emulatorEnv, time: () => t };
}

const base = { dir: DIR, scale: 'sharp' as const, maxDurationMs: 3_600_000 };

describe('capture', () => {
  it('passes Windows paths to the emulator and finishes when it exits', async () => {
    const { deps, log, env } = harness({ infoAt: 1_000, emulatorExitsAt: 10_000 });
    const result = await capture(deps, base);
    expect(result).toMatchObject({ video: `${DIR}/video.mp4`, audio: `${DIR}/audio.raw`, endReason: 'ended' });
    expect(result.frames).toBeGreaterThan(0);
    expect(env()).toEqual({
      FC2MP4_VIDEO: 'Z:\\tmp\\fc2mp4-x\\video.fifo',
      FC2MP4_AUDIO: 'Z:\\tmp\\fc2mp4-x\\audio.raw',
      FC2MP4_INFO: 'Z:\\tmp\\fc2mp4-x\\info.txt',
      FC2MP4_IDLE_MS: '5000',
    });
    expect(log).toEqual([`fifo:${DIR}/video.fifo`, `encoder:${DIR}/video.mp4`, 'emulator']);
  });

  it('fails within firstFrameMs when the stream never starts, killing both processes', async () => {
    const { deps, log, time } = harness({});
    await expect(capture(deps, base)).rejects.toMatchObject({ exitCode: ExitCode.Recording });
    expect(time()).toBe(60_000);
    expect(log).toContain('kill:emulator');
    expect(log).toContain('kill:encoder');
  });

  it('reports an emulator that exits before the first frame', async () => {
    const { deps, log } = harness({ emulatorExitsAt: 2_000 });
    await expect(capture(deps, base)).rejects.toMatchObject({ exitCode: ExitCode.Emulator });
    expect(log).toContain('kill:encoder');
  });

  it('reports an encoder that dies while capturing', async () => {
    const { deps, log } = harness({ infoAt: 1_000, encoderExitsAt: 3_000, encoderCode: 1 });
    await expect(capture(deps, base)).rejects.toMatchObject({ exitCode: ExitCode.Encode });
    expect(log).toContain('kill:emulator');
  });

  it('stops at maxDurationMs and keeps what was captured', async () => {
    const { deps, log } = harness({ infoAt: 1_000 });
    const result = await capture(deps, { ...base, maxDurationMs: 5_000 });
    expect(result.endReason).toBe('max-duration');
    expect(log).toContain('kill:emulator');
    expect(log).not.toContain('kill:encoder');
  });

  it('rejects a wrong frame format', async () => {
    const { deps } = harness({ infoAt: 1_000, info: INFO.replace('bpp=4', 'bpp=2') });
    await expect(capture(deps, base)).rejects.toMatchObject({ exitCode: ExitCode.Recording, message: expect.stringContaining('bpp 2') });
  });

  it('cleans up on Ctrl-C', async () => {
    const { deps, log } = harness({ infoAt: 1_000 });
    const controller = new AbortController();
    const sleep = deps.sleep;
    deps.sleep = async (ms) => {
      await sleep(ms);
      if (ms > 0) controller.abort();
    };
    await expect(capture(deps, { ...base, signal: controller.signal })).rejects.toMatchObject({ exitCode: ExitCode.Interrupted });
    expect(log).toContain('kill:emulator');
    expect(log).toContain('kill:encoder');
  });
});

describe('winPath', () => {
  it('maps a POSIX path onto Wine drive Z:', () => {
    expect(winPath('/Users/a b/x.fifo')).toBe('Z:\\Users\\a b\\x.fifo');
  });
});
