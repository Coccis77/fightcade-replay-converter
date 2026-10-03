# Fightcade Replay → MP4 Converter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CLI, `fc2mp4 <link-or-quarkId>`, that drives Fightcade's FBNeo emulator to record a Street Fighter III: 3rd Strike replay and produces a 1440×1080 H.264/AAC MP4.

**Architecture:** TypeScript/Node library (`convert()`) with a thin CLI. The emulator is launched with `quark:stream`. A tiny Win32 helper (`fbneo-ctl.exe`, run through Wine on macOS) posts the emulator's own menu commands to start and stop the AVI writer, and holds a fast-forward key. The tool watches the AVI segment(s) to detect the end of the replay, restores the Fightcade config, and has ffmpeg concatenate and re-encode the segments.

**Tech Stack:** Node ≥ 22.12 (ESM), TypeScript 5.9, vitest 5, tsx 4, mingw-w64 (i686) for the C helper, ffmpeg/ffprobe.

**Spec:** `docs/superpowers/specs/2026-10-03-fightcade-replay-to-mp4-design.md`

## Global Constraints

- Only game: `sfiii3nr1`. Any other game in a link → usage error.
- Never request the Fightcade website. Links are parsed as strings only.
- Node `>=22.12` (vitest 5 requirement). ESM (`"type": "module"`), `module`/`moduleResolution` `NodeNext`, so relative imports end in `.js`.
- Output video: 1440×1080, `setsar=1`, `libx264 -preset slow -crf 18 -pix_fmt yuv420p`, AAC 192k, `-movflags +faststart`.
- Default output: `~/Movies/Fightcade/<quarkId>.mp4` (macOS), `%USERPROFILE%\Videos\Fightcade\<quarkId>.mp4` (Windows). `-o` may be a file or an existing directory.
- The only writes inside the Fightcade install: the two patched ini files (`config/fcadefbneo.ini`, `config/games/sfiii3nr1.ini`), each backed up first to `<file>.fc2mp4.bak` and restored after the emulator has been killed; and FBNeo's own AVI output in `fbneo/avi/`, which is deleted afterwards (or moved next to the MP4 with `--keep-avi`).
- Menu command IDs: Record AVI `11827`, Stop recording `11828`. FFWD key: DirectInput scan code `0x46` (Scroll Lock), ini binding `switch 0x46`.
- Timeouts: window 30 s, AVI appears 15 s, first AVI growth 60 s, stall 5 s (wall clock), settle 1 s (max 10 s), poll 500 ms, default `--max-duration` 60 min.
- Ini patches: `bAutoPause 0`, `bAlwaysProcessKeyboardInput 1`, `nAvi3x 1`; with FFWD also `macro "System FFWD" switch 0x46`.
- FBNeo may split recordings into several AVI files. Every unit that handles "the AVI" handles a list of segments ordered by mtime.
- Exit codes: Usage 2, Preflight 3, Busy 4, Emulator 5, Recording 6, Encode 7, Interrupted 130, unexpected 1.

## Review Focus

1. **Ctrl-C or a crash mid-recording**: the user expects their Fightcade config to be exactly as before, no leftover emulator, and no multi-GB AVIs left behind. Pinned by the abort test in Task 11 and the stale-backup and own-binding tests in Task 6.
2. **Real-world link shapes**: trailing slash, query string, surrounding whitespace, `fcade://` scheme, and a link to another game should all parse or fail with a clear message. Pinned by the Task 3 tests.
3. **The user is already playing in Fightcade**: the run must refuse *before* touching any config. Pinned by the "emulator already running" test in Task 11.
4. **Re-running for the same quark, or ffmpeg failing**: a previous MP4 must stay intact and no `.part.mp4` may be left behind. Pinned by the failed-encode test in Task 9.
5. **A bad or expired quark ID**: must fail within about a minute with a clear message, not hang until `--max-duration`. Pinned by the "never started" test in Task 8 and the "emulator exits before stream" test in Task 11.

---

## File Structure

```
native/fbneo-ctl.c        Win32 helper source (window lookup, WM_COMMAND, SendInput)
native/build.sh           mingw build → vendor/fbneo-ctl.exe
vendor/fbneo-ctl.exe      committed prebuilt helper
docs/spike-findings.md    spike results (Task 2)
package.json, tsconfig.json, tsconfig.build.json
src/constants.ts          all magic numbers + spike-derived values
src/errors.ts             ConvertError + ExitCode
src/replayRef.ts          parseReplayRef
src/outputPath.ts         default output dir + -o resolution
src/fsUtil.ts             pathExists, freeBytes, listAvis
src/install.ts            installLayout, locateInstall, preflight
src/iniPatch.ts           pure text edits of FBNeo ini files
src/configPatcher.ts      backup/patch/restore of ini files, emulatorPatches
src/exec.ts               run() child-process helper, which()
src/fbneoCtl.ts           wrapper around fbneo-ctl.exe
src/emulator.ts           emulator command, start, kill, isEmulatorRunning
src/recordingWatcher.ts   waitForNewAvi, waitForEnd, waitForSettle
src/transcoder.ts         ffmpeg args, concat list, transcode()
src/lock.ts               single-instance lock file
src/convert.ts            orchestration + defaultDeps
src/cliArgs.ts            argv parsing, durations, usage text
src/cli.ts                executable entry (signals, progress, exit codes)
tests/*.test.ts           vitest unit tests; tests/e2e.test.ts opt-in
```

---

### Task 1: `fbneo-ctl.exe` Win32 helper

**Files:**
- Create: `native/fbneo-ctl.c`
- Create: `native/build.sh`
- Create: `vendor/fbneo-ctl.exe` (build output, committed)

**Interfaces:**
- Produces the CLI contract used by Task 7:
  `fbneo-ctl.exe list | wait [ms] | title | record | stop | ffwd on|off [scancode]`.
  Exit codes: `0` ok, `1` usage, `2` window not found / timeout, `3` Win32 call failed.
  `title` prints the window title on stdout. `list` prints `hwnd\tpid\tclass\ttitle` per visible top-level window.

- [ ] **Step 1: Install toolchain**

Run: `brew install mingw-w64 ffmpeg`
Expected: `i686-w64-mingw32-gcc --version` and `ffmpeg -version` both print versions.

- [ ] **Step 2: Write the helper source**

`native/fbneo-ctl.c`:

```c
/*
 * fbneo-ctl: drive Fightcade's FBNeo window from the command line.
 * Runs under the same Wine prefix as the emulator (macOS) or natively (Windows).
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MENU_RECORD_AVI 11827
#define MENU_STOP_AVI 11828
#define DEFAULT_FFWD_SCANCODE 0x46
#define TITLE_PREFIX "Fightcade FBNeo"

enum { EXIT_OK = 0, EXIT_USAGE = 1, EXIT_NO_WINDOW = 2, EXIT_FAILED = 3 };

static BOOL CALLBACK listProc(HWND hwnd, LPARAM unused) {
    char title[512];
    char cls[256];
    DWORD pid = 0;
    (void)unused;
    if (!IsWindowVisible(hwnd)) return TRUE;
    GetWindowTextA(hwnd, title, sizeof title);
    GetClassNameA(hwnd, cls, sizeof cls);
    GetWindowThreadProcessId(hwnd, &pid);
    printf("%p\t%lu\t%s\t%s\n", (void *)hwnd, (unsigned long)pid, cls, title);
    return TRUE;
}

static BOOL CALLBACK findProc(HWND hwnd, LPARAM out) {
    char title[512];
    if (!IsWindowVisible(hwnd)) return TRUE;
    GetWindowTextA(hwnd, title, sizeof title);
    if (strncmp(title, TITLE_PREFIX, strlen(TITLE_PREFIX)) == 0) {
        *(HWND *)out = hwnd;
        return FALSE;
    }
    return TRUE;
}

static HWND findWindow(void) {
    HWND found = NULL;
    EnumWindows(findProc, (LPARAM)&found);
    return found;
}

static int usage(void) {
    fprintf(stderr, "usage: fbneo-ctl list | wait [ms] | title | record | stop | ffwd on|off [scancode]\n");
    return EXIT_USAGE;
}

static int sendMenu(WORD id) {
    HWND hwnd = findWindow();
    if (!hwnd) {
        fprintf(stderr, "FBNeo window not found\n");
        return EXIT_NO_WINDOW;
    }
    if (!PostMessageA(hwnd, WM_COMMAND, MAKEWPARAM(id, 0), 0)) {
        fprintf(stderr, "PostMessage failed: %lu\n", (unsigned long)GetLastError());
        return EXIT_FAILED;
    }
    return EXIT_OK;
}

static int sendKey(WORD scancode, BOOL up) {
    INPUT input;
    ZeroMemory(&input, sizeof input);
    input.type = INPUT_KEYBOARD;
    input.ki.wScan = scancode;
    input.ki.dwFlags = KEYEVENTF_SCANCODE | (up ? KEYEVENTF_KEYUP : 0);
    if (SendInput(1, &input, sizeof input) != 1) {
        fprintf(stderr, "SendInput failed: %lu\n", (unsigned long)GetLastError());
        return EXIT_FAILED;
    }
    return EXIT_OK;
}

static int waitForWindow(DWORD timeoutMs) {
    DWORD start = GetTickCount();
    while (!findWindow()) {
        if (GetTickCount() - start >= timeoutMs) {
            fprintf(stderr, "timed out waiting for FBNeo window\n");
            return EXIT_NO_WINDOW;
        }
        Sleep(200);
    }
    return EXIT_OK;
}

static int printTitle(void) {
    char title[512];
    HWND hwnd = findWindow();
    if (!hwnd) return EXIT_NO_WINDOW;
    GetWindowTextA(hwnd, title, sizeof title);
    printf("%s\n", title);
    return EXIT_OK;
}

int main(int argc, char **argv) {
    const char *cmd;
    if (argc < 2) return usage();
    cmd = argv[1];
    if (strcmp(cmd, "list") == 0) {
        EnumWindows(listProc, 0);
        return EXIT_OK;
    }
    if (strcmp(cmd, "wait") == 0) return waitForWindow(argc > 2 ? strtoul(argv[2], NULL, 10) : 30000);
    if (strcmp(cmd, "title") == 0) return printTitle();
    if (strcmp(cmd, "record") == 0) return sendMenu(MENU_RECORD_AVI);
    if (strcmp(cmd, "stop") == 0) return sendMenu(MENU_STOP_AVI);
    if (strcmp(cmd, "ffwd") == 0 && argc >= 3) {
        WORD scancode = (WORD)(argc > 3 ? strtoul(argv[3], NULL, 0) : DEFAULT_FFWD_SCANCODE);
        if (strcmp(argv[2], "on") == 0) return sendKey(scancode, FALSE);
        if (strcmp(argv[2], "off") == 0) return sendKey(scancode, TRUE);
    }
    return usage();
}
```

- [ ] **Step 3: Write the build script**

`native/build.sh`:

```sh
#!/bin/sh
# Builds the 32-bit helper (Fightcade's Wine prefix is win32).
set -eu
cd "$(dirname "$0")/.."
mkdir -p vendor
i686-w64-mingw32-gcc -O2 -s -Wall -Wextra -o vendor/fbneo-ctl.exe native/fbneo-ctl.c -luser32
echo "built vendor/fbneo-ctl.exe"
```

Run: `chmod +x native/build.sh && native/build.sh`
Expected: `built vendor/fbneo-ctl.exe`, no warnings.

- [ ] **Step 4: Smoke-test without the emulator**

Run (from the repo root):
```sh
W=/Applications/FightCade2.app/Contents/Resources/wine.sh
$W "$PWD/vendor/fbneo-ctl.exe" wait 1000; echo "exit=$?"
$W "$PWD/vendor/fbneo-ctl.exe" bogus; echo "exit=$?"
```
Expected: `timed out waiting for FBNeo window` then `exit=2`; usage line then `exit=1`.

- [ ] **Step 5: Smoke-test against a running emulator**

Run in terminal A: `cd /Applications/FightCade2.app/Contents/MacOS/emulator/fbneo && /Applications/FightCade2.app/Contents/Resources/wine.sh fcadefbneo.exe sfiii3nr1`
Run in terminal B (repo root):
```sh
W=/Applications/FightCade2.app/Contents/Resources/wine.sh
AVI=/Applications/FightCade2.app/Contents/MacOS/emulator/fbneo/avi
$W "$PWD/vendor/fbneo-ctl.exe" wait 30000; echo "exit=$?"
$W "$PWD/vendor/fbneo-ctl.exe" list
$W "$PWD/vendor/fbneo-ctl.exe" title
$W "$PWD/vendor/fbneo-ctl.exe" record; sleep 5; ls -la "$AVI"
$W "$PWD/vendor/fbneo-ctl.exe" stop; ls -la "$AVI"
```
Expected: `exit=0`; `list` shows a row whose title starts with `Fightcade FBNeo`; `title` prints it; a new `.avi` appears in `avi/` after `record` and stops growing after `stop`. If `record` produces no file or a dialog appears, note it for Task 2 (do not change the plan yet). Close the emulator and delete the test AVI.

- [ ] **Step 6: Commit**

```bash
git add native/ vendor/fbneo-ctl.exe
git commit -m "feat: add fbneo-ctl Win32 helper to drive the FBNeo window"
```

