# fc2mp4 web page (`fc2mp4 serve`) — Design

Date: 2026-10-04
Builds on: v0.6.0 (silent, windowless recording on every platform; Docker image).
Next, separate project: the public version on a VPS (limits, fairness, cleanup).

## 1. Goal and understanding

- **Outcome (user's words):** "a really small page where I can paste a fightcade URL, and the page
  will return a download link or directly a file to save on my computer."
- **Audience now (option C):** the user, maybe a few friends, on the home network — on the PC
  (Docker in WSL) or the Mac. **Later:** public on a VPS; this design must make that a small step
  (same page and queue), but the public protections are out of scope here.
- **Where it lives:** in this project, as a new command of the same program, `fc2mp4 serve`,
  calling the same `convert()` as the CLI. No new dependencies (Node's `http`, one inline HTML page).

### Success criteria

1. `fc2mp4 serve` (native) or the Docker image with `serve` shows a page where pasting a replay link
   (or quark ID) converts it and the browser downloads `<quarkId>.mp4` by itself, with a link to
   download it again.
2. While waiting, the page shows the queue position, then the conversion progress
   ("Converting… 1:12 of replay (×2.8)").
3. One conversion at a time; other requests wait in order. The same replay requested twice never
   converts twice.
4. Errors are shown with fc2mp4's message and hint; the server keeps running.
5. Ctrl-C / `docker stop` stops the current conversion cleanly (no leftovers, as the CLI) and the server.
6. The CLI's other commands behave as before.

## 2. Command

- `fc2mp4 serve [--port <n>] [--host <addr>] [--fightcade-dir <p>] [-v]`
- `--port` default `8080`. `--host` default `127.0.0.1` (this machine only); env `FC2MP4_HOST`
  sets the default (the Docker image sets `FC2MP4_HOST=0.0.0.0`; `-p` decides what is published).
- Startup: locate Fightcade, run the preflight checks, then the same preparation as `prepare`
  (tools, ffmpeg, emulator, Wine). Any failure is printed with its hint and the command exits with
  the usual exit code before listening. Then it prints `Open http://localhost:<port>` (or the host
  given) and logs one line per job event (queued, converting, done, failed).
- Ctrl-C / SIGTERM / SIGHUP: abort the current conversion (existing signal handling), close the
  server, exit 130 (Ctrl-C) as the CLI does.

## 3. HTTP interface

| Route | Answer |
|---|---|
| `GET /` | the page (HTML, inline CSS/JS, no external resources) |
| `POST /api/jobs` body `{"url": "<link or quark ID>"}` | `200 {"id": "<quarkId>"}`; `400 {"error", "hint"}` for an invalid link (same message as the CLI) |
| `GET /api/jobs/<id>` | `{"state":"queued","position":n}` · `{"state":"converting","seconds":s,"speed":x}` · `{"state":"done"}` · `{"state":"failed","error","hint"}`; `404` if unknown |
| `GET /api/jobs/<id>/file` | the MP4, `Content-Type: video/mp4`, `Content-Disposition: attachment; filename="<id>.mp4"`, `Content-Length`; `404` if not done |

- `<id>` must match the quark ID format; anything else is `404` (no path from the request ever
  reaches the file system).
- Any other route: `404`. Request body limited to 4 KB.

## 4. Jobs

- In memory, keyed by quark ID. States: queued → converting → done | failed.
- `POST` with a replay whose MP4 already exists in the output folder → `done` at once (also after a
  restart). Same replay already queued or converting → the existing job. A failed job is replaced by
  a new queued one.
- One worker runs jobs in arrival order, each through `convert()` with output
  `<outputDir>/<quarkId>.mp4`; progress events update `seconds`/`speed`.
- Output folder: the usual default (`FC2MP4_OUTPUT_DIR`, `/videos` in Docker,
  `~/Videos/Fightcade` natively). Files are kept (cleanup belongs to the public version).

## 5. Page

- Title, one text box ("Paste a Fightcade replay link"), a "Convert" button.
- Each submitted link adds a line (newest on top) with its status, refreshed every second:
  "Waiting — 2 replays ahead" / "Converting… 1:12 of replay (×2.8)" / "Done — downloading…" +
  "Download again" link / error + hint.
- When a job turns done, the browser downloads the file once by itself (hidden link click).
- Plain styling, readable on a phone, light and dark mode.

## 6. Testing

- **Unit:** job list (order, joining an existing job, file already on disk, failure then retry,
  progress fields); HTTP routes on a real server on a random port with a fake converter (page,
  create, status, file headers, invalid link, unknown or malformed id, body too large); argument
  parsing for `serve`.
- **Real (Claude, Mac):** `fc2mp4 serve`, then the page in Chrome: paste the short replay, watch
  the status, the file downloads and plays.
- **Real (user, WSL Docker):** image with `serve`, page opened from Windows at
  `http://localhost:8080`, short replay downloaded; two links in a row (queue).

## 7. Out of scope

- Public hosting: rate limits, per-user fairness, replay length limits, cleanup, HTTPS, accounts.
- Persisting the queue across restarts (finished files are still served).
- Cancelling a job from the page.
