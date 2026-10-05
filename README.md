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
  packages once: `sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 ffmpeg`.
  Point it at Fightcade's files with `--fightcade-dir` (or `FC2MP4_FIGHTCADE_DIR`): either a Fightcade
  folder, or a copy of its `emulator/fbneo` folder containing `ggponet.dll` and `ROMs/sfiii3nr1.zip` +
  `ROMs/sfiii3.zip`. No screen or sound device is needed.

## Usage

```sh
fc2mp4 https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234
```

Videos go to `~/Movies/Fightcade` (macOS), `%USERPROFILE%\Videos\Fightcade` (Windows) or `~/Videos/Fightcade` (Linux); use `-o`
for another file or folder. `--help` lists all options.

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

The MP4 lands in `./videos/<id>.mp4`. Every option works (`--scale`, `--max-duration`, `-o`, `-v`).
The container runs as uid 1000: the `videos` folder must be writable by that user (on most single-user
Linux machines, that is you). Pin a version with `ghcr.io/coccis77/fc2mp4:<version>`.

Without Docker, `fc2mp4 prepare` does the same one-time setup (emulator download, Wine environment)
ahead of the first conversion. `FC2MP4_OUTPUT_DIR` sets the default output folder.

## Web page

`fc2mp4 serve` starts a small page: paste a replay link, the MP4 downloads when it is ready. One
replay is converted at a time; the others wait in line. Open `http://localhost:8080`
(`--port` to change it; `--host 0.0.0.0` lets other devices on your network in).

```bash
docker run --rm -p 8080:8080 \
  -v /path/to/Fightcade:/fightcade:ro -v "$PWD/videos":/videos \
  ghcr.io/coccis77/fc2mp4 serve
```

The MP4s are also kept in the output folder. Add `--keep 7d` (or `12h`, …) to delete fc2mp4's MP4s
older than that, checked at startup and every hour; other files in the folder are never touched, and a
deleted replay is simply converted again if someone asks for it.

On Windows with Docker in WSL, if `http://localhost:8080` does not load, use the WSL address shown by
`hostname -I` in Ubuntu (e.g. `http://172.25.192.17:8080`).

### Accounts

The page needs a login. The first visit to `/admin` creates the admin account; the admin then adds
users there (username, temporary password, replays per day — 3 by default) and each user chooses their
own password at first login. Everyone sees the same list of conversions, with an "Uploaded by" filter;
only the admin can delete them. The admin has no daily limit. Users, sessions and the list live in
`fc2mp4-data.json` in the output folder (back it up with the videos). The day resets at local midnight:
in Docker add `-e TZ=Europe/Paris` (your time zone).

Lost the admin password? `fc2mp4 reset-admin` (Docker: `docker exec <container> fc2mp4 reset-admin`),
then open `/admin` again.

### On a VPS, with HTTPS (Caddy)

Run fc2mp4 on the server's own address only and let Caddy add HTTPS:

```bash
docker run -d --restart unless-stopped -p 127.0.0.1:8080:8080 -e TZ=Europe/Paris -e FC2MP4_TRUST_PROXY=1 \
  -v /srv/fightcade:/fightcade:ro -v /srv/videos:/videos \
  ghcr.io/coccis77/fc2mp4 serve --keep 7d
```

`FC2MP4_TRUST_PROXY=1` tells fc2mp4 that it is only reachable through Caddy, so it uses the visitor's real
address (login limit) and knows the connection is HTTPS (secure cookie). Only set it when the port is
published on `127.0.0.1` as above.

`/etc/caddy/Caddyfile`:

```
replays.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

## How it works

fc2mp4 runs its own copy of Fightcade's emulator, built by GitHub Actions from the public source
(github.com/fightcadeorg/fightcade-fbneo) with small patches (`emulator/patches.py`) that stream
every frame to ffmpeg and fast-forward through the replay. While recording, the emulator shows no
window and plays no sound. That copy and, on Windows, ffmpeg are
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
