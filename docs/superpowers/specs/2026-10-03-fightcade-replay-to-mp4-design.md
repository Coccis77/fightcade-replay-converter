# Fightcade Replay → MP4 Converter — Design (rev 2)

Date: 2026-10-03
Status: Revised after the feasibility spikes (see `docs/spike-findings.md`). Rev 1 relied on
FBNeo's built-in AVI writer, which records only one frame under Wine; rev 2 builds a patched
Fightcade FBNeo that streams raw frames to ffmpeg.

## 1. Goal

Turn a Fightcade replay (link or quark ID) into a shareable MP4 video.

- **Purpose:** a free, non-commercial community tool, so people can get their replays as videos and
  re-watch specific rounds (Fightcade's replay viewer can't).
- **Final objective:** a hosted service: drop a replay link, get an MP4.
- **This spec (v1):** a CLI (macOS first, Windows second) whose core is a library function
  `convert()` that the future server can call unchanged.
- **Scope:** Street Fighter III: 3rd Strike only (`sfiii3nr1`).

### Success criteria

1. `fc2mp4 <link-or-quarkId>` produces an MP4 with no manual interaction.
2. Output is 1440×1080 (4:3, square pixels), H.264 + AAC, `+faststart`.
3. The video contains every emulated frame and continuous audio (video and audio lengths agree to
   within one frame).
4. Capture runs faster than real time (the spike measured ≈6×; the overall conversion is then bounded
   by encoding speed).
5. Nothing inside the Fightcade install is modified.
6. A Fightcade update never silently breaks conversions: the emulator is rebuilt from the latest
   source, and if that fails the last working build is kept.

## 2. Verified facts (from the spikes)

- Replays are input streams served by Fightcade. Fightcade's emulator plays one with
  `fcadefbneo.exe quark:stream,sfiii3nr1,<quarkId>.7,7100`: port 7100, and the client appends `.7`
  to the quark ID from the link (without it the game never loads; meaning unknown, treated as a
  constant). We never request the Fightcade website.
- On macOS the emulator runs through Fightcade's Wine (`Contents/Resources/wine.sh`), and the exe
  must be given as an absolute path.
- Fightcade's FBNeo source is public (`github.com/fightcadeorg/fightcade-fbneo`, no tags or releases).
  Its network library `ggponet.dll` is closed (header + import lib only), so we use the copy from the
  Fightcade install.
- The source cross-compiles on macOS with mingw-w64 (i686) from the VS2015 project's file list
  (1094 files, ~1 min on 10 cores), with: host-built generators + perl scripts, three MSVC-isms
  handled by flags/one-line patches, a stub for the MSVC-asm `hq_shared32.cpp`, a per-file rename for
  `luaengine.cpp`, and FBNeo's bundled XAudio2 2.7 header.
- Our build runs under Fightcade's Wine with `nVidSelect 0` (DirectDraw) and `bVidFullStretch 1`; the
  DX9 Alt renderer crashes it.
- Dump hook: after each frame in `RunFrame` (`run.cpp`), with `bDraw` forced on. Format: BGRA (`bgr0`)
  384×224 @ 59.59 fps (`nBurnFPS` = 5959), s16le stereo 44.1 kHz. Forcing the fast-forward loop
  (`bAppDoFast` branch) while dumping gave ≈6.3× real time, with every frame.
- End of a replay: the stream does not disconnect; the emulator waits for input and stops producing
  frames. A real disconnect calls `QuarkFinishReplay()`.
- A Win32 program under Fightcade's Wine can write to a macOS FIFO (206 MB in 2.4 s), so frames can be
  streamed into ffmpeg without temp files (raw is ≈20 MB per second of replay).
- `wine.sh taskkill /IM <exe> /F` stops a Wine process cleanly.

## 3. Usage

```
fc2mp4 <link-or-quarkId> [-o out.mp4] [--scale sharp|smooth] [--max-duration 60m]
       [--fightcade-dir <path>] [--verbose]
fc2mp4 rebuild-emulator [--fightcade-dir <path>] [--verbose]
```

