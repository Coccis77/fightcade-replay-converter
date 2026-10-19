# fc2mp4

Turns a Fightcade replay into an MP4 video (1440×1080, H.264/AAC), faster than real time.
Windows, macOS and Linux. Free and non-commercial.

- [Before you start](#before-you-start)
- [Download and install](#download-and-install): [Windows](#windows) · [macOS](#macos) · [Linux](#linux) · [Docker](#with-docker)
- [Usage](#usage): [Windows](#windows-1) · [macOS](#macos-1) · [Linux](#linux-1) · [Docker](#docker-linux-and-macos) · [Options](#options)
- [Supported games](#supported-games) · [How it works](#how-it-works) · [Development](#development) · [License](#license)

## Before you start

- Install [Fightcade](https://www.fightcade.com/) and **open the game once** in it, so it downloads the
  game's files (ROMs). fc2mp4 uses them and never modifies your Fightcade install.
- Copy the replay link from Fightcade. It looks like
  `https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234`.

## Download and install

Every file is on the [latest release](https://github.com/Coccis77/fightcade-replay-converter/releases/latest).

### Windows

1. Download **`fc2mp4-setup.exe`** and run it.
2. Windows may warn that the program is unsigned: click **More info** → **Run anyway**.

It installs for your Windows account (no administrator rights needed) and adds **fc2mp4** to the
Start menu. ffmpeg and the emulator are downloaded on the first conversion. When a new version is out,
fc2mp4 offers to update itself.

### macOS

Apple Silicon (M1 and later). Install ffmpeg with [Homebrew](https://brew.sh), then download fc2mp4:

```sh
brew install ffmpeg
curl -L -o fc2mp4 https://github.com/Coccis77/fightcade-replay-converter/releases/latest/download/fc2mp4-macos-arm64
chmod +x fc2mp4
```

If you download `fc2mp4-macos-arm64` with a browser instead, rename it to `fc2mp4` and run
`chmod +x fc2mp4 && xattr -d com.apple.quarantine fc2mp4`, or macOS refuses to open it.

Intel Mac: use [Docker](#with-docker) instead.

### Linux

x86-64. Install Wine and ffmpeg once (Debian/Ubuntu shown), then download fc2mp4:

```sh
sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 ffmpeg
curl -L -o fc2mp4 https://github.com/Coccis77/fightcade-replay-converter/releases/latest/download/fc2mp4-linux-x64
chmod +x fc2mp4
```

No screen or sound device is needed: it works on a server.

### With Docker

For Linux or macOS, if you would rather not install Wine or ffmpeg. Install
[Docker](https://docs.docker.com/get-docker/), then download the `fc2mp4-docker` script:

```sh
curl -L -o fc2mp4-docker https://github.com/Coccis77/fightcade-replay-converter/releases/latest/download/fc2mp4-docker
chmod +x fc2mp4-docker
```

On macOS, Docker Desktop must be allowed to read `/Applications` (where Fightcade is): add it in
**Docker Desktop → Settings → Resources → File sharing**. The script tells you if it's missing.

The image is x86-64: on Apple Silicon it runs emulated and is much slower than the native `fc2mp4`.

## Usage

### Windows

Open **fc2mp4** from the Start menu.

1. Paste one or more replay links, one per line.
2. Press **Convert**. The links are converted one after the other; the console shows the progress.
3. **Open video** opens the last video, **Open folder** the folder. If the window is in the
   background, Windows tells you when it's done.

Videos go to `Videos\Fightcade` in your user folder. **Settings** has the Fightcade folder, the videos
folder and the encoder; they are remembered. Leave *Fightcade folder* empty unless fc2mp4 doesn't find
Fightcade by itself.

**From PowerShell:** the installer also puts the command-line tool `fc2mp4-cli.exe` next to the window
(the release page offers it on its own too):

```powershell
& "$env:LOCALAPPDATA\Programs\fc2mp4\fc2mp4-cli.exe" "https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234"
```

Keep the `&` and the quotes. With a Fightcade folder fc2mp4 doesn't find, and a chosen video file:

```powershell
& "$env:LOCALAPPDATA\Programs\fc2mp4\fc2mp4-cli.exe" "https://replay.fightcade.com/fbneo/garou/1791766846976-7757" --fightcade-dir "D:\Games\Fightcade" -o "$HOME\Desktop\garou.mp4"
```

Keep the quotes around paths with spaces, and don't end a path with `\` (`"D:\Games\Fightcade\"` breaks
the command).

fc2mp4 looks for Fightcade in `Documents\Fightcade` (also under OneDrive), `%USERPROFILE%\Fightcade`,
`C:\Fightcade` and `%LOCALAPPDATA%\Programs\Fightcade`. Elsewhere, pass the folder that contains
`emulator\fbneo\fcadefbneo.exe` with `--fightcade-dir`.

### macOS

```sh
./fc2mp4 https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234
```

Videos go to `~/Movies/Fightcade`. fc2mp4 finds `FightCade2.app` in `/Applications` or
`~/Applications`; elsewhere, add `--fightcade-dir "/path/to/FightCade2.app"`.

### Linux

```sh
./fc2mp4 https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234
```

Videos go to `~/Videos/Fightcade`. fc2mp4 finds Fightcade in `~/Fightcade`, `~/fightcade` or
`/opt/fightcade`; elsewhere, add `--fightcade-dir /path/to/Fightcade` (or set `FC2MP4_FIGHTCADE_DIR`).

On a server without Fightcade, `--fightcade-dir` can point to a copy of Fightcade's `emulator/fbneo`
folder: it needs `ggponet.dll`, the game's ROMs in `ROMs/`, and preferably Fightcade's
`emulator/fbneo_roms.json` copied into it (so fc2mp4 knows which parent or BIOS files a game needs).

### Docker (Linux and macOS)

`fc2mp4-docker` takes the same arguments as `fc2mp4`:

```sh
./fc2mp4-docker https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234
./fc2mp4-docker https://replay.fightcade.com/fbneo/garou/1791766846976-7757 -o ~/clips/garou.mp4
```

It finds Fightcade like `fc2mp4` does and saves the video in the same folder. On Linux the videos
belong to user 1000 (the image's user), which is you on most single-user machines.

<details>
<summary>Without the script</summary>

```sh
mkdir -p videos   # create it first: a folder Docker creates belongs to root
docker run --rm -v /path/to/Fightcade:/fightcade:ro -v "$PWD/videos":/videos \
  ghcr.io/coccis77/fc2mp4 https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234
```

</details>

### Options

The same on every system (the Windows window has them under **Settings**).

| Option | What it does |
| --- | --- |
| `-o <file or folder>` | Where to write the video. Default: the videos folder above, or `FC2MP4_OUTPUT_DIR`. |
| `--fightcade-dir <path>` | Where Fightcade is, when fc2mp4 doesn't find it. |
| `--encoder <name>` | Video encoder, see below. Default: `auto`. |
| `--scale sharp\|smooth` | Upscaling style. Default: `sharp`. |
| `--max-duration <d>` | Stop after this long: `90s`, `45m`, `1h`. Default: `60m`. |
| `-v` | Print debug details. |
| `--help` | List every command and option. |

In a folder, videos are named `<game> - <player 1> vs <player 2> - <date> - <quark ID>.mp4`, e.g.
`garou - iorimg6680 vs WhiteGriffith - 2026-10-12 - 1791766846976-7757.mp4`. With a file name, that
name is used as is.

Encoders:

- `auto`: `nvenc` on Windows when there is an NVIDIA graphics card, `x264` otherwise.
- `x264`: your processor; works everywhere.
- `nvenc` (NVIDIA), `qsv` (Intel), `amf` (AMD), `mf` (Windows, any graphics card), `videotoolbox`
  (macOS): your graphics card. Same quality, usually faster (`nvenc` about 25%), files slightly bigger.
  If one isn't available on your computer, fc2mp4 says so.

## Supported games

Any horizontal FBNeo arcade game you can play on Fightcade: fc2mp4 reads each game's screen size and
speed from the emulator, and its ROMs from Fightcade's game list. Vertical games (shoot'em ups like
DoDonPachi) are not supported yet.

Tested with real replays: Street Fighter III: 3rd Strike (`sfiii3nr1`), Garou: Mark of the Wolves
(`garou`), Super Street Fighter II X (`ssf2xjr1`), Street Fighter Alpha 3 (`sfa3`), Vampire Savior
(`vsavj`), Mortal Kombat (`mk`).

A quark ID alone (`1700000000000-1234`) is read as 3rd Strike.

## How it works

fc2mp4 runs its own copy of Fightcade's emulator, built by GitHub Actions from the public source
([fightcade-fbneo](https://github.com/fightcadeorg/fightcade-fbneo)) with small patches
(`emulator/patches.py`) that stream every frame to ffmpeg and fast-forward through the replay. While
recording, the emulator shows no window and plays no sound.

That copy and, on Windows, ffmpeg are downloaded on first use. The emulator is checked for updates once
a day (`fc2mp4 update-emulator` checks now); `fc2mp4 prepare` downloads it and sets up Wine ahead of
time. It runs from its own folder (`%LOCALAPPDATA%\fc2mp4` or `~/Library/Caches/fc2mp4`) using
Fightcade's network library and ROMs: **your Fightcade install is never modified**, and Fightcade
itself always uses its original emulator.

## Development

```sh
npm install && npm run build && node dist/cli.js <link>
npm test && npm run test:emulator
```

`fc2mp4 rebuild-emulator` builds the emulator locally instead of downloading it (macOS, from a source
checkout, `brew install mingw-w64 git`). `npm run bundle && npm run sea` builds the single executable
for the current system.

## License

fc2mp4 is free for non-commercial use: you may use, modify and share it, but not sell it or make money
from it. Changes you make must be made public. See [LICENSE](LICENSE); its terms are adapted from the
FB Neo license. The emulator fc2mp4 downloads is Fightcade's FB Neo, under the
[FB Neo license](https://github.com/finalburnneo/FBNeo/blob/master/src/license.txt).
