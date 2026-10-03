# Fightcade Replay → MP4 Converter — Design

Date: 2026-10-03
Status: Draft, pending spike findings (see §9)

## 1. Goal

Turn a Fightcade replay (link or quark ID) into a shareable MP4 video.

- **Final objective:** a hosted service — a user drops a replay link, the server returns an MP4.
- **This spec (v1):** a cross-platform CLI (macOS first, Windows second) whose core is a library
  function `convert()` that the future server can call unchanged.
- **Scope:** Street Fighter III: 3rd Strike only (`sfiii3nr1`), via Fightcade's FBNeo build
  (`fcadefbneo.exe`). Flycast games and other titles are out of scope.

### Success criteria

1. `fc2mp4 <link-or-quarkId>` produces an MP4 without any manual interaction with the emulator.
2. Output is 1440×1080 (4:3, square pixels), H.264 + AAC, `+faststart`, plays on YouTube/Discord.
3. Video contains every emulated frame and continuous audio for the replay.
4. With fast-forward enabled, conversion is meaningfully faster than real time (target: measured
   in the spike, not assumed).
5. The user's Fightcade configuration is identical before and after a run, including after crashes
   or Ctrl-C.

## 2. Background and verified facts

Facts verified by inspecting the local install (`/Applications/FightCade2.app`, FBNeo
v0.2.97.44-55):

- Launch on macOS: from `Contents/MacOS/emulator/fbneo`, run
  `/Applications/FightCade2.app/Contents/Resources/wine.sh fcadefbneo.exe sfiii3nr1`.
  `wine.sh` sets `WINEPREFIX=.../Resources/.wine32`, `WINEARCH=win32`.
- Replays are inputs only, stored server-side, identified by a quark ID. The emulator accepts
  `quark:stream,<game>,<quarkId>,<port>` (format string `quark:stream,%[^,],%[^,],%d`) and fetches
  the replay from Fightcade's GGPO replay server itself. **We never request the Fightcade website**,
  so its anti-bot protection is irrelevant; the link is only parsed as a string.
- Built-in AVI writer: output to `.\avi\` named `%s_%X.avi`; `nAvi3x` in
  `config/fcadefbneo.ini` selects 1x–3x output size. The binary does not import `AVISaveOptions`
  (so likely no codec-picker dialog — to verify).
- Menu command IDs (from the exe's `RT_MENU` resources):
  - `11827` Record AVI, `11828` Stop recording
  - `10724` / `10725` / `10726` AVI Writer output size 1x / 2x / 3x
- Lua 5.1 is embedded but exposes no AVI API, and `quark:stream` does not load a script. Lua is
  not used.
- Fast-forward exists as an input macro: `macro "System FFWD" undefined` in
  `config/games/sfiii3nr1.ini`. Keyboard bindings use DirectInput scan codes
  (e.g. `switch 0x46` = Scroll Lock).
- Native resolution is 384×224, displayed at 4:3 on original hardware (non-square pixels).
- `bAutoPause 1` is set by default: FBNeo pauses when its window loses focus, so it must be patched
  to `0` for unattended capture. The window title starts with `Fightcade FBNeo v`.
- The AVI file name pattern `%s_%X.avi` suggests FBNeo splits recordings into several segments
  (uncompressed 384×224@60 is roughly 15 MB/s). The pipeline handles a list of segments (joined
  with ffmpeg's concat demuxer), and preflight checks free disk space.
- Wine ships `taskkill`, used to stop the emulator (`wine.sh taskkill /IM fcadefbneo.exe /F`).

Unknown, to be resolved by the spike (§9): the `quark:stream` port, whether the stream starts
without the Fightcade client running, end-of-replay behaviour, FFWD behaviour in stream mode and
its effect on AVI frames/audio, the AVI codec, and when `record` can safely be sent.

## 3. Usage

```
fc2mp4 <link-or-quarkId> [-o out.mp4] [--scale sharp|smooth] [--no-ffwd]
       [--max-duration 60m] [--fightcade-dir <path>] [--keep-avi] [--verbose]
