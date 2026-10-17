# Every Horizontal FBNeo Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fc2mp4 converts any horizontal FBNeo arcade game from Fightcade, reading each game's frame format from the emulator and its ROMs from Fightcade's `fbneo_roms.json`, and refuses vertical games clearly.

**Architecture:** (1) The macOS/Linux video transport becomes a relay like Windows': fc2mp4 reads the FIFO and pipes it into ffmpeg's stdin, so the emulator never waits for ffmpeg. (2) `capture` starts the emulator first, reads `info.txt`, validates it (height > width = vertical → refused), then starts ffmpeg with that format and reports it back. (3) A game is just its name from the link; required ROMs come from `fbneo_roms.json` (recursive `require`), the hand-written `GAMES` table is removed.

**Tech Stack:** TypeScript/Node ≥ 22.12 (ESM, strict), vitest, ffmpeg, the patched FBNeo emulator (unchanged).

**Spec:** `docs/superpowers/specs/2026-10-17-all-fbneo-games-design.md`

## Global Constraints

- No emulator patch, no new emulator release. Output 1440×1080 and scale modes unchanged; web page and `fc2mp4-ui.exe` unchanged.
- A bare quark ID means `sfiii3nr1`.
- Vertical (height > width) → Usage error `<game> is a vertical game; vertical games are not supported yet`, hint `Only horizontal games can be converted for now`; emulator stopped, no ffmpeg, no video.
- Unknown game (list present, name absent) → Usage error `Unknown game "<name>": it is not in Fightcade's FBNeo game list`.
- Missing ROM → Preflight error `ROM not found: <path>`, hint `Open the game once in Fightcade so it downloads its ROMs`.
- `fbneo_roms.json` lookup order: parent of the `fbneo` folder, then inside it; missing/unreadable → no list → only `<game>.zip` checked.
- Required ROMs: `<game>.zip` plus `require` entries recursively, each once.
- `--help` intro and `package.json` description: "Records a Fightcade FBNeo replay to MP4" / "Convert Fightcade FBNeo replays to MP4".
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. The emulator never opens the FIFO (crashes or the replay does not exist): fc2mp4 must still finish and exit, not hang on a pending FIFO open — Task 1 test.
2. ffmpeg attached long after the emulator started writing: no frame may be lost or reordered — Task 1 test.
3. A game whose `require` entries form a cycle or repeat a BIOS must not loop or check a file twice — Task 3 test.
4. A link whose game name is an Object prototype key (`constructor`) must be "unknown game" with a list, not a crash — Task 3 test.
5. The emulator exits normally right after reporting its format, before any frame: no hang waiting for ffmpeg — Task 2 test.

---

### Task 1: FIFO relay transport on macOS/Linux

**Files:**
- Modify: `src/transport.ts` (`fifoTransport`)
- Test: `tests/transport.test.ts`

**Interfaces:**
- Produces: `fifoTransport(dir, makeFifo)` returns a `VideoTransport` with `encoderInput: 'pipe:0'`, `attach(stdin)` relaying the FIFO into it, `close()` that never hangs (even if no writer ever opened the FIFO).

- [ ] **Step 1: Write the failing tests**

Add to `tests/transport.test.ts` (merge imports: `createWriteStream` from `node:fs`, `execFileSync` from `node:child_process`):

```ts
describe.skipIf(process.platform === 'win32')('fifoTransport', () => {
  async function fifo() {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-fifo-'));
    return fifoTransport(dir, async (p) => {
      execFileSync('mkfifo', [p]);
    }).then((t) => ({ t, path: join(dir, 'video.fifo') }));
  }

  it('relays into the encoder input, even when the encoder is attached after the emulator wrote', async () => {
    const { t, path } = await fifo();
    expect(t.encoderInput).toBe('pipe:0');
    const payload = Buffer.alloc(512 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const writer = createWriteStream(path);
    const written = new Promise<void>((resolve) => writer.end(payload, () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 200)); // emulator already writing, no encoder yet
    const { sink, data } = slowSink();
    const finished = new Promise<void>((resolve) => sink.on('finish', () => resolve()));
    t.attach(sink);
    await written;
    await finished;
    expect(data().equals(payload)).toBe(true);
    await t.close();
  }, 20_000);

  it('closes without hanging when the emulator never opened the FIFO', async () => {
    const { t } = await fifo();
    await t.close();
  }, 5_000);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/transport.test.ts -t fifoTransport`
Expected: FAIL — `encoderInput` is the FIFO path, not `pipe:0`.

- [ ] **Step 3: Implement**

