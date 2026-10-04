# fc2mp4 on headless Linux — Design

Date: 2026-10-04
Builds on: `2026-10-03-windows-support-design.md` (Windows + released binaries) and
`2026-10-03-fightcade-replay-to-mp4-design.md` (rev 2). Evidence: `docs/spike-findings.md`, spike 4
(Ubuntu 24.04, stock Wine 9: Xvfb + Wine virtual desktop captured 8220/8220 frames headless).

## 1. Goal and understanding

- **Outcome:** `fc2mp4 <replay link>` works on an x86_64 Linux machine with no screen and produces
  the same MP4 as on Windows/macOS. This is the building block for the future hosted service; the
  service itself is out of scope.
- **Packaging:** one `fc2mp4-linux-x64` single-executable binary per release, plus system packages
  installed once by the admin (`wine` with 32-bit support, `xvfb`, `ffmpeg`), checked by the tool.
  A Docker image comes later, with the server work.
- **Test machine:** the user's WSL2 Ubuntu 24.04 on the Windows PC, reading the Windows Fightcade
  folder through `/mnt/c` (read-only).

### Success criteria

1. On Ubuntu/Debian with the prerequisites installed: `fc2mp4-linux-x64 <link> --fightcade-dir <dir>`
   → 1440×1080 H.264/AAC MP4 with every frame and audio within 0.05 s of the video, without any
   visible window.
2. Missing prerequisites are reported before any work, with the exact `apt` command.
3. Ctrl-C or a failure leaves no Wine process, temp dir or lock behind.
4. Nothing in the Fightcade folder is modified (same guarantee as the other platforms).
5. Windows and macOS behaviour unchanged.

## 2. Fightcade files on Linux

- **Needed:** a folder containing `ggponet.dll` (and the DLLs next to it) and `ROMs/sfiii3nr1.zip`
  (+ parent `ROMs/sfiii3.zip`). On Linux, Fightcade's `fcadefbneo.exe` and `config/fcadefbneo.ini`
  are optional; without the ini, the runtime config contains only fc2mp4's overrides.
- **Lookup order:** `--fightcade-dir`, then the `FC2MP4_FIGHTCADE_DIR` environment variable, then
  `~/Fightcade`, `~/fightcade`, `/opt/fightcade`.
- **Accepted layouts for a given path `<dir>`:**
  - Fightcade root: `<dir>/emulator/fbneo/ggponet.dll` exists → fbneo folder = `<dir>/emulator/fbneo`;
  - fbneo folder itself: `<dir>/ggponet.dll` exists → fbneo folder = `<dir>`.
- A located install on Linux therefore requires `ggponet.dll` and the ROM (checked in preflight), not
  `fcadefbneo.exe`.
- **Paths:** cache `$XDG_CACHE_HOME/fc2mp4` (default `~/.cache/fc2mp4`) with `runtime/`,
  `wineprefix/`; output `~/Videos/Fightcade/<quarkId>.mp4`.

## 3. Headless launch

- **Command** (cwd = runtime folder, env `FC2MP4_*` as on other platforms):
  `xvfb-run -a -s "-screen 0 1024x768x24" wine explorer /desktop=fc2mp4,1024x768 <runtime>/fcadefbneo-fc2mp4.exe <streamArg>`
  with `WINEARCH=win32`, `WINEPREFIX=<cache>/wineprefix`, `WINEDEBUG=-all`. A virtual display is used
  even when a real one exists (`DISPLAY`/`WAYLAND_DISPLAY` are not used), so behaviour is identical
  everywhere. Bare Xvfb without the virtual desktop fails (X_UnmapWindow BadWindow) and must not be
  used.
- **Wine environment:** created once with `xvfb-run -a wineboot -i` (same env) when
  `<cache>/wineprefix/system.reg` is missing; progress says "Setting up Wine (first run, ~1 min)…".
  If the output mentions missing 32-bit support (`wine32 is missing` / `ELFCLASS32`), fail with a
  Preflight error and the apt hint.
- **Frame transport:** POSIX FIFO, as on macOS (`Z:\…` path inside Wine); audio/info via files.
- **Stopping:** normal end = emulator exits (Wine and the virtual display end with it). On Ctrl-C,
  max-duration, stall or errors: `wineserver -k` with our `WINEPREFIX` (stops every Wine process of
  our prefix only), then hard-kill the `xvfb-run` child.
- **Prerequisites (preflight):** `wine`, `xvfb-run` and `ffmpeg` on PATH; hint
  `sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 xvfb ffmpeg`.
- **Emulator:** downloaded from the GitHub release (no local build on Linux).
- No `caffeinate` (macOS only).

## 4. Packaging and testing

- **CI:** `cli.yml` gains an `ubuntu-latest` job building `fc2mp4-linux-x64` (Node 24 SEA) and running
  the full unit suite; releases carry `fc2mp4.exe`, `fc2mp4-macos-arm64`, `fc2mp4-linux-x64`.
- **Unit tests:** Linux install detection (both layouts, env var, candidates, not found); Linux app
  paths (XDG, Videos); headless launch command and `wineserver -k` stop; Wine-environment setup
  (first run vs present, 32-bit missing → hint); prerequisite checks.
- **Real test (WSL2 Ubuntu, user runs):** short replay with `--fightcade-dir
  /mnt/c/Users/Coccis/Documents/Fightcade` (1440×1080, all frames, audio vs video ≤ 0.05 s); the 9-min
  replay (speed); Ctrl-C (no `wine`/`wineserver`/`Xvfb` process, temp dir or lock left); Fightcade
  folder unchanged.

## 5. Out of scope

- Docker image; the hosted service (web page, queue, storage).
- Prerequisite hints for non-Debian distributions (they work if the packages exist).
- ARM Linux (the emulator is x86 Windows code).
