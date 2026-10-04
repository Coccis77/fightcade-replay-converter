# Silent, windowless recording — Design

Date: 2026-10-04
Builds on: `2026-10-04-docker-image-design.md` (v0.5.1) and `2026-10-04-linux-headless-design.md`.
Evidence: throwaway spike on local branch `spike/silent` (not merged), summarised in §6.

## 1. Goal and understanding

- **Outcome:** while fc2mp4 records, the emulator shows no window and plays no sound, on Windows,
  macOS and Linux. On Linux this also removes the virtual display (Xvfb) and the silent sound server
  (PulseAudio) that v0.4–v0.5.1 needed.
- **User's words:** "It's way better to not run any sound. If we can even not have an image at all of
  the emulator while it's recording, it would be even better."
- **Unchanged:** the MP4 itself (1440×1080 H.264/AAC, every frame, audio within 0.05 s), speed,
  exit/stop behaviour, and the emulator's normal behaviour when it is not recording (Fightcade's own
  emulator is never touched; ours behaves like stock FBNeo without the `FC2MP4_*` variables).

### Success criteria

1. During a conversion on Windows and macOS no emulator window (main window, popup, loading box)
   appears and no sound is played.
2. On Linux a conversion needs only `wine`, `wine32:i386` and `ffmpeg`: no Xvfb, no PulseAudio, no
   display, no sound device.
3. Output quality is identical: a frame at 60 s of the short replay matches the current output, all
   8220 frames, audio within 0.05 s.
4. A Linux Wine environment created by v0.4–v0.5.1 is recreated once, automatically.
5. The Docker image no longer installs `xvfb`, `xauth` or `pulseaudio`.

## 2. Emulator

New file `emulator/src/fc2mp4_headless.cpp`, compiled with `fc2mp4_dump.cpp`:

- **`AudOutFc2mp4` (silent audio plugin):** SoundInit computes `nAudSegLen`/`nAudAllocSegLen` from
  `nAudSampleRate[0]` and `nAppVirtualFps` (as DirectSound does) and allocates `nAudNextSound`; Play/
  Stop set `bAudPlaying`; Check/Frame/SetVolume do nothing; Exit frees the buffer. No device is opened.
- **`VidOutFc2mp4` (memory video plugin):**
  - Init without a loaded game (FBNeo starts video for its splash screen): succeeds with no frame
    buffer, so the splash image is skipped (drawing it crashed in the spike).
  - Init with a game: visible size from `BurnDrvGetVisibleSize`, depth 32 / 4 bytes per pixel,
    `VidSAllocVidImage()`, then `SetBurnHighCol(nVidImageDepth)` (without it colours are wrong — the
    spike's first video was black with magenta outlines).
  - Frame: `BurnDrvFrame()` (or redraw) + `pVidTransCallback` for 16-bit-only drivers, as DirectDraw.
  - Paint/ImageSize: nothing.

Patches added to `emulator/patches.py` (anchored as today):

| File | Change |
|---|---|
| `src/intf/audio/aud_interface.cpp` | declare and append `AudOutFc2mp4` to the Win32 plugin list; in `AudSoundInit`, select it when `Fc2mp4DumpActive()` |
| `src/intf/video/vid_interface.cpp` | declare and append `VidOutFc2mp4` to the Win32 list; in `VidInit`, select it when `Fc2mp4DumpActive()` |
| `src/burner/win32/run.cpp` | do not `ShowWindow` the main window when `Fc2mp4DumpActive()` |
| `src/burner/win32/progress.cpp` | `ProgressCreate` does nothing when `Fc2mp4DumpActive()` |

The patch set hash changes, so `emulator.yml` publishes a new emulator release
(`emulator-<commit12>-<hash12>`) when the change reaches `main`.

## 3. CLI

- **Windows, macOS:** no code change; the new emulator does it. macOS keeps `caffeinate`.
- **Linux launch:** `wine <runtime>/fcadefbneo-fc2mp4.exe <streamArg>` (own process group, our
  `WINEPREFIX`, `WINEDEBUG=-all`, `WINEDLLOVERRIDES=mscoree,mshtml=`), no `xvfb-run`. Stop:
  `wineserver -k`, then the process-group sweep (unchanged).
- **Linux Wine environment:** setup = `wine wineboot -i`, then
  `wine reg add HKCU\Software\Wine\Drivers /v Graphics /d null /f`, then `wineserver -w`, then the
  marker. All without `xvfb-run` (verified in the spike: `wineboot` logs display errors but completes).
  The virtual-desktop registry keys are no longer written.
- **Migration:** the ready marker becomes `.fc2mp4-ready-2`. When it is missing, the prefix folder is
  deleted (it is fc2mp4's own cache) and set up again; progress says "Setting up Wine (first run,
  about a minute)…" as today.
- **Removed:** `src/silentAudio.ts`, the `startAudio` dependency in `convert`, and the
  `emulatorEnv` capture option (it only carried the PulseAudio socket).
- **Prerequisites (Linux):** `checkTools` requires `wine` only (ffmpeg is checked where located);
  `APT_HINT` = `sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 ffmpeg`.
- **Docker image:** packages `wine wine32:i386 ffmpeg ca-certificates tini`.
- README: Linux prerequisites updated; no mention of Xvfb/PulseAudio.

## 4. Testing

- **Unit tests:** Linux launch command (no `xvfb-run`); Wine setup steps (no `xvfb-run`, `Graphics`
  null, no Explorer keys); migration (old marker only → prefix removed, set up again, new marker);
  `checkTools` / hint (wine only); `convert` order without the sound device.
- **Emulator:** patch anchors apply to the latest fightcade-fbneo (`patcher` already fails on a missing
  or ambiguous anchor); CI emulator build.
- **Real tests before the CLI release:**
  - macOS (Claude, on the Mac): short replay through `fc2mp4` itself with the new emulator — no
    window seen (window list sampled every 0.3 s), 8220 frames, audio ≤ 0.05 s, frame at 60 s correct.
  - Linux in Docker (Claude, amd64 emulation): image without xvfb/pulseaudio, short replay, frame at
    60 s correct.
  - Windows (user, on the PC): after the patch change reaches `main` and `emulator.yml` publishes, a
    PowerShell script downloads that emulator release and runs it on the short replay with the
    `FC2MP4_*` variables (files, not pipes) — no window, no sound, frames + audio + a frame image.
  - After the tag: the user's WSL/Docker script (v0.6.0).

## 5. Release

- CLI version `0.6.0` (Linux requirements change).
- Order: merge → `emulator.yml` publishes the emulator → Windows test → tag `v0.6.0` → WSL/Docker test.
  Each push/tag asked first.

## 6. Spike evidence (branch `spike/silent`)

- macOS (Fightcade's Wine): no visible window (sampled every 0.3 s), 8220/8220 frames, sample rate
  44100, audio 137.931 s vs video 137.942 s, 40–43 s (was 54 s); video checked by the user.
- Linux (Docker, amd64 emulation): prefix created without any display, `Graphics=null`, no Xvfb, no
  PulseAudio: 8220/8220 frames, audio 137.931 s, frame at 60 s correct.
- Found and fixed during the spike: video plugin refusing to start before a game is loaded (error
  popup), splash image crash, wrong colours without `SetBurnHighCol`, "Loading…" box.

## 7. Out of scope

- Fightcade's own emulator and online play (never touched).
- Removing `caffeinate` on macOS (kept as a cheap precaution).
- The hosted service.