Replace `fifoTransport` in `src/transport.ts` (add `import { closeSync, constants, createReadStream, openSync } from 'node:fs';`):

```ts
// fc2mp4 reads the FIFO itself and relays it to ffmpeg's stdin (as on Windows), so the emulator's
// open of the FIFO never waits for ffmpeg: fc2mp4 can read the game's format before starting it.
// Until attach() the stream is not read; the emulator waits on the full pipe and nothing is lost.
export async function fifoTransport(dir: string, makeFifo: (p: string) => Promise<void>): Promise<VideoTransport> {
  const fifo = join(dir, 'video.fifo');
  await makeFifo(fifo);
  let opened = false;
  const stream = createReadStream(fifo); // the open completes when the emulator opens its end
  stream.on('open', () => (opened = true));
  stream.on('error', () => {});
  return {
    emulatorPath: winPath(fifo),
    encoderInput: 'pipe:0',
    attach: (stdin) => relay(stream, stdin),
    close: async () => {
      // No writer ever came: open the write end once so the pending read-side open returns
      // (otherwise it blocks a libuv thread and Node never exits).
      if (!opened) {
        try {
          closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
        } catch {
          // already unblocked
        }
      }
      stream.destroy();
    },
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/transport.test.ts && npm test && npm run typecheck`
Expected: PASS (capture still starts ffmpeg first and attaches; nothing else changes).

- [ ] **Step 5: Commit**

```bash
git add src/transport.ts tests/transport.test.ts
git commit -m "feat: relay the FIFO to ffmpeg on macOS/Linux, as on Windows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Capture reads the format from the emulator; vertical games refused

**Files:**
- Modify: `src/ffmpeg.ts` (`checkInfo` → `validateFormat`)
- Modify: `src/capture.ts` (`CaptureOptions`, `CaptureResult`, `capture`)
- Modify: `src/convert.ts` (capture call, seconds, mux format)
- Test: `tests/ffmpeg.test.ts`, `tests/capture.test.ts`, `tests/convert.test.ts`

**Interfaces:**
- Consumes: Task 1 transport (`encoderInput: 'pipe:0'` everywhere).
- Produces: `validateFormat(info: FrameFormat, game: string): void`; `CaptureOptions { dir; game: string; scale; maxDurationMs; signal?; onProgress?(frames: number, seconds: number, elapsedMs: number) }` (no `format`); `CaptureResult { video; audio; frames; format: FrameFormat; endReason }`.

- [ ] **Step 1: Write the failing tests**

`tests/ffmpeg.test.ts`: import `validateFormat` instead of `checkInfo`; replace the `describe('emulator info', …)` body's checks with:

```ts
  it('parses and accepts a horizontal format', () => {
    const info = parseInfo(good);
    expect(info).toEqual({ width: 384, height: 224, bpp: 4, fpsX100: 5959, sampleRate: 44100 });
    expect(() => validateFormat(info, 'sfiii3nr1')).not.toThrow();
    expect(() => validateFormat(parseInfo('width=400\nheight=254\nbpp=4\nfps_x100=5471\nsample_rate=44100\n'), 'mk')).not.toThrow();
  });
  it('rejects an invalid format with a Recording error', () => {
    expect(thrown(() => validateFormat(parseInfo(good.replace('bpp=4', 'bpp=2')), 'x'))).toMatchObject({ exitCode: ExitCode.Recording, message: expect.stringContaining('bpp 2') });
    expect(thrown(() => validateFormat(parseInfo(good.replace('fps_x100=5959', 'fps_x100=0')), 'x'))).toMatchObject({ exitCode: ExitCode.Recording });
  });
  it('refuses a vertical game by name', () => {
    expect(thrown(() => validateFormat(parseInfo('width=240\nheight=320\nbpp=4\nfps_x100=5755\nsample_rate=44100\n'), 'ddonpach'))).toMatchObject({
      exitCode: ExitCode.Usage,
      message: 'ddonpach is a vertical game; vertical games are not supported yet',
      hint: 'Only horizontal games can be converted for now',
    });
  });
  it('rejects an incomplete info file', () => {
    expect(thrown(() => parseInfo('width=384\n'))).toMatchObject({ exitCode: ExitCode.Recording });
  });
