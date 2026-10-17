# Every horizontal FBNeo arcade game — Design

Date: 2026-10-17
Builds on: v0.15.1 (five hand-listed games, Windows window).

## 1. Goal and understanding

- **Outcome (user's words):** "I want fc2mp4 to be compatible with all fbneo games."
- **Scope (user's choice):** every **horizontal** FBNeo arcade game in Fightcade's list; vertical games
  are refused with a clear message ("let's drop the vertical games"). No emulator patch, no new
  emulator release.
- **Not needed:** a list of games with replays (Fightcade's API is not public); testing every ROM.
  The mechanism is the same for every game; a handful of representative replays is the test.
- **Unchanged:** the emulator build, output size (1440×1080) and scale modes, the web page,
  `fc2mp4-ui.exe`, accounts, a bare quark ID meaning 3rd Strike.

### Spike findings (2026-10-17, throwaway code)

- `fbneo_roms.json` (Fightcade, next to its `fbneo` folder) lists 6243 arcade games, each with a
  `download` URL and an optional `require` list (0–2 names). It matches the five hand-written
  ROM lists exactly (e.g. `garou` → `neogeo`, `ssf2xjr1` → `ssf2t`).
- The patched emulator's `info.txt` already reports what each game needs:
  - Mortal Kombat (`mk`): 400×254, 54.71 fps, 44100 Hz — correct picture, whole 3:55 replay,
    audio/video within 0.001 s.
  - DoDonPachi (`ddonpach`, vertical): reports 240×320 (upright size) but draws 320×240 sideways;
    as reported, the video is garbage. A vertical game is recognisable by height > width.
- The emulator opens its video pipe **before** writing `info.txt`; on macOS/Linux that pipe is a FIFO
  whose open blocks until a reader opens it.

### Success criteria

1. A Mortal Kombat replay converts end to end, in sync, with no game-specific code or table entry.
2. The five games already supported convert as before.
3. A DoDonPachi link fails before recording, with "vertical games are not supported yet"; nothing is
   left running, no video is written.
4. A link for a game not in Fightcade's list is refused with a clear message (when the list exists).
5. Missing ROMs (game, parent or BIOS) are named before the emulator starts.

## 2. Capture: format read from the emulator

### Transport

- **Today:** Windows — fc2mp4 serves a named pipe and relays the emulator's bytes to ffmpeg's stdin;
  macOS/Linux — ffmpeg reads the FIFO directly.
- **New:** macOS/Linux also relay: fc2mp4 opens the FIFO's read side itself (so the emulator's open
  returns at once) and pipes it into ffmpeg's stdin once ffmpeg runs. Until then the stream is not
  read; the emulator blocks on the full pipe and no frame is lost. ffmpeg's input is `pipe:0`
  everywhere.

### Order

1. Open the transport; start the emulator.
2. Wait for `info.txt` (existing 60 s "The replay stream never started" limit; existing "emulator
   exited before the replay started" check).
3. Validate the format: `bpp` 4, width, height, fps and sample rate > 0, else the existing
   "Unexpected frame format" Recording error. **height > width → vertical:** stop the emulator, fail
   with `<game> is a vertical game; vertical games are not supported yet` (exit code Usage, hint
   "Only horizontal games can be converted for now").
4. Start ffmpeg with the reported width × height and fps; attach the relay.
5. Then as today: progress, stall detection, `--max-duration`, cleanup.

### Output and timing

- Every accepted game is scaled to 1440×1080 as now (arcade screens are 4:3).
- Audio: read at the real rate derived from the reported fps and sample rate (`audioInputRate`),
  resampled to the reported sample rate.
- Progress and final length use the reported fps, known from step 3; frames before it are none.

## 3. Games and ROMs

- **Game identity:** `ReplayRef = { game: string; quarkId: string }` — the game name from the link
  (`/<name>/<id>`); a bare quark ID → `sfiii3nr1`. The `GAMES` table, titles and measured formats are
  removed.
- **Fightcade's list:** `fbneo_roms.json`, looked up in this order: the parent of the `fbneo` folder
  (where Fightcade keeps it), then inside the `fbneo` folder (for copied server folders). Missing or
  unreadable → no list.
- **Unknown game** (list present, name absent): Usage error
  `Unknown game "<name>": it is not in Fightcade's FBNeo game list`.
- **Required ROMs:** the game's zip plus its `require` entries, resolved recursively, each once
  (cycle-safe). No list → just `<name>.zip`.
- **Missing ROM:** Preflight error `ROM not found: <path>`, hint
  `Open the game once in Fightcade so it downloads its ROMs`.
- Checked per conversion, before the emulator starts (as today); `serve` startup and `prepare` check
  no ROMs.

## 4. Docs and texts

- README: "Supported games" becomes: any horizontal FBNeo arcade game on Fightcade; vertical games
  not supported yet; tested with real replays: 3rd Strike, Garou, Super SF2X, Alpha 3, Vampire
  Savior, Mortal Kombat. Server section: copy the ROMs of the games you offer (and optionally
  `fbneo_roms.json` into the `fbneo` folder).
- `--help` intro and `package.json` description: "Records a Fightcade FBNeo replay to MP4".
- No change to the web page or `fc2mp4-ui.exe`.

## 5. Error handling

| Case | Result |
| --- | --- |
| Game not in Fightcade's list | Usage error, nothing started |
| ROM (game/parent/BIOS) missing | Preflight error naming the file |
| Vertical game | Usage error after `info.txt`, emulator stopped, no video |
| Invalid format in `info.txt` | Existing Recording error |
| No `info.txt` within 60 s | Existing "replay stream never started" |

## 6. Testing

- Unit:
  - link parsing (any name, bare ID → `sfiii3nr1`, junk);
  - ROM list reading (requires, recursion, cycle, unknown game, missing/unreadable file, lookup
    order) and the ROM check with and without a list;
  - capture order with the fake emulator: encoder started only after `info.txt`, with the reported
    size/fps; vertical refusal (emulator killed, encoder never started); invalid format;
  - the FIFO relay with a real FIFO (macOS/Linux), like the existing named-pipe test.
- Real (manual, `tests/e2e.test.ts`): Mortal Kombat
  `https://replay.fightcade.com/fbneo/mk/1792204056623-9422` (≈234.7 s), the five existing games,
  and DoDonPachi `https://replay.fightcade.com/fbneo/ddonpach/1791133804325-1040` refused.

## 7. Out of scope

Vertical games (rotation; the spike found how: report FBNeo's vertical/flipped flags from the
emulator, rotate 90°), upside-down "flipped" horizontal games (rare; would need the same emulator
flags), console systems, per-game aspect ratios other than 4:3.