---

### Task 2: Feasibility spike (interactive, gate)

This task needs the user: the Fightcade client, a real replay, and observation of the emulator window. **Run it in the main session, not in a subagent.** Scripts written here are throwaway. Only `docs/spike-findings.md` and the spec update are kept.

**Files:**
- Create: `docs/spike-findings.md`
- Modify: `docs/superpowers/specs/2026-10-03-fightcade-replay-to-mp4-design.md` (§2, §6, §9)

**Interfaces:**
- Produces the values consumed by `src/constants.ts` (Task 3) and `emulatorCommand` (Task 7): `STREAM_PORT`, the emulator argument list, `WINDOW_TITLE_PREFIX`, `RECORD_DELAY_MS`, `END_TITLE_PATTERN`, `FFWD_SUPPORTED`, `MIN_FREE_BYTES`, the AVI segment naming, and the kill method.

- [ ] **Step 1: Get test replays from the user**

Ask the user for (a) a short 3rd Strike replay link (under 3 minutes) and (b) a long one (over 5 minutes, which is enough to cross a 2 GB uncompressed AVI split).

- [ ] **Step 2: Capture the client's exact emulator command line**

Ask the user to open replay (a) from the Fightcade client. While it plays, run:
`ps -axww -o pid,command | grep -i '[f]cadefbneo'`
Record the full argument list (port, whether the game name is passed separately, the working directory). Then close the replay.

- [ ] **Step 3: Launch the stream without the client**

Quit the Fightcade client completely. Then run, using the arguments from Step 2:
```sh
cd /Applications/FightCade2.app/Contents/MacOS/emulator/fbneo
/Applications/FightCade2.app/Contents/Resources/wine.sh fcadefbneo.exe <args from step 2>
```
Record: does the replay play with the client closed? If not, record what is needed (client running? `fcade.sh fcade://...`?) and **stop and discuss with the user**.

- [ ] **Step 4: Patch the inis by hand (keep backups)**

```sh
cd /Applications/FightCade2.app/Contents/MacOS/emulator/fbneo/config
cp fcadefbneo.ini /tmp/fcadefbneo.ini.orig && cp games/sfiii3nr1.ini /tmp/sfiii3nr1.ini.orig
sed -i '' -e 's/^bAutoPause .*/bAutoPause 0/' -e 's/^bAlwaysProcessKeyboardInput .*/bAlwaysProcessKeyboardInput 1/' fcadefbneo.ini
sed -i '' -e 's/^macro  "System FFWD" .*/macro  "System FFWD"      switch 0x46/' games/sfiii3nr1.ini
grep -nE '^(bAutoPause|bAlwaysProcessKeyboardInput|nAvi3x)' fcadefbneo.ini; grep -n 'System FFWD' games/sfiii3nr1.ini
```

- [ ] **Step 5: Record, codec, timing**

Launch replay (a) as in Step 3. In another terminal (repo root), with `W=.../wine.sh` and `CTL="$PWD/vendor/fbneo-ctl.exe"`:
1. `$W "$CTL" wait 30000 && $W "$CTL" record` immediately after launch, then again on a second run about 5 s after the gameplay appears. Note which run captures the start of the match and whether lead-in (connection/black) frames are captured.
2. `ffprobe -v error -show_streams -show_format <avi>`: record the video codec, resolution, fps, audio format, and file bytes per second of capture.

- [ ] **Step 6: Fast-forward**

Run replay (a) again: `record`, then `$W "$CTL" ffwd on`, unfocus the emulator window, and time the wall clock until the replay ends. Then:
```sh
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames,avg_frame_rate -of default=nw=1 <avi>
ffmpeg -v info -i <avi> -af silencedetect=n=-50dB:d=1 -f null - 2>&1 | grep silence_
```
Record: is fast-forward visible while unfocused? Does `frames / 59.6` ≈ the in-game duration? Is the audio continuous (no silences besides genuine game silence; listen to a stretch)? What is the speedup factor (in-game duration ÷ wall time)? Set `FFWD_SUPPORTED = false` if any of these fail.

- [ ] **Step 7: End of replay**

While replay (a) runs to the end, poll in a loop:
```sh
while true; do date +%T; $W "$CTL" title; ls -l <avi dir>; sleep 2; done
```
Record what happens at the end: process exits? title changes (to what text)? AVI stops growing, or keeps growing with frozen frames? Choose `END_TITLE_PATTERN` (a RegExp) if the title gives a reliable signal, else `null`.

- [ ] **Step 8: Segments and kill**

Run replay (b) with `--no-ffwd` behaviour (no `ffwd on`). Record whether more than one AVI file is produced, their names, and their sizes. Then verify the kill method: `$W taskkill /IM fcadefbneo.exe /F; echo $?` and check `pgrep -f fcadefbneo.exe` returns nothing.

- [ ] **Step 9: Restore the inis**

```sh
cd /Applications/FightCade2.app/Contents/MacOS/emulator/fbneo/config
cp /tmp/fcadefbneo.ini.orig fcadefbneo.ini && cp /tmp/sfiii3nr1.ini.orig games/sfiii3nr1.ini
```

- [ ] **Step 10: Write `docs/spike-findings.md`**

Use this structure, filled with the observed values:

```markdown
# Spike findings (YYYY-MM-DD)

| Constant / question | Value | Evidence |
|---|---|---|
| Emulator args | `quark:stream,sfiii3nr1,<id>,<port>` (or the observed list) | ps output |
| STREAM_PORT | … | ps output |
| Works without client running | yes/no | step 3 |
| WINDOW_TITLE_PREFIX | `Fightcade FBNeo` | `title` output |
| RECORD_DELAY_MS | 0 or N | step 5 |
| AVI codec / size / fps / audio | … | ffprobe |
| AVI bytes per second | … | step 5 |
| MIN_FREE_BYTES | AVI bytes/s × 1800 (30 min), rounded up to GB | computed |
| AVI segment naming / split size | … | step 8 |
| FFWD_SUPPORTED | true/false | step 6 |
| FFWD speedup | ×N | step 6 |
| End-of-replay behaviour | exit / title / freeze | step 7 |
| END_TITLE_PATTERN | `/…/` or null | step 7 |
| Kill method | `wine.sh taskkill /IM fcadefbneo.exe /F` works? | step 8 |
| Dead time in output (lead-in / tail) | seconds | steps 5, 7 |
```

- [ ] **Step 11: Update the spec and commit**

Update spec §2 (move the resolved unknowns into verified facts), §6 (the chosen end signal), and §9 (mark as done, link the findings). Then:
```bash
git add docs/spike-findings.md docs/superpowers/specs/2026-10-03-fightcade-replay-to-mp4-design.md
git commit -m "docs: record feasibility spike findings"
```

- [ ] **Step 12: GATE**

Continue to Task 3 only if all of these hold: the stream works without the client (or with an automatable workaround), `record`/`stop` produce a valid AVI, and the end of a replay is detectable (exit, title, or stall). Otherwise **stop and present the findings to the user**. The plan needs revising. `FFWD_SUPPORTED = false` does not block (v1 falls back to real time). If the findings show dead time of more than about 2 s in the output, tell the user and propose adding `blackdetect`/`freezedetect` trimming as an extra task after Task 9.

---

