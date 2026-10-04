# fc2mp4

Turns a Fightcade **Street Fighter III: 3rd Strike** replay into an MP4 (1440×1080, H.264/AAC),
faster than real time. Windows, macOS and Linux. Free and non-commercial.

## Install

- **Windows:** download `fc2mp4.exe` from the latest `v*` release on the
  [releases page](https://github.com/Coccis77/fightcade-replay-converter/releases). Windows may warn
  that it is unsigned: click *More info* → *Run anyway*. Needs Fightcade 2 with 3rd Strike opened once.
- **macOS:** download `fc2mp4-macos-arm64`, `chmod +x` it, and install ffmpeg (`brew install ffmpeg`).
  Needs Fightcade 2 with 3rd Strike opened once.
- **Linux (x86_64, headless):** download `fc2mp4-linux-x64`, `chmod +x` it, and install the system
  packages once: `sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 xvfb ffmpeg`.
  Point it at Fightcade's files with `--fightcade-dir` (or `FC2MP4_FIGHTCADE_DIR`): either a Fightcade
  folder, or a copy of its `emulator/fbneo` folder containing `ggponet.dll` and `ROMs/sfiii3nr1.zip` +
  `ROMs/sfiii3.zip`. No screen is needed: it runs on a virtual display.

## Usage

```sh
fc2mp4 https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234
```

Videos go to `~/Movies/Fightcade` (macOS), `%USERPROFILE%\Videos\Fightcade` (Windows) or `~/Videos/Fightcade` (Linux); use `-o`
for another file or folder. `--help` lists all options.

## How it works

fc2mp4 runs its own copy of Fightcade's emulator, built by GitHub Actions from the public source
(github.com/fightcadeorg/fightcade-fbneo) with small patches (`emulator/patches.py`) that stream
every frame to ffmpeg and fast-forward through the replay. That copy and, on Windows, ffmpeg are
downloaded automatically on first use (the emulator is checked for updates once a day;
`fc2mp4 update-emulator` checks now). It runs from its own folder (`%LOCALAPPDATA%\fc2mp4` or
`~/Library/Caches/fc2mp4`) using Fightcade's network library and ROM: **your Fightcade install is
never modified**, and Fightcade itself always uses its original emulator.

## Development

```sh
npm install && npm run build && node dist/cli.js <link>
npm test && npm run test:emulator
```

`fc2mp4 rebuild-emulator` builds the emulator locally instead of downloading it (macOS, from a
source checkout, `brew install mingw-w64 git`). `npm run bundle && npm run sea` builds the single
executable for the current OS.