```

`tests/capture.test.ts`:
- In the harness's fake transport, `encoderInput: 'pipe:0'`.
- `const base = { dir: DIR, game: 'sfiii3nr1', scale: 'sharp' as const, maxDurationMs: 3_600_000 };`
- The first test's order becomes `[`transport:${DIR}`, 'emulator', 'attach', `encoder:${DIR}/video.mp4`, 'close:transport']` and its result also `toMatchObject({ format: { width: 384, height: 224, fpsX100: 5959 } })`. (`attach` is logged by the fake transport when the encoder is wired; adjust the fake's `startEncoder` to call `attach` before logging `encoder:` if needed so this order holds.)
- `'fails within firstFrameMs…'` and `'reports an emulator that exits before the first frame'`: replace `expect(log).toContain('kill:encoder')` with `expect(log.some((l) => l.startsWith('encoder:'))).toBe(false)` (ffmpeg is never started).
- Replace the Garou format test with:

```ts
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
```

- Every other `capture(deps, { ...base, format: … })` drops `format`.

`tests/convert.test.ts`:
- Fake `capture`: `calls.push(`capture:${opts.game}:${ref.quarkId}:${opts.dir}`); return { video: '/tmp/run/video.mp4', audio: '/tmp/run/audio.raw', frames: 8220, format: { width: 384, height: 224, bpp: 4, fpsX100: 5959, sampleRate: 44100 }, endReason: 'ended' };` and every other fake capture result gains the same `format`.
- Expectations `capture:<game>:${ID}:/tmp/run:<width>` lose the `:<width>` suffix.
- Replace `'reports progress and length in seconds at the game frame rate'` with:

```ts
  it('passes on capture progress and times the result at the reported frame rate', async () => {
    const events: unknown[] = [];
    const { deps } = harness({
      capture: async (_install, _ref, _ffmpeg, opts) => {
        opts.onProgress?.(35508, 600, 60_000);
        return { video: 'v', audio: 'a', frames: 35508, format: { width: 320, height: 224, bpp: 4, fpsX100: 5918, sampleRate: 44100 }, endReason: 'ended' };
      },
    });
    const result = await convert(`https://replay.fightcade.com/fbneo/garou/${ID}`, { ...baseOptions, onProgress: (e) => events.push(e) }, deps);
    expect(events).toContainEqual({ phase: 'capturing', frames: 35508, seconds: 600, elapsedMs: 60_000 });
    expect(result.seconds).toBe(600);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/ffmpeg.test.ts tests/capture.test.ts tests/convert.test.ts`
Expected: FAIL — `validateFormat` missing, encoder started before the emulator, no `format` in the result.

- [ ] **Step 3: Implement**

`src/ffmpeg.ts`: replace `checkInfo` with:

```ts
const describeFormat = (f: FrameFormat) => `${f.width}x${f.height} bpp ${f.bpp} @ ${f.fpsX100 / 100} fps, ${f.sampleRate} Hz`;

// What the emulator reported for this game. Vertical games report their upright size (taller than
// wide) but draw sideways: not supported (they would need the emulator's orientation flags).
export function validateFormat(info: FrameFormat, game: string): void {
  if (info.bpp !== 4 || info.width <= 0 || info.height <= 0 || info.fpsX100 <= 0 || info.sampleRate <= 0) {
    throw new ConvertError(
      ExitCode.Recording,
      `Unexpected frame format from the emulator: ${describeFormat(info)}`,
      'The emulator build may not match this fc2mp4 version; run fc2mp4 rebuild-emulator',
    );
  }
  if (info.height > info.width) {
    throw new ConvertError(ExitCode.Usage, `${game} is a vertical game; vertical games are not supported yet`, 'Only horizontal games can be converted for now');
  }
}
```

`src/capture.ts`:
- Imports: `validateFormat` instead of `checkInfo`; `type FrameFormat` stays.
- `CaptureOptions`: remove `format`, add `game: string;`, and `onProgress?: (frames: number, seconds: number, elapsedMs: number) => void;`.
- `CaptureResult`: add `format: FrameFormat;`.
- Replace the body of `capture` with:

```ts
export async function capture(deps: CaptureDeps, opts: CaptureOptions): Promise<CaptureResult> {
  const video = join(opts.dir, 'video.mp4');
  const audio = join(opts.dir, 'audio.raw');
  const info = join(opts.dir, 'info.txt');

  const transport = await deps.openTransport(opts.dir);
  let frames = 0;
  let format: FrameFormat | null = null;
  let encoder: CaptureProcess | null = null;
  // The emulator first, ffmpeg once the emulator reported the game's format (the transport holds
  // the frames meanwhile).
  const emulator = deps.startEmulator({
    FC2MP4_VIDEO: transport.emulatorPath,
    FC2MP4_AUDIO: deps.toEmulatorPath(audio),
    FC2MP4_INFO: deps.toEmulatorPath(info),
    FC2MP4_IDLE_MS: String(TIMEOUTS.emulatorIdleMs),
  });

  const start = deps.now();
  let lastFrames = 0;
  let lastProgressAt = start;
  let endReason: CaptureResult['endReason'] = 'ended';
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new ConvertError(ExitCode.Interrupted, 'Interrupted');
      if (format === null) {
        const text = await deps.readInfo(info);
        if (text !== null) {
          const reported = parseInfo(text);
          validateFormat(reported, opts.game);
          format = reported;
          encoder = deps.startEncoder(
            videoEncodeArgs({ input: transport.encoderInput, output: video, scale: opts.scale, format }),
            (n) => (frames = n),
            (stdin) => transport.attach(stdin),
          );
          lastProgressAt = deps.now();
        }
      }
      if (emulator.exited) {
        if (format === null) {
          throw new ConvertError(ExitCode.Emulator, 'The emulator exited before the replay started', 'Check the link; a quark ID alone means a 3rd Strike replay. The replay may also no longer exist');
        }
        const code = await emulator.wait();
        if (code !== 0) {
          throw new ConvertError(ExitCode.Emulator, `The emulator stopped unexpectedly (exit ${code}) after ${frames} frames`, 'The replay was not captured completely; try again');
        }
        break;
      }
      if (encoder?.exited) throw new ConvertError(ExitCode.Encode, 'The video encoder stopped unexpectedly');
      const now = deps.now();
      const elapsed = now - start;
      if (frames !== lastFrames) {
        lastFrames = frames;
        lastProgressAt = now;
      }
      if (format !== null && now - lastProgressAt >= TIMEOUTS.stallMs) {
        throw new ConvertError(ExitCode.Recording, `The capture stalled: no new frame for ${TIMEOUTS.stallMs / 1000} s`, 'The emulator may be stuck; try again (use -v for details)');
      }
      if (format === null && elapsed >= TIMEOUTS.firstFrameMs) {
        throw new ConvertError(ExitCode.Recording, 'The replay stream never started', 'Check the link (a quark ID alone means a 3rd Strike replay) and that Fightcade replay servers are reachable');
      }
      if (elapsed >= opts.maxDurationMs) {
        // Nothing to keep yet: say so instead of letting ffmpeg fail on an empty video.
        if (format === null || frames === 0) throw new ConvertError(ExitCode.Recording, 'The replay had not started when --max-duration was reached', 'Use a longer --max-duration');
        endReason = 'max-duration';
        await emulator.kill();
        break;
      }
      if (format !== null) opts.onProgress?.(frames, (frames * 100) / format.fpsX100, elapsed);
      await deps.sleep(TIMEOUTS.pollMs);
    }
    // The loop only leaves normally once the format is known, so ffmpeg runs.
    const code = await encoder!.wait();
    if (code !== 0) throw new ConvertError(ExitCode.Encode, `The video encoder failed (exit ${code})`);
    return { video, audio, frames, format: format!, endReason };
  } finally {
    if (!emulator.exited) await emulator.kill().catch(() => {});
    if (encoder !== null && !encoder.exited) await encoder.kill().catch(() => {});
    await transport.close().catch(() => {});
  }
}
```

- `CaptureDeps.startEncoder`'s third parameter type becomes `(stdin: Writable) => void` (always given); in `defaultCaptureDeps.startEncoder`, spawn with `stdio: ['pipe', 'pipe', 'ignore']` and always `child.stdin.on('error', () => {}); attach(child.stdin);`.

`src/convert.ts`, in `convert`: replace the `const { format } = ref.game;` … `deps.capture(…)` block, the mux call and the return with:

```ts
    const captured = await deps.capture(install, ref, ffmpeg, {
      dir,
      game: ref.game.id,
      scale: options.scale,
      maxDurationMs: options.maxDurationMs,
      signal: options.signal,
      onProgress: (frames, seconds, elapsedMs) => options.onProgress?.({ phase: 'capturing', frames, seconds, elapsedMs }),
    });
    if (captured.endReason === 'max-duration') log('Warning: reached --max-duration; the video may be cut short');

    options.onProgress?.({ phase: 'finalizing' });
    await deps.mkdir(dirname(output));
    await deps.mux({ video: captured.video, audio: captured.audio, output, format: captured.format }, ffmpeg);
    return { output, frames: captured.frames, seconds: (captured.frames * 100) / captured.format.fpsX100, endReason: captured.endReason };