### Task 3: Project scaffold, errors, constants, `parseReplayRef`

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`
- Create: `src/errors.ts`, `src/constants.ts`, `src/replayRef.ts`
- Test: `tests/replayRef.test.ts`
- Modify: `.gitignore` (already ignores `node_modules/`, `dist/`; no change expected)

**Interfaces:**
- Produces:
  - `ExitCode` (`Usage 2, Preflight 3, Busy 4, Emulator 5, Recording 6, Encode 7, Interrupted 130`), `type ExitCodeValue`, `class ConvertError(exitCode, message, hint?)`
  - constants: `GAME`, `MENU_RECORD_AVI`, `MENU_STOP_AVI`, `FFWD_SCANCODE`, `FFWD_INI_BINDING`, `WINDOW_TITLE_PREFIX`, `STREAM_PORT`, `RECORD_DELAY_MS`, `END_TITLE_PATTERN: RegExp | null`, `FFWD_SUPPORTED`, `MIN_FREE_BYTES`, `TIMEOUTS`, `DEFAULT_MAX_DURATION_MS`, `BACKUP_SUFFIX`
  - `interface ReplayRef { game: 'sfiii3nr1'; quarkId: string }`, `parseReplayRef(input: string): ReplayRef`

- [ ] **Step 1: Ensure Node ≥ 22.12**

Run: `node --version`. If it is below `v22.12`, install Node 22 (`brew install node@22` and follow brew's PATH instructions, or `nvm install 22 && nvm use 22`). Re-check `node --version`.

- [ ] **Step 2: Create the package files**

`package.json`:
```json
{
  "name": "fc2mp4",
  "version": "0.1.0",
  "description": "Convert Fightcade Street Fighter III: 3rd Strike replays to MP4",
  "type": "module",
  "bin": { "fc2mp4": "dist/cli.js" },
  "files": ["dist", "vendor"],
  "engines": { "node": ">=22.12" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "dev": "tsx src/cli.ts"
  },
  "devDependencies": {
    "@types/node": "^22.20.0",
    "tsx": "^4.23.0",
    "typescript": "^5.9.3",
    "vitest": "^5.0.3"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`tsconfig.build.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

Run: `npm install`
Expected: installs without errors.

- [ ] **Step 3: Write `src/errors.ts` and `src/constants.ts`**

`src/errors.ts`:
```ts
export const ExitCode = {
  Usage: 2,
  Preflight: 3,
  Busy: 4,
  Emulator: 5,
  Recording: 6,
  Encode: 7,
  Interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class ConvertError extends Error {
  constructor(
    readonly exitCode: ExitCodeValue,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ConvertError';
  }
}
```

`src/constants.ts`: copy the spike values from `docs/spike-findings.md` over the defaults below and keep the comments pointing at the evidence:
```ts
export const GAME = 'sfiii3nr1';

// FBNeo menu command IDs (RT_MENU resources of fcadefbneo.exe).
export const MENU_RECORD_AVI = 11827;
export const MENU_STOP_AVI = 11828;

// "System FFWD" is bound to Scroll Lock (DirectInput DIK_SCROLL) while we run.
export const FFWD_SCANCODE = 0x46;
export const FFWD_INI_BINDING = 'switch 0x46';

// Values below come from docs/spike-findings.md.
export const WINDOW_TITLE_PREFIX = 'Fightcade FBNeo';
export const STREAM_PORT = 7100;
export const RECORD_DELAY_MS = 0;
export const END_TITLE_PATTERN: RegExp | null = null;
export const FFWD_SUPPORTED = true;
export const MIN_FREE_BYTES = 30 * 1024 ** 3;

export const TIMEOUTS = {
  windowMs: 30_000,
  aviAppearMs: 15_000,
  firstGrowthMs: 60_000,
  stallMs: 5_000,
  settleMs: 1_000,
  settleTimeoutMs: 10_000,
  pollMs: 500,
} as const;

export const DEFAULT_MAX_DURATION_MS = 60 * 60_000;
export const BACKUP_SUFFIX = '.fc2mp4.bak';
```

- [ ] **Step 4: Write the failing tests**

`tests/replayRef.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseReplayRef } from '../src/replayRef.js';
import { ConvertError, ExitCode } from '../src/errors.js';

const ID = '1700000000000-1234';

describe('parseReplayRef', () => {
  it.each([
    [ID],
    [`  ${ID}\n`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}/`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}?t=42#x`],
    [`fcade://play/fbneo/sfiii3nr1/${ID}`],
  ])('accepts %j', (input) => {
    expect(parseReplayRef(input)).toEqual({ game: 'sfiii3nr1', quarkId: ID });
  });

  it('rejects another game with a message naming it', () => {
    const run = () => parseReplayRef(`https://replay.fightcade.com/fbneo/garou/${ID}`);
    expect(run).toThrow(ConvertError);
    expect(run).toThrow(/garou/);
    try {
      run();
    } catch (err) {
      expect((err as ConvertError).exitCode).toBe(ExitCode.Usage);
    }
  });

  it.each([[''], ['hello'], ['https://replay.fightcade.com/'], ['1700000000000']])(
    'rejects %j as not a replay',
    (input) => {
      expect(() => parseReplayRef(input)).toThrow(/Not a Fightcade replay/);
    },
  );
});
```

- [ ] **Step 5: Run the tests and watch them fail**

Run: `npx vitest run tests/replayRef.test.ts`
Expected: FAIL, cannot resolve `../src/replayRef.js`.

- [ ] **Step 6: Implement `src/replayRef.ts`**

```ts
import { GAME } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';

export interface ReplayRef {
  game: typeof GAME;
  quarkId: string;
}

const BARE_ID = /^\d+-\d+$/;
const IN_LINK = /\/([A-Za-z0-9_]+)\/(\d+-\d+)(?=[/?#]|$)/;

export function parseReplayRef(input: string): ReplayRef {
  const value = input.trim();
  if (BARE_ID.test(value)) return { game: GAME, quarkId: value };

  const match = IN_LINK.exec(value);
  if (!match) {
    throw new ConvertError(
      ExitCode.Usage,
      `Not a Fightcade replay link or quark ID: "${value}"`,
      `Expected e.g. https://replay.fightcade.com/fbneo/${GAME}/1700000000000-1234 or 1700000000000-1234`,
    );
  }
  const [, game, quarkId] = match;
  if (game !== GAME) {
    throw new ConvertError(ExitCode.Usage, `Unsupported game "${game}": only ${GAME} (3rd Strike) is supported`);
  }
  return { game: GAME, quarkId };
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run tests/replayRef.test.ts && npm run typecheck`
Expected: all tests PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json src tests
git commit -m "feat: scaffold project and parse replay links"
```

---

### Task 4: Output path resolution

**Files:**
- Create: `src/outputPath.ts`
- Test: `tests/outputPath.test.ts`

**Interfaces:**
- Produces:
  - `interface OutputEnv { platform: NodeJS.Platform; home: string; env: Record<string, string | undefined> }`
  - `defaultOutputDir(info: OutputEnv): string`
  - `resolveOutputPath(quarkId: string, output: string | undefined, info: OutputEnv, isDir?: (p: string) => Promise<boolean>): Promise<string>` (does not create directories and does not make the path absolute)

- [ ] **Step 1: Write the failing tests**

`tests/outputPath.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { defaultOutputDir, resolveOutputPath, type OutputEnv } from '../src/outputPath.js';

const mac: OutputEnv = { platform: 'darwin', home: '/Users/fran', env: {} };
const win: OutputEnv = { platform: 'win32', home: 'C:\\Users\\fran', env: { USERPROFILE: 'C:\\Users\\fran' } };
const never = async () => false;

describe('defaultOutputDir', () => {
  it('uses ~/Movies/Fightcade on macOS', () => {
    expect(defaultOutputDir(mac)).toBe('/Users/fran/Movies/Fightcade');
  });
  it('uses %USERPROFILE%\\Videos\\Fightcade on Windows', () => {
    expect(defaultOutputDir(win)).toBe('C:\\Users\\fran\\Videos\\Fightcade');
  });
});

describe('resolveOutputPath', () => {
  it('defaults to <videos>/Fightcade/<quarkId>.mp4', async () => {
    expect(await resolveOutputPath('1-2', undefined, mac, never)).toBe('/Users/fran/Movies/Fightcade/1-2.mp4');
  });
  it('treats an existing directory as the target folder', async () => {
    const isDir = async (p: string) => p === '/tmp/out';
    expect(await resolveOutputPath('1-2', '/tmp/out', mac, isDir)).toBe('/tmp/out/1-2.mp4');
  });
  it('treats a trailing separator as a folder even if it does not exist yet', async () => {
    expect(await resolveOutputPath('1-2', '/tmp/new/', mac, never)).toBe('/tmp/new/1-2.mp4');
  });
  it('keeps an explicit file path', async () => {
    expect(await resolveOutputPath('1-2', '/tmp/final.mp4', mac, never)).toBe('/tmp/final.mp4');
  });
  it('uses Windows separators on Windows', async () => {
    const isDir = async (p: string) => p === 'D:\\clips';
    expect(await resolveOutputPath('1-2', 'D:\\clips', win, isDir)).toBe('D:\\clips\\1-2.mp4');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/outputPath.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/outputPath.ts`**

```ts
import path from 'node:path';
import { stat } from 'node:fs/promises';

export interface OutputEnv {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
}

function pathFor(platform: NodeJS.Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function defaultOutputDir({ platform, home, env }: OutputEnv): string {
  const p = pathFor(platform);
  if (platform === 'darwin') return p.join(home, 'Movies', 'Fightcade');
  if (platform === 'win32') return p.join(env.USERPROFILE ?? home, 'Videos', 'Fightcade');
  return p.join(home, 'Videos', 'Fightcade');
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export async function resolveOutputPath(
  quarkId: string,
  output: string | undefined,
  info: OutputEnv,
  isDir: (p: string) => Promise<boolean> = isDirectory,
): Promise<string> {
  const p = pathFor(info.platform);
  const fileName = `${quarkId}.mp4`;
  if (output === undefined) return p.join(defaultOutputDir(info), fileName);
  if (output.endsWith('/') || output.endsWith(p.sep) || (await isDir(output))) return p.join(output, fileName);
  return output;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/outputPath.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/outputPath.ts tests/outputPath.test.ts
git commit -m "feat: resolve MP4 output path per OS"
```

---

### Task 5: Fightcade install discovery and preflight

**Files:**
- Create: `src/fsUtil.ts`, `src/install.ts`
- Test: `tests/install.test.ts`

**Interfaces:**
- Consumes: `GAME`, `MIN_FREE_BYTES` (Task 3), `ConvertError`, `ExitCode`.
- Produces:
  - `fsUtil`: `pathExists(p): Promise<boolean>`, `freeBytes(dir): Promise<number>`, `interface AviFile { path: string; size: number; mtimeMs: number }`, `listAvis(dir): Promise<AviFile[]>`
  - `install`: `type SupportedPlatform = 'darwin' | 'win32'`;
    `interface FightcadeInstall { platform: SupportedPlatform; root: string; fbneoDir: string; exe: string; mainIni: string; gameIni: string; aviDir: string; rom: string; wineSh: string | null }`;
    `installLayout(root, platform): FightcadeInstall`;
    `candidateRoots(platform, home, env): string[]`;
    `locateInstall(opts: { platform: NodeJS.Platform; home: string; env: Record<string, string | undefined>; override?: string; exists: (p: string) => Promise<boolean> }): Promise<FightcadeInstall>`;
    `interface PreflightDeps { exists(p: string): Promise<boolean>; which(cmd: string): Promise<string | null>; freeBytes(dir: string): Promise<number> }`;
    `preflight(install, deps): Promise<void>`

- [ ] **Step 1: Write the failing tests**

`tests/install.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { installLayout, locateInstall, preflight, type PreflightDeps } from '../src/install.js';
import { ConvertError, ExitCode } from '../src/errors.js';
import { MIN_FREE_BYTES } from '../src/constants.js';

const MAC_ROOT = '/Applications/FightCade2.app';

describe('installLayout', () => {
  it('maps the macOS app bundle', () => {
    const i = installLayout(MAC_ROOT, 'darwin');
    expect(i.fbneoDir).toBe(`${MAC_ROOT}/Contents/MacOS/emulator/fbneo`);
    expect(i.exe).toBe(`${i.fbneoDir}/fcadefbneo.exe`);
    expect(i.mainIni).toBe(`${i.fbneoDir}/config/fcadefbneo.ini`);
    expect(i.gameIni).toBe(`${i.fbneoDir}/config/games/sfiii3nr1.ini`);
    expect(i.aviDir).toBe(`${i.fbneoDir}/avi`);
    expect(i.rom).toBe(`${i.fbneoDir}/ROMs/sfiii3nr1.zip`);
    expect(i.wineSh).toBe(`${MAC_ROOT}/Contents/Resources/wine.sh`);
  });
  it('maps a Windows folder', () => {
    const i = installLayout('C:\\Fightcade', 'win32');
    expect(i.exe).toBe('C:\\Fightcade\\emulator\\fbneo\\fcadefbneo.exe');
    expect(i.wineSh).toBeNull();
  });
});

describe('locateInstall', () => {
  const home = '/Users/fran';
  it('finds the first candidate that has fcadefbneo.exe', async () => {
    const exists = async (p: string) => p === `${home}/Applications/FightCade2.app/Contents/MacOS/emulator/fbneo/fcadefbneo.exe`;
    const i = await locateInstall({ platform: 'darwin', home, env: {}, exists });
    expect(i.root).toBe(`${home}/Applications/FightCade2.app`);
  });
  it('uses --fightcade-dir and explains when it is wrong', async () => {
    const promise = locateInstall({ platform: 'darwin', home, env: {}, override: '/nope', exists: async () => false });
    await expect(promise).rejects.toMatchObject({ exitCode: ExitCode.Preflight, hint: expect.stringContaining('/nope') });
  });
  it('rejects unsupported platforms', async () => {
    await expect(locateInstall({ platform: 'linux', home, env: {}, exists: async () => true })).rejects.toBeInstanceOf(ConvertError);
  });
});

describe('preflight', () => {
  const install = installLayout(MAC_ROOT, 'darwin');
  const ok: PreflightDeps = {
    exists: async () => true,
    which: async () => '/opt/homebrew/bin/ffmpeg',
    freeBytes: async () => MIN_FREE_BYTES,
  };

  it('passes when everything is present', async () => {
    await expect(preflight(install, ok)).resolves.toBeUndefined();
  });
  it.each([
    ['ROM', { exists: async (p: string) => !p.endsWith('sfiii3nr1.zip') }, /ROM not found/],
    ['game ini', { exists: async (p: string) => !p.endsWith('sfiii3nr1.ini') }, /game config not found/],
    ['wine.sh', { exists: async (p: string) => !p.endsWith('wine.sh') }, /wine\.sh not found/],
    ['ffmpeg', { which: async () => null }, /ffmpeg not found/],
    ['disk space', { freeBytes: async () => MIN_FREE_BYTES - 1 }, /free disk space/],
  ])('fails when %s is missing', async (_name, override, message) => {
    const promise = preflight(install, { ...ok, ...override });
    await expect(promise).rejects.toMatchObject({ exitCode: ExitCode.Preflight, message: expect.stringMatching(message) });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/install.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/fsUtil.ts`**

```ts
import { access, readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return s.bavail * s.bsize;
}

export interface AviFile {
  path: string;
  size: number;
  mtimeMs: number;
}

export async function listAvis(dir: string): Promise<AviFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const files = await Promise.all(
    names
      .filter((name) => /\.avi$/i.test(name))
      .map(async (name): Promise<AviFile | null> => {
        const p = join(dir, name);
        try {
          const s = await stat(p);
          return { path: p, size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          return null;
        }
      }),
  );
  return files.filter((f): f is AviFile => f !== null);
}
```

- [ ] **Step 4: Implement `src/install.ts`**

```ts
import path from 'node:path';
import { GAME, MIN_FREE_BYTES } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';

export type SupportedPlatform = 'darwin' | 'win32';

export interface FightcadeInstall {
  platform: SupportedPlatform;
  root: string;
  fbneoDir: string;
  exe: string;
  mainIni: string;
  gameIni: string;
  aviDir: string;
  rom: string;
  wineSh: string | null;
}

export function installLayout(root: string, platform: SupportedPlatform): FightcadeInstall {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const fbneoDir =
    platform === 'darwin' ? p.join(root, 'Contents', 'MacOS', 'emulator', 'fbneo') : p.join(root, 'emulator', 'fbneo');
  return {
    platform,
    root,
    fbneoDir,
    exe: p.join(fbneoDir, 'fcadefbneo.exe'),
    mainIni: p.join(fbneoDir, 'config', 'fcadefbneo.ini'),
    gameIni: p.join(fbneoDir, 'config', 'games', `${GAME}.ini`),
    aviDir: p.join(fbneoDir, 'avi'),
    rom: p.join(fbneoDir, 'ROMs', `${GAME}.zip`),
    wineSh: platform === 'darwin' ? p.join(root, 'Contents', 'Resources', 'wine.sh') : null,
  };
}

export function candidateRoots(
  platform: SupportedPlatform,
  home: string,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === 'darwin') {
    return ['/Applications/FightCade2.app', path.posix.join(home, 'Applications', 'FightCade2.app')];
  }
  const profile = env.USERPROFILE ?? home;
  return [
    path.win32.join(profile, 'Fightcade'),
    'C:\\Fightcade',
    ...(env.LOCALAPPDATA ? [path.win32.join(env.LOCALAPPDATA, 'Fightcade')] : []),
  ];
}

export async function locateInstall(opts: {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  override?: string;
  exists: (p: string) => Promise<boolean>;
}): Promise<FightcadeInstall> {
  const { platform } = opts;
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new ConvertError(ExitCode.Preflight, `Unsupported platform: ${platform}`, 'fc2mp4 supports macOS and Windows');
  }
  const roots = opts.override ? [opts.override] : candidateRoots(platform, opts.home, opts.env);
  for (const root of roots) {
    const install = installLayout(root, platform);
    if (await opts.exists(install.exe)) return install;
  }
  throw new ConvertError(
    ExitCode.Preflight,
    'Fightcade install not found',
    opts.override
      ? `No emulator/fbneo/fcadefbneo.exe under ${opts.override}`
      : 'Pass --fightcade-dir <path to FightCade2.app or your Fightcade folder>',
  );
}

export interface PreflightDeps {
  exists(p: string): Promise<boolean>;
  which(cmd: string): Promise<string | null>;
  freeBytes(dir: string): Promise<number>;
}

export async function preflight(install: FightcadeInstall, deps: PreflightDeps): Promise<void> {
  if (!(await deps.exists(install.rom))) {
    throw new ConvertError(ExitCode.Preflight, `3rd Strike ROM not found: ${install.rom}`, 'Open 3rd Strike once in Fightcade so it downloads the ROM');
  }
  if (!(await deps.exists(install.gameIni))) {
    throw new ConvertError(ExitCode.Preflight, `3rd Strike game config not found: ${install.gameIni}`, 'Launch 3rd Strike once from Fightcade, then retry');
  }
  if (install.wineSh !== null && !(await deps.exists(install.wineSh))) {
    throw new ConvertError(ExitCode.Preflight, `wine.sh not found: ${install.wineSh}`, 'Reinstall Fightcade');
  }
  if ((await deps.which('ffmpeg')) === null) {
    throw new ConvertError(
      ExitCode.Preflight,
      'ffmpeg not found on PATH',
      install.platform === 'darwin' ? 'brew install ffmpeg' : 'winget install ffmpeg',
    );
  }
  const free = await deps.freeBytes(install.fbneoDir);
  if (free < MIN_FREE_BYTES) {
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
    throw new ConvertError(
      ExitCode.Preflight,
      `Not enough free disk space for the raw recording: ${gb(free)} GB free, ${gb(MIN_FREE_BYTES)} GB needed`,
      'Free some space on the disk that holds Fightcade',
    );
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/install.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/fsUtil.ts src/install.ts tests/install.test.ts
git commit -m "feat: locate Fightcade install and run preflight checks"
```

---

### Task 6: Ini patching with backup and restore

**Files:**
- Create: `src/iniPatch.ts`, `src/configPatcher.ts`
- Test: `tests/configPatcher.test.ts`

**Interfaces:**
- Consumes: `FightcadeInstall` (Task 5), `BACKUP_SUFFIX`, `FFWD_INI_BINDING` (Task 3).
- Produces:
  - `setIniValue(text, key, value): string`, `setMacro(text, name, binding): string`
  - `interface Patch { file: string; transform: (text: string) => string }`
  - `applyPatches(patches: Patch[]): Promise<void>`: copies `file` to `file + BACKUP_SUFFIX` (fails if a backup already exists), then writes the transformed text
  - `restorePatches(files: string[]): Promise<string[]>`: moves each existing backup over its file and returns the restored files (a no-op for files without a backup)
  - `emulatorPatches(install: FightcadeInstall, ffwd: boolean): Patch[]`

- [ ] **Step 1: Write the failing tests**

`tests/configPatcher.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIniValue, setMacro } from '../src/iniPatch.js';
import { applyPatches, emulatorPatches, restorePatches } from '../src/configPatcher.js';
import { installLayout } from '../src/install.js';
import { BACKUP_SUFFIX } from '../src/constants.js';
import { pathExists } from '../src/fsUtil.js';

describe('setIniValue', () => {
  it('replaces an existing key', () => {
    expect(setIniValue('a 1\nbAutoPause 1\nb 2\n', 'bAutoPause', '0')).toBe('a 1\nbAutoPause 0\nb 2\n');
  });
  it('keeps CRLF line endings', () => {
    expect(setIniValue('bAutoPause 1\r\nx 2\r\n', 'bAutoPause', '0')).toBe('bAutoPause 0\r\nx 2\r\n');
  });
  it('appends a missing key', () => {
    expect(setIniValue('a 1\n', 'nAvi3x', '1')).toBe('a 1\nnAvi3x 1\n');
    expect(setIniValue('a 1', 'nAvi3x', '1')).toBe('a 1\nnAvi3x 1\n');
  });
  it('ignores comments and keys that only share a prefix', () => {
    expect(setIniValue('// bAutoPause pauses\nbAutoPause 1\n', 'bAutoPause', '0')).toBe('// bAutoPause pauses\nbAutoPause 0\n');
    expect(setIniValue('nAvi3xFoo 5\n', 'nAvi3x', '1')).toBe('nAvi3xFoo 5\nnAvi3x 1\n');
  });
});

describe('setMacro', () => {
  it('replaces the binding of an existing macro', () => {
    const text = 'macro  "System Pause"     undefined\nmacro  "System FFWD"      undefined\n';
    expect(setMacro(text, 'System FFWD', 'switch 0x46')).toBe(
      'macro  "System Pause"     undefined\nmacro  "System FFWD"  switch 0x46\n',
    );
  });
  it('appends a missing macro', () => {
    expect(setMacro('x\n', 'System FFWD', 'switch 0x46')).toBe('x\nmacro  "System FFWD"  switch 0x46\n');
  });
});

describe('applyPatches / restorePatches', () => {
  let dir: string;
  let file: string;
  const original = 'bAutoPause 1\nmacro  "System FFWD"      switch 0x3B\n';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fc2mp4-ini-'));
    file = join(dir, 'fcadefbneo.ini');
    await writeFile(file, original, 'latin1');
  });

  it('backs up, patches, then restores byte-for-byte', async () => {
    await applyPatches([{ file, transform: (t) => setIniValue(t, 'bAutoPause', '0') }]);
    expect(await readFile(file, 'latin1')).toContain('bAutoPause 0');
    expect(await readFile(file + BACKUP_SUFFIX, 'latin1')).toBe(original);

    expect(await restorePatches([file])).toEqual([file]);
    expect(await readFile(file, 'latin1')).toBe(original);
    expect(await pathExists(file + BACKUP_SUFFIX)).toBe(false);
  });

  it("restores the user's own FFWD binding after our override", async () => {
    await applyPatches([{ file, transform: (t) => setMacro(t, 'System FFWD', 'switch 0x46') }]);
    expect(await readFile(file, 'latin1')).toContain('switch 0x46');
    await restorePatches([file]);
    expect(await readFile(file, 'latin1')).toContain('switch 0x3B');
  });

  it('refuses to overwrite an existing backup (it holds the real original)', async () => {
    await writeFile(file + BACKUP_SUFFIX, 'REAL ORIGINAL', 'latin1');
    await expect(applyPatches([{ file, transform: () => 'patched' }])).rejects.toThrow();
    expect(await readFile(file, 'latin1')).toBe(original);
    expect(await readFile(file + BACKUP_SUFFIX, 'latin1')).toBe('REAL ORIGINAL');
  });

  it('recovers a stale backup left by a crashed run', async () => {
    await writeFile(file, 'patched by a crashed run', 'latin1');
    await writeFile(file + BACKUP_SUFFIX, original, 'latin1');
    expect(await restorePatches([file])).toEqual([file]);
    expect(await readFile(file, 'latin1')).toBe(original);
  });

  it('is a no-op without backups', async () => {
    expect(await restorePatches([file])).toEqual([]);
    expect(await readFile(file, 'latin1')).toBe(original);
  });
});

describe('emulatorPatches', () => {
  const install = installLayout('/Apps/FightCade2.app', 'darwin');

  it('patches both inis when fast-forward is on', () => {
    const patches = emulatorPatches(install, true);
    expect(patches.map((p) => p.file)).toEqual([install.mainIni, install.gameIni]);
    const main = patches[0]!.transform('bAutoPause 1\nbAlwaysProcessKeyboardInput 0\nnAvi3x 3\n');
    expect(main).toBe('bAutoPause 0\nbAlwaysProcessKeyboardInput 1\nnAvi3x 1\n');
    expect(patches[1]!.transform('macro  "System FFWD"      undefined\n')).toBe('macro  "System FFWD"  switch 0x46\n');
  });

  it('only patches the main ini without fast-forward', () => {
    expect(emulatorPatches(install, false).map((p) => p.file)).toEqual([install.mainIni]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/configPatcher.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/iniPatch.ts`**

```ts
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceOrAppend(text: string, pattern: RegExp, line: string): string {
  if (pattern.test(text)) return text.replace(pattern, line);
  if (text === '' || text.endsWith('\n')) return `${text}${line}\n`;
  return `${text}\n${line}\n`;
}

// FBNeo ini lines look like `key value`; `.` stops before \r so CRLF is preserved.
export function setIniValue(text: string, key: string, value: string): string {
  return replaceOrAppend(text, new RegExp(`^${escapeRegExp(key)}[ \\t]+.*$`, 'm'), `${key} ${value}`);
}

export function setMacro(text: string, name: string, binding: string): string {
  return replaceOrAppend(
    text,
    new RegExp(`^macro[ \\t]+"${escapeRegExp(name)}"[ \\t]+.*$`, 'm'),
    `macro  "${name}"  ${binding}`,
  );
}
```

- [ ] **Step 4: Implement `src/configPatcher.ts`**

```ts
import { constants as fsConstants } from 'node:fs';
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises';
import { BACKUP_SUFFIX, FFWD_INI_BINDING } from './constants.js';
import type { FightcadeInstall } from './install.js';
import { setIniValue, setMacro } from './iniPatch.js';

export interface Patch {
  file: string;
  transform: (text: string) => string;
}

// latin1 round-trips every byte, so untouched lines stay byte-identical.
export async function applyPatches(patches: Patch[]): Promise<void> {
  for (const { file, transform } of patches) {
    await copyFile(file, file + BACKUP_SUFFIX, fsConstants.COPYFILE_EXCL);
    const original = await readFile(file, 'latin1');
    await writeFile(file, transform(original), 'latin1');
  }
}

export async function restorePatches(files: string[]): Promise<string[]> {
  const restored: string[] = [];
  for (const file of files) {
    try {
      await rename(file + BACKUP_SUFFIX, file);
      restored.push(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  return restored;
}

export function emulatorPatches(install: FightcadeInstall, ffwd: boolean): Patch[] {
  const main: Patch = {
    file: install.mainIni,
    transform: (text) =>
      [
        ['bAutoPause', '0'],
        ['bAlwaysProcessKeyboardInput', '1'],
        ['nAvi3x', '1'],
      ].reduce((acc, [key, value]) => setIniValue(acc, key!, value!), text),
  };
  if (!ffwd) return [main];
  return [main, { file: install.gameIni, transform: (text) => setMacro(text, 'System FFWD', FFWD_INI_BINDING) }];
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/configPatcher.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/iniPatch.ts src/configPatcher.ts tests/configPatcher.test.ts
git commit -m "feat: patch and restore FBNeo ini files with backups"
```

---

### Task 7: Process helpers, `FbneoCtl`, emulator control

**Files:**
- Create: `src/exec.ts`, `src/fbneoCtl.ts`, `src/emulator.ts`
- Test: `tests/emulator.test.ts`

**Interfaces:**
- Consumes: `FightcadeInstall` (Task 5); `GAME`, `STREAM_PORT`, `FFWD_SCANCODE` (Task 3); `ConvertError`.
- Produces:
  - `exec`: `interface RunResult { code: number | null; stdout: string; stderr: string }`; `type RunFn = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>`; `run: RunFn`; `which(cmd): Promise<string | null>`
  - `fbneoCtl`: `interface FbneoCtl { wait(timeoutMs: number): Promise<void>; record(): Promise<void>; stop(): Promise<void>; ffwd(on: boolean): Promise<void>; title(): Promise<string | null> }`; `helperInvocation(install, helperExe, args)`; `createFbneoCtl(install, helperExe, runFn?): FbneoCtl`
  - `emulator`: `interface Command { command: string; args: string[]; cwd: string }`; `streamArg(quarkId): string`; `emulatorCommand(install, quarkId): Command`; `interface RunningEmulator { readonly exited: boolean; kill(): Promise<void> }`; `startEmulator(install, quarkId, spawnFn?, runFn?): RunningEmulator`; `killEmulator(install, runFn): Promise<void>`; `isEmulatorRunning(platform, runFn): Promise<boolean>`

If `docs/spike-findings.md` shows a different emulator argument list (e.g. the game name passed separately), use that list in `emulatorCommand` and in its tests below.

- [ ] **Step 1: Write the failing tests**

`tests/emulator.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { installLayout } from '../src/install.js';
import { createFbneoCtl, helperInvocation } from '../src/fbneoCtl.js';
import { emulatorCommand, isEmulatorRunning, killEmulator, streamArg } from '../src/emulator.js';
import type { RunFn, RunResult } from '../src/exec.js';
import { ExitCode } from '../src/errors.js';
import { STREAM_PORT } from '../src/constants.js';

const mac = installLayout('/Apps/FightCade2.app', 'darwin');
const win = installLayout('C:\\Fightcade', 'win32');
const HELPER = '/repo/vendor/fbneo-ctl.exe';

function fakeRun(result: Partial<RunResult> = {}) {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const runFn: RunFn = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    return { code: 0, stdout: '', stderr: '', ...result };
  };
  return { calls, runFn };
}

describe('emulatorCommand', () => {
  it('runs through wine.sh from the fbneo folder on macOS', () => {
    expect(emulatorCommand(mac, '1-2')).toEqual({
      command: mac.wineSh,
      args: ['fcadefbneo.exe', `quark:stream,sfiii3nr1,1-2,${STREAM_PORT}`],
      cwd: mac.fbneoDir,
    });
  });
  it('runs the exe directly on Windows', () => {
    expect(emulatorCommand(win, '1-2')).toEqual({ command: win.exe, args: [streamArg('1-2')], cwd: win.fbneoDir });
  });
});

describe('fbneo-ctl', () => {
  it('goes through wine.sh on macOS', () => {
    expect(helperInvocation(mac, HELPER, ['record'])).toEqual({ command: mac.wineSh, args: [HELPER, 'record'], cwd: mac.fbneoDir });
  });
  it('sends ffwd with the scan code', async () => {
    const { calls, runFn } = fakeRun();
    await createFbneoCtl(mac, HELPER, runFn).ffwd(true);
    expect(calls[0]!.args).toEqual([HELPER, 'ffwd', 'on', '0x46']);
  });
  it('turns helper failures into Emulator errors', async () => {
    const { runFn } = fakeRun({ code: 2, stderr: 'FBNeo window not found' });
    await expect(createFbneoCtl(mac, HELPER, runFn).record()).rejects.toMatchObject({
      exitCode: ExitCode.Emulator,
      message: expect.stringContaining('FBNeo window not found'),
    });
  });
  it('returns null when the title cannot be read', async () => {
    const { runFn } = fakeRun({ code: 2 });
    expect(await createFbneoCtl(mac, HELPER, runFn).title()).toBeNull();
  });
});

describe('emulator processes', () => {
  it('detects a running emulator on macOS via pgrep', async () => {
    expect(await isEmulatorRunning('darwin', fakeRun({ code: 0 }).runFn)).toBe(true);
    expect(await isEmulatorRunning('darwin', fakeRun({ code: 1 }).runFn)).toBe(false);
  });
  it('detects a running emulator on Windows via tasklist', async () => {
    expect(await isEmulatorRunning('win32', fakeRun({ stdout: 'fcadefbneo.exe  1234 Console' }).runFn)).toBe(true);
    expect(await isEmulatorRunning('win32', fakeRun({ stdout: 'INFO: No tasks are running' }).runFn)).toBe(false);
  });
  it('kills through Wine taskkill on macOS', async () => {
    const { calls, runFn } = fakeRun();
    await killEmulator(mac, runFn);
    expect(calls[0]).toMatchObject({ cmd: mac.wineSh, args: ['taskkill', '/IM', 'fcadefbneo.exe', '/F'] });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/emulator.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/exec.ts`**

```ts
import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunFn = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>;

export const run: RunFn = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined;
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

export async function which(cmd: string): Promise<string | null> {
  const result = await run(process.platform === 'win32' ? 'where' : 'which', [cmd]).catch(() => null);
  if (!result || result.code !== 0) return null;
  return result.stdout.split(/\r?\n/)[0]!.trim() || null;
}
```

- [ ] **Step 4: Implement `src/fbneoCtl.ts`**

```ts
import { FFWD_SCANCODE } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import { run, type RunFn } from './exec.js';
import type { FightcadeInstall } from './install.js';
import type { Command } from './emulator.js';

export interface FbneoCtl {
  wait(timeoutMs: number): Promise<void>;
  record(): Promise<void>;
  stop(): Promise<void>;
  ffwd(on: boolean): Promise<void>;
  title(): Promise<string | null>;
}

export function helperInvocation(install: FightcadeInstall, helperExe: string, args: string[]): Command {
  if (install.platform === 'darwin') return { command: install.wineSh!, args: [helperExe, ...args], cwd: install.fbneoDir };
  return { command: helperExe, args, cwd: install.fbneoDir };
}

export function createFbneoCtl(install: FightcadeInstall, helperExe: string, runFn: RunFn = run): FbneoCtl {
  async function call(args: string[], timeoutMs = 15_000): Promise<string> {
    const inv = helperInvocation(install, helperExe, args);
    const result = await runFn(inv.command, inv.args, { cwd: inv.cwd, timeoutMs });
    if (result.code !== 0) {
      throw new ConvertError(
        ExitCode.Emulator,
        `fbneo-ctl ${args.join(' ')} failed (exit ${result.code}): ${result.stderr.trim()}`,
      );
    }
    return result.stdout.trim();
  }

  return {
    wait: async (timeoutMs) => {
      await call(['wait', String(timeoutMs)], timeoutMs + 15_000);
    },
    record: async () => {
      await call(['record']);
    },
    stop: async () => {
      await call(['stop']);
    },
    ffwd: async (on) => {
      await call(['ffwd', on ? 'on' : 'off', `0x${FFWD_SCANCODE.toString(16)}`]);
    },
    title: async () => {
      try {
        return await call(['title']);
      } catch {
        return null;
      }
    },
  };
}
```

- [ ] **Step 5: Implement `src/emulator.ts`**

```ts
import { spawn } from 'node:child_process';
import { GAME, STREAM_PORT } from './constants.js';
import { run, type RunFn } from './exec.js';
import type { FightcadeInstall } from './install.js';

export interface Command {
  command: string;
  args: string[];
  cwd: string;
}

export function streamArg(quarkId: string): string {
  return `quark:stream,${GAME},${quarkId},${STREAM_PORT}`;
}

export function emulatorCommand(install: FightcadeInstall, quarkId: string): Command {
  const args = [streamArg(quarkId)];
  if (install.platform === 'darwin') return { command: install.wineSh!, args: ['fcadefbneo.exe', ...args], cwd: install.fbneoDir };
  return { command: install.exe, args, cwd: install.fbneoDir };
}

export interface RunningEmulator {
  readonly exited: boolean;
  kill(): Promise<void>;
}

export function startEmulator(
  install: FightcadeInstall,
  quarkId: string,
  spawnFn: typeof spawn = spawn,
  runFn: RunFn = run,
): RunningEmulator {
  const { command, args, cwd } = emulatorCommand(install, quarkId);
  const child = spawnFn(command, args, { cwd, stdio: 'ignore' });
  let exited = false;
  child.on('exit', () => (exited = true));
  child.on('error', () => (exited = true));
  return {
    get exited() {
      return exited;
    },
    kill: async () => {
      await killEmulator(install, runFn);
      if (!exited) child.kill('SIGKILL');
    },
  };
}

export async function killEmulator(install: FightcadeInstall, runFn: RunFn): Promise<void> {
  if (install.platform === 'darwin') {
    await runFn(install.wineSh!, ['taskkill', '/IM', 'fcadefbneo.exe', '/F'], { cwd: install.fbneoDir, timeoutMs: 15_000 });
  } else {
    await runFn('taskkill', ['/IM', 'fcadefbneo.exe', '/T', '/F'], { timeoutMs: 15_000 });
  }
}

export async function isEmulatorRunning(platform: NodeJS.Platform, runFn: RunFn): Promise<boolean> {
  if (platform === 'win32') {
    const result = await runFn('tasklist', ['/FI', 'IMAGENAME eq fcadefbneo.exe', '/NH']);
    return result.stdout.toLowerCase().includes('fcadefbneo.exe');
  }
  const result = await runFn('pgrep', ['-f', 'fcadefbneo.exe']);
  return result.code === 0;
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/emulator.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/exec.ts src/fbneoCtl.ts src/emulator.ts tests/emulator.test.ts
git commit -m "feat: control the emulator process and fbneo-ctl helper"
```

---

### Task 8: Recording watcher (end-of-replay detection)

**Files:**
- Create: `src/recordingWatcher.ts`
- Test: `tests/recordingWatcher.test.ts`

**Interfaces:**
- Consumes: `ConvertError`, `ExitCode`.
- Produces:
  - `interface Clock { now(): number; sleep(ms: number): Promise<void>; aborted(): boolean }`
  - `waitForNewAvi(listNew: () => Promise<string[]>, clock: Clock, timeoutMs: number, pollMs: number): Promise<string>`
  - `type EndReason = 'emulator-exit' | 'end-signal' | 'stall' | 'max-duration'`
  - `interface EndDeps extends Clock { size(): Promise<number>; emulatorExited(): boolean; endSignal(): Promise<boolean> }` (`size` is the total bytes of all new AVI segments)
  - `interface WaitOptions { stallMs: number; firstGrowthMs: number; maxDurationMs: number; pollMs: number; onProgress?: (bytes: number, elapsedMs: number) => void }`
  - `waitForEnd(deps: EndDeps, opts: WaitOptions): Promise<EndReason>`
  - `waitForSettle(size: () => Promise<number>, clock: Pick<Clock, 'now' | 'sleep'>, settleMs: number, timeoutMs: number, pollMs: number): Promise<void>` (never throws)

- [ ] **Step 1: Write the failing tests**

`tests/recordingWatcher.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { waitForEnd, waitForNewAvi, waitForSettle, type EndDeps } from '../src/recordingWatcher.js';
import { ExitCode } from '../src/errors.js';

const opts = { stallMs: 5_000, firstGrowthMs: 60_000, maxDurationMs: 3_600_000, pollMs: 500 };

// Simulated time advances only when the code under test sleeps.
function fake(sizeAt: (t: number) => number, extra: Partial<EndDeps> = {}) {
  let t = 0;
  const deps: EndDeps = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    aborted: () => false,
    size: async () => sizeAt(t),
    emulatorExited: () => false,
    endSignal: async () => false,
    ...extra,
  };
  return { deps, time: () => t };
}

describe('waitForEnd', () => {
  it('ends on a stall once the AVI stops growing for stallMs', async () => {
    const { deps, time } = fake((t) => 100 + Math.min(t, 10_000));
    await expect(waitForEnd(deps, opts)).resolves.toBe('stall');
    expect(time()).toBe(15_000);
  });

  it('fails within firstGrowthMs when the stream never starts', async () => {
    const { deps, time } = fake(() => 100);
    await expect(waitForEnd(deps, opts)).rejects.toMatchObject({ exitCode: ExitCode.Recording });
    expect(time()).toBe(60_000);
  });

  it('stops at maxDurationMs while still growing', async () => {
    const { deps } = fake((t) => t);
    await expect(waitForEnd(deps, { ...opts, maxDurationMs: 10_000 })).resolves.toBe('max-duration');
  });

  it('ends when the emulator exits after the replay started', async () => {
    let t = 0;
    const { deps } = fake((now) => (t = now));
    await expect(waitForEnd({ ...deps, emulatorExited: () => t >= 2_000 }, opts)).resolves.toBe('emulator-exit');
  });

  it('fails when the emulator exits before the replay started', async () => {
    const { deps } = fake(() => 100, { emulatorExited: () => true });
    await expect(waitForEnd(deps, opts)).rejects.toMatchObject({ exitCode: ExitCode.Emulator });
  });

  it('ends on the emulator end signal', async () => {
    const { deps } = fake((t) => t, { endSignal: async () => true });
    await expect(waitForEnd(deps, opts)).resolves.toBe('end-signal');
  });

  it('throws Interrupted when aborted', async () => {
    const { deps } = fake((t) => t, { aborted: () => true });
    await expect(waitForEnd(deps, opts)).rejects.toMatchObject({ exitCode: ExitCode.Interrupted });
  });

  it('reports progress as the AVI grows', async () => {
    const seen: number[] = [];
    const { deps } = fake((t) => 100 + Math.min(t, 1_000));
    await waitForEnd(deps, { ...opts, onProgress: (bytes) => seen.push(bytes) });
    expect(seen).toEqual([600, 1_100]);
  });
});

describe('waitForNewAvi', () => {
  it('returns the first new file', async () => {
    const { deps } = fake(() => 0);
    let polls = 0;
    const listNew = async () => (++polls >= 3 ? ['/avi/new.avi'] : []);
    await expect(waitForNewAvi(listNew, deps, 15_000, 500)).resolves.toBe('/avi/new.avi');
  });
  it('times out with a Recording error', async () => {
    const { deps, time } = fake(() => 0);
    await expect(waitForNewAvi(async () => [], deps, 15_000, 500)).rejects.toMatchObject({ exitCode: ExitCode.Recording });
    expect(time()).toBe(15_000);
  });
});

describe('waitForSettle', () => {
  it('returns once the size is stable for settleMs', async () => {
    const { deps, time } = fake((t) => Math.min(t, 2_000));
    await waitForSettle(() => deps.size(), deps, 1_000, 10_000, 500);
    expect(time()).toBe(3_000);
  });
  it('gives up silently after timeoutMs', async () => {
    const { deps, time } = fake((t) => t);
    await waitForSettle(() => deps.size(), deps, 1_000, 10_000, 500);
    expect(time()).toBe(10_000);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/recordingWatcher.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/recordingWatcher.ts`**

```ts
import { ConvertError, ExitCode } from './errors.js';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
  aborted(): boolean;
}

function interrupted(): ConvertError {
  return new ConvertError(ExitCode.Interrupted, 'Interrupted');
}

export async function waitForNewAvi(
  listNew: () => Promise<string[]>,
  clock: Clock,
  timeoutMs: number,
  pollMs: number,
): Promise<string> {
  const start = clock.now();
  for (;;) {
    if (clock.aborted()) throw interrupted();
    const [first] = await listNew();
    if (first !== undefined) return first;
    if (clock.now() - start >= timeoutMs) {
      throw new ConvertError(
        ExitCode.Recording,
        'FBNeo did not create an AVI file after the record command',
        'Run with --verbose and check the emulator window for a dialog',
      );
    }
    await clock.sleep(pollMs);
  }
}

export type EndReason = 'emulator-exit' | 'end-signal' | 'stall' | 'max-duration';

export interface EndDeps extends Clock {
  size(): Promise<number>;
  emulatorExited(): boolean;
  endSignal(): Promise<boolean>;
}

export interface WaitOptions {
  stallMs: number;
  firstGrowthMs: number;
  maxDurationMs: number;
  pollMs: number;
  onProgress?: (bytes: number, elapsedMs: number) => void;
}

export async function waitForEnd(deps: EndDeps, opts: WaitOptions): Promise<EndReason> {
  const start = deps.now();
  let lastSize = await deps.size();
  let lastChange = start;
  let started = false;
  for (;;) {
    if (deps.aborted()) throw interrupted();
    if (deps.emulatorExited()) {
      if (started) return 'emulator-exit';
      throw new ConvertError(ExitCode.Emulator, 'The emulator exited before the replay started', 'Check the quark ID; the replay may no longer exist');
    }
    if (await deps.endSignal()) return 'end-signal';

    const now = deps.now();
    const size = await deps.size();
    if (size > lastSize) {
      lastSize = size;
      lastChange = now;
      started = true;
      opts.onProgress?.(size, now - start);
    }
    if (now - start >= opts.maxDurationMs) return 'max-duration';
    if (!started && now - start >= opts.firstGrowthMs) {
      throw new ConvertError(
        ExitCode.Recording,
        'The replay stream never started (the recording is not growing)',
        'Check the quark ID and that Fightcade replay servers are reachable',
      );
    }
    if (started && now - lastChange >= opts.stallMs) return 'stall';
    await deps.sleep(opts.pollMs);
  }
}

export async function waitForSettle(
  size: () => Promise<number>,
  clock: Pick<Clock, 'now' | 'sleep'>,
  settleMs: number,
  timeoutMs: number,
  pollMs: number,
): Promise<void> {
  const start = clock.now();
  let last = await size();
  let lastChange = start;
  while (clock.now() - start < timeoutMs) {
    await clock.sleep(pollMs);
    const current = await size();
    if (current !== last) {
      last = current;
      lastChange = clock.now();
    } else if (clock.now() - lastChange >= settleMs) {
      return;
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/recordingWatcher.test.ts && npm run typecheck`
Expected: PASS. If a timing assertion is off by one poll, re-trace the loop by hand (time only advances in `sleep`) and fix the implementation, not the expected number, unless the trace proves the test wrong.

- [ ] **Step 5: Commit**

```bash
git add src/recordingWatcher.ts tests/recordingWatcher.test.ts
git commit -m "feat: detect replay end from AVI growth, exit and signals"
```

---

### Task 9: Transcoder (AVI segments → MP4)

**Files:**
- Create: `src/transcoder.ts`
- Test: `tests/transcoder.test.ts`

**Interfaces:**
- Consumes: `ConvertError`, `ExitCode`.
- Produces:
  - `type ScaleMode = 'sharp' | 'smooth'`; `VIDEO_FILTERS: Record<ScaleMode, string>`
  - `concatList(files: string[]): string`; `ffmpegArgs(o: { listFile: string; output: string; scale: ScaleMode }): string[]`; `partPath(output: string): string`
  - `interface TranscodeArgs { segments: string[]; output: string; scale: ScaleMode; onProgress?: (seconds: number) => void }`
  - `transcode(args: TranscodeArgs, ffmpeg?: string): Promise<void>`: encodes to `partPath(output)` and renames it on success; on failure removes the part file and leaves any existing `output` untouched

- [ ] **Step 1: Write the failing tests**

`tests/transcoder.test.ts`:
```ts
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { concatList, ffmpegArgs, partPath, transcode } from '../src/transcoder.js';
import { ExitCode } from '../src/errors.js';
import { pathExists } from '../src/fsUtil.js';

const exec = promisify(execFile);
const hasFfmpeg = await exec('ffmpeg', ['-version']).then(() => true, () => false);

describe('ffmpeg arguments', () => {
  it('builds a concat + 1440x1080 H.264/AAC command', () => {
    const args = ffmpegArgs({ listFile: '/t/list.txt', output: '/o/x.part.mp4', scale: 'sharp' });
    expect(args).toEqual([
      '-hide_banner', '-nostats', '-progress', 'pipe:1', '-y',
      '-f', 'concat', '-safe', '0', '-i', '/t/list.txt',
      '-vf', 'scale=iw*4:ih*4:flags=neighbor,scale=1440:1080:flags=lanczos,setsar=1',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
      '/o/x.part.mp4',
    ]);
    expect(ffmpegArgs({ listFile: 'l', output: 'o', scale: 'smooth' })).toContain('scale=1440:1080:flags=lanczos,setsar=1');
  });

  it('quotes segment paths for the concat demuxer', () => {
    expect(concatList(['/a/b.avi', "/a/it's.avi"])).toBe("file '/a/b.avi'\nfile '/a/it'\\''s.avi'\n");
  });

  it('derives a .part.mp4 path', () => {
    expect(partPath('/o/1-2.mp4')).toBe('/o/1-2.part.mp4');
    expect(partPath('/o/clip')).toBe('/o/clip.part.mp4');
  });
});

describe.skipIf(!hasFfmpeg)('transcode (real ffmpeg)', () => {
  async function makeSegment(file: string): Promise<void> {
    await exec('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=384x224:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
      '-t', '1', '-c:v', 'rawvideo', '-pix_fmt', 'bgr24', '-c:a', 'pcm_s16le', file,
    ]);
  }

  it('joins segments into a 1440x1080 h264/aac MP4', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-tx-'));
    const segments = [join(dir, 'a.avi'), join(dir, 'b.avi')];
    for (const s of segments) await makeSegment(s);
    const output = join(dir, 'out.mp4');

    await transcode({ segments, output, scale: 'sharp' });

    const { stdout } = await exec('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,sample_aspect_ratio:format=duration', '-of', 'json', output,
    ]);
    const info = JSON.parse(stdout) as { streams: Record<string, unknown>[]; format: { duration: string } };
    expect(info.streams.find((s) => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: 1440, height: 1080, sample_aspect_ratio: '1:1' });
    expect(info.streams.find((s) => s.codec_type === 'audio')).toMatchObject({ codec_name: 'aac' });
    expect(Number(info.format.duration)).toBeCloseTo(2, 0);
    expect(await pathExists(partPath(output))).toBe(false);
  }, 60_000);

  it('keeps an existing MP4 intact and leaves no part file when ffmpeg fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-tx-'));
    const output = join(dir, 'out.mp4');
    await writeFile(output, 'OLD VIDEO');
    await expect(transcode({ segments: [join(dir, 'missing.avi')], output, scale: 'sharp' })).rejects.toMatchObject({ exitCode: ExitCode.Encode });
    expect(await readFile(output, 'utf8')).toBe('OLD VIDEO');
    expect(await pathExists(partPath(output))).toBe(false);
  }, 60_000);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/transcoder.test.ts`
Expected: FAIL, module not found. (If ffmpeg is not installed, the real-ffmpeg block is skipped. Install it with `brew install ffmpeg` so these tests run.)

- [ ] **Step 3: Implement `src/transcoder.ts`**

```ts
import { spawn } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConvertError, ExitCode } from './errors.js';

export type ScaleMode = 'sharp' | 'smooth';

export const VIDEO_FILTERS: Record<ScaleMode, string> = {
  sharp: 'scale=iw*4:ih*4:flags=neighbor,scale=1440:1080:flags=lanczos,setsar=1',
  smooth: 'scale=1440:1080:flags=lanczos,setsar=1',
};

export function concatList(files: string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'\n`).join('');
}

export function ffmpegArgs({ listFile, output, scale }: { listFile: string; output: string; scale: ScaleMode }): string[] {
  return [
    '-hide_banner', '-nostats', '-progress', 'pipe:1', '-y',
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', VIDEO_FILTERS[scale],
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    output,
  ];
}

export function partPath(output: string): string {
  return `${output.replace(/\.mp4$/i, '')}.part.mp4`;
}

export interface TranscodeArgs {
  segments: string[];
  output: string;
  scale: ScaleMode;
  onProgress?: (seconds: number) => void;
}

export async function transcode(args: TranscodeArgs, ffmpeg = 'ffmpeg'): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-'));
  const listFile = join(dir, 'segments.txt');
  const part = partPath(args.output);
  try {
    await writeFile(listFile, concatList(args.segments));
    await new Promise<void>((resolve, reject) => {
      const child = spawn(ffmpeg, ffmpegArgs({ listFile, output: part, scale: args.scale }), { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4_000)));
      child.stdout.on('data', (d) => {
        // ffmpeg's out_time_ms is in microseconds despite its name.
        const match = /out_time_ms=(\d+)/.exec(String(d));
        if (match) args.onProgress?.(Number(match[1]) / 1e6);
      });
      child.on('error', (err) => reject(new ConvertError(ExitCode.Encode, `Could not run ffmpeg: ${err.message}`)));
      child.on('close', (code) => {
        if (code === 0) return resolve();
        reject(new ConvertError(ExitCode.Encode, `ffmpeg failed (exit ${code})`, stderr.trim().split('\n').slice(-5).join('\n')));
      });
    });
    await rename(part, args.output);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/transcoder.test.ts && npm run typecheck`
Expected: PASS (including the real-ffmpeg block).

- [ ] **Step 5: Commit**

```bash
git add src/transcoder.ts tests/transcoder.test.ts
git commit -m "feat: encode AVI segments to 1440x1080 MP4 with ffmpeg"
```

---

### Task 10: Single-instance lock

**Files:**
- Create: `src/lock.ts`
- Test: `tests/lock.test.ts`

**Interfaces:**
- Produces: `acquireLock(file?: string, isAlive?: (pid: number) => boolean): Promise<() => Promise<void>>` (default file `join(tmpdir(), 'fc2mp4.lock')`); `pidAlive(pid): boolean`

- [ ] **Step 1: Write the failing tests**

`tests/lock.test.ts`:
```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { acquireLock } from '../src/lock.js';
import { ExitCode } from '../src/errors.js';
import { pathExists } from '../src/fsUtil.js';

async function lockFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'fc2mp4-lock-')), 'fc2mp4.lock');
}

