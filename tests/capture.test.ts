import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { capture, emulatorCommand, waitAtMost, emulatorSpawnOptions, killCommand, sweepProcessGroup, winPath, type CaptureDeps, type CaptureProcess } from '../src/capture.js';
import { installLayout } from '../src/install.js';
import { ExitCode } from '../src/errors.js';

const SF3 = { game: 'sfiii3nr1', quarkId: '1-2' };

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
        encoderInput: 'pipe:0',
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

const base = { dir: DIR, game: 'sfiii3nr1', scale: 'sharp' as const, maxDurationMs: 3_600_000 };

describe('capture', () => {
  it('passes Windows paths to the emulator and finishes when it exits', async () => {
    const { deps, log, env } = harness({ infoAt: 1_000, emulatorExitsAt: 10_000 });
    const result = await capture(deps, base);
    expect(result).toMatchObject({ video: `${DIR}/video.mp4`, audio: `${DIR}/audio.raw`, endReason: 'ended', format: { width: 384, height: 224, fpsX100: 5959 } });
    expect(result.frames).toBeGreaterThan(0);
    expect(env()).toEqual({
      FC2MP4_VIDEO: 'Z:\\tmp\\fc2mp4-x\\video.fifo',
      FC2MP4_AUDIO: 'Z:\\tmp\\fc2mp4-x\\audio.raw',
      FC2MP4_INFO: 'Z:\\tmp\\fc2mp4-x\\info.txt',
      FC2MP4_IDLE_MS: '3000',
    });
    expect(log).toEqual([`transport:${DIR}`, 'emulator', 'attach', `encoder:${DIR}/video.mp4`, 'close:transport']);
  });

  it('fails within firstFrameMs when the stream never starts, killing both processes', async () => {
    const { deps, log, time } = harness({});
    await expect(capture(deps, base)).rejects.toMatchObject({ exitCode: ExitCode.Recording });
    expect(time()).toBe(20_000); // a replay that doesn't exist never answers: give up after 20 s
    expect(log).toContain('kill:emulator');
    expect(log.some((l) => l.startsWith('encoder:'))).toBe(false); // ffmpeg is never started
  });

  it('reports an emulator that exits before the first frame', async () => {
    const { deps, log } = harness({ emulatorExitsAt: 2_000 });
    await expect(capture(deps, base)).rejects.toMatchObject({ exitCode: ExitCode.Emulator });
    expect(log.some((l) => l.startsWith('encoder:'))).toBe(false);
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

  it('says a hardware encoder is not available when it fails before its first frame', async () => {
    const { deps } = harness({ infoAt: 1_000, encoderExitsAt: 1_000, encoderCode: 1 });
    await expect(capture(deps, { ...base, encoder: 'nvenc' })).rejects.toMatchObject({
      exitCode: ExitCode.Encode,
      message: "The nvenc encoder isn't available on this computer",
      hint: expect.stringMatching(/^Try another --encoder, or x264/),
    });
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

  it('reports a replay that had not started when --max-duration was reached', async () => {
    const { deps, log } = harness({});
    await expect(capture(deps, { ...base, maxDurationMs: 5_000 })).rejects.toMatchObject({
      exitCode: ExitCode.Recording,
      message: 'The replay had not started when --max-duration was reached',
      hint: 'Use a longer --max-duration',
    });
    expect(log).toContain('kill:emulator');
  });

  it('reports a replay that announced itself but sent no frame before --max-duration', async () => {
    const { deps } = harness({ infoAt: 1_000, framesStopAt: 1_000 });
    await expect(capture(deps, { ...base, maxDurationMs: 5_000 })).rejects.toMatchObject({
      exitCode: ExitCode.Recording,
      message: 'The replay had not started when --max-duration was reached',
    });
  });

  it('reads both player names from the info file', async () => {
    const info = 'p1=PlayerA\np2=Player B\nwidth=384\nheight=224\nbpp=4\nfps_x100=5959\nsample_rate=44100\n';
    const { deps } = harness({ infoAt: 1_000, emulatorExitsAt: 10_000, info });
    expect((await capture(deps, base)).players).toEqual({ p1: 'PlayerA', p2: 'Player B' });
  });

  it('has no players when the emulator does not report them (older build)', async () => {
    const { deps } = harness({ infoAt: 1_000, emulatorExitsAt: 10_000 });
    expect((await capture(deps, base)).players).toBeNull();
  });

  it('starts ffmpeg only after the emulator reported its format, at that format', async () => {
    const info = 'width=400\nheight=254\nbpp=4\nfps_x100=5471\nsample_rate=44100\n';
    const { deps, log } = harness({ infoAt: 3_000, emulatorExitsAt: 10_000, info });
    let encoderArgs: string[] = [];
    let startedAt = -1;
    const start = deps.startEncoder;
    deps.startEncoder = (args, onFrames, attach) => {
      encoderArgs = args;
      startedAt = log.length;
      return start(args, onFrames, attach);
    };
    const result = await capture(deps, { ...base, game: 'mk' });
    expect(log.indexOf('emulator')).toBeLessThan(startedAt);
    expect(encoderArgs).toContain('400x254');
    expect(encoderArgs).toContain('54.71');
    expect(result.format).toEqual({ width: 400, height: 254, bpp: 4, fpsX100: 5471, sampleRate: 44100 });
  });

  it('refuses a vertical game before starting ffmpeg, and stops the emulator', async () => {
    const info = 'width=240\nheight=320\nbpp=4\nfps_x100=5755\nsample_rate=44100\n';
    const { deps, log } = harness({ infoAt: 1_000, info });
    await expect(capture(deps, { ...base, game: 'ddonpach' })).rejects.toMatchObject({ exitCode: ExitCode.Usage, message: expect.stringContaining('ddonpach is a vertical game') });
    expect(log).toContain('kill:emulator');
    expect(log.some((l) => l.startsWith('encoder:'))).toBe(false);
    expect(log).toContain('close:transport');
  });

  it('reports progress in seconds at the reported frame rate, only once the format is known', async () => {
    const info = 'width=400\nheight=254\nbpp=4\nfps_x100=5471\nsample_rate=44100\n';
    const { deps } = harness({ infoAt: 2_000, emulatorExitsAt: 12_000, info });
    const seen: [number, number][] = [];
    await capture(deps, { ...base, game: 'mk', onProgress: (frames, seconds) => seen.push([frames, seconds]) });
    expect(seen.length).toBeGreaterThan(0);
    for (const [frames, seconds] of seen) expect(seconds).toBeCloseTo((frames * 100) / 5471, 6);
  });

  it('finishes when the emulator exits right after reporting its format, before any frame', async () => {
    const { deps } = harness({ infoAt: 1_000, emulatorExitsAt: 1_000, framesStopAt: 1_000 });
    await expect(capture(deps, base)).resolves.toMatchObject({ endReason: 'ended' });
  });

  it('asks for the full link when the emulator never starts (a bare ID is 3rd Strike)', async () => {
    const { deps } = harness({ emulatorExitsAt: 2_000 });
    await expect(capture(deps, base)).rejects.toMatchObject({
      exitCode: ExitCode.Emulator,
      hint: 'Check the link; a quark ID alone means a 3rd Strike replay. The replay may also no longer exist',
    });
  });

  it('asks for the full link when the stream never starts (a bare ID is 3rd Strike)', async () => {
    const { deps } = harness({});
    await expect(capture(deps, base)).rejects.toMatchObject({
      exitCode: ExitCode.Recording,
      message: "This replay didn't start: the link may be wrong, or Fightcade's replay server didn't answer",
      hint: 'Check the link (a quark ID alone means a 3rd Strike replay)',
    });
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
      if (deps.now() >= 1_500) controller.abort(); // after ffmpeg started (format reported at 1 s)
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
  it('streams the replay game', () => {
    const mac = installLayout('/Applications/FightCade2.app', 'darwin');
    expect(emulatorCommand(mac, '/rt', { game: 'garou', quarkId: '1-2' }).args).toEqual(['/rt/fcadefbneo-fc2mp4.exe', 'quark:stream,garou,1-2.7,7100']);
  });
  it('runs through wine.sh on macOS', () => {
    const mac = installLayout('/Applications/FightCade2.app', 'darwin');
    expect(emulatorCommand(mac, '/rt', SF3)).toEqual({
      command: '/Applications/FightCade2.app/Contents/Resources/wine.sh',
      args: ['/rt/fcadefbneo-fc2mp4.exe', 'quark:stream,sfiii3nr1,1-2.7,7100'],
    });
    expect(killCommand(mac, null)).toEqual({ command: mac.launcher, args: ['taskkill', '/IM', 'fcadefbneo-fc2mp4.exe', '/F'] });
  });
  it('runs the exe directly on Windows, with spaces in the path', () => {
    const win = installLayout('C:\\Users\\Jean Pierre\\Documents\\Fightcade', 'win32');
    const rt = 'C:\\Users\\Jean Pierre\\AppData\\Local\\fc2mp4\\runtime';
    expect(emulatorCommand(win, rt, SF3)).toEqual({
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

  it('launches the emulator with plain wine: no display needed, its exit code comes back', () => {
    expect(emulatorCommand(linux, rt, SF3)).toEqual({
      command: 'wine',
      args: [`${rt}/fcadefbneo-fc2mp4.exe`, 'quark:stream,sfiii3nr1,1-2.7,7100'],
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

  it('hides any display from the emulator on Linux (desktop, WSLg)', () => {
    const opts = emulatorSpawnOptions(linux, rt, {}, prefix, { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', PATH: '/usr/bin' });
    expect(opts.env).not.toHaveProperty('DISPLAY');
    expect(opts.env).not.toHaveProperty('WAYLAND_DISPLAY');
    expect(opts.env).toMatchObject({ PATH: '/usr/bin', WINEPREFIX: prefix });
  });

  it('keeps macOS and Windows launches as they were', () => {
    const mac = installLayout('/Applications/FightCade2.app', 'darwin');
    expect(emulatorSpawnOptions(mac, '/rt', {}, null, {})).toMatchObject({ detached: false });
    expect(killCommand(mac, null)).toEqual({ command: mac.launcher, args: ['taskkill', '/IM', 'fcadefbneo-fc2mp4.exe', '/F'] });
  });
});

describe.skipIf(process.platform === 'win32')('sweepProcessGroup', () => {
  it('stops what the emulator process group left behind', async () => {
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

describe('waitAtMost', () => {
  it('ends as soon as the process has exited, leaving no timer behind (or Node waits for it before exiting)', async () => {
    vi.useFakeTimers();
    try {
      await waitAtMost(Promise.resolve(), 15_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the limit when the process never exits', async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const waiting = waitAtMost(new Promise(() => {}), 15_000).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(14_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await waiting;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