```

(`game: ref.game.id` becomes `game: ref.game` in Task 3.)

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg.ts src/capture.ts src/convert.ts tests/ffmpeg.test.ts tests/capture.test.ts tests/convert.test.ts
git commit -m "feat: read each game's format from the emulator; refuse vertical games

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Games are names; ROMs from Fightcade's list

**Files:**
- Create: `src/romList.ts`; Test: `tests/romList.test.ts`
- Modify: `src/constants.ts` (remove `Game`, `GAMES`; `DEFAULT_GAME = 'sfiii3nr1'`), `src/replayRef.ts`, `src/install.ts` (`checkRoms`), `src/convert.ts` (`checkRoms` dep, `game: ref.game`)
- Test: `tests/replayRef.test.ts`, `tests/install.test.ts`, `tests/convert.test.ts`, `tests/capture.test.ts`, `tests/ffmpeg.test.ts`, `tests/server/jobs.test.ts`, `tests/server/http.test.ts`

**Interfaces:**
- Produces: `ReplayRef { game: string; quarkId: string }`; `DEFAULT_GAME: string`; `type RomList = ReadonlyMap<string, readonly string[]>`; `parseRomList(text: string): RomList | null`; `romListPaths(install): string[]`; `loadRomList(install, readText: (p: string) => Promise<string | null>): Promise<RomList | null>`; `requiredRoms(game: string, list: RomList | null): string[]`; `checkRoms(install, game: string, list: RomList | null, exists): Promise<void>`; `ConvertDeps.checkRoms(install, game: string)`.

- [ ] **Step 1: Write the failing tests**

`tests/romList.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { installLayout } from '../src/install.js';
import { loadRomList, parseRomList, requiredRoms, romListPaths } from '../src/romList.js';
import { ExitCode } from '../src/errors.js';

