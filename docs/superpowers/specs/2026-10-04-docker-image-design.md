# fc2mp4 Docker image — Design

Date: 2026-10-04
Builds on: `2026-10-04-linux-headless-design.md` (headless Linux binary, verified in WSL2 as v0.4.1).
Next, separate project: the hosted service, which will run this image.

## 1. Goal and understanding

- **Outcome:** a public Docker image, published with every release, that converts a Fightcade replay
  link to an MP4 with one `docker run`. It is for the user's future VPS and for anyone in the
  community who wants to run their own converter.
- **Fightcade files are never in the image.** ROMs are copyrighted and `ggponet.dll` is closed
  Fightcade code; whoever runs the image mounts their own Fightcade folder.
- **Ready to convert:** the Wine environment and the current emulator are prepared when the image is
  built, so a `docker run --rm` starts converting immediately (no ~1 min setup, no download).

### Success criteria

1. `docker run --rm -v <Fightcade>:/fightcade:ro -v <dir>:/videos ghcr.io/coccis77/fc2mp4 <link>`
   writes `<dir>/<quarkId>.mp4` (1440×1080 H.264/AAC, every frame, audio within 0.05 s of the video),
   with no Wine setup and no emulator download on the first run of a fresh container.
2. Without a mounted Fightcade folder, the run fails with the existing "Fightcade not found" error.
3. Ctrl-C (`docker run` in the foreground; `docker stop`) stops cleanly with no partial MP4.
4. The image is published as `ghcr.io/coccis77/fc2mp4:<version>` and `:latest` by the release
   workflow, only after it passes its checks.
5. The native binaries (Windows, macOS, Linux) behave as before, apart from the two additions below.

## 2. Usage

```bash
docker run --rm \
  -v /path/to/Fightcade:/fightcade:ro \
  -v "$PWD/videos":/videos \
  ghcr.io/coccis77/fc2mp4 <replay link or quark ID> [options]
```

- `/fightcade`: the Fightcade root or its `emulator/fbneo` folder (both layouts, as on Linux), mounted
  read-only. Only `ggponet.dll` (+ the DLLs next to it) and `ROMs/sfiii3nr1.zip` (+ `sfiii3.zip`)
  are used.
- `/videos`: output folder. All CLI options work (`-o`, `--scale`, `--max-duration`, `-v`).
- The container runs as user `fc2mp4` (uid 1000, gid 1000): output files belong to uid 1000 on the
  host. Running with another `--user` is not supported (Wine refuses a prefix owned by another user).
- x86-64 only. On Apple Silicon, Docker runs it through slow emulation; Mac users should use the
  native `fc2mp4-macos-arm64` binary (README says so).

## 3. CLI additions (all platforms)

- **`fc2mp4 prepare [-v]`:** prepares everything except the Fightcade files — checks the required
  tools (as preflight does: `wine` + `xvfb-run` + `ffmpeg` on Linux), locates/downloads ffmpeg where
  fc2mp4 manages it (Windows), ensures the emulator (forces a release check, like
  `update-emulator`), and on Linux creates the Wine environment. It takes the conversion lock, does
  not need `--fightcade-dir`, and prints what it did. Errors use the existing messages and exit codes.
- **`FC2MP4_OUTPUT_DIR`:** when set (absolute path), replaces the default output folder
  (`~/Videos/Fightcade`, `~/Movies/Fightcade`, `%USERPROFILE%\Videos\Fightcade`). `-o` still wins.
  A relative or empty value is ignored (default folder used).
- Usage/help text documents both.

## 4. Image

- **Base:** `ubuntu:24.04` (the verified environment). `dpkg --add-architecture i386`, then
  `wine wine32:i386 xvfb xauth ffmpeg ca-certificates`, with apt lists removed.
- **Binary:** the `fc2mp4-linux-x64` built by the same release run, copied to `/usr/local/bin/fc2mp4`.
- **User:** `fc2mp4` (uid/gid 1000), `HOME=/home/fc2mp4`; the cache lives in
  `/home/fc2mp4/.cache/fc2mp4` (emulator runtime + Wine prefix).
- **Build step:** `RUN fc2mp4 prepare` as that user — the emulator and Wine prefix are in the image.
- **Environment:** `FC2MP4_FIGHTCADE_DIR=/fightcade`, `FC2MP4_OUTPUT_DIR=/videos`.
- **No arguments:** the usual usage error.
- **Signals:** the entrypoint is `["tini", "--", "fc2mp4"]` (package `tini`), so users need no
  `--init` flag: tini runs as PID 1, forwards Ctrl-C (SIGINT, proxied by `docker run`) and
  `docker stop` (SIGTERM) to fc2mp4, and reaps orphaned Wine/Xvfb processes.
- **Emulator updates:** as on every platform — checked once a day; a newer release is downloaded into
  the container (a few MB, lost with the container). If offline, the built-in one is used.

## 5. CI and publishing

- `cli.yml` release job gains an `image` job on `ubuntu-latest`, after the Linux binary job, on tags
  only: build with the binary artifact, run the checks, then push `:<version>` and `:latest` to
  `ghcr.io/coccis77/fc2mp4` with the workflow's `GITHUB_TOKEN` (`packages: write`). No other secret.
- **Image checks (before push):** `--version` prints the version; the emulator exe and the Wine ready
  marker exist in the image; a run without `/fightcade` fails with the "Fightcade not found" error
  and its exit code.
- The `Dockerfile` lives at the repo root; non-tag pushes build the image and run the checks without
  pushing, so a broken Dockerfile is caught before release.
- **One manual step:** after the first publish, the user makes the package public once in GitHub's
  package settings (new packages are private).

## 6. Testing

- **Unit tests:** `prepare` (no Fightcade needed; order: preflight tools → ffmpeg → emulator forced →
  Wine; lock released on error), `FC2MP4_OUTPUT_DIR` (absolute used, relative/empty ignored, `-o`
  wins), argument parsing (`prepare` takes no positional argument).
- **Real test (user runs, WSL2 Ubuntu with Docker Engine):** pull the published image; short replay
  (1440×1080, frames, audio vs video ≤ 0.05 s, no "Setting up Wine" or download message); 9-min
  replay (speed); Ctrl-C (exit 130, no partial MP4, container gone); emulator killed inside the
  container (error, no MP4); Fightcade folder unchanged.

## 7. Out of scope

- The hosted service (web page, queue, storage, abuse limits) — next project.
- ARM images; running as an arbitrary `--user`; non-Docker container runtimes beyond what works
  unchanged.
