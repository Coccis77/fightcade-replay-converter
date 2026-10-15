# Garou: Mark of the Wolves Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** fc2mp4 converts Fightcade replays of Garou: Mark of the Wolves (`garou`) as well as 3rd Strike (`sfiii3nr1`), from the CLI, Docker and the web page.

**Architecture:** A small `GAMES` table in `src/constants.ts` (id, titles, required ROM files, frame format) replaces the single `GAME` / `FRAME_FORMAT` constants. `parseReplayRef` returns the `Game` from the link; that `ReplayRef` flows through convert → capture (stream argument, ffmpeg input format, info check) → mux (sample rate), through the per-game ROM check, and through the web server's job queue. Progress is reported in seconds of replay, computed once in `convert` from the game's fps.

**Tech Stack:** TypeScript (Node ≥ 22.12, ESM, `strict`), vitest, ffmpeg, the patched FBNeo emulator (unchanged).

**Spec:** `docs/superpowers/specs/2026-10-15-garou-support-design.md`

## Global Constraints

- Garou only besides 3rd Strike: no generic game support, no `--game` flag, no format auto-detection.
- Garou format (measured): `{ width: 320, height: 224, bpp: 4, fpsX100: 5918, sampleRate: 44100 }`; 3rd Strike unchanged: `{ width: 384, height: 224, bpp: 4, fpsX100: 5959, sampleRate: 44100 }`.
- ROMs: 3rd Strike `['sfiii3nr1.zip', 'sfiii3.zip']`, Garou `['garou.zip', 'neogeo.zip']`.
- A bare quark ID means 3rd Strike. Existing 3rd Strike links and IDs behave exactly as before.
- Unknown game message: `Unsupported game "<id>": supported games are sfiii3nr1 (3rd Strike), garou (Garou)`.
- Missing ROM message: `<title> ROM not found: <path>`, hint `Open <shortTitle> once in Fightcade so it downloads the ROM`.
- `prepare` and `serve` startup check no ROMs; the ROM check runs per conversion.
- Web page: no game names. `<h1>fc2mp4</h1>`, subtitle `Fightcade replay → MP4`. No game label in the list.
- `fc2mp4-data.json` / `ConversionRecord` unchanged. Videos stay `<quarkId>.mp4`.
- Emulator build, timeouts, INI settings, 1440×1080 output and scale filters unchanged.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A link whose game segment is an Object prototype key (`…/fbneo/constructor/<id>`, `…/toString/<id>`) must be refused as an unsupported game, not crash or pass — Task 1 test.
2. A bare quark ID of a Garou replay is streamed as 3rd Strike and the emulator exits before starting: the hint must tell the user to paste the full link — Task 2 test.
3. Only `neogeo.zip` missing (garou.zip present): the message must name `neogeo.zip`, not a generic "ROM" — Task 3 test.
4. A server whose Fightcade folder has only 3rd Strike ROMs must still start and convert 3rd Strike; a Garou request fails with the ROM message (refunded as any failure) — Task 3 test (preflight no longer checks ROMs) + Task 4 test (runner error surfaces in the job view).
5. Progress and final length for Garou use 59.18 fps, not 59.59 (a 10-minute Garou replay must not read 9:56) — Task 2 test.

---

### Task 1: Game table and the ReplayRef carrying it to the emulator

**Files:**
- Modify: `src/constants.ts:1` (add types + table; keep `GAME` and `FRAME_FORMAT` for now, removed in Tasks 3 and 4)
- Modify: `src/replayRef.ts` (whole file)
- Modify: `src/capture.ts:49-58` (`emulatorCommand`), `src/capture.ts:193-199,228` (`defaultCaptureDeps`)
- Modify: `src/convert.ts:58,111,146` (`capture` dep takes the ref)
- Test: `tests/replayRef.test.ts`, `tests/capture.test.ts:195-226`, `tests/convert.test.ts:49-51`

**Interfaces:**
- Produces:
  - `src/constants.ts`: `interface FrameFormat { readonly width: number; readonly height: number; readonly bpp: number; readonly fpsX100: number; readonly sampleRate: number }`, `interface Game { readonly id: string; readonly title: string; readonly shortTitle: string; readonly roms: readonly string[]; readonly format: FrameFormat }`, `const GAMES: Readonly<Record<string, Game>>`, `const DEFAULT_GAME: Game`.
  - `src/replayRef.ts`: `interface ReplayRef { game: Game; quarkId: string }`, `parseReplayRef(input: string): ReplayRef`, `streamArg(ref: ReplayRef): string`.
  - `src/capture.ts`: `emulatorCommand(install, runtimeDir, ref: ReplayRef)`, `defaultCaptureDeps(install, runtimeDir, ref: ReplayRef, ffmpeg, winePrefix)`.
  - `ConvertDeps.capture(install: FightcadeInstall, ref: ReplayRef, ffmpeg: string, opts: CaptureOptions): Promise<CaptureResult>`.

- [ ] **Step 1: Write the failing tests**