const JSON_LIST = JSON.stringify({
  garou: { download: 'x', require: ['neogeo'] },
  neogeo: { download: 'x' },
  kof98a: { download: 'x', require: ['kof98', 'neogeo'] },
  kof98: { download: 'x', require: ['neogeo'] },
  loopa: { require: ['loopb'] },
  loopb: { require: ['loopa'] },
  mk: { download: 'x' },
});

describe('parseRomList', () => {
  it('reads each game and what it requires', () => {
    const list = parseRomList(JSON_LIST)!;
    expect(list.get('garou')).toEqual(['neogeo']);
    expect(list.get('mk')).toEqual([]);
  });
  it.each([['not json'], ['[]'], ['null'], ['42']])('gives no list for %j', (text) => {
    expect(parseRomList(text)).toBeNull();
  });
});

describe('requiredRoms', () => {
  const list = parseRomList(JSON_LIST);
  it('adds parents and BIOS, each once', () => {
    expect(requiredRoms('garou', list)).toEqual(['garou.zip', 'neogeo.zip']);
    expect(requiredRoms('kof98a', list)).toEqual(['kof98a.zip', 'kof98.zip', 'neogeo.zip']);
    expect(requiredRoms('mk', list)).toEqual(['mk.zip']);
  });
  it('survives a cycle', () => {
    expect(requiredRoms('loopa', list)).toEqual(['loopa.zip', 'loopb.zip']);
  });
  it.each([['kof99'], ['constructor'], ['__proto__']])('refuses %j when it is not in the list', (game) => {
    expect(() => requiredRoms(game, list)).toThrow(expect.objectContaining({ exitCode: ExitCode.Usage, message: `Unknown game "${game}": it is not in Fightcade's FBNeo game list` }));
  });
  it('without a list, checks only the game zip', () => {
    expect(requiredRoms('anything', null)).toEqual(['anything.zip']);
  });
});