- Input: a link containing `sfiii3nr1/<quarkId>` (any scheme, query or trailing slash) or a bare quark
  ID (`<digits>-<digits>`); other games are rejected.
- Default output: `<videos>/Fightcade/<quarkId>.mp4` (`~/Movies` on macOS, `%USERPROFILE%\Videos` on
  Windows); `-o` accepts a file or an existing directory. The final path is printed.
- `--scale sharp` (default): nearest-neighbour ×4 then lanczos to 1440×1080; `smooth`: lanczos only.

## 4. Architecture

Two parts: the **emulator build** (patch + compile Fightcade FBNeo) and the **converter** (TypeScript,
Node ≥ 22.12). Both are driven by the same CLI.

### 4.1 Emulator build ("patcher")

| Unit | Responsibility |
|---|---|
| `emulator/patches.json` | Anchored source patches: each names a file, an exact anchor snippet and its replacement. Applying is idempotent (skipped when the replacement is already present); a missing anchor is a hard error naming the file and patch. |
| `emulator/src/fc2mp4_dump.cpp` | Added source: dump + end detection (below). |
| `emulator/stubs/hq_shared32.cpp` | Replaces the MSVC-asm scaler helpers. |
| `emulator/build.py` | Fetch source (git, latest `master` or `--ref`), apply patches, run generators, cross-compile, link; writes `fcadefbneo-fc2mp4.exe` + `build-info.json` (source commit, patch set version). |
| `src/emulatorBuild.ts` | TypeScript side: decides when to (re)build, runs `build.py`, keeps the last good build. |

Patch behaviour inside the emulator, active only when the `FC2MP4_VIDEO` / `FC2MP4_AUDIO` environment
variables give output paths (Windows paths, e.g. `Z:\...\video.fifo`):

- each frame: write the visible image rows (`nVidImageWidth × nVidImageBPP` bytes per row) and that
  frame's audio (`nBurnSoundLen × 4` bytes); force `bDraw = 1`; take the fast-forward loop;
- on the first frame write `FC2MP4_INFO` (key=value: width, height, bpp, fps_x100, sample_rate);
- **end detection inside the emulator:** once frames have started, if no new frame is emulated for
  `FC2MP4_IDLE_MS` (default 5000) of wall-clock time, or `QuarkFinishReplay()` runs, close both outputs
  (ffmpeg then sees EOF) and exit the process.

Runtime folder (`~/Library/Caches/fc2mp4/runtime` on macOS, `%LOCALAPPDATA%\fc2mp4\runtime` on
Windows): our exe, DLLs copied from Fightcade's `emulator/fbneo` folder, a link to its `ROMs` folder,
and our own `config/fcadefbneo.ini` (`nVidSelect 0`, `bVidFullStretch 1`, `bAutoPause 0`).

**When to rebuild:** `runtime/manifest.json` records the hashes of the installed `fcadefbneo.exe` and
`ggponet.dll`, the source commit and the patch set version. Before each conversion: if the runtime is
missing or any of these differ, rebuild (`fc2mp4 rebuild-emulator` forces it). If fetching, patching
or building fails and a previous build exists, keep using it with a warning; with no previous build,
fail with the patch/build error. Toolchain prerequisites (`git`, `perl`, `i686-w64-mingw32-g++`) are
checked first, with an install hint (`brew install mingw-w64`).

**Designed for CI later (option B):** `build.py` is self-contained (inputs: source ref + patches;
outputs: exe + `build-info.json`), so a scheduled GitHub Action can run it and publish the artifact;
the converter would then download a build matching the manifest instead of compiling.

### 4.2 Converter

