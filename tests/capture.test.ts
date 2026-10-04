import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { capture, emulatorCommand, emulatorSpawnOptions, killCommand, sweepProcessGroup, winPath, type CaptureDeps, type CaptureProcess } from '../src/capture.js';
import { installLayout } from '../src/install.js';
import { ExitCode } from '../src/errors.js';

const INFO = 'width=384\nheight=224\nbpp=4\nfps_x100=5959\nsample_rate=44100\n';
const DIR = '/tmp/fc2mp4-x';

// Simulated time advances only in sleep(); processes exit at a scripted time or when killed.
function harness(
  world: { infoAt?: number; info?: string; emulatorExitsAt?: number; emulatorCode?: number; framesStopAt?: number; encoderExitsAt?: number; encoderCode?: number } = {},
) {
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
    openTransport: async (dir) => {
      log.push(`transport:${dir}`);
      return {
        emulatorPath: 'Z:\\tmp\\fc2mp4-x\\video.fifo',
        encoderInput: `${dir}/video.fifo`,
        attach: () => {
          log.push('attach');
        },
        close: async () => {
          log.push('close:transport');
        },
      };
    },
    toEmulatorPath: (p) => winPath(p),
    startEncoder: (args, frames, attach) => {
      if (attach) attach(new PassThrough());
      log.push(`encoder:${args.at(-1)}`);
      onFrames = frames;
      return proc('encoder', world.encoderExitsAt, world.encoderCode ?? 0);
    },
    startEmulator: (env) => {
      emulatorEnv = env;
      log.push('emulator');
      return proc('emulator', world.emulatorExitsAt, world.emulatorCode ?? 0);
    },
    readInfo: async () => (world.infoAt !== undefined && t >= world.infoAt ? (world.info ?? INFO) : null),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      if (world.infoAt !== undefined && t >= world.infoAt) onFrames(Math.round((Math.min(t, world.framesStopAt ?? Infinity) - world.infoAt) / 16.78));
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
      FC2MP4_IDLE_MS: '15000',
    });
    expect(log).toEqual([`transport:${DIR}`, `encoder:${DIR}/video.mp4`, 'emulator', 'close:transport']);
  });

  it('adds the extra emulator environment (Linux sound device)', async () => {
    const { deps, env } = harness({ infoAt: 1_000, emulatorExitsAt: 10_000 });
    await capture(deps, { ...base, emulatorEnv: { PULSE_SERVER: 'unix:/tmp/fc2mp4-x/pulse/native' } });
    expect(env()).toMatchObject({ PULSE_SERVER: 'unix:/tmp/fc2mp4-x/pulse/native', FC2MP4_IDLE_MS: '15000' });
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

  it('reports an emulator that crashes after the replay started instead of keeping a truncated video', async () => {
    const { deps } = harness({ infoAt: 1_000, emulatorExitsAt: 5_000, emulatorCode: 3 });
    await expect(capture(deps, base)).rejects.toMatchObject({ exitCode: ExitCode.Emulator, message: expect.stringContaining('exit 3') });
  });

  it('fails instead of hanging when frames stop arriving', async () => {
    const { deps, log, time } = harness({ infoAt: 1_000, framesStopAt: 10_000 });
    await expect(capture(deps, base)).rejects.toMatchObject({ exitCode: ExitCode.Recording, message: expect.stringContaining('stalled') });
    expect(time()).toBeLessThan(60_000);
    expect(log).toContain('kill:emulator');
    expect(log).toContain('kill:encoder');
  });

  it('closes the transport on every exit path', async () => {
    for (const world of [{}, { emulatorExitsAt: 2_000 }, { infoAt: 1_000, encoderExitsAt: 3_000, encoderCode: 1 }]) {
      const { deps, log } = harness(world);
      await capture(deps, base).catch(() => {});
      expect(log).toContain('close:transport');
    }
  });

  it('attaches the encoder stdin when the transport is a pipe', async () => {
    const { deps, log } = harness({ infoAt: 1_000, emulatorExitsAt: 10_000 });
    const open = deps.openTransport;
    deps.openTransport = async (dir) => ({ ...(await open(dir)), encoderInput: 'pipe:0', emulatorPath: '\\\\.\\pipe\\fc2mp4-1-a' });
    await capture(deps, base);
    expect(log).toContain('attach');
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

describe('emulator launch per platform', () => {
  it('runs through wine.sh on macOS', () => {
    const mac = installLayout('/Applications/FightCade2.app', 'darwin');
    expect(emulatorCommand(mac, '/rt', '1-2')).toEqual({
      command: '/Applications/FightCade2.app/Contents/Resources/wine.sh',
      args: ['/rt/fcadefbneo-fc2mp4.exe', 'quark:stream,sfiii3nr1,1-2.7,7100'],
    });
    expect(killCommand(mac, null)).toEqual({ command: mac.launcher, args: ['taskkill', '/IM', 'fcadefbneo-fc2mp4.exe', '/F'] });
  });
  it('runs the exe directly on Windows, with spaces in the path', () => {
    const win = installLayout('C:\\Users\\Jean Pierre\\Documents\\Fightcade', 'win32');
    const rt = 'C:\\Users\\Jean Pierre\\AppData\\Local\\fc2mp4\\runtime';
    expect(emulatorCommand(win, rt, '1-2')).toEqual({
      command: `${rt}\\fcadefbneo-fc2mp4.exe`,
      args: ['quark:stream,sfiii3nr1,1-2.7,7100'],
    });
    expect(killCommand(win, null)).toEqual({ command: 'taskkill', args: ['/IM', 'fcadefbneo-fc2mp4.exe', '/F'] });
  });
});

describe('headless launch on Linux', () => {
  const linux = installLayout('/srv/fightcade', 'linux');
  const rt = '/home/a/.cache/fc2mp4/runtime';
  const prefix = '/home/a/.cache/fc2mp4/wineprefix';

  it('always runs under a virtual display, launching the emulator directly so its exit code comes back', () => {
    // The virtual desktop is configured in our prefix's registry at setup (no `explorer /desktop`).
    expect(emulatorCommand(linux, rt, '1-2')).toEqual({
      command: 'xvfb-run',
      args: ['-a', '-s', '-screen 0 1024x768x24', 'wine', `${rt}/fcadefbneo-fc2mp4.exe`, 'quark:stream,sfiii3nr1,1-2.7,7100'],
    });
  });

  it('stops every Wine process of our prefix only', () => {
    expect(killCommand(linux, prefix)).toEqual({
      command: 'wineserver',
      args: ['-k'],
      env: { WINEARCH: 'win32', WINEPREFIX: prefix, WINEDEBUG: '-all', WINEDLLOVERRIDES: 'mscoree,mshtml=' },
    });
  });

  it('starts in its own process group with our prefix, even if the user set WINEPREFIX', () => {
    const opts = emulatorSpawnOptions(linux, rt, { FC2MP4_VIDEO: 'Z:\\x' }, prefix, { WINEPREFIX: '/home/a/.wine', PATH: '/usr/bin' });
    expect(opts).toMatchObject({ cwd: rt, detached: true, stdio: 'ignore' });
    expect(opts.env).toMatchObject({ WINEPREFIX: prefix, WINEARCH: 'win32', FC2MP4_VIDEO: 'Z:\\x', PATH: '/usr/bin' });
  });

  it('keeps macOS and Windows launches as they were', () => {
    const mac = installLayout('/Applications/FightCade2.app', 'darwin');
    expect(emulatorSpawnOptions(mac, '/rt', {}, null, {})).toMatchObject({ detached: false });
    expect(killCommand(mac, null)).toEqual({ command: mac.launcher, args: ['taskkill', '/IM', 'fcadefbneo-fc2mp4.exe', '/F'] });
  });
});

describe.skipIf(process.platform === 'win32')('sweepProcessGroup', () => {
  it('stops what the emulator process group left behind (e.g. Xvfb after xvfb-run was killed)', async () => {
    const child = spawn('sh', ['-c', 'sleep 30 & echo $!'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout!.on('data', (d) => (out += d));
    await new Promise((done) => child.on('exit', done));
    const orphan = Number(out.trim());
    expect(() => process.kill(orphan, 0)).not.toThrow(); // still running after its parent exited

    sweepProcessGroup(child.pid!);
    await new Promise((done) => setTimeout(done, 200));
    expect(() => process.kill(orphan, 0)).toThrow();
  });

  it('does nothing when the group is already gone', () => {
    expect(() => sweepProcessGroup(2 ** 22 - 3)).not.toThrow();
  });
});
