# fc2mp4

Turns a Fightcade **Street Fighter III: 3rd Strike** replay into an MP4 (1440×1080, H.264/AAC),
faster than real time. macOS only for now. Free and non-commercial.

## Requirements

- Fightcade 2, with 3rd Strike opened at least once (so the ROM is downloaded)
- Node ≥ 22.12, ffmpeg, and the emulator build tools: `brew install ffmpeg mingw-w64 git`

## Usage

```sh
npm install && npm run build
node dist/cli.js https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234
```

The video goes to `~/Movies/Fightcade/`; use `-o` for another file or folder. `--help` lists
all options.

## How it works

fc2mp4 builds its own copy of Fightcade's emulator from the public source
(github.com/fightcadeorg/fightcade-fbneo), with small patches (`emulator/patches.py`) that stream
every frame to ffmpeg and fast-forward through the replay. It runs that copy from
`~/Library/Caches/fc2mp4/runtime` using Fightcade's Wine and network library; your Fightcade
install is never modified. When Fightcade updates, the emulator is rebuilt automatically from the
latest source (`fc2mp4 rebuild-emulator` forces it); if a patch no longer applies, the previous
build keeps working and a warning names the patch to fix.
