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

- **Windows:** download `fc2mp4.exe` from the latest `v*` release on the
  [releases page](https://github.com/Coccis77/fightcade-replay-converter/releases). Windows may warn
  that it is unsigned: click *More info* → *Run anyway*. ffmpeg and the emulator are downloaded on
  first use. Also download `fc2mp4-ui.exe` into the same folder for a window instead of PowerShell.
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

**The easy way:** put `fc2mp4.exe` and `fc2mp4-ui.exe` in the same folder and open `fc2mp4-ui.exe`.
Paste the replay link and press **Convert**; the console shows the progress, and **Open video**
opens the result. The folders (Fightcade, videos) are under **Settings** and are remembered.
Leave *Fightcade folder* empty unless fc2mp4 does not find Fightcade by itself.
Settings also shows the version of your `fc2mp4.exe`; when a newer release is out, it says so and links
to the download page.

**From PowerShell:**

Open PowerShell in the folder where you saved `fc2mp4.exe`: in Explorer, right-click an empty spot in
that folder → *Open in Terminal* (Windows 11), or *Shift + right-click* → *Open PowerShell window here*
(Windows 10). Then:

```powershell
.\fc2mp4.exe "https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234"
```

PowerShell needs the `.\` in front of `fc2mp4.exe`, and the link in quotes. The video goes to
`Videos\Fightcade` in your user folder.

fc2mp4 looks for Fightcade in `Documents\Fightcade` (also under OneDrive), `%USERPROFILE%\Fightcade`,
`C:\Fightcade` and `%LOCALAPPDATA%\Programs\Fightcade`. If yours is elsewhere, pass the Fightcade
folder (the one that contains `emulator\fbneo\fcadefbneo.exe`) with `--fightcade-dir`:

```powershell
.\fc2mp4.exe "https://replay.fightcade.com/fbneo/garou/1791766846976-7757" --fightcade-dir "D:\Games\Fightcade"
```

To choose where the video goes, add `-o` with a folder or a file name:

```powershell
.\fc2mp4.exe "https://replay.fightcade.com/fbneo/sfa3/1792152118748-6544" --fightcade-dir "D:\Games\Fightcade" -o "$HOME\Desktop\alpha3.mp4"
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
- `--fightcade-dir <path>`: where Fightcade is, when it is not found by itself.
- `--scale sharp|smooth`: upscaling style (default `sharp`).
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

### On a VPS, with HTTPS

Run fc2mp4 on the server's own address only (`127.0.0.1`) and put a web server in front of it for HTTPS
(Caddy, nginx, Apache, Traefik…):

```bash
mkdir -p /srv/fc2mp4/fightcade /srv/fc2mp4/videos && sudo chown 1000:1000 /srv/fc2mp4/videos
docker run -d --name fc2mp4 --restart unless-stopped \
  -p 127.0.0.1:8080:8080 -e TZ=Europe/Paris -e FC2MP4_TRUST_PROXY=1 \
  -v /srv/fc2mp4/fightcade:/fightcade:ro -v /srv/fc2mp4/videos:/videos \
  ghcr.io/coccis77/fc2mp4 serve --keep 7d
```

`/srv/fc2mp4/fightcade` holds a copy of Fightcade's `emulator/fbneo` folder: its DLLs (`ggponet.dll`…) and
the ROMs of the games you want to offer in `ROMs/` (see [Supported games](#supported-games)), and
optionally Fightcade's `emulator/fbneo_roms.json` copied into it, so fc2mp4 can tell which parent or BIOS
files each game needs. Set `TZ` to your time zone (the daily limits reset at midnight).

`FC2MP4_TRUST_PROXY=1` tells fc2mp4 that it is only reachable through the web server in front, so it uses
the visitor's address for the login limit and knows when the connection is HTTPS (secure cookie). Only set
it when the port is published on `127.0.0.1` as above.

What the web server in front must do:

- forward everything to `http://127.0.0.1:8080`, keeping the `Host` header;
- set `X-Forwarded-Proto` (`https`);
- set `X-Forwarded-For` to **the visitor's address only** — never append it to what the visitor sent
  (fc2mp4 reads the first address, so an appended list would let anyone fake theirs and bypass the login limit);
- ideally stream responses instead of buffering them (MP4 downloads of 60 MB and more).

**Caddy** (`/etc/caddy/Caddyfile`; HTTPS certificates are automatic, and Caddy already replaces
`X-Forwarded-For` with the visitor's address):

```
replays.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

**nginx + certbot** (`/etc/nginx/sites-available/fc2mp4`, linked in `sites-enabled`):

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name replays.example.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;    # not $proxy_add_x_forwarded_for
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_read_timeout 300s;
        client_max_body_size 16k;
    }
}
```

then `sudo nginx -t && sudo systemctl reload nginx` and `sudo certbot --nginx -d replays.example.com --redirect`
(certbot adds the HTTPS part and renews the certificate).

Behind another web server, apply the same four rules. Without a domain name, use an SSH tunnel instead of
exposing the page: `ssh -L 8080:127.0.0.1:8080 you@server`, then `http://localhost:8080`.

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
