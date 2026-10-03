# fc2mp4 on Windows + released binaries — Design

Date: 2026-10-03
Builds on: `2026-10-03-fightcade-replay-to-mp4-design.md` (rev 2, macOS). Evidence: `docs/spike-findings.md`
(spike 3: the patched emulator built on macOS captured identically on Windows 11).

## 1. Goal and understanding

- **Outcome:** run `fc2mp4.exe <replay link>` on the user's Windows 11 PC and get the same MP4 as on
  macOS; macOS keeps working.
- **Install burden:** as little as possible. On Windows the user downloads one `fc2mp4.exe` from the
  GitHub releases page and runs it. Fightcade is already installed; ffmpeg and the emulator are
  fetched automatically. No Node, Git, compiler or Homebrew-equivalent.
- **Context:** personal/community, non-commercial tool; public repo `github.com/Coccis77/fightcade-replay-converter`.
  Headless Linux is the next project and must not be blocked by choices here.
- **Accepted:** the unsigned `fc2mp4.exe` triggers SmartScreen on first run ("More info" → "Run
  anyway"); no code signing.

### Success criteria

1. On Windows: download `fc2mp4.exe`, run it with a replay link → MP4 in `%USERPROFILE%\Videos\Fightcade`,
   with nothing else installed beyond Fightcade.
2. Output identical in format/quality to macOS (1440×1080 H.264/AAC, every frame, A/V aligned).
3. Capture and encoding overlap on Windows (no full raw dump on disk).
4. A Fightcade source update is picked up automatically within a day (CI rebuild + download); a patch
   that stops applying fails CI loudly (GitHub email) and users keep the last working emulator.
5. macOS behaviour preserved (same CLI, same output); macOS users no longer need mingw/perl.

## 2. Emulator builds in GitHub Actions + download

**Workflow `.github/workflows/emulator.yml`** (ubuntu runner):
- Triggers: daily schedule, pushes touching `emulator/**`, manual dispatch.
- Steps: install `mingw-w64` (i686), `g++`, `perl`, `python3`; create the ggponet import library from
  the committed `emulator/ggponet.def` (`i686-w64-mingw32-dlltool -d ggponet.def -l libggponet.a`); run
  `emulator/build.py` against the latest `fightcade-fbneo` `master`.
- Release tag: `emulator-<sourceCommit[:12]>-<patchSetHash[:12]>`. If that release already exists the
  job ends early. Assets: `fcadefbneo-fc2mp4.exe`, `build-info.json` (`sourceCommit`, `patchSetHash`,
  `builtAt`).
- A patch that no longer applies or a build error fails the job (GitHub notifies the owner); no release
  is created, so clients keep the previous one.

**`build.py` changes:** accept an import library (`.a`) as well as a DLL for `--ggponet`; create the
`InitGuid.h` → `<initguid.h>` case shim itself (Linux is case-sensitive); report missing tools
(`git`, `perl`, `c++`, `cc`, mingw) as a clean error with exit code 3 instead of a traceback.

**`emulator/ggponet.def`:** the export names of Fightcade's `ggponet.dll` (names only; no Fightcade
binary is committed or released).

**Patch-set hash:** one definition shared by CI and the CLI: sha256 over the files of `emulator/`
(excluding `test_*` and `__pycache__`), path + content, sorted. The CLI binary embeds the hash computed
at its build time.

**Client side (macOS and Windows), `emulatorSource`:**
- Pick the newest GitHub release whose tag ends with the embedded patch-set hash
  (`GET /repos/Coccis77/fightcade-replay-converter/releases`, unauthenticated; the repo is public).
- Check at most once a day (timestamp in `runtime/manifest.json`); `fc2mp4 update-emulator` forces it.
- Download to a temp name, verify it is a PE file of the expected size, rename into place, update the
  manifest. An interrupted download never replaces a working exe.
- Network/GitHub failure with an existing exe → keep it, warn. No exe at all → fail with exit 5 and a
  hint.