describe('loadRomList', () => {
  const mac = installLayout('/Applications/FightCade2.app', 'darwin');
  it('looks next to the fbneo folder, then inside it', () => {
    expect(romListPaths(mac)).toEqual([
      '/Applications/FightCade2.app/Contents/MacOS/emulator/fbneo_roms.json',
      '/Applications/FightCade2.app/Contents/MacOS/emulator/fbneo/fbneo_roms.json',
    ]);
  });
  it('uses the first readable list, and none when no file is readable', async () => {
    const files: Record<string, string> = { [romListPaths(mac)[1]!]: JSON_LIST };
    const list = await loadRomList(mac, async (p) => files[p] ?? null);
    expect(list?.get('garou')).toEqual(['neogeo']);
    expect(await loadRomList(mac, async () => null)).toBeNull();
    expect(await loadRomList(mac, async () => 'garbage')).toBeNull();
  });
});
```

`tests/install.test.ts`: replace `describe('checkRoms', …)` with:

```ts
describe('checkRoms', () => {
  const win = installLayout(WIN_ROOT, 'win32');
  const roms = `${WIN_ROOT}\\emulator\\fbneo\\ROMs`;
  const list = parseRomList(JSON.stringify({ garou: { require: ['neogeo'] }, neogeo: {}, mk: {} }));
  const only = (...files: string[]) => async (p: string) => files.some((f) => p === `${roms}\\${f}`);

  it('passes when the game and everything it requires are there', async () => {
    await expect(checkRoms(win, 'garou', list, only('garou.zip', 'neogeo.zip'))).resolves.toBeUndefined();
    await expect(checkRoms(win, 'mk', list, only('mk.zip'))).resolves.toBeUndefined();
  });
  it('names the missing file', async () => {
    await expect(checkRoms(win, 'garou', list, only('garou.zip'))).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: `ROM not found: ${roms}\\neogeo.zip`,
      hint: 'Open the game once in Fightcade so it downloads its ROMs',
    });
  });
  it('without a list checks only the game zip', async () => {
    await expect(checkRoms(win, 'garou', null, only('garou.zip'))).resolves.toBeUndefined();
  });
  it('refuses a game missing from the list', async () => {
    await expect(checkRoms(win, 'kof99', list, only())).rejects.toMatchObject({ exitCode: ExitCode.Usage });
  });
});
```

(import `parseRomList` from `../src/romList.js`; drop the `GAMES` import.)

`tests/replayRef.test.ts`: rewrite the expectations for names:
- 3rd Strike inputs → `toEqual({ game: 'sfiii3nr1', quarkId: ID })`; Garou links → `{ game: 'garou', quarkId: ID }`.
- Replace the "rejects game … supported games" test with: `it('takes any game name from a link', () => { expect(parseReplayRef(`https://replay.fightcade.com/fbneo/mk/${ID}`)).toEqual({ game: 'mk', quarkId: ID }); });`
- `streamArg({ game: 'garou', quarkId: ID })` → `quark:stream,garou,…`.
- Delete the `describe('GAMES', …)` block and the Super SF2X/Alpha 3/Vampire Savior link tests become a single `it.each([['ssf2xjr1'], ['sfa3'], ['vsavj']])` reading `{ game, quarkId: ID }`.
- `DEFAULT_GAME` test: `expect(DEFAULT_GAME).toBe('sfiii3nr1')`.

Other tests, mechanical (`GAMES.<x>` → `'<x>'`, `.game.id` → `.game`):
- `tests/capture.test.ts`: `const SF3 = { game: 'sfiii3nr1', quarkId: '1-2' };`, `{ game: 'garou', quarkId: '1-2' }`; drop the `GAMES` import.
- `tests/ffmpeg.test.ts`: `const SF3 = { width: 384, height: 224, bpp: 4, fpsX100: 5959, sampleRate: 44100 } as const;`, `const GAROU = { width: 320, height: 224, bpp: 4, fpsX100: 5918, sampleRate: 44100 } as const;`, replace `GAMES.garou.format` by `GAROU`; drop the import.
- `tests/convert.test.ts`: fake `checkRoms: async (_install, game) => { calls.push(`roms:${game}`); }`; the ROM-error fake throws `new ConvertError(ExitCode.Preflight, 'ROM not found: neogeo.zip')` and the expectation matches that message; `convert({ game: 'garou', quarkId: ID }, …)`; drop the import.
- `tests/server/jobs.test.ts`: `const ref = (quarkId: string) => ({ game: 'sfiii3nr1', quarkId });`, `game: r.game`, `{ game: 'garou', quarkId: A }`; drop the import.
- `tests/server/http.test.ts`: `seen.push(`${r.game}:${r.quarkId}`)`, `{ game: 'sfiii3nr1', quarkId: ID }`; remove the `kof98` 400 check (any name is accepted by the parser now; unknown names fail in the job); drop the import.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/romList.test.ts tests/install.test.ts tests/replayRef.test.ts`
Expected: FAIL — `src/romList.ts` missing; `checkRoms`/`parseReplayRef` still use `GAMES`.

- [ ] **Step 3: Implement**

`src/romList.ts`:

```ts
import { ConvertError, ExitCode } from './errors.js';
import type { FightcadeInstall } from './install.js';
import { pathFor } from './platform.js';

// Fightcade's fbneo_roms.json: every FBNeo arcade game it can download, with the ROM sets it needs
// besides its own (parent, BIOS). Game name → required names.
export type RomList = ReadonlyMap<string, readonly string[]>;

export function parseRomList(text: string): RomList | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const list = new Map<string, readonly string[]>();
  for (const [name, entry] of Object.entries(data as Record<string, unknown>)) {
    const require = entry !== null && typeof entry === 'object' ? (entry as { require?: unknown }).require : undefined;
    list.set(name, Array.isArray(require) ? require.filter((r): r is string => typeof r === 'string') : []);
  }
  return list;
}

// Where Fightcade keeps it (next to the fbneo folder), then inside the fbneo folder (copied server folders).
export function romListPaths(install: FightcadeInstall): string[] {
  const p = pathFor(install.platform);
  return [p.join(p.dirname(install.fbneoDir), 'fbneo_roms.json'), p.join(install.fbneoDir, 'fbneo_roms.json')];
}

export async function loadRomList(install: FightcadeInstall, readText: (p: string) => Promise<string | null>): Promise<RomList | null> {
  for (const file of romListPaths(install)) {
    const text = await readText(file);
    const list = text === null ? null : parseRomList(text);
    if (list) return list;
  }
  return null;
}

// The game's zip and everything it requires, recursively, each once. Without a list: its zip only.
export function requiredRoms(game: string, list: RomList | null): string[] {
  if (list && !list.has(game)) throw new ConvertError(ExitCode.Usage, `Unknown game "${game}": it is not in Fightcade's FBNeo game list`);
  const seen = new Set<string>();
  const zips: string[] = [];
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    zips.push(`${name}.zip`);
    for (const required of list?.get(name) ?? []) visit(required);
  };
  visit(game);
  return zips;
}
```

`src/constants.ts`: delete the `Game` interface and the `GAMES` table (and its comment); replace `DEFAULT_GAME` with:

```ts
// A bare quark ID (no link) is a 3rd Strike replay.
export const DEFAULT_GAME = 'sfiii3nr1';
```

`src/replayRef.ts`:

```ts
import { DEFAULT_GAME, QUARK_SUFFIX, STREAM_PORT } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';

// game: the FBNeo name from the link (checked against Fightcade's list before converting).
export interface ReplayRef {
  game: string;
  quarkId: string;
}

