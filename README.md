# fc2mp4

Turns a Fightcade replay into an MP4 (1440×1080, H.264/AAC), faster than real time. Windows, macOS
and Linux. Free and non-commercial.

## Supported games

Any horizontal FBNeo arcade game you can play on Fightcade: fc2mp4 reads each game's screen size and
speed from the emulator, and its ROMs from Fightcade's game list. Vertical games (shoot'em ups like
DoDonPachi) are not supported yet.

Tested with real replays: Street Fighter III: 3rd Strike (`sfiii3nr1`), Garou: Mark of the Wolves
(`garou`), Super Street Fighter II X (`ssf2xjr1`), Street Fighter Alpha 3 (`sfa3`), Vampire Savior
(`vsavj`), Mortal Kombat (`mk`).

Open the game once in Fightcade so it downloads its ROMs. Links look like
`https://replay.fightcade.com/fbneo/<game>/<id>`; a quark ID alone (`1700000000000-1234`) is read as
3rd Strike.

## Install

- **Windows:** download `fc2mp4-setup.exe` from the latest release on the
  [releases page](https://github.com/Coccis77/fightcade-replay-converter/releases) and run it. Windows may
  warn that it is unsigned: click *More info* → *Run anyway*. It installs for your Windows account (no
  administrator rights), adds fc2mp4 to the Start menu, and offers each new version when you open it.
  ffmpeg and the emulator are downloaded on the first conversion.
- **macOS:** download `fc2mp4-macos-arm64`, `chmod +x` it, and install ffmpeg (`brew install ffmpeg`).
- **Linux (x86_64, headless):** download `fc2mp4-linux-x64`, `chmod +x` it, and install the system
  packages once: `sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 ffmpeg`.
  Point it at Fightcade's files with `--fightcade-dir` (or `FC2MP4_FIGHTCADE_DIR`): either a Fightcade
  folder, or a copy of its `emulator/fbneo` folder containing `ggponet.dll` and the game's ROMs in
  `ROMs/` (see [Supported games](#supported-games)) and, optionally, Fightcade's `emulator/fbneo_roms.json`
  copied into that folder, so fc2mp4 can tell which parent or BIOS files each game needs. No screen or
  sound device is needed.

Windows and macOS need Fightcade 2 installed, with the game opened once.

## Usage

### Windows

Open **fc2mp4** from the Start menu. Paste one or more replay links (one per line) and press
**Convert**: the links are converted one after the other, the console shows the progress, and
**Open video** opens the last one. If the window is in the background, Windows tells you when it is
done. The folders (Fightcade, videos) and the encoder are under **Settings** and are remembered; leave
*Fightcade folder* empty unless fc2mp4 does not find Fightcade by itself. When a new version is out, a
bar at the top offers to update.

Coming from the two files `fc2mp4.exe` + `fc2mp4-ui.exe`: run the installer, then delete them; your
settings are kept.

**From PowerShell:**

The installer also puts the command-line tool, `fc2mp4-cli.exe`, next to the window (the release page
offers it on its own too):

```powershell
& "$env:LOCALAPPDATA\Programs\fc2mp4\fc2mp4-cli.exe" "https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234"
```

Keep the `&` and the quotes. The video goes to `Videos\Fightcade` in your user folder.

fc2mp4 looks for Fightcade in `Documents\Fightcade` (also under OneDrive), `%USERPROFILE%\Fightcade`,
`C:\Fightcade` and `%LOCALAPPDATA%\Programs\Fightcade`. If yours is elsewhere, pass the Fightcade
folder (the one that contains `emulator\fbneo\fcadefbneo.exe`) with `--fightcade-dir`:

```powershell
& "$env:LOCALAPPDATA\Programs\fc2mp4\fc2mp4-cli.exe" "https://replay.fightcade.com/fbneo/garou/1791766846976-7757" --fightcade-dir "D:\Games\Fightcade"
```

To choose where the video goes, add `-o` with a folder or a file name:

```powershell
& "$env:LOCALAPPDATA\Programs\fc2mp4\fc2mp4-cli.exe" "https://replay.fightcade.com/fbneo/sfa3/1792152118748-6544" --fightcade-dir "D:\Games\Fightcade" -o "$HOME\Desktop\alpha3.mp4"
```

Keep the quotes around paths that contain spaces, and don't end a path with `\` (`"D:\Games\Fightcade\"`
breaks the command).

### macOS

```sh
./fc2mp4-macos-arm64 https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234
```

fc2mp4 finds `FightCade2.app` in `/Applications` or `~/Applications`; otherwise add
`--fightcade-dir "/path/to/FightCade2.app"`. Videos go to `~/Movies/Fightcade`.

### Linux

```sh
./fc2mp4-linux-x64 https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234 --fightcade-dir /srv/fightcade
```

Videos go to `~/Videos/Fightcade`.

### Options

- `-o <file or folder>`: where to write the MP4 (default: the folder above, or `FC2MP4_OUTPUT_DIR`).
  In a folder, videos are named `<game> - <player 1> vs <player 2> - <date> - <quark ID>.mp4`
  (e.g. `garou - iorimg6680 vs WhiteGriffith - 2026-10-12 - 1791766846976-7757.mp4`); with a file name,
  that name is used as is.
- `--fightcade-dir <path>`: where Fightcade is, when it is not found by itself.
- `--scale sharp|smooth`: upscaling style (default `sharp`).
- `--encoder <name>`: video encoder. `auto` (the default) uses an NVIDIA graphics card on Windows when
  there is one (`nvenc`: about 25% faster, same quality, files slightly bigger) and `x264` (your
  processor, works everywhere) otherwise. You can also choose `x264`, `nvenc`, `qsv` (Intel graphics),
  `amf` (AMD graphics), `mf` (Windows, any graphics card) or `videotoolbox` (macOS); if one isn't
  available on your computer, fc2mp4 says so.
- `--max-duration <d>`: stop after this long, e.g. `90s`, `45m`, `1h` (default `60m`).
- `-v`: print debug details. `--help` lists every command and option.

## Docker

A ready-to-use image is published with every release (x86-64; on Apple Silicon Macs use the native
binary instead, Docker would emulate it slowly). Fightcade's files are not in the image: mount your
own Fightcade folder (or its `emulator/fbneo` folder) read-only.

```bash
mkdir -p videos   # create it first: a folder Docker creates belongs to root, and the container can't write to it
docker run --rm \
  -v /path/to/Fightcade:/fightcade:ro \
  -v "$PWD/videos":/videos \
  ghcr.io/coccis77/fc2mp4 https://replay.fightcade.com/fbneo/sfiii3nr1/<id>
```

The MP4 lands in `./videos/`, named `<game> - <player 1> vs <player 2> - <date> - <id>.mp4`. Every option works (`--scale`, `--max-duration`, `-o`, `-v`).
The container runs as uid 1000: the `videos` folder must be writable by that user (on most single-user
Linux machines, that is you). Pin a version with `ghcr.io/coccis77/fc2mp4:<version>`.

Without Docker, `fc2mp4 prepare` does the same one-time setup (emulator download, Wine environment)
ahead of the first conversion. `FC2MP4_OUTPUT_DIR` sets the default output folder.

## How it works

fc2mp4 runs its own copy of Fightcade's emulator, built by GitHub Actions from the public source
(github.com/fightcadeorg/fightcade-fbneo) with small patches (`emulator/patches.py`) that stream
every frame to ffmpeg and fast-forward through the replay. While recording, the emulator shows no
window and plays no sound. That copy and, on Windows, ffmpeg are
downloaded automatically on first use (the emulator is checked for updates once a day;
`fc2mp4 update-emulator` checks now). It runs from its own folder (`%LOCALAPPDATA%\fc2mp4` or
`~/Library/Caches/fc2mp4`) using Fightcade's network library and ROMs: **your Fightcade install is
never modified**, and Fightcade itself always uses its original emulator.

## Development

```sh
npm install && npm run build && node dist/cli.js <link>
npm test && npm run test:emulator
```

`fc2mp4 rebuild-emulator` builds the emulator locally instead of downloading it (macOS, from a
source checkout, `brew install mingw-w64 git`). `npm run bundle && npm run sea` builds the single
executable for the current OS.

## License

fc2mp4 is free for non-commercial use: you may use, modify and share it, but not sell it or make money
from it. Changes you make must be made public. See [LICENSE](LICENSE); its terms are adapted from the
FB Neo license. The emulator fc2mp4 downloads is Fightcade's FB Neo, under the
[FB Neo license](https://github.com/finalburnneo/FBNeo/blob/master/src/license.txt).