- No release matches the embedded hash (local patch edits, or CI not finished yet): on macOS fall back
  to the local build (`fc2mp4 rebuild-emulator --local`, today's toolchain path); on Windows fail with
  a clear message ("no emulator build for this fc2mp4 version yet").
- Fightcade's own exe/dll hashes no longer trigger rebuilds (CI tracks upstream source). DLLs are still
  copied into the runtime only when the emulator changes or a DLL is missing.

## 3. Windows runtime and capture

**Install detection** (`--fightcade-dir` overrides):
- macOS: unchanged.
- Windows candidates, in order: `%USERPROFILE%\Documents\Fightcade`, `%USERPROFILE%\Fightcade`,
  `C:\Fightcade`, `%LOCALAPPDATA%\Programs\Fightcade`. Layout `<root>\emulator\fbneo\{fcadefbneo.exe,
  ggponet.dll, ROMs\, config\fcadefbneo.ini}`.
- `FightcadeInstall` gains `platform` and `launcher: string | null` (`wine.sh` on macOS, null on
  Windows); all path building uses `path.win32`/`path.posix` per platform. Platform is passed in (not
  read from `process.platform` inside units) so both are unit-tested on any machine.

**Runtime folder:** `%LOCALAPPDATA%\fc2mp4\runtime` on Windows (macOS unchanged). ROMs link: directory
junction on Windows (no admin rights needed), symlink on macOS. Same DLL policy, same
`config\fcadefbneo-fc2mp4.ini` with the same overrides.

**Launch/kill:** Windows runs `<runtime>\fcadefbneo-fc2mp4.exe <streamArg>` directly (cwd = runtime,
same env vars); kill = `taskkill /IM fcadefbneo-fc2mp4.exe /F` then hard-kill the child. macOS
unchanged (`wine.sh`).

**Video transport** — interface with one implementation per platform:
```
interface VideoTransport {
  emulatorPath: string;              // what FC2MP4_VIDEO is set to
  encoderInput: string;              // ffmpeg -i argument ("pipe:0" or the FIFO path)
  attach(encoderStdin: Writable): void;
  close(): Promise<void>;
}
```
- macOS FIFO (existing behaviour): `mkfifo`, emulator path `Z:\…\video.fifo`, ffmpeg reads the FIFO,
  `attach` is a no-op.
- Windows named pipe: Node listens on `\\.\pipe\fc2mp4-<pid>-<random>` with `net.createServer`; the
  emulator `fopen`s it (no emulator change); the first connection is piped into ffmpeg's stdin
  (`-i pipe:0`) with back-pressure; when the emulator closes it, stdin ends and the encode finishes.
- Audio and info stay regular temp files; on Windows their paths are passed natively (the `Z:` mapping
  applies only under Wine).

**ffmpeg:**
- macOS: `ffmpeg` from PATH (Homebrew), as today.
- Windows: `ffmpeg` from PATH if present; otherwise download a pinned static build (a fixed release of
  `BtbN/FFmpeg-Builds`, win64 GPL zip) on first run into `%LOCALAPPDATA%\fc2mp4\ffmpeg\`, verify its
  sha256 (pinned), extract `ffmpeg.exe`. The CLI uses an explicit ffmpeg path everywhere.

**Preflight on Windows:** ROM, `fcadefbneo.exe`, `ggponet.dll` present; ffmpeg available (or
downloadable). No Wine check.

**Output:** `%USERPROFILE%\Videos\Fightcade\<quarkId>.mp4`.

## 4. Distribution of the CLI

**Workflow `.github/workflows/cli.yml`:** on version tags `v*` (and manual):
- bundle `src/cli.ts` with esbuild into one CommonJS file (top-level `await` in `cli.ts` becomes an
  async `main()` call); inject `PATCH_SET_HASH` and the version as constants;
- build a Node 24 single executable on each OS runner (`windows-latest` → `fc2mp4.exe`,
  `macos-latest` arm64 → `fc2mp4`): `node --experimental-sea-config` (`useCodeCache: false`,
  `useSnapshot: false`, `disableExperimentalSEAWarning: true`), copy `node`, inject with `postject`
  (macOS: remove and re-apply an ad-hoc signature);
- attach both binaries to the GitHub release `v<version>`.

Developers keep `npm install && npm run build && node dist/cli.js`.

## 5. Testing

- **Unit (vitest, run on macOS):** Windows/macOS install detection and layouts; runtime junction vs
  symlink; launch and kill commands per platform; named-pipe transport (a Unix domain socket stands in
  for `\\.\pipe\` on macOS — same `net` API; asserts every byte arrives in order with back-pressure and
  that close ends the encoder input); release selection by patch-set hash, daily check, offline
  fallback, no-match behaviour per platform, interrupted download keeps the old exe (fake GitHub API +
  fake downloads); ffmpeg resolution (PATH vs cached vs download, checksum mismatch rejected).
- **Python unittest:** `build.py` case shim, `.a` import library accepted, missing-tool error.
- **CI:** the first `emulator.yml` run must publish a release whose exe imports `ggponet.dll`; the
  macOS e2e test then passes using the downloaded exe instead of a local build.
- **On the Windows PC (user runs, exact commands provided):** download `fc2mp4.exe` from the release;
  convert the short replay (paste output, watch the MP4); convert the 9-minute replay (speed compared
  with macOS); one Ctrl-C mid-capture, then a provided command checks no emulator/ffmpeg process,
  temp dir or lock remains.

## 6. Out of scope

- Headless Linux (next project; the emulator CI build is already Linux-based).
- Code signing, an installer, running as a Windows service.
- macOS Intel builds (only arm64 is built).
- Changing the encode settings (stay `veryfast` / crf 20, YUV-first scaling).