```

- Accepts a full replay URL containing `sfiii3nr1/<quarkId>` or a bare quark ID
  (`<digits>-<digits>`).
- Default output: `<videos>/Fightcade/<quarkId>.mp4`, where `<videos>` is `~/Movies` on macOS and
  `%USERPROFILE%\Videos` on Windows. The folder is created if missing. `-o` accepts a file path, or
  an existing directory (the `<quarkId>.mp4` name is kept). The final path is printed at the end.
  Never write inside the Fightcade install: on macOS it lives inside the signed app bundle and is
  replaced by updates.
- `--scale sharp` (default): nearest-neighbour integer upscale, then smooth scale to 1440×1080.
  `--scale smooth`: lanczos straight to 1440×1080.

## 4. Architecture

TypeScript on Node. The CLI is a thin shell over `convert(ref, options, onProgress)`.

| Unit | Responsibility | Depends on |
|---|---|---|
| `parseReplayRef` | link/ID → `{ game, quarkId }`; rejects non-`sfiii3nr1` | nothing (pure) |
| `FightcadeInstall` | locate install (default macOS/Windows paths or `--fightcade-dir`), expose paths to exe, ini files, `avi/`, ROM; preflight checks | filesystem |
| `ConfigPatcher` | back up and patch `fcadefbneo.ini` / `games/sfiii3nr1.ini` (`bAutoPause 0`, `bAlwaysProcessKeyboardInput 1`, `nAvi3x 1`, FFWD binding); restore; recover from a stale `.bak` | filesystem |
| `EmulatorRunner` | spawn the emulator with `quark:stream`, via `wine.sh` on macOS or natively on Windows; wait for the window; kill the process tree | `FightcadeInstall`, `FbneoCtl` |
| `FbneoCtl` | TypeScript wrapper that runs the `fbneo-ctl.exe` helper | helper exe |
| `RecordingWatcher` | find the new AVI, track growth, decide when the replay has ended | filesystem, clock |
| `Transcoder` | build and run the ffmpeg command, AVI segment(s) → MP4 (encoded to `.part.mp4`, then renamed); optional trimming of dead time | ffmpeg |
| `convert()` | orchestrate, lock, clean up, report progress | all of the above |

### 4.1 `fbneo-ctl.exe` helper

A small Win32 C program (built with mingw-w64 `i686`, committed prebuilt along with its source
and a build script). It runs under the same `wine.sh` on macOS (same prefix and wineserver, so it
can see the emulator window) and natively on Windows.

```
fbneo-ctl.exe wait [timeoutMs]  → exit 0 when the FBNeo main window exists
fbneo-ctl.exe record            → PostMessage(hwnd, WM_COMMAND, 11827, 0)
fbneo-ctl.exe stop              → PostMessage(hwnd, WM_COMMAND, 11828, 0)
fbneo-ctl.exe ffwd on|off       → SendInput key down/up with the bound scan code
fbneo-ctl.exe status            → print the window title (for end detection)
```

The window is located by enumerating top-level windows owned by the emulator process / matching
its class or title (exact criterion fixed in the spike).

## 5. Data flow

1. Parse input → `{ sfiii3nr1, quarkId }`.
2. Preflight (install, ROM, ffmpeg, no running emulator) and acquire the lock.
3. `ConfigPatcher.apply()` (writes a `.bak` first).
4. Spawn the emulator: `fcadefbneo.exe sfiii3nr1 quark:stream,sfiii3nr1,<quarkId>,<port>`.
5. `fbneo-ctl wait` → `fbneo-ctl record` (at the point the spike shows is safe) →
   `fbneo-ctl ffwd on` (unless `--no-ffwd`).
6. `RecordingWatcher` monitors until the end is detected (§6).
7. `ffwd off` → `stop` → wait for the AVI size to settle → kill the emulator process tree.
8. `ConfigPatcher.restore()`, release the lock.
9. `Transcoder`: AVI → MP4 (1440×1080, `libx264 -crf 18 -preset slow -pix_fmt yuv420p`,
   AAC 192k, `-movflags +faststart`, `setsar=1`).
10. Delete the temp AVI from `fbneo/avi/` (FBNeo's fixed output dir) unless `--keep-avi`, in which
    case move it next to the MP4.

Steps 7–8 also run from `finally` and from SIGINT/SIGTERM handlers.

## 6. End-of-replay detection

Layered, first signal wins:

1. **Emulator signal (primary):** process exit, window title change, or another observable marker,
   chosen in the spike.
2. **AVI stall (fallback):** AVI size unchanged for 5 s of real (wall-clock) time.
3. **Safety cap:** `--max-duration` (default 60 min of capture). On hitting the cap, stop cleanly,
   encode what was captured, and print a warning.

Optional (kept only if the spike shows dead time in the output): trim leading black/connection
frames and trailing frozen frames with ffmpeg `blackdetect` / `freezedetect`.

## 7. Error handling

- Preflight also checks the ROM, the game config, `wine.sh`, ffmpeg and free disk space.
- Preflight errors include a fix hint (e.g. "ffmpeg not found → `brew install ffmpeg`").
- A lock file prevents concurrent runs. The run refuses to start if an `fcadefbneo.exe` process
  is already running.
- Timeouts: window 30 s; AVI file appearing after `record` 15 s; first AVI growth (stream started)
  60 s.
- Each failure class maps to a distinct, documented exit code.
- A stale `.bak` from a crashed run is restored automatically at the next start, before anything
  else.
- Progress phases: `connecting → recording (×N speed, frames) → encoding (%)`. `--verbose` prints
  the commands that are run.

## 8. Testing

- **Unit (vitest):** `parseReplayRef`; output path resolution (default per OS, `-o` file vs directory); `ConfigPatcher` patch/restore/stale-backup recovery
  (temp dirs); ffmpeg argument builder; `RecordingWatcher` end detection using a fake clock and
  simulated file sizes.
- **Integration (opt-in, `FC_E2E=1`):** real short quark → MP4; assert with `ffprobe` 1440×1080,
  h264 + aac, an audio stream present, duration within tolerance of the expected value.

## 9. Feasibility spike (first implementation task)

Throwaway scripts that answer these questions. Findings go into `docs/spike-findings.md`, and this
spec is updated before the remaining tasks start.

1. `quark:stream` port, and whether the stream works without the Fightcade client running.
2. Does `PostMessage(WM_COMMAND, 11827/11828)` start and stop the AVI under Wine? Any dialog?
3. Which codec FBNeo selects, and how to get lossless/uncompressed output (and the effect of
   `nAvi3x`).
4. When `record` can be sent safely (immediately vs after the stream starts).
5. FFWD: does `SendInput` on the bound key work (with `bAlwaysProcessKeyboardInput 1`, without
   focus)? Is it honoured in stream mode? Does the AVI keep every frame (frame count ≈ duration
   × 59.6) and continuous audio? Measured speedup.
6. What happens at the end of a stream (exit / title / freeze / message)?
7. Whether and where the AVI splits into segments; bytes per second (sets the free-space threshold);
   whether `wine.sh taskkill` stops the emulator cleanly.

If FFWD fails any check, v1 ships with real-time capture (FFWD stays behind a flag for later).

## 10. Out of scope (v1)

- Hosted web service, queueing, uploads (future: wraps `convert()` in a worker).
- Headless/libretro rendering by decoding the GGPO replay protocol (future server-grade path).
- Games other than `sfiii3nr1`; Flycast.
- Overlays, player names, cutting to specific rounds, custom resolutions.
- Linux: same Wine-based mechanism as macOS, best-effort after macOS and Windows work (not tested in v1).