Replace `tests/replayRef.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { parseReplayRef, streamArg } from '../src/replayRef.js';
import { DEFAULT_GAME, GAMES } from '../src/constants.js';
import { ConvertError, ExitCode } from '../src/errors.js';

const ID = '1700000000000-1234';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('parseReplayRef', () => {
  it.each([
    [ID],
    [`  ${ID}\n`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}/`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}?t=42#x`],
    [`fcade://play/fbneo/sfiii3nr1/${ID}`],
  ])('reads %j as 3rd Strike', (input) => {
    expect(parseReplayRef(input)).toEqual({ game: GAMES.sfiii3nr1, quarkId: ID });
  });

  it.each([[`https://replay.fightcade.com/fbneo/garou/${ID}`], [`fcade://play/fbneo/garou/${ID}`]])('reads %j as Garou', (input) => {
    expect(parseReplayRef(input)).toEqual({ game: GAMES.garou, quarkId: ID });
  });

  it('treats a bare quark ID as 3rd Strike', () => {
    expect(DEFAULT_GAME).toBe(GAMES.sfiii3nr1);
    expect(parseReplayRef(ID).game.id).toBe('sfiii3nr1');
  });

  it.each([['kof98'], ['constructor'], ['toString'], ['__proto__']])('rejects game %j with a usage error listing the supported games', (game) => {
    const error = thrown(() => parseReplayRef(`https://replay.fightcade.com/fbneo/${game}/${ID}`));
    expect(error).toBeInstanceOf(ConvertError);
    expect(error).toMatchObject({
      exitCode: ExitCode.Usage,
      message: `Unsupported game "${game}": supported games are sfiii3nr1 (3rd Strike), garou (Garou)`,
    });
  });

  it.each([[''], ['hello'], ['https://replay.fightcade.com/'], ['1700000000000']])('rejects %j', (input) => {
    expect(() => parseReplayRef(input)).toThrow(/Not a Fightcade replay/);
  });
});

describe('streamArg', () => {
  it('builds the quark:stream argument for the replay game, with the client suffix and port', () => {
    expect(streamArg({ game: GAMES.sfiii3nr1, quarkId: ID })).toBe(`quark:stream,sfiii3nr1,${ID}.7,7100`);
    expect(streamArg({ game: GAMES.garou, quarkId: ID })).toBe(`quark:stream,garou,${ID}.7,7100`);
  });
});

describe('GAMES', () => {
  it('holds the measured formats and required ROMs', () => {
    expect(GAMES.sfiii3nr1).toMatchObject({ roms: ['sfiii3nr1.zip', 'sfiii3.zip'], format: { width: 384, height: 224, bpp: 4, fpsX100: 5959, sampleRate: 44100 } });
    expect(GAMES.garou).toMatchObject({ roms: ['garou.zip', 'neogeo.zip'], format: { width: 320, height: 224, bpp: 4, fpsX100: 5918, sampleRate: 44100 } });
  });
});
```

In `tests/capture.test.ts`, add after the existing imports (line 6):

```ts
import { GAMES } from '../src/constants.js';

const SF3 = { game: GAMES.sfiii3nr1, quarkId: '1-2' };
```

and replace the three `emulatorCommand(…, '1-2')` calls (lines 199, 208, 222) with `emulatorCommand(…, SF3)` (same expected values). Then add inside `describe('emulator launch per platform', …)`:

```ts
  it('streams the replay game', () => {
    const mac = installLayout('/Applications/FightCade2.app', 'darwin');
    expect(emulatorCommand(mac, '/rt', { game: GAMES.garou, quarkId: '1-2' }).args).toEqual(['/rt/fcadefbneo-fc2mp4.exe', 'quark:stream,garou,1-2.7,7100']);
  });
```

In `tests/convert.test.ts`, change the fake `capture` (lines 49-51) to:

```ts
    capture: async (_install, ref, _ffmpeg, opts) => {
      calls.push(`capture:${ref.game.id}:${ref.quarkId}:${opts.dir}`);
      return { video: '/tmp/run/video.mp4', audio: '/tmp/run/audio.raw', frames: 8220, endReason: 'ended' };
    },
```

and in `'runs the pipeline in order'` replace `` `capture:${ID}:/tmp/run` `` with `` `capture:sfiii3nr1:${ID}:/tmp/run` ``. Add this test after it:

```ts
  it('captures the game from the link', async () => {
    const { deps, calls } = harness();
    await convert(`https://replay.fightcade.com/fbneo/garou/${ID}`, baseOptions, deps);
    expect(calls).toContain(`capture:garou:${ID}:/tmp/run`);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/replayRef.test.ts tests/capture.test.ts tests/convert.test.ts`
Expected: FAIL — `GAMES` / `DEFAULT_GAME` not exported, `ref.game.id` undefined.

- [ ] **Step 3: Implement**

In `src/constants.ts`, insert after line 1 (`export const GAME = 'sfiii3nr1';`):

```ts

export interface FrameFormat {
  readonly width: number;
  readonly height: number;
  readonly bpp: number;
  readonly fpsX100: number;
  readonly sampleRate: number;
}

export interface Game {
  readonly id: string; // ROM name, as in replay links and quark:stream
  readonly title: string;
  readonly shortTitle: string;
  readonly roms: readonly string[]; // files the emulator needs in Fightcade's ROMs folder
  readonly format: FrameFormat; // what the patched emulator reports in its info file
}

// Garou's format was measured on a real replay (2026-10-15).
export const GAMES: Readonly<Record<string, Game>> = {
  sfiii3nr1: {
    id: 'sfiii3nr1',
    title: 'Street Fighter III: 3rd Strike',
    shortTitle: '3rd Strike',
    roms: ['sfiii3nr1.zip', 'sfiii3.zip'],
    format: { width: 384, height: 224, bpp: 4, fpsX100: 5959, sampleRate: 44100 },
  },
  garou: {
    id: 'garou',
    title: 'Garou: Mark of the Wolves',
    shortTitle: 'Garou',
    roms: ['garou.zip', 'neogeo.zip'],
    format: { width: 320, height: 224, bpp: 4, fpsX100: 5918, sampleRate: 44100 },
  },
};

// A bare quark ID (no link) is a 3rd Strike replay, as before Garou was supported.
export const DEFAULT_GAME: Game = GAMES.sfiii3nr1;
```

Replace `src/replayRef.ts` with:

```ts
import { DEFAULT_GAME, GAMES, QUARK_SUFFIX, STREAM_PORT, type Game } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';

export interface ReplayRef {
  game: Game;
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
      `Expected e.g. https://replay.fightcade.com/fbneo/${DEFAULT_GAME.id}/1700000000000-1234 or 1700000000000-1234`,
    );
  }
  const [, id, quarkId] = match;
  // hasOwn: "constructor" and friends are not games.
  const game = Object.hasOwn(GAMES, id!) ? GAMES[id!] : undefined;
  if (!game) {
    const supported = Object.values(GAMES).map((g) => `${g.id} (${g.shortTitle})`).join(', ');
    throw new ConvertError(ExitCode.Usage, `Unsupported game "${id}": supported games are ${supported}`);
  }
  return { game, quarkId: quarkId! };
}

