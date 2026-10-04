# Review Fixes (v0.9.0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the 17 deferred minor issues the user approved (list in chat, 2026-10-04), test-first.

**Spec:** the approved in-chat list (items 1–17 below keep its numbering). No separate spec file: each item is a small change to existing code; rulings made here are recorded in the ledger.

## Global Constraints

- No new dependencies. Existing behaviour unchanged except for the listed items.
- Each item: failing test first (where code is testable), then the change; `npm test` green; `npx tsc --noEmit -p .` clean.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push or tag without asking.

## Review Focus

1. Serve startup order change (#4): requests arriving while startup runs must not start a conversion before `prepare()` finished (lock contention), and a startup failure must close the port.
2. LAN addresses (#3) inside Docker are the container's, not the host's: never print them there.
3. `prepare` exit codes (#11, #12): Docker builds rely on a non-zero exit when the emulator check fails.
4. Wine prefix reset (#14): `wineserver -k` before deleting must not fail the setup when no wineserver runs.
5. CI (#17): a normal `vX.Y.Z` tag still pushes `:latest`; a `-rc` tag does not.

---

### Task 1: `serve` and the job list (items 3–9, plus `FC2MP4_HOST=""`)

- **#4 port first:** `serve` creates the server and listens *before* `deps.startup()`, attaching the request handler only after startup and the folder check; on any startup error the server is closed and the error rethrown. Test: port in use → rejects with the port message and `startup` was never called. Existing tests keep passing (no `Open` line before startup succeeds).
- **#5 listen errors:** `EACCES` → `Not allowed to use port <n>` (hint: use a port above 1024, e.g. --port 8080); `EADDRNOTAVAIL` / `ENOTFOUND` → `This machine has no address <host>` (hint: use --host 0.0.0.0, or leave --host out). Test: `--host 203.0.113.1` (TEST-NET, never local) → Preflight error with that message.
- **#3 addresses:** `ServeDeps.addresses(): string[]` (default: non-internal IPv4 of `os.networkInterfaces()`, or `[]` when `FC2MP4_DOCKER` is set). When the host is `0.0.0.0` or `::` and addresses exist, the startup prints `Open http://localhost:<port>` and then `Other devices: http://<ip>:<port>` per address. In Docker it prints `Other devices: use this computer's network address, port <port>`. Test: host `0.0.0.0`, addresses `['192.168.1.20']` → both lines.
- **`FC2MP4_HOST=""`:** `parseCli` uses `||` so an empty value means the default `127.0.0.1`. Test.
- **#6 folder hint:** `serve` rethrows the folder error with hint `Make it writable, or set FC2MP4_OUTPUT_DIR to another folder` + ` (in Docker: the folder mounted at /videos must be writable by uid 1000)` only when `FC2MP4_DOCKER` is set; the CLI's own hint keeps `-o` and shows the Docker part only in Docker. Pure helper `notWritableHint(forServe: boolean, inDocker: boolean)` in `src/convert.ts`, tested for the four cases.
- **#7 no forced update:** `prepare(options)` gains `forceUpdate?: boolean` (default `true`, unchanged for `fc2mp4 prepare`); serve's startup passes `false`. Test in `tests/convert.test.ts`: `ensure:false:false` with `forceUpdate: false`.
- **#8 stop race:** `Jobs` gets a `stopped` flag: `submit` after `stop()` marks the job failed (`The server stopped`) without queueing; `drain` stops before taking the next job. Test: `stop()` then `submit(A)` → failed view, no run.
- **#9 oversized body:** as soon as the body exceeds 4 KB, answer 413 with `Connection: close` and destroy the request after the response. Existing 413 test keeps passing; ledger the manual check.

### Task 2: the page (items 1–2)

- **#1:** a finished line reads `Done — the download has started. Download again` the first time, `Done. Download again` afterwards (never "downloading…").
- **#2:** a failed status request is retried up to 5 times, 2 s apart, before `Lost contact with the server (paste the link again to retry)`; a 404 shows `Unknown replay — the server may have restarted (paste the link again)`.
- Tests: the page test keeps checking that the script parses; add checks that the new texts are present and `Done — downloading` is gone. Real check in Chrome in Task 5.

### Task 3: command line (items 10–16)

- **#10:** in `capture`, reaching `--max-duration` before the replay started throws `ConvertError(Recording, 'The replay had not started when --max-duration was reached', 'Use a longer --max-duration')` instead of muxing nothing. Test in `tests/capture.test.ts`.
- **#11:** `prepare` throws Interrupted when the signal is aborted after the emulator step (a fetch abort is turned into a warning inside `ensureEmulator`). Test.
- **#12:** `prepareMessage(result): string | null` in `src/cliArgs.ts`: `Ready (emulator downloaded).` / `Ready.` / `null` when there is a warning (the CLI then prints nothing more and exits 5). Test.
- **#13:** `prepare` takes `debug` and logs the ffmpeg path, whether the emulator was updated, and the Wine step; the CLI passes `debug` with `-v`. Test: debug lines include the ffmpeg path.
- **#14:** `ensureWinePrefix` stops Wine (`wineserver -k`, failures ignored) before deleting the prefix; a delete failure becomes `ConvertError(Emulator, 'Could not reset the Wine environment: <reason>', 'Delete <prefix> and try again')`; the default `removeDir` retries (`maxRetries: 10, retryDelay: 200`). Tests: call order starts `wineserver -k`, `rm`; a throwing `removeDir` gives that error.
- **#15:** the Linux "Fightcade files not found" hint lists the folders checked (including `FC2MP4_FIGHTCADE_DIR`'s value when set). Test.
- **#16:** the stale "virtual display" comment in `src/winePrefix.ts`.

### Task 4: CI and image (item 17)

- `cli.yml`: top-level `permissions: contents: read`; `release` job `permissions: contents: write`; the publish loop pushes `latest` only when the version has no `-`.
- `Dockerfile`: `ENV … FC2MP4_DOCKER=1` (used by #3 and #6).
- Check: YAML parses (ruby), job permissions as stated; `bash scripts/check-image.sh` unaffected.

### Task 5: real checks (Mac)

- `serve` while port 8080 is taken → the port error at once, no startup work.
- `serve --host 0.0.0.0` → `Other devices: http://<LAN IP>:8080` printed.
- Chrome: convert the short replay → `Done — the download has started.`; stop the server during a second conversion → the line retries, then shows the lost-contact message.
- `fc2mp4 prepare` → `Ready.`; `fc2mp4 1791006077129-2245 --max-duration 2s` → the new clear error.