describe('acquireLock', () => {
  it('writes our pid and removes the file on release', async () => {
    const file = await lockFile();
    const release = await acquireLock(file);
    expect(await readFile(file, 'utf8')).toBe(String(process.pid));
    await release();
    expect(await pathExists(file)).toBe(false);
  });

  it('refuses while another live process holds it', async () => {
    const file = await lockFile();
    await writeFile(file, '424242');
    await expect(acquireLock(file, () => true)).rejects.toMatchObject({ exitCode: ExitCode.Busy, message: expect.stringContaining('424242') });
  });

  it('takes over a stale lock', async () => {
    const file = await lockFile();
    await writeFile(file, '424242');
    const release = await acquireLock(file, () => false);
    expect(await readFile(file, 'utf8')).toBe(String(process.pid));
    await release();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/lock.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lock.ts`**

```ts
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConvertError, ExitCode } from './errors.js';

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function acquireLock(
  file = join(tmpdir(), 'fc2mp4.lock'),
  isAlive: (pid: number) => boolean = pidAlive,
): Promise<() => Promise<void>> {
  try {
    await writeFile(file, String(process.pid), { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const pid = Number((await readFile(file, 'utf8')).trim());
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
      throw new ConvertError(ExitCode.Busy, `Another fc2mp4 conversion is running (pid ${pid})`, 'Wait for it to finish');
    }
    await rm(file, { force: true });
    await writeFile(file, String(process.pid), { flag: 'wx' });
  }
  return async () => {
    await rm(file, { force: true });
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/lock.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lock.ts tests/lock.test.ts
git commit -m "feat: add single-instance lock"
```

---

### Task 11: `convert()` orchestration and cleanup

**Files:**
- Create: `src/convert.ts`
- Test: `tests/convert.test.ts`

**Interfaces:**
- Consumes: everything above. Exact names: `parseReplayRef`, `emulatorPatches`, `applyPatches`, `restorePatches`, `locateInstall`, `preflight`, `listAvis`, `pathExists`, `freeBytes`, `isEmulatorRunning`, `startEmulator`, `createFbneoCtl`, `run`, `which`, `acquireLock`, `resolveOutputPath`, `transcode`, `waitForNewAvi`, `waitForEnd`, `waitForSettle`, the constants `TIMEOUTS`, `RECORD_DELAY_MS`, `END_TITLE_PATTERN`.
- Produces:
  - `interface ConvertOptions { output?: string; scale: ScaleMode; ffwd: boolean; maxDurationMs: number; fightcadeDir?: string; keepAvi: boolean; signal?: AbortSignal; onProgress?: (e: ProgressEvent) => void; log?: (msg: string) => void; debug?: (msg: string) => void }`
  - `type ProgressEvent = { phase: 'connecting' } | { phase: 'recording'; bytes: number; elapsedMs: number } | { phase: 'encoding'; seconds: number }`
  - `interface ConvertResult { output: string; endReason: EndReason; segments: number }`
  - `interface ConvertDeps` (see code); `defaultDeps(): ConvertDeps`
  - `convert(input: string, options: ConvertOptions, deps?: ConvertDeps): Promise<ConvertResult>`

Ordering rules (these are what the tests pin): preflight and the "emulator already running" check happen before any config change; stale backups are restored before patching; on every exit path the order is ffwd off → stop → settle → kill → restore inis → release lock; encoding happens after the lock is released; new AVIs are always removed (or, with `--keep-avi`, moved next to the MP4 on success and left in place with a log line on failure).

- [ ] **Step 1: Write the failing tests**

`tests/convert.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { convert, type ConvertDeps, type ConvertOptions } from '../src/convert.js';
import { installLayout } from '../src/install.js';
import { ExitCode } from '../src/errors.js';

const install = installLayout('/Apps/FightCade2.app', 'darwin');
const ID = '1700000000000-1234';
const AVI = '/avi/sfiii3nr1_0.avi';
const baseOptions: ConvertOptions = { scale: 'sharp', ffwd: true, maxDurationMs: 3_600_000, keepAvi: false };

// Simulated world: time advances only in sleep(); the AVI grows 1 KB per ms from record until growsUntil.
function harness(
  world: { emulatorRunning?: boolean; growsUntil?: number; emulatorExitsAt?: number; existingAvi?: string } = {},
) {
  const calls: string[] = [];
  let t = 0;
  let recordedAt: number | null = null;
  let killed = false;
  const growsUntil = world.growsUntil ?? 10_000;
  const size = () => (recordedAt === null ? 0 : 100 + Math.max(0, Math.min(t, growsUntil) - recordedAt) * 1_000);

  const deps: ConvertDeps = {
    locateInstall: async () => install,
    resolveOutput: async (quarkId) => `/out/${quarkId}.mp4`,
    acquireLock: async () => {
      calls.push('lock');
      return async () => {
        calls.push('unlock');
      };
    },
    preflight: async () => {
      calls.push('preflight');
    },
    isEmulatorRunning: async () => world.emulatorRunning ?? false,
    restorePatches: async () => {
      calls.push('restore');
      return [];
    },
    applyPatches: async (patches) => {
      calls.push(`apply:${patches.length}`);
    },
    listAvis: async () => [
      ...(world.existingAvi ? [{ path: world.existingAvi, size: 5, mtimeMs: 0 }] : []),
      ...(recordedAt === null ? [] : [{ path: AVI, size: size(), mtimeMs: 1 }]),
    ],
    startEmulator: () => {
      calls.push('start');
      return {
        get exited() {
          return killed || (world.emulatorExitsAt !== undefined && t >= world.emulatorExitsAt);
        },
        kill: async () => {
          calls.push('kill');
          killed = true;
        },
      };
    },
    ctl: () => ({
      wait: async () => {
        calls.push('wait');
      },
      record: async () => {
        calls.push('record');
        recordedAt = t;
      },
      stop: async () => {
        calls.push('stop');
      },
      ffwd: async (on) => {
        calls.push(`ffwd:${on}`);
      },
      title: async () => null,
    }),
    mkdir: async () => {},
    transcode: async ({ segments, output }) => {
      calls.push(`transcode:${segments.join(',')}:${output}`);
    },
    removeFile: async (p) => {
      calls.push(`rm:${p}`);
    },
    moveFile: async (from, to) => {
      calls.push(`mv:${from}->${to}`);
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return { deps, calls, time: () => t };
}

describe('convert', () => {
  it('records, cleans up in order, then encodes only the new AVI', async () => {
    const { deps, calls } = harness({ existingAvi: '/avi/mine.avi' });
    const result = await convert(`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}`, baseOptions, deps);
    expect(result).toEqual({ output: `/out/${ID}.mp4`, endReason: 'stall', segments: 1 });
    expect(calls).toEqual([
      'lock', 'preflight', 'restore', 'apply:2', 'start', 'wait', 'record', 'ffwd:true',
      'ffwd:false', 'stop', 'kill', 'restore', 'unlock',
      `transcode:${AVI}:/out/${ID}.mp4`, `rm:${AVI}`,
    ]);
  });

  it('refuses before touching config or the user's own AVIs when a Fightcade emulator is already running', async () => {
    const { deps, calls } = harness({ emulatorRunning: true, existingAvi: '/avi/mine.avi' });
    await expect(convert(ID, baseOptions, deps)).rejects.toMatchObject({ exitCode: ExitCode.Busy });
    expect(calls).toEqual(['lock', 'preflight', 'unlock']);
  });

  it('cleans up when the emulator exits before the stream starts', async () => {
    const { deps, calls } = harness({ growsUntil: 0, emulatorExitsAt: 1_000 });
    await expect(convert(ID, baseOptions, deps)).rejects.toMatchObject({ exitCode: ExitCode.Emulator });
    expect(calls).not.toContain('stop');
    expect(calls.filter((c) => c.startsWith('transcode'))).toEqual([]);
    expect(calls.slice(-4)).toEqual(['kill', 'restore', 'unlock', `rm:${AVI}`]);
  });

  it('on Ctrl-C mid-recording restores config, kills the emulator and removes the AVI', async () => {
    const { deps, calls } = harness();
    const controller = new AbortController();
    const sleep = deps.sleep;
    deps.sleep = async (ms) => {
      await sleep(ms);
      if (calls.includes('record') && !controller.signal.aborted) controller.abort();
    };
    await expect(convert(ID, { ...baseOptions, signal: controller.signal }, deps)).rejects.toMatchObject({ exitCode: ExitCode.Interrupted });
    expect(calls.slice(-6)).toEqual(['ffwd:false', 'stop', 'kill', 'restore', 'unlock', `rm:${AVI}`]);
    expect(calls.filter((c) => c.startsWith('transcode'))).toEqual([]);
  });

  it('moves the AVI next to the MP4 with keepAvi', async () => {
    const { deps, calls } = harness();
    await convert(ID, { ...baseOptions, keepAvi: true }, deps);
    expect(calls.at(-1)).toBe(`mv:${AVI}->/out/sfiii3nr1_0.avi`);
  });

  it('skips ffwd and patches only the main ini with ffwd off', async () => {
    const { deps, calls } = harness();
    await convert(ID, { ...baseOptions, ffwd: false }, deps);
    expect(calls).toContain('apply:1');
    expect(calls.filter((c) => c.startsWith('ffwd'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/convert.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/convert.ts`**

```ts
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPatches, emulatorPatches, restorePatches, type Patch } from './configPatcher.js';
import { END_TITLE_PATTERN, RECORD_DELAY_MS, TIMEOUTS } from './constants.js';
import { isEmulatorRunning, startEmulator, type RunningEmulator } from './emulator.js';
import { ConvertError, ExitCode } from './errors.js';
import { run, which } from './exec.js';
import { createFbneoCtl, type FbneoCtl } from './fbneoCtl.js';
import { freeBytes, listAvis, pathExists, type AviFile } from './fsUtil.js';
import { locateInstall, preflight, type FightcadeInstall } from './install.js';
import { acquireLock } from './lock.js';
import { resolveOutputPath } from './outputPath.js';
import { waitForEnd, waitForNewAvi, waitForSettle, type EndReason } from './recordingWatcher.js';
import { parseReplayRef } from './replayRef.js';
import { transcode, type ScaleMode, type TranscodeArgs } from './transcoder.js';

export type ProgressEvent =
  | { phase: 'connecting' }
  | { phase: 'recording'; bytes: number; elapsedMs: number }
  | { phase: 'encoding'; seconds: number };

export interface ConvertOptions {
  output?: string;
  scale: ScaleMode;
  ffwd: boolean;
  maxDurationMs: number;
  fightcadeDir?: string;
  keepAvi: boolean;
  signal?: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
  log?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface ConvertResult {
  output: string;
  endReason: EndReason;
  segments: number;
}

export interface ConvertDeps {
  locateInstall(override?: string): Promise<FightcadeInstall>;
  resolveOutput(quarkId: string, output?: string): Promise<string>;
  acquireLock(): Promise<() => Promise<void>>;
  preflight(install: FightcadeInstall): Promise<void>;
  isEmulatorRunning(): Promise<boolean>;
  restorePatches(files: string[]): Promise<string[]>;
  applyPatches(patches: Patch[]): Promise<void>;
  listAvis(dir: string): Promise<AviFile[]>;
  startEmulator(install: FightcadeInstall, quarkId: string): RunningEmulator;
  ctl(install: FightcadeInstall): FbneoCtl;
  mkdir(dir: string): Promise<void>;
  transcode(args: TranscodeArgs): Promise<void>;
  removeFile(p: string): Promise<void>;
  moveFile(from: string, to: string): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export function defaultDeps(): ConvertDeps {
  const info = { platform: process.platform, home: homedir(), env: process.env };
  const helperExe = fileURLToPath(new URL('../vendor/fbneo-ctl.exe', import.meta.url));
  return {
    locateInstall: (override) => locateInstall({ ...info, override, exists: pathExists }),
    resolveOutput: async (quarkId, output) => resolve(await resolveOutputPath(quarkId, output, info)),
    acquireLock: () => acquireLock(),
    preflight: async (install) => {
      await preflight(install, { exists: pathExists, which, freeBytes });
      if (!(await pathExists(helperExe))) {
        throw new ConvertError(ExitCode.Preflight, `Helper not found: ${helperExe}`, 'Run native/build.sh');
      }
    },
    isEmulatorRunning: () => isEmulatorRunning(process.platform, run),
    restorePatches,
    applyPatches,
    listAvis,
    startEmulator: (install, quarkId) => startEmulator(install, quarkId),
    ctl: (install) => createFbneoCtl(install, helperExe),
    mkdir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    transcode: (args) => transcode(args),
    removeFile: (p) => rm(p, { force: true }),
    moveFile: async (from, to) => {
      try {
        await rename(from, to);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        await copyFile(from, to);
        await rm(from, { force: true });
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}

export async function convert(input: string, options: ConvertOptions, deps: ConvertDeps = defaultDeps()): Promise<ConvertResult> {
  const ref = parseReplayRef(input);
  const log = options.log ?? (() => {});
  const debug = options.debug ?? (() => {});
  const install = await deps.locateInstall(options.fightcadeDir);
  const output = await deps.resolveOutput(ref.quarkId, options.output);
  debug(`Fightcade: ${install.root}`);
  debug(`Output: ${output}`);

  const clock = { now: deps.now, sleep: deps.sleep, aborted: () => options.signal?.aborted ?? false };
  // null until we have snapshotted the AVI folder: before that, nothing in it is ours.
  let before: Set<string> | null = null;
  const newAvis = async () => {
    const known = before;
    if (known === null) return [];
    return (await deps.listAvis(install.aviDir))
      .filter((f) => !known.has(f.path))
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  };
  const totalSize = async () => (await newAvis()).reduce((sum, f) => sum + f.size, 0);

  let succeeded = false;
  try {
    const endReason = await capture();
    const segments = (await newAvis()).map((f) => f.path);
    if (segments.length === 0) throw new ConvertError(ExitCode.Recording, 'No AVI was recorded');
    debug(`Capture ended (${endReason}), ${segments.length} AVI segment(s)`);
    await deps.mkdir(dirname(output));
    await deps.transcode({
      segments,
      output,
      scale: options.scale,
      onProgress: (seconds) => options.onProgress?.({ phase: 'encoding', seconds }),
    });
    succeeded = true;
    return { output, endReason, segments: segments.length };
  } finally {
    for (const avi of await newAvis()) {
      if (!options.keepAvi) await deps.removeFile(avi.path);
      else if (succeeded) await deps.moveFile(avi.path, join(dirname(output), basename(avi.path)));
      else log(`Raw recording kept at ${avi.path}`);
    }
  }

  async function capture(): Promise<EndReason> {
    const patchedFiles = [install.mainIni, install.gameIni];
    const release = await deps.acquireLock();
    const ctl = deps.ctl(install);
    let applied = false;
    let emulator: RunningEmulator | undefined;
    try {
      await deps.preflight(install);
      if (await deps.isEmulatorRunning()) {
        throw new ConvertError(ExitCode.Busy, 'A Fightcade emulator (fcadefbneo.exe) is already running', 'Close Fightcade games, then retry');
      }
      const recovered = await deps.restorePatches(patchedFiles);
      if (recovered.length > 0) log(`Restored Fightcade config left by an interrupted run: ${recovered.join(', ')}`);

      before = new Set((await deps.listAvis(install.aviDir)).map((f) => f.path));
      await deps.applyPatches(emulatorPatches(install, options.ffwd));
      applied = true;

      options.onProgress?.({ phase: 'connecting' });
      emulator = deps.startEmulator(install, ref.quarkId);
      const running = emulator;
      await ctl.wait(TIMEOUTS.windowMs);
      if (RECORD_DELAY_MS > 0) await deps.sleep(RECORD_DELAY_MS);
      await ctl.record();
      await waitForNewAvi(async () => (await newAvis()).map((f) => f.path), clock, TIMEOUTS.aviAppearMs, TIMEOUTS.pollMs);
      if (options.ffwd) await ctl.ffwd(true);

      const endReason = await waitForEnd(
        {
          ...clock,
          size: totalSize,
          emulatorExited: () => running.exited,
          endSignal: async () => END_TITLE_PATTERN !== null && END_TITLE_PATTERN.test((await ctl.title()) ?? ''),
        },
        {
          stallMs: TIMEOUTS.stallMs,
          firstGrowthMs: TIMEOUTS.firstGrowthMs,
          maxDurationMs: options.maxDurationMs,
          pollMs: TIMEOUTS.pollMs,
          onProgress: (bytes, elapsedMs) => options.onProgress?.({ phase: 'recording', bytes, elapsedMs }),
        },
      );
      if (endReason === 'max-duration') log('Warning: reached --max-duration; the video may be cut short');
      return endReason;
    } finally {
      if (emulator) {
        if (!emulator.exited) {
          if (options.ffwd) await ctl.ffwd(false).catch(() => {});
          await ctl.stop().catch(() => {});
          await waitForSettle(totalSize, clock, TIMEOUTS.settleMs, TIMEOUTS.settleTimeoutMs, TIMEOUTS.pollMs);
        }
        await emulator.kill().catch((err: unknown) => log(`Could not stop the emulator: ${String(err)}`));
      }
      if (applied) await deps.restorePatches(patchedFiles);
      await release();
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/convert.test.ts && npm run typecheck`
Expected: PASS. If the call order differs from the expected arrays, fix `convert.ts` to match the ordering rules above. Do not edit the expectations unless they contradict those rules.

- [ ] **Step 5: Run the full suite**

Run: `npm test && npm run typecheck`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/convert.ts tests/convert.test.ts
git commit -m "feat: orchestrate capture, cleanup and encoding in convert()"
```

---

### Task 12: CLI, end-to-end test, README

**Files:**
- Create: `src/cliArgs.ts`, `src/cli.ts`, `tests/cliArgs.test.ts`, `tests/e2e.test.ts`, `README.md`

**Interfaces:**
- Consumes: `convert`, `ProgressEvent`, `ConvertError`, `ExitCode`, `DEFAULT_MAX_DURATION_MS`, `FFWD_SUPPORTED`, `ScaleMode`.
- Produces: `USAGE: string`; `parseDuration(text: string): number` (ms; bare number = minutes); `interface CliRequest { input: string; output?: string; scale: ScaleMode; ffwd: boolean; maxDurationMs: number; fightcadeDir?: string; keepAvi: boolean; verbose: boolean }`; `parseCli(argv: string[]): CliRequest | 'help'`

- [ ] **Step 1: Write the failing tests**

`tests/cliArgs.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseCli, parseDuration } from '../src/cliArgs.js';
import { ExitCode } from '../src/errors.js';
import { DEFAULT_MAX_DURATION_MS, FFWD_SUPPORTED } from '../src/constants.js';

describe('parseDuration', () => {
  it.each([
    ['90s', 90_000],
    ['45m', 2_700_000],
    ['1h', 3_600_000],
    ['30', 1_800_000],
    ['1.5h', 5_400_000],
  ])('%s → %d ms', (text, ms) => {
    expect(parseDuration(text)).toBe(ms);
  });
  it.each([['abc'], ['0'], ['-5m'], ['10x']])('rejects %s', (text) => {
    expect(() => parseDuration(text)).toThrow(/Invalid duration/);
  });
});

describe('parseCli', () => {
  it('applies defaults', () => {
    expect(parseCli(['1-2'])).toEqual({
      input: '1-2',
      output: undefined,
      scale: 'sharp',
      ffwd: FFWD_SUPPORTED,
      maxDurationMs: DEFAULT_MAX_DURATION_MS,
      fightcadeDir: undefined,
      keepAvi: false,
      verbose: false,
    });
  });
  it('reads every option', () => {
    expect(
      parseCli(['-o', '/tmp/x.mp4', '--scale', 'smooth', '--no-ffwd', '--max-duration', '20m', '--fightcade-dir', '/F', '--keep-avi', '-v', '1-2']),
    ).toEqual({ input: '1-2', output: '/tmp/x.mp4', scale: 'smooth', ffwd: false, maxDurationMs: 1_200_000, fightcadeDir: '/F', keepAvi: true, verbose: true });
  });
  it('returns help', () => {
    expect(parseCli(['--help'])).toBe('help');
  });
  it.each([[[]], [['a', 'b']], [['--scale', 'blurry', '1-2']], [['--bogus', '1-2']]])('rejects %j with a usage error', (argv) => {
    let error: unknown;
    try {
      parseCli(argv);
    } catch (err) {
      error = err;
    }
    expect(error).toMatchObject({ exitCode: ExitCode.Usage });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/cliArgs.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/cliArgs.ts`**

```ts
import { parseArgs } from 'node:util';
import { DEFAULT_MAX_DURATION_MS, FFWD_SUPPORTED } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import type { ScaleMode } from './transcoder.js';

export const USAGE = `Usage: fc2mp4 <replay-link-or-quarkId> [options]

Records a Fightcade Street Fighter III: 3rd Strike replay to MP4.

  -o, --output <path>       MP4 file, or an existing folder
                            (default: ~/Movies/Fightcade or %USERPROFILE%\\Videos\\Fightcade)
      --scale sharp|smooth  Upscaling style (default: sharp)
      --no-ffwd             Record in real time instead of fast-forwarding
      --max-duration <d>    Stop capturing after this long: 90s, 45m, 1h (default: 60m)
      --fightcade-dir <p>   Fightcade install (FightCade2.app on macOS)
      --keep-avi            Keep the raw AVI next to the MP4
  -v, --verbose             Print debug details
  -h, --help                Show this help`;

export interface CliRequest {
  input: string;
  output?: string;
  scale: ScaleMode;
  ffwd: boolean;
  maxDurationMs: number;
  fightcadeDir?: string;
  keepAvi: boolean;
  verbose: boolean;
}

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)([smh])?$/.exec(text.trim());
  const ms = match ? Number(match[1]) * UNIT_MS[(match[2] ?? 'm') as keyof typeof UNIT_MS] : NaN;
  if (!(ms > 0)) throw new ConvertError(ExitCode.Usage, `Invalid duration "${text}"`, 'Use e.g. 90s, 45m or 1h');
  return ms;
}

export function parseCli(argv: string[]): CliRequest | 'help' {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: 'string', short: 'o' },
        scale: { type: 'string' },
        'no-ffwd': { type: 'boolean' },
        'max-duration': { type: 'string' },
        'fightcade-dir': { type: 'string' },
        'keep-avi': { type: 'boolean' },
        verbose: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    throw new ConvertError(ExitCode.Usage, (err as Error).message, 'Run fc2mp4 --help');
  }
  const { values, positionals } = parsed;
  if (values.help) return 'help';
  if (positionals.length !== 1) {
    throw new ConvertError(ExitCode.Usage, 'Expected exactly one replay link or quark ID', 'Run fc2mp4 --help');
  }
  const scale = values.scale ?? 'sharp';
  if (scale !== 'sharp' && scale !== 'smooth') {
    throw new ConvertError(ExitCode.Usage, `Invalid --scale "${scale}"`, 'Use sharp or smooth');
  }
  return {
    input: positionals[0]!,
    output: values.output,
    scale,
    ffwd: !values['no-ffwd'] && FFWD_SUPPORTED,
    maxDurationMs: values['max-duration'] ? parseDuration(values['max-duration']) : DEFAULT_MAX_DURATION_MS,
    fightcadeDir: values['fightcade-dir'],
    keepAvi: values['keep-avi'] ?? false,
    verbose: values.verbose ?? false,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/cliArgs.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Implement the entry point `src/cli.ts`**

```ts
#!/usr/bin/env node
import { parseCli, USAGE } from './cliArgs.js';
import { convert, type ProgressEvent } from './convert.js';
import { ConvertError, ExitCode } from './errors.js';

function progressLine(e: ProgressEvent): string {
  switch (e.phase) {
    case 'connecting':
      return 'Connecting to the replay stream…';
    case 'recording':
      return `Recording… ${Math.round(e.elapsedMs / 1000)}s elapsed, ${Math.round(e.bytes / 1024 ** 2)} MB captured`;
    case 'encoding':
      return `Encoding… ${Math.round(e.seconds)}s of video done`;
  }
}

async function main(): Promise<number> {
  const controller = new AbortController();
  let interrupts = 0;
  process.on('SIGINT', () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(ExitCode.Interrupted);
    process.stderr.write('\nStopping and restoring the Fightcade config (Ctrl-C again to force quit)…\n');
    controller.abort();
  });
  process.on('SIGTERM', () => controller.abort());

  const tty = process.stderr.isTTY;
  try {
    const request = parseCli(process.argv.slice(2));
    if (request === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const result = await convert(request.input, {
      output: request.output,
      scale: request.scale,
      ffwd: request.ffwd,
      maxDurationMs: request.maxDurationMs,
      fightcadeDir: request.fightcadeDir,
      keepAvi: request.keepAvi,
      signal: controller.signal,
      log: (msg) => process.stderr.write(`${tty ? '\n' : ''}${msg}\n`),
      debug: request.verbose ? (msg) => process.stderr.write(`[debug] ${msg}\n`) : undefined,
      onProgress: (e) => process.stderr.write(tty ? `\r\x1b[K${progressLine(e)}` : `${progressLine(e)}\n`),
    });
    if (tty) process.stderr.write('\n');
    process.stdout.write(`${result.output}\n`);
    return 0;
  } catch (err) {
    if (tty) process.stderr.write('\n');
    if (err instanceof ConvertError) {
      process.stderr.write(`Error: ${err.message}\n`);
      if (err.hint) process.stderr.write(`Hint: ${err.hint}\n`);
      return err.exitCode;
    }
    process.stderr.write(`Unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    return 1;
  }
}

process.exitCode = await main();
```

Run: `npm run build && node dist/cli.js --help && node dist/cli.js; echo "exit=$?"`
Expected: usage text; then `Error: Expected exactly one replay link or quark ID`, `Hint: Run fc2mp4 --help`, `exit=2`.

- [ ] **Step 6: Write the opt-in end-to-end test**

`tests/e2e.test.ts`:
```ts
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/convert.js';
import { FFWD_SUPPORTED } from '../src/constants.js';

const exec = promisify(execFile);
const replay = process.env.FC_E2E;

// FC_E2E=<link or quark ID> npx vitest run tests/e2e.test.ts
// Optional: FC_E2E_EXPECTED_SECONDS=<in-game duration> to check the length within 5%.
describe.skipIf(!replay)('end-to-end', () => {
  it('converts a real replay to a 1440x1080 h264/aac MP4', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-e2e-'));
    const result = await convert(replay!, { output: dir, scale: 'sharp', ffwd: FFWD_SUPPORTED, maxDurationMs: 20 * 60_000, keepAvi: false });

    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', result.output]);
    const info = JSON.parse(stdout) as { streams: Record<string, unknown>[]; format: { duration: string } };
    expect(info.streams.find((s) => s.codec_type === 'video')).toMatchObject({ codec_name: 'h264', width: 1440, height: 1080 });
    expect(info.streams.find((s) => s.codec_type === 'audio')).toMatchObject({ codec_name: 'aac' });

    const duration = Number(info.format.duration);
    expect(duration).toBeGreaterThan(10);
    const expected = Number(process.env.FC_E2E_EXPECTED_SECONDS);
    if (Number.isFinite(expected)) expect(Math.abs(duration - expected)).toBeLessThan(expected * 0.05);
  }, 30 * 60_000);
});
```

Run: `npm test`
Expected: all PASS, e2e skipped.

- [ ] **Step 7: Run end-to-end for real**

First snapshot the inis:
```sh
CFG=/Applications/FightCade2.app/Contents/MacOS/emulator/fbneo/config
SNAP=$(mktemp -d); cp "$CFG/fcadefbneo.ini" "$CFG/games/sfiii3nr1.ini" "$SNAP/"
```
With the user's short replay from Task 2:
Run: `FC_E2E='<link>' FC_E2E_EXPECTED_SECONDS=<seconds> npx vitest run tests/e2e.test.ts`
Expected: PASS. Then run `npm run dev -- '<link>'` once to see the CLI progress output, open the MP4, and confirm by eye that the picture is 4:3, there is audio, and the start and end are correct.
Check the config is untouched: `cmp "$SNAP/fcadefbneo.ini" "$CFG/fcadefbneo.ini" && cmp "$SNAP/sfiii3nr1.ini" "$CFG/games/sfiii3nr1.ini"` prints nothing.
Then run `npm run dev -- '<link>'` again, press Ctrl-C during recording, and confirm: the same two `cmp` commands print nothing, `pgrep -f fcadefbneo.exe` prints nothing, and no new `.avi` remains in `fbneo/avi/`.

- [ ] **Step 8: README**

`README.md`:
````markdown
# fc2mp4

Turns a Fightcade **Street Fighter III: 3rd Strike** replay into an MP4 (1440×1080, H.264/AAC).

## Requirements

- Fightcade 2 installed, with 3rd Strike launched at least once (ROM + game config present)
- Node ≥ 22.12, ffmpeg (`brew install ffmpeg` / `winget install ffmpeg`)
- macOS or Windows

## Usage

```sh
npm install && npm run build
node dist/cli.js https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234
```

The video is saved to `~/Movies/Fightcade/` (macOS) or `%USERPROFILE%\Videos\Fightcade\` (Windows);
use `-o` to choose another file or folder. Run `node dist/cli.js --help` for all options.

While it runs, fc2mp4 temporarily changes two Fightcade config files (auto-pause off, a
fast-forward key binding) and restores them afterwards, even on Ctrl-C. Do not play on Fightcade
during a conversion.

## How it works

The replay is played by Fightcade's own emulator (`quark:stream`); the helper
`vendor/fbneo-ctl.exe` (source in `native/`, rebuild with `native/build.sh`) starts and stops
FBNeo's AVI recorder and holds fast-forward; ffmpeg converts the recording to MP4.
````

- [ ] **Step 9: Commit**

```bash
git add src/cliArgs.ts src/cli.ts tests/cliArgs.test.ts tests/e2e.test.ts README.md
git commit -m "feat: add fc2mp4 CLI, e2e test and README"
```