export function streamArg(ref: ReplayRef): string {
  return `quark:stream,${ref.game.id},${ref.quarkId}${QUARK_SUFFIX},${STREAM_PORT}`;
}
```

In `src/capture.ts`: change the import on line 12 to `import { streamArg, type ReplayRef } from './replayRef.js';`, then replace `emulatorCommand` (lines 49-58) with:

```ts
export function emulatorCommand(install: FightcadeInstall, runtimeDir: string, ref: ReplayRef): { command: string; args: string[] } {
  const exe = pathFor(install.platform).join(runtimeDir, EMULATOR_EXE);
  if (install.platform === 'linux') {
    // No display: our prefix uses Wine's null display driver and the emulator shows no window while
    // recording. Launched directly, so its exit code comes back.
    return { command: 'wine', args: [exe, streamArg(ref)] };
  }
  if (install.launcher !== null) return { command: install.launcher, args: [exe, streamArg(ref)] };
  return { command: exe, args: [streamArg(ref)] };
}
```

In `defaultCaptureDeps`, rename the parameter `quarkId: string` to `ref: ReplayRef` and change `emulatorCommand(install, runtimeDir, quarkId)` to `emulatorCommand(install, runtimeDir, ref)`.

In `src/convert.ts`: change the import on line 18 to `import { parseReplayRef, type ReplayRef } from './replayRef.js';`; change the `ConvertDeps.capture` line to

```ts
  capture(install: FightcadeInstall, ref: ReplayRef, ffmpeg: string, opts: CaptureOptions): Promise<CaptureResult>;
```

the default dep (line 111) to

```ts
    capture: (install, ref, ffmpeg, opts) => capture(defaultCaptureDeps(install, app.runtimeDir, ref, ffmpeg, install.platform === 'linux' ? app.wineprefixDir : null), opts),