const BARE_ID = /^\d+-\d+$/;
const IN_LINK = /\/([A-Za-z0-9_]+)\/(\d+-\d+)(?=[/?#]|$)/;

export function parseReplayRef(input: string): ReplayRef {
  const value = input.trim();
  if (BARE_ID.test(value)) return { game: DEFAULT_GAME, quarkId: value };

  const match = IN_LINK.exec(value);
  if (!match) {
    throw new ConvertError(
      ExitCode.Usage,
      `Not a Fightcade replay link or quark ID: "${value}"`,
      `Expected e.g. https://replay.fightcade.com/fbneo/${DEFAULT_GAME}/1700000000000-1234 or 1700000000000-1234`,
    );
  }
  return { game: match[1]!, quarkId: match[2]! };
}

export function streamArg(ref: ReplayRef): string {
  return `quark:stream,${ref.game},${ref.quarkId}${QUARK_SUFFIX},${STREAM_PORT}`;
}
```

`src/install.ts`: drop `import type { Game }`; add `import { requiredRoms, type RomList } from './romList.js';`; replace `checkRoms`:

```ts
// Per conversion, for the replay's game: a server with only some games' ROMs still converts those.
export async function checkRoms(install: FightcadeInstall, game: string, list: RomList | null, exists: (p: string) => Promise<boolean>): Promise<void> {
  const p = pathFor(install.platform);
  for (const rom of requiredRoms(game, list)) {
    const file = p.join(install.romsDir, rom);
    if (!(await exists(file))) {
      throw new ConvertError(ExitCode.Preflight, `ROM not found: ${file}`, 'Open the game once in Fightcade so it downloads its ROMs');
    }
  }
}
```

`src/convert.ts`:
- Imports: `import type { FrameFormat } from './constants.js';` (no `Game`); add `import { loadRomList } from './romList.js';` and `readFile` to the `node:fs/promises` import.
- `ConvertDeps.checkRoms(install: FightcadeInstall, game: string): Promise<void>;`
- Default dep: `checkRoms: async (install, game) => checkRoms(install, game, await loadRomList(install, (p) => readFile(p, 'utf8').catch(() => null)), pathExists),`
- In `convert`: `game: ref.game` in the capture options.

- [ ] **Step 4: Run the tests**

Run: `npm test && npm run typecheck && grep -rn "GAMES\|\.game\.id\|game\.format\|game\.title" src tests`
Expected: PASS; the grep prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat: any FBNeo game from Fightcade's list; ROMs read from fbneo_roms.json

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Texts, real replays, release

**Files:**
- Modify: `src/cliArgs.ts` (USAGE intro), `package.json` (description), `README.md`
- Test: `tests/cliArgs.test.ts` (USAGE test), manual e2e

- [ ] **Step 1: Update the USAGE test (failing)**

In `tests/cliArgs.test.ts`, the `USAGE` test becomes:

```ts
  it('describes any FBNeo game and says a bare quark ID is 3rd Strike', () => {
    expect(USAGE).toContain('Records a Fightcade FBNeo replay to MP4 (macOS, Windows and Linux).');
    expect(USAGE).toContain('a quark ID alone means 3rd Strike');
    expect(USAGE).toContain('Vertical games are not supported yet.');
  });
```

Run: `npx vitest run tests/cliArgs.test.ts` — Expected: FAIL.

- [ ] **Step 2: Update the texts**

- `src/cliArgs.ts` USAGE intro lines:

```
Records a Fightcade FBNeo replay to MP4 (macOS, Windows and Linux).
Pass the replay link; a quark ID alone means 3rd Strike. Vertical games are not supported yet.
```

- `package.json` description: `"Convert Fightcade FBNeo replays to MP4"`.
- `README.md`:
  - First paragraph: `Turns a Fightcade FBNeo replay into an MP4 (1440×1080, H.264/AAC), faster than real time.` (keep the rest of the sentence).
  - Replace the `## Supported games` table section with:

```markdown
## Supported games

Any horizontal FBNeo arcade game you can play on Fightcade: fc2mp4 reads each game's screen size and
speed from the emulator, and its ROMs from Fightcade's game list. Vertical games (shoot'em ups like
DoDonPachi) are not supported yet.

Tested with real replays: Street Fighter III: 3rd Strike (`sfiii3nr1`), Garou: Mark of the Wolves
(`garou`), Super Street Fighter II X (`ssf2xjr1`), Street Fighter Alpha 3 (`sfa3`), Vampire Savior
(`vsavj`), Mortal Kombat (`mk`).

Open the game once in Fightcade so it downloads its ROMs. Links look like
`https://replay.fightcade.com/fbneo/<game>/<id>`; a quark ID alone (`1700000000000-1234`) is read as
3rd Strike.
```

  - Linux install and VPS sections: where they say "the game's ROMs in `ROMs/` (see Supported games)" / "the ROMs of the games you want to offer in `ROMs/`", add: "and, optionally, Fightcade's `emulator/fbneo_roms.json` copied into that folder, so fc2mp4 can tell which parent or BIOS files each game needs".

Run: `npx vitest run tests/cliArgs.test.ts && npm test && npm run typecheck` — Expected: PASS.

- [ ] **Step 3: Real replays**

```bash
FC_E2E=https://replay.fightcade.com/fbneo/mk/1792204056623-9422 FC_E2E_EXPECTED_SECONDS=234.69 npx vitest run tests/e2e.test.ts
FC_E2E=https://replay.fightcade.com/fbneo/garou/1791766846976-7757 FC_E2E_EXPECTED_SECONDS=106.45 npx vitest run tests/e2e.test.ts
FC_E2E=https://replay.fightcade.com/fbneo/ssf2xjr1/1792135916955-7043 FC_E2E_EXPECTED_SECONDS=288.78 npx vitest run tests/e2e.test.ts
FC_E2E=https://replay.fightcade.com/fbneo/sfa3/1792152118748-6544 FC_E2E_EXPECTED_SECONDS=240.48 npx vitest run tests/e2e.test.ts
FC_E2E=https://replay.fightcade.com/fbneo/vsavj/1792150879328-2444 FC_E2E_EXPECTED_SECONDS=199.23 npx vitest run tests/e2e.test.ts
FC_E2E=1791006077129-2245 FC_E2E_EXPECTED_SECONDS=137.94 npx vitest run tests/e2e.test.ts
npx tsx src/cli.ts https://replay.fightcade.com/fbneo/ddonpach/1791133804325-1040 -o /tmp; echo "exit $?"
```

Expected: the six e2e runs PASS; the last prints `Error: ddonpach is a vertical game; vertical games are not supported yet`, exit 2, and `pgrep -fl fcadefbneo` prints nothing afterwards.

- [ ] **Step 4: Commit**

```bash
git add src/cliArgs.ts package.json README.md tests/cliArgs.test.ts
git commit -m "docs: any horizontal FBNeo game; tested games listed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Release (ask first)** — after the final review: fast-forward `main`, `npm version 0.16.0 --no-git-tag-version`, commit `chore: v0.16.0`, annotated tag `v0.16.0`, push `main` and the tag, confirm the release lists its four files. (The Windows `fc2mp4-ui.exe` needs no change.)