| Unit | Responsibility |
|---|---|
| `parseReplayRef` | link/ID → `{ game, quarkId }`, rejects non-`sfiii3nr1` |
| `resolveOutputPath` | default/`-o` output path per OS |
| `FightcadeInstall` | locate the install (default paths or `--fightcade-dir`), expose wine.sh, DLL folder, ROMs, exe/dll paths; preflight (ROM, wine.sh, ffmpeg, toolchain when a build is needed) |
| `emulatorBuild` | manifest check, rebuild, last-good fallback (4.1) |
| `runtime` | create/refresh the runtime folder (DLL copies, ROMs link, our ini) |
| `capture` | create two FIFOs in a temp dir, start ffmpeg reading them, start the emulator with the env vars, wait for both to exit, enforce `--max-duration`, kill both on error/Ctrl-C |
| `ffmpegArgs` | raw inputs (`-f rawvideo -pix_fmt bgr0 -s WxH -r fps` / `-f s16le -ar rate -ac 2`) → 1440×1080 H.264 (`-preset medium -crf 18 -pix_fmt yuv420p`) + AAC 192k, `+faststart`, written to `<out>.part.mp4` then renamed |
| `lock` | one conversion at a time (one runtime folder) |
| `convert()` | orchestration + progress (`building emulator → connecting → capturing (N frames, ×speed) → finalizing`) |

ffmpeg needs the frame size before it starts. It is fixed for `sfiii3nr1` (384×224, bpp 4, 59.59 fps,
44.1 kHz) and kept as constants; the emulator's `FC2MP4_INFO` file is checked against them on the first
frame, and a mismatch aborts with a clear error rather than producing a garbled video.

## 5. Data flow

1. Parse input → quark ID. Resolve output path. Acquire lock.
2. Locate Fightcade; preflight.
3. `emulatorBuild.ensure()` → exe path (rebuilds if needed).
4. `runtime.prepare()`.
5. `mkfifo video.fifo audio.fifo` in a temp dir; spawn ffmpeg reading both (it blocks until the
   emulator opens them).
6. Spawn the emulator (`wine.sh <abs exe> quark:stream,sfiii3nr1,<quarkId>.7,7100`) with
   `FC2MP4_VIDEO`/`FC2MP4_AUDIO`/`FC2MP4_INFO` set.
7. Watch: emulator exit (normal end), ffmpeg exit, progress from ffmpeg `-progress` (frames), a
   "never started" timeout (60 s without a first frame), `--max-duration`, and Ctrl-C.
8. On emulator exit: wait for ffmpeg to finish; rename `.part.mp4` → output.
9. Always: kill leftovers (`wine.sh taskkill /IM fcadefbneo-fc2mp4.exe /F`, ffmpeg), remove the temp dir,
   release the lock.

## 6. Error handling

- Distinct exit codes: Usage 2, Preflight 3, Busy 4, Emulator 5 (build or run), Recording 6 (stream
  never started, frame-format mismatch), Encode 7, Interrupted 130, unexpected 1.
- Patch failures name the file and patch; build failures keep the compiler output in
  `runtime/build.log` and print its path.
- A conversion that hits `--max-duration` finishes the video it has and warns.
- An existing output file is replaced only after the new encode succeeds (`.part.mp4` + rename).

## 7. Testing

- **Unit (vitest):** `parseReplayRef`; output paths; patch application (anchor found / missing /
  already applied, on fixture files); manifest decision (fresh, unchanged, Fightcade updated, patch set
  changed, build failed with/without a last good build); runtime ini generation; ffmpeg arguments;
  `capture` orchestration with fake processes (normal end, never started, max-duration, Ctrl-C cleanup).
- **Emulator build test (opt-in, `FC_BUILD=1`):** run `build.py` against the latest source; assert the
  exe exists and imports `ggponet.dll`.
- **End-to-end (opt-in, `FC_E2E=<link>`):** convert a real replay; `ffprobe` checks 1440×1080, h264 +
  aac, audio/video durations within one frame of each other, and optionally the expected duration.

## 8. Out of scope (v1)

- The CI-published emulator builds (option B), the hosted service, uploads.
- Replacing `ggponet.dll` (so Fightcade stays a requirement: Wine, `ggponet.dll`, ROM).
- Games other than `sfiii3nr1`; Flycast; Linux (same Wine approach, later).
- Round detection / cutting (a valued follow-up: the frame-exact dump makes it possible later).
- Windows: install/runtime paths and the no-Wine launch are designed in, but the frame transport uses
  POSIX FIFOs; Windows needs named pipes (`\\.\pipe\...`) in both the patch and `capture`. v1 is
  supported and tested on macOS only; Windows is the first follow-up.
