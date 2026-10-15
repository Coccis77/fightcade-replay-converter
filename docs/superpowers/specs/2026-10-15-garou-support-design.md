# Garou: Mark of the Wolves support — Design

Date: 2026-10-15
Builds on: v0.10.1 (web page with accounts, VPS docs).

## 1. Goal and understanding

- **Outcome:** fc2mp4 converts Fightcade replays of **Garou: Mark of the Wolves** (`garou`) as well
  as 3rd Strike (`sfiii3nr1`), from the CLI, Docker and the web page.
- **Scope (user's choice, option A):** Garou only, for now. No generic "any FBNeo game" support,
  no auto-detection of the frame format. Adding a game later = one table entry + one test run.
- **Unchanged:** existing 3rd Strike links and bare quark IDs, the emulator build, the 1440×1080
  H.264/AAC output and both scale modes, timeouts, the INI settings, accounts and saved data.

### Spike findings (2026-10-15, throwaway code, not kept)

The current patched emulator, run with `quark:stream,garou,1791766846976-7757.7,7100`, played the
Garou replay https://replay.fightcade.com/fbneo/garou/1791766846976-7757 to the end with no change
to the emulator:

- `info.txt`: **320×224, bpp 4, fps_x100 5918, 44100 Hz**.
- 1:46 match captured whole (ends on the final K.O.), no desync, audio present (mean −16.8 dB)
  and aligned (video 106.45 s, audio 106.43 s). About ×2.5 real time including the idle wait.
- ROMs needed: `garou.zip` + `neogeo.zip` (both in Fightcade's `ROMs` folder once Garou was opened).
- The first seconds show the Neo Geo boot screen breaking up: the game's start, left as is.

### Success criteria

1. `fc2mp4 https://replay.fightcade.com/fbneo/garou/<id>` produces a correct 1440×1080 MP4 of the
   whole match, in sync, as fast as 3rd Strike.
2. 3rd Strike links and bare quark IDs behave exactly as before.
3. Pasting a Garou link on the web page converts it like any other replay.
4. Missing ROMs for the requested game give a clear message naming the game and the missing file;
   one game's missing ROMs never block the other game.
5. Any other game in a link is refused with the list of supported games.

## 2. The game table (approach 1)

`src/constants.ts` replaces `GAME` and `FRAME_FORMAT` with:

```ts
export interface FrameFormat { width: number; height: number; bpp: number; fpsX100: number; sampleRate: number }
export interface Game {
  id: string;               // ROM name in the link and in quark:stream
  title: string;            // for messages: 'Street Fighter III: 3rd Strike', 'Garou: Mark of the Wolves'
  shortTitle: string;       // for hints: '3rd Strike', 'Garou'
  roms: readonly string[];  // files that must exist in ROMs/
  format: FrameFormat;      // what the patched emulator reports in info.txt
}
export const GAMES: Readonly<Record<string, Game>> = {
  sfiii3nr1: { …, roms: ['sfiii3nr1.zip', 'sfiii3.zip'], format: { width: 384, height: 224, bpp: 4, fpsX100: 5959, sampleRate: 44100 } },
  garou:     { …, roms: ['garou.zip', 'neogeo.zip'],     format: { width: 320, height: 224, bpp: 4, fpsX100: 5918, sampleRate: 44100 } },
};
export const DEFAULT_GAME = GAMES.sfiii3nr1;  // a bare quark ID
```

3rd Strike now also checks `sfiii3.zip`, which the README already lists as required: a missing
parent ROM becomes a clear preflight error instead of an emulator failure.

## 3. Where the game flows

- **`replayRef.ts`:** `ReplayRef = { game: Game; quarkId: string }`. A bare ID → `DEFAULT_GAME`.
  A link's game is looked up in `GAMES`; unknown → usage error
  `Unsupported game "kof98": supported games are sfiii3nr1 (3rd Strike), garou (Garou)`.
  `streamArg(ref)` uses `ref.game.id`.
- **`install.ts`:** `FightcadeInstall.rom` is removed (`romsDir` stays). New
  `checkRoms(install, game, deps)`: for each missing file,
  `Garou: Mark of the Wolves ROM not found: <path>` with hint
  `Open Garou once in Fightcade so it downloads the ROM`. The general preflight (Fightcade found,
  `ggponet.dll`, …) stays game-independent; `checkRoms` runs per conversion, before capture.
  `prepare` and `serve` startup check no ROMs.
- **`capture.ts` / `ffmpeg.ts`:** `videoEncodeArgs`, the audio mux args and `checkInfo` take a
  `FrameFormat` argument instead of importing the global. `capture` receives the `ReplayRef`
  (for `streamArg` and `format`). Capture order is unchanged: ffmpeg still starts before
  `info.txt`, and `checkInfo` remains the safety net against a wrong table entry.
- **Durations:** `cliArgs.ts` progress line and `server/jobs.ts` progress use the converted
  game's `format.fpsX100`.
- **`convert.ts`:** parses the input once into a `ReplayRef` and passes it down.

## 4. CLI, web page, saved data

- **CLI:** no new flag. `--help` intro: "Records a Fightcade replay (3rd Strike or Garou: Mark of
  the Wolves) to MP4"; the argument is "a replay link, or a quark ID for a 3rd Strike replay".
- **README / `package.json` description:** name both games; list the ROMs per game, including in
  the Linux `--fightcade-dir` and Docker instructions; "with the game opened once in Fightcade".
- **Web page (user's choice: generic):** no game names anywhere. The `<h1>` becomes `fc2mp4`
  and the "Street Fighter III: 3rd Strike" subtitle becomes "Fightcade replay → MP4". No game
  label in the conversion list. The input placeholder is already generic.
- **Jobs:** `submit(ref, …)` instead of a bare ID; jobs stay keyed by quark ID (unique across
  games: timestamp + number) and keep `id → Game` for queued/running jobs only.
  `JobRunner(ref, output, onProgress)`. Videos are still `<quarkId>.mp4`.
- **Saved data:** `fc2mp4-data.json` and `ConversionRecord` are unchanged. A replay asked for
  again is parsed from its link again. The daily limit counts every game the same.
- **Missing ROMs on a server:** the conversion fails with the CLI's message and the replay is
  refunded, as any failed conversion today.

## 5. Error handling

| Case | Result |
| --- | --- |
| Link for an unsupported game | Usage error listing supported games (CLI exit `Usage`; page shows it, nothing counted) |
| ROM file missing for the requested game | Preflight error naming game + file, hint to open the game in Fightcade |
| Emulator reports a format other than the table's | Existing `checkInfo` error (expected vs got) |

## 6. Testing

- Unit: `parseReplayRef` (Garou link, 3rd Strike link, bare ID → 3rd Strike, unknown game),
  `streamArg` for both games, `checkRoms` (all present, one missing per game, other game's ROMs
  absent doesn't matter), `checkInfo` and ffmpeg args with Garou's format, CLI duration text at
  59.18 fps, jobs passing the right `ReplayRef` to the runner and using its fps for progress,
  page HTML without game names.
- Existing tests updated for the new signatures; their 3rd Strike expectations unchanged.
- End-to-end (manual, existing harness):
  `FC_E2E=https://replay.fightcade.com/fbneo/garou/1791766846976-7757 FC_E2E_EXPECTED_SECONDS=106.4 npx vitest run tests/e2e.test.ts`,
  plus one 3rd Strike replay to confirm nothing regressed.

## 7. Out of scope

Other games, a `--game` flag, format auto-detection, trimming the Neo Geo boot screen, per-game
labels or filters on the page.