```

and in `convert`, `deps.capture(install, ref.quarkId, ffmpeg, {` to `deps.capture(install, ref, ffmpeg, {`.

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/replayRef.test.ts tests/capture.test.ts tests/convert.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/constants.ts src/replayRef.ts src/capture.ts src/convert.ts tests/replayRef.test.ts tests/capture.test.ts tests/convert.test.ts
git commit -m "feat: game table; replay links for Garou reach the emulator

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The game's frame format in capture, ffmpeg and progress

**Files:**
- Modify: `src/ffmpeg.ts:1-35,44-71,90-99`
- Modify: `src/capture.ts:9,35-41,99,118,125`
- Modify: `src/convert.ts:22-27,40-44,60,115,146-157`
- Modify: `src/cliArgs.ts:2,44-47`, `src/cli.ts:20-24,82`
- Test: `tests/ffmpeg.test.ts`, `tests/capture.test.ts`, `tests/convert.test.ts`, `tests/cliArgs.test.ts:83-88`

**Interfaces:**
- Consumes: `FrameFormat`, `GAMES` (Task 1); `ReplayRef` (Task 1).
- Produces:
  - `videoEncodeArgs({ input, output, scale, format: FrameFormat })`, `muxArgs({ video, audio, output, sampleRate: number })`, `mux({ video, audio, output, sampleRate }, ffmpeg?)`, `parseInfo(text): FrameFormat`, `checkInfo(info: FrameFormat, expected: FrameFormat): void`. `FrameInfo` is removed.
  - `CaptureOptions.format: FrameFormat`.
  - `ProgressEvent` capturing: `{ phase: 'capturing'; frames: number; seconds: number; elapsedMs: number }` (seconds of replay).
  - `ConvertResult.seconds: number`; `ConvertDeps.mux(args: { video: string; audio: string; output: string; sampleRate: number }, ffmpeg: string)`.
  - `formatReplayLength(seconds: number): string`.

- [ ] **Step 1: Write the failing tests**

`tests/ffmpeg.test.ts`: add `import { GAMES } from '../src/constants.js';` and `const SF3 = GAMES.sfiii3nr1.format;` after the imports. Then:
- In `'encodes raw BGRA frames…'` pass `format: SF3` to both `videoEncodeArgs` calls (expectations unchanged), and add:

```ts
  it('reads raw frames at the game size and rate', () => {
    const args = videoEncodeArgs({ input: 'i', output: 'o', scale: 'sharp', format: GAMES.garou.format });
    expect(args.slice(args.indexOf('-s'), args.indexOf('-s') + 4)).toEqual(['-s', '320x224', '-r', '59.18']);
  });
```

- In `'muxes the video with the raw audio'` add `sampleRate: 44100` to the `muxArgs` argument (expectation unchanged).
- Replace the `describe('emulator info', …)` block with:

```ts
describe('emulator info', () => {
  const good = 'width=384\nheight=224\nbpp=4\nfps_x100=5959\nsample_rate=44100\n';
  it('parses and accepts the expected format', () => {
    const info = parseInfo(good);
    expect(info).toEqual({ width: 384, height: 224, bpp: 4, fpsX100: 5959, sampleRate: 44100 });
    expect(() => checkInfo(info, SF3)).not.toThrow();
    expect(() => checkInfo(parseInfo('width=320\nheight=224\nbpp=4\nfps_x100=5918\nsample_rate=44100\n'), GAMES.garou.format)).not.toThrow();
  });
  it('rejects another format with a Recording error describing both', () => {
    expect(thrown(() => checkInfo(parseInfo(good.replace('bpp=4', 'bpp=2')), SF3))).toMatchObject({
      exitCode: ExitCode.Recording,
      message: expect.stringContaining('bpp 2'),
    });
    expect(thrown(() => checkInfo(parseInfo(good), GAMES.garou.format))).toMatchObject({
      exitCode: ExitCode.Recording,
      message: expect.stringContaining('expected 320x224'),
    });
  });
  it('rejects an incomplete info file', () => {
    expect(thrown(() => parseInfo('width=384\n'))).toMatchObject({ exitCode: ExitCode.Recording });
  });
});
```

- In the real-ffmpeg test: `videoEncodeArgs({ input: raw.video, output: videoMp4, scale: 'sharp', format: SF3 })`, `mux({ video: videoMp4, audio: raw.audio, output, sampleRate: 44100 })`, and in the failing-mux test `mux({ video: …, audio: …, output, sampleRate: 44100 })`.

`tests/capture.test.ts`:
- Change `const base = { dir: DIR, scale: 'sharp' as const, maxDurationMs: 3_600_000 };` to `const base = { dir: DIR, scale: 'sharp' as const, maxDurationMs: 3_600_000, format: GAMES.sfiii3nr1.format };`.
- Add inside `describe('capture', …)`:

```ts
  it('feeds the encoder at the game format and accepts its info file', async () => {
    const info = 'width=320\nheight=224\nbpp=4\nfps_x100=5918\nsample_rate=44100\n';
    const { deps } = harness({ infoAt: 1_000, emulatorExitsAt: 10_000, info });
    let encoderArgs: string[] = [];
    const start = deps.startEncoder;
    deps.startEncoder = (args, onFrames, attach) => {
      encoderArgs = args;
      return start(args, onFrames, attach);
    };
    await expect(capture(deps, { ...base, format: GAMES.garou.format })).resolves.toMatchObject({ endReason: 'ended' });
    expect(encoderArgs).toContain('320x224');
    expect(encoderArgs).toContain('59.18');
  });

  it('asks for the full link when the emulator never starts (a bare ID is 3rd Strike)', async () => {
    const { deps } = harness({ emulatorExitsAt: 2_000 });
    await expect(capture(deps, base)).rejects.toMatchObject({
      exitCode: ExitCode.Emulator,
      hint: 'Check the link; a quark ID alone means a 3rd Strike replay. The replay may also no longer exist',
    });
  });
```

`tests/convert.test.ts`:
- Fake `capture`: also push the format: `` calls.push(`capture:${ref.game.id}:${ref.quarkId}:${opts.dir}:${opts.format.width}`); `` and update the two expectations from Task 1 to `` `capture:sfiii3nr1:${ID}:/tmp/run:384` `` and `` `capture:garou:${ID}:/tmp/run:320` ``.
- Fake `mux`: `mux: async ({ output, sampleRate }) => { calls.push(`mux:${output}:${sampleRate}`); },` and update every `` `mux:/out/${ID}.mp4` `` expectation to `` `mux:/out/${ID}.mp4:44100` ``.
- In `'runs the pipeline in order'`, the result expectation becomes `{ output: `/out/${ID}.mp4`, frames: 8220, seconds: (8220 * 100) / 5959, endReason: 'ended' }`.
- Add:

```ts
  it('reports progress and length in seconds at the game frame rate', async () => {
    const events: unknown[] = [];
    const { deps } = harness({
      capture: async (_install, _ref, _ffmpeg, opts) => {
        opts.onProgress?.(35508, 60_000); // 600 s of Garou at 59.18 fps
        return { video: 'v', audio: 'a', frames: 35508, endReason: 'ended' };
      },
    });
    const result = await convert(`https://replay.fightcade.com/fbneo/garou/${ID}`, { ...baseOptions, onProgress: (e) => events.push(e) }, deps);
    expect(events).toContainEqual({ phase: 'capturing', frames: 35508, seconds: 600, elapsedMs: 60_000 });
    expect(result.seconds).toBe(600);
  });
```

`tests/cliArgs.test.ts` lines 83-88: replace the `formatReplayLength` block with:

```ts
describe('formatReplayLength', () => {
  it('formats seconds of replay as m:ss', () => {
    expect(formatReplayLength(137.9)).toBe('2:18');
    expect(formatReplayLength(549.7)).toBe('9:10');
    expect(formatReplayLength(600)).toBe('10:00');
    expect(formatReplayLength(0)).toBe('0:00');
  });
});
```

(Keep the existing `it(...)` title if it differs; only the body matters.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ffmpeg.test.ts tests/capture.test.ts tests/convert.test.ts tests/cliArgs.test.ts`
Expected: FAIL — `-s 384x224` for Garou, `checkInfo` ignores its second argument, no `seconds` in events/result, old hint text.

- [ ] **Step 3: Implement**

`src/ffmpeg.ts`:
- Line 3: `import type { FrameFormat } from './constants.js';`
- Delete `const FPS = …` (line 15) and the `FrameInfo` interface (lines 44-50).
- `videoEncodeArgs`:

```ts
export function videoEncodeArgs({ input, output, scale, format }: { input: string; output: string; scale: ScaleMode; format: FrameFormat }): string[] {
  return [
    '-hide_banner', '-nostats', '-progress', 'pipe:1', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'bgr0', '-s', `${format.width}x${format.height}`, '-r', String(format.fpsX100 / 100), '-i', input,
```

  (rest unchanged).
- `muxArgs({ video, audio, output, sampleRate }: { video: string; audio: string; output: string; sampleRate: number })` with `'-ar', String(sampleRate)`.
- `parseInfo(text: string): FrameFormat`.
- `checkInfo`:

```ts
export function checkInfo(info: FrameFormat, expected: FrameFormat): void {
  const e = expected;
  if (info.width !== e.width || info.height !== e.height || info.bpp !== e.bpp || info.fpsX100 !== e.fpsX100 || info.sampleRate !== e.sampleRate) {
    const describe = (f: FrameFormat) => `${f.width}x${f.height} bpp ${f.bpp} @ ${f.fpsX100 / 100} fps, ${f.sampleRate} Hz`;
```

  (rest unchanged).
- `mux(args: { video: string; audio: string; output: string; sampleRate: number }, ffmpeg = 'ffmpeg')` calling `muxArgs({ video: args.video, audio: args.audio, output: part, sampleRate: args.sampleRate })`.

`src/capture.ts`:
- Line 6 import becomes `import { EMULATOR_EXE, TIMEOUTS, type FrameFormat } from './constants.js';`.
- `CaptureOptions` gets `format: FrameFormat;` after `scale`.
- Encoder: `videoEncodeArgs({ input: transport.encoderInput, output: video, scale: opts.scale, format: opts.format })`.
- Info check: `checkInfo(parseInfo(text), opts.format);`.
- The "exited before the replay started" error hint becomes `'Check the link; a quark ID alone means a 3rd Strike replay. The replay may also no longer exist'`.

`src/convert.ts`:
- `ProgressEvent` capturing member: `| { phase: 'capturing'; frames: number; seconds: number; elapsedMs: number }`.
- `ConvertResult` gets `seconds: number;` after `frames`.
- `ConvertDeps.mux(args: { video: string; audio: string; output: string; sampleRate: number }, ffmpeg: string): Promise<void>;` (default dep `mux: (args, ffmpeg) => mux(args, ffmpeg)` unchanged).
- In `convert`, before `deps.capture`: `const { format } = ref.game;` then the call becomes:

```ts
    const seconds = (frames: number) => (frames * 100) / format.fpsX100;
    const captured = await deps.capture(install, ref, ffmpeg, {
      dir,
      scale: options.scale,
      format,
      maxDurationMs: options.maxDurationMs,
      signal: options.signal,
      onProgress: (frames, elapsedMs) => options.onProgress?.({ phase: 'capturing', frames, seconds: seconds(frames), elapsedMs }),
    });
```

  and later `await deps.mux({ video: captured.video, audio: captured.audio, output, sampleRate: format.sampleRate }, ffmpeg);` and `return { output, frames: captured.frames, seconds: seconds(captured.frames), endReason: captured.endReason };`.

`src/cliArgs.ts`: line 2 `import { DEFAULT_MAX_DURATION_MS } from './constants.js';` and

```ts
export function formatReplayLength(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
```

`src/cli.ts` `progressLine` capturing case:

```ts
    case 'capturing': {
      const speed = e.elapsedMs > 0 ? (e.seconds * 1000) / e.elapsedMs : 0;
      return `Capturing… ${Math.round(e.seconds)}s of replay (${e.frames} frames, ×${speed.toFixed(1)})`;
    }
```

and `formatReplayLength(result.seconds)` on the "Captured" line.

`src/server/serve.ts`: no change needed in this task (it reads `e.frames` / `e.elapsedMs`, still present). Jobs keep `FRAME_FORMAT` until Task 4.

- [ ] **Step 4: Run all tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS (the real-ffmpeg tests run if ffmpeg is installed).

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg.ts src/capture.ts src/convert.ts src/cliArgs.ts src/cli.ts tests/ffmpeg.test.ts tests/capture.test.ts tests/convert.test.ts tests/cliArgs.test.ts
git commit -m "feat: encode, check and time each replay at its game's frame format

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Per-game ROM check

**Files:**
- Modify: `src/install.ts:1,14,31,99-107`
- Modify: `src/convert.ts` (`ConvertDeps.checkRoms`, default dep, call in `convert`)
- Modify: `src/constants.ts` (delete `export const GAME = 'sfiii3nr1';`)
- Test: `tests/install.test.ts:16,24,67-74`, `tests/convert.test.ts`

**Interfaces:**
- Consumes: `Game`, `GAMES` (Task 1); `ReplayRef` (Task 1).
- Produces: `checkRoms(install: FightcadeInstall, game: Game, exists: (p: string) => Promise<boolean>): Promise<void>`; `ConvertDeps.checkRoms(install: FightcadeInstall, game: Game): Promise<void>`. `FightcadeInstall.rom` is removed; `preflight` no longer checks ROMs.

- [ ] **Step 1: Write the failing tests**

`tests/install.test.ts`:
- Import `checkRoms` too, and `import { GAMES } from '../src/constants.js';`.
- Delete the two `expect(i.rom)…` lines (16 and 24).
- Replace the `describe('preflight', …)` block with:

```ts
describe('preflight', () => {
  it('needs wine.sh only on macOS, and no ROM (checked per conversion)', async () => {
    const mac = installLayout(MAC_ROOT, 'darwin');
    const win = installLayout(WIN_ROOT, 'win32');
    await expect(preflight(mac, { exists: async () => true, which: async () => '/usr/bin/x' })).resolves.toBeUndefined();
    await expect(preflight(win, { exists: async (p) => !p.endsWith('wine.sh'), which: async () => '/usr/bin/x' })).resolves.toBeUndefined();
    await expect(preflight(mac, { exists: async (p) => !p.endsWith('wine.sh'), which: async () => '/usr/bin/x' })).rejects.toMatchObject({ message: expect.stringMatching(/wine\.sh/) });
    await expect(preflight(win, { exists: async (p) => !p.endsWith('.zip'), which: async () => '/usr/bin/x' })).resolves.toBeUndefined();
  });
});

describe('checkRoms', () => {
  const win = installLayout(WIN_ROOT, 'win32');
  const roms = `${WIN_ROOT}\\emulator\\fbneo\\ROMs`;
  const only = (...files: string[]) => async (p: string) => files.some((f) => p === `${roms}\\${f}`);

  it('passes when every ROM of the game is there, whatever the other game', async () => {
    await expect(checkRoms(win, GAMES.garou, only('garou.zip', 'neogeo.zip'))).resolves.toBeUndefined();
    await expect(checkRoms(win, GAMES.sfiii3nr1, only('sfiii3nr1.zip', 'sfiii3.zip'))).resolves.toBeUndefined();
  });

  it('names the game and the missing file', async () => {
    await expect(checkRoms(win, GAMES.garou, only('garou.zip'))).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: `Garou: Mark of the Wolves ROM not found: ${roms}\\neogeo.zip`,
      hint: 'Open Garou once in Fightcade so it downloads the ROM',
    });
    await expect(checkRoms(win, GAMES.sfiii3nr1, only('sfiii3nr1.zip'))).rejects.toMatchObject({
      message: `Street Fighter III: 3rd Strike ROM not found: ${roms}\\sfiii3.zip`,
      hint: 'Open 3rd Strike once in Fightcade so it downloads the ROM',
    });
  });
});
```

`tests/convert.test.ts`:
- In the harness, add after `preflight`:

```ts
    checkRoms: async (_install, game) => {
      calls.push(`roms:${game.id}`);
    },
```

- In `'runs the pipeline in order'`, insert `'roms:sfiii3nr1'` right after `'preflight'`. In `'fails before capturing when the output folder is not writable'`, the expectation becomes `['lock', 'preflight', 'roms:sfiii3nr1', 'unlock']`. Any other test asserting a full `calls` list that includes `'preflight'` gets `'roms:sfiii3nr1'` right after it.
- Add:

```ts
  it('checks the ROMs of the replay game before capturing', async () => {
    const { deps, calls } = harness({
      checkRoms: async (_install, game) => {
        throw new ConvertError(ExitCode.Preflight, `${game.title} ROM not found`);
      },
    });
    await expect(convert(`https://replay.fightcade.com/fbneo/garou/${ID}`, baseOptions, deps)).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: 'Garou: Mark of the Wolves ROM not found',
    });
    expect(calls).toEqual(['lock', 'preflight', 'unlock']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/install.test.ts tests/convert.test.ts`
Expected: FAIL — `checkRoms` not exported, preflight still rejects a missing `.zip`, no `roms:` call.

- [ ] **Step 3: Implement**

`src/install.ts`:
- Line 1: `import type { Game } from './constants.js';`
- Remove `rom: string;` from `FightcadeInstall` and `rom: p.join(fbneo, 'ROMs', `${GAME}.zip`),` from `installLayout`.
- In `preflight`, delete the ROM `if` block (first three lines of the body).
- Add after `preflight`:

```ts
// Per conversion, for the replay's game: a server with only one game's ROMs still converts that game.
export async function checkRoms(install: FightcadeInstall, game: Game, exists: (p: string) => Promise<boolean>): Promise<void> {
  const p = pathFor(install.platform);
  for (const rom of game.roms) {
    const file = p.join(install.romsDir, rom);
    if (!(await exists(file))) {
      throw new ConvertError(ExitCode.Preflight, `${game.title} ROM not found: ${file}`, `Open ${game.shortTitle} once in Fightcade so it downloads the ROM`);
    }
  }
}
```

`src/convert.ts`:
- Import `checkRoms` from `./install.js` alongside `preflight`, and `type Game` from `./constants.js`.
- `ConvertDeps`: add `checkRoms(install: FightcadeInstall, game: Game): Promise<void>;` after `preflight`.
- `defaultDeps`: add `checkRoms: (install, game) => checkRoms(install, game, pathExists),` after `preflight`.
- `convert`: after `await deps.preflight(install);` add `await deps.checkRoms(install, ref.game);`.

`src/constants.ts`: delete `export const GAME = 'sfiii3nr1';` (and the blank line after it).

- [ ] **Step 4: Run all tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. (`grep -rn "\bGAME\b\|install.rom" src tests` prints nothing.)

- [ ] **Step 5: Commit**

```bash
git add src/install.ts src/convert.ts src/constants.ts tests/install.test.ts tests/convert.test.ts
git commit -m "feat: check the ROMs of the replay's game, per conversion

3rd Strike now also checks sfiii3.zip.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Web server — the game through the job queue, generic page

**Files:**
- Modify: `src/server/jobs.ts:1-2,11,27,38-80,90-95,103-110,116-136`
- Modify: `src/server/http.ts:95-110`
- Modify: `src/server/serve.ts:97-110` (`run`)
- Modify: `src/convert.ts` (`convert` accepts a `ReplayRef`)
- Modify: `src/server/page.ts:30-31`
- Modify: `src/constants.ts` (delete `FRAME_FORMAT` and its comment)
- Test: `tests/server/jobs.test.ts`, `tests/server/http.test.ts`, `tests/server/serve.test.ts:23,104`, `tests/server/pages.test.ts`, `tests/convert.test.ts`

**Interfaces:**
- Consumes: `ReplayRef`, `parseReplayRef` (Task 1); `ProgressEvent.seconds` (Task 2).
- Produces: `JobRunner = (ref: ReplayRef, output: string, onProgress: (seconds: number, elapsedMs: number) => void) => Promise<void>`; `Jobs.submit(ref: ReplayRef, options?)`; `view`, `forget`, `isBusy`, `filePath` still take the quark ID string; `convert(input: string | ReplayRef, options, deps?)`.

- [ ] **Step 1: Write the failing tests**

`tests/server/jobs.test.ts`:
- Add `import { GAMES } from '../../src/constants.js';` and after `const C = …`:

```ts
const ref = (quarkId: string) => ({ game: GAMES.sfiii3nr1, quarkId });
```

- Wrap every `A` / `B` / `C` passed to `jobs.submit` in `ref(...)`:

```bash
sed -i '' -E 's/jobs\.submit\(([ABC])\)/jobs.submit(ref(\1))/g; s/jobs\.submit\(([ABC]),/jobs.submit(ref(\1),/g' tests/server/jobs.test.ts
```

  (on Linux drop the `''` after `-i`). Afterwards `grep -n "submit(" tests/server/jobs.test.ts` must show only `jobs.submit(ref(A))` and `jobs.submit(ref(A), { … })` forms.
- The harness `run` becomes `run: (r, output, progress) => { const done = deferred(); runs.push({ id: r.quarkId, game: r.game.id, output, progress, done }); return done.promise; },` and the `runs` array type gets `game: string`.
- Fakes at lines 154 and 178 take `(r)` instead of `(id)` if they use the argument (use `r.quarkId`).
- `'reports progress as seconds of replay and speed'`: `runs[0]!.progress(100, 10_000); // 100 s of replay in 10 s` (expectation unchanged).
- Add:

```ts
  it('hands the runner the replay game', async () => {
    const { jobs, runs } = harness();
    await jobs.submit({ game: GAMES.garou, quarkId: A });
    expect(runs.map((r) => [r.id, r.game])).toEqual([[A, 'garou']]);
  });

  it('shows a ROM error from the runner as the failed view', async () => {
    const { jobs, runs } = harness();
    await jobs.submit({ game: GAMES.garou, quarkId: A });
    runs[0]!.done.reject(new ConvertError(ExitCode.Preflight, 'Garou: Mark of the Wolves ROM not found: /f/ROMs/garou.zip', 'Open Garou once in Fightcade so it downloads the ROM'));
    await flush();
    expect(jobs.view(A)).toEqual({ state: 'failed', error: 'Garou: Mark of the Wolves ROM not found: /f/ROMs/garou.zip', hint: 'Open Garou once in Fightcade so it downloads the ROM' });
  });
```

`tests/server/http.test.ts`:
- Add `import { GAMES } from '../../src/constants.js';`.
- `writesMp4` stays `async (_ref, output) => …`.
- Line 289: `await jobs.submit({ game: GAMES.sfiii3nr1, quarkId: ID }, { beforeQueue: () => accounts.claim(ID, 'Coccis') });`.
- Next to the `'hello'` 400 test (line ~262), add in the same `it` or a new one using the same setup as that test:

```ts
    const other = await admin.post('/api/jobs', { url: `https://replay.fightcade.com/fbneo/kof98/${ID}` });
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({ error: expect.stringContaining('supported games are sfiii3nr1 (3rd Strike), garou (Garou)') });
```

- Add a test, modelled on the existing job tests in this file (same `start` / `client` / setup calls), that posts a Garou link and checks the runner got Garou:

```ts
  it('passes the game of the link to the runner', async () => {
    const seen: string[] = [];
    const ctx = await start(async (r, output) => {
      seen.push(`${r.game.id}:${r.quarkId}`);
      await writeFile(output, 'MP4DATA');
    });
    const admin = client(ctx.base);
    await admin.post('/api/setup', { name: 'Coccis', password: 'password1' });
    expect((await admin.post('/api/jobs', { url: `https://replay.fightcade.com/fbneo/garou/${ID}` })).status).toBe(200);
    await ctx.jobs.idle();
    expect(seen).toEqual([`garou:${ID}`]);
  });
```

`tests/server/serve.test.ts`: the two fake runners (`run: async (id) => { runs.push(id); }` and `run: (id) => new Promise…runs.push(id)…`) take `(r)` and push `r.quarkId`.

`tests/server/pages.test.ts`: add to `'main page: …'`:

```ts
    expect(PAGE).toContain('<h1>fc2mp4</h1>');
    expect(PAGE).toContain('Fightcade replay → MP4');
    expect(PAGE).not.toMatch(/3rd Strike|Garou/);
```

`tests/convert.test.ts`: add

```ts
  it('accepts an already parsed replay', async () => {
    const { deps, calls } = harness();
    await convert({ game: GAMES.garou, quarkId: ID }, baseOptions, deps);
    expect(calls).toContain(`capture:garou:${ID}:/tmp/run:320`);
  });
```

(with `import { GAMES } from '../src/constants.js';`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/server tests/convert.test.ts`
Expected: FAIL — runner receives a string, page has the old heading, `convert` rejects an object.

- [ ] **Step 3: Implement**

`src/server/jobs.ts`:
- Imports: replace `import { FRAME_FORMAT } from '../constants.js';` with `import type { ReplayRef } from '../replayRef.js';`.
- `export type JobRunner = (ref: ReplayRef, output: string, onProgress: (seconds: number, elapsedMs: number) => void) => Promise<void>;`
- `private readonly queue: ReplayRef[] = [];`
- `submit(ref: ReplayRef, options: { beforeQueue?: () => Promise<boolean> } = {}): Promise<SubmitOutcome>` — first line of the body: `const id = ref.quarkId;` (the rest keeps using `id`), and `this.queue.push(ref);` instead of `this.queue.push(id);`.
- `view`: `position: this.queue.findIndex((r) => r.quarkId === id) + (this.current === null ? 0 : 1)`.
- `stop`: `for (const { quarkId: id } of this.queue.splice(0)) {`.
- `drain`:

```ts
      const ref = this.queue.shift()!;
      const id = ref.quarkId;
      this.current = id;
      this.views.set(id, { state: 'converting', seconds: 0, speed: 0 });
      this.deps.log?.(`Converting ${id}`);
      try {
        await this.deps.run(ref, this.filePath(id), (seconds, elapsedMs) => {
          const speed = elapsedMs > 0 ? Math.round((seconds * 10_000) / elapsedMs) / 10 : 0;
          this.views.set(id, { state: 'converting', seconds: Math.floor(seconds), speed });
        });
```

  (rest unchanged).

`src/server/http.ts` `createJob`:

```ts
  let ref: ReplayRef;
  try {
    ref = parseReplayRef(body.url);
  } catch (err) {
    if (err instanceof ConvertError) return json(res, 400, { error: err.message, hint: err.hint });
    throw err;
  }
  const id = ref.quarkId;
  const outcome = await app.jobs.submit(ref, { beforeQueue: () => app.accounts.claim(id, user.name) });
```

  (rest unchanged; import `type ReplayRef` with `parseReplayRef`).

`src/convert.ts`: `export async function convert(input: string | ReplayRef, options: ConvertOptions, deps: ConvertDeps = defaultDeps()): Promise<ConvertResult> {` and first line `const ref = typeof input === 'string' ? parseReplayRef(input) : input;`.

`src/server/serve.ts` `run`:

```ts
    run: async (ref, output, onProgress) => {
      await convert(ref, {
        output,
        scale: 'sharp',
        maxDurationMs: DEFAULT_MAX_DURATION_MS,
        fightcadeDir: options.fightcadeDir,
        signal: options.signal,
        log: options.log,
        onProgress: (e) => {
          if (e.phase === 'capturing') onProgress(e.seconds, e.elapsedMs);
        },
      });
    },
```

`src/server/page.ts` lines 30-31:

```html
  <h1>fc2mp4</h1>
  <p class="sub">Fightcade replay → MP4</p>
```

`src/constants.ts`: delete the `FRAME_FORMAT` line and its comment.

- [ ] **Step 4: Run all tests and typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS. `grep -rn "FRAME_FORMAT\|59\.59" src` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/server/jobs.ts src/server/http.ts src/server/serve.ts src/server/page.ts src/convert.ts src/constants.ts tests/server tests/convert.test.ts
git commit -m "feat(serve): Garou links on the web page; generic page header

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs, help text, and real-replay checks

**Files:**
- Modify: `README.md:3,10,12,15-17,94,151`
- Modify: `src/cliArgs.ts:6,13` (`USAGE`)
- Modify: `package.json:4`
- Test: `tests/cliArgs.test.ts` (help text), manual e2e

**Interfaces:**
- Consumes: everything above. Produces: nothing new.

- [ ] **Step 1: Write the failing test**

In `tests/cliArgs.test.ts` add (import `USAGE` from `../src/cliArgs.js`):

```ts
describe('USAGE', () => {
  it('names both games and says a bare quark ID is 3rd Strike', () => {
    expect(USAGE).toContain('Records a Fightcade replay (3rd Strike or Garou: Mark of the Wolves) to MP4');
    expect(USAGE).toContain('a quark ID alone means 3rd Strike');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/cliArgs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update texts**

`src/cliArgs.ts` `USAGE`: the intro line becomes

```
Records a Fightcade replay (3rd Strike or Garou: Mark of the Wolves) to MP4 (macOS, Windows and Linux).
Pass the replay link; a quark ID alone means 3rd Strike.
```

`package.json` `description`: `"Convert Fightcade replays (3rd Strike, Garou: Mark of the Wolves) to MP4"`.

`README.md`:
- Line 3: `Turns a Fightcade **Street Fighter III: 3rd Strike** or **Garou: Mark of the Wolves** replay into an MP4 (1440×1080, H.264/AAC),`
- Lines 10 and 12: `Needs Fightcade 2 with the game opened once.`
- Lines 15-17 (Linux): `…containing \`ggponet.dll\` and the game's ROMs: \`ROMs/sfiii3nr1.zip\` + \`ROMs/sfiii3.zip\` (3rd Strike), \`ROMs/garou.zip\` + \`ROMs/neogeo.zip\` (Garou). No screen or sound device is needed.`
- After the usage example (line 22), add: ``Garou works the same way: `fc2mp4 https://replay.fightcade.com/fbneo/garou/<id>`. A quark ID alone (`1700000000000-1234`) is read as 3rd Strike.``
- Line 94 (VPS): `` `ROMs/sfiii3nr1.zip` + `ROMs/sfiii3.zip` for 3rd Strike, `ROMs/garou.zip` + `ROMs/neogeo.zip` for Garou (only the games you want to offer). ``
- Line 151: `using Fightcade's network library and ROMs`.

- [ ] **Step 4: Run tests, typecheck, and the real replays**

Run: `npm test && npm run typecheck`
Expected: PASS.

Then the end-to-end checks (needs Fightcade with both games opened once; about 2 and a few minutes):

```bash
FC_E2E=https://replay.fightcade.com/fbneo/garou/1791766846976-7757 FC_E2E_EXPECTED_SECONDS=106.4 npx vitest run tests/e2e.test.ts
FC_E2E=<any 3rd Strike replay link> npx vitest run tests/e2e.test.ts
```

Expected: both PASS. Also run `npm run dev -- https://replay.fightcade.com/fbneo/garou/1791766846976-7757 -o /tmp/garou.mp4` and confirm it prints `Captured 1:46 of replay.`, then spot-check a frame (`ffmpeg -ss 60 -i /tmp/garou.mp4 -frames:v 1 /tmp/garou.png`) shows the match. If either e2e fails, stop and report the output rather than adjusting the format table.

- [ ] **Step 5: Commit**

```bash
git add README.md src/cliArgs.ts package.json tests/cliArgs.test.ts
git commit -m "docs: Garou: Mark of the Wolves support

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
