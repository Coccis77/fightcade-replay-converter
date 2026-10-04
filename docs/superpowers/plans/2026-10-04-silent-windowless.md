# Silent, Windowless Recording Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While fc2mp4 records, the emulator shows no window and plays no sound on every platform, and Linux no longer needs Xvfb or PulseAudio.

**Architecture:** The emulator patch set gains two recording plugins (silent audio, memory-only video) that FBNeo selects whenever the `FC2MP4_*` dump is active, plus two patches that keep the main window and the "Loading…" box hidden. On Linux, fc2mp4 sets Wine's null display driver in its own prefix (recreated once via a new ready marker), launches the emulator with plain `wine`, and drops the v0.5.1 PulseAudio sound server.

**Tech Stack:** C++ (FBNeo Win32, mingw-w64), Python patcher/build (unittest), TypeScript 5.9 / Node 24 (vitest), Docker.

**Spec:** `docs/superpowers/specs/2026-10-04-silent-windowless-design.md`

## Global Constraints

- Without the `FC2MP4_*` variables the emulator behaves like stock FBNeo; Fightcade's install and emulator are never modified.
- Output unchanged: 1440×1080 H.264/AAC, every frame (8220 for the short replay), audio within 0.05 s, sample rate 44100.
- Linux requirements: `wine`, `wine32:i386`, `ffmpeg` only. `APT_HINT` = `sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 ffmpeg`.
- Linux prefix: setup = `wine wineboot -i`, then `wine reg add HKCU\Software\Wine\Drivers /v Graphics /d null /f`, then `wineserver -w`, then marker `.fc2mp4-ready-2`; no `xvfb-run`, no Explorer/Desktops keys; a prefix without that marker is deleted and set up again.
- Linux launch: `wine <runtime>/fcadefbneo-fc2mp4.exe <streamArg>`, own process group, stop = `wineserver -k` + group sweep.
- Docker image packages: `wine wine32:i386 ffmpeg ca-certificates tini`.
- macOS keeps `caffeinate`. CLI version for the release: `0.6.0`.
- Node via `source ~/.nvm/nvm.sh && nvm use 24`; TS suite `npm test`; Python suite `npm run test:emulator`; both stay green.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push or tag without asking the user.

## Review Focus

1. **Existing Linux install from v0.4–v0.5.1** (old `.fc2mp4-ready` marker, prefix with virtual-desktop keys): must be deleted and recreated once, then reused. → Task 2 test "recreates a prefix set up by an older fc2mp4".
2. **Linux machine that has a display (WSLg, a desktop)**: the emulator must still not open a window — the null driver lives in our prefix, not in `DISPLAY`. → Task 2 test "never needs a display: no xvfb-run anywhere" (setup + launch commands) and the real WSL test.
3. **Emulator run without `FC2MP4_*` (by hand, or a future non-recording use)**: stock plugins, visible window. → reviewer checks every new patch is guarded by `Fc2mp4DumpActive()`; Task 1 test "every new patch is guarded".
4. **Ctrl-C while the old prefix is being replaced**: no prefix marked ready, Wine stopped, Interrupted. → existing interrupt test kept green with the new step list (Task 2).
5. **Splash/preview video init before a game is loaded**: no error popup, no crash. → Task 4 real macOS run watches for any window (the popup was the spike's first failure).

---

### Task 1: Emulator recording plugins and hidden windows

**Files:**
- Create: `emulator/src/fc2mp4_headless.cpp`
- Modify: `emulator/patches.py` (append 7 patches), `emulator/build.py` (compile every `emulator/src/*.cpp`)
- Test: `emulator/test_build.py`, `emulator/test_patcher.py`

**Interfaces:**
- Produces: `fc2mp4_sources(here=HERE) -> list[str]` in `emulator/build.py`; C++ symbols `AudOutFc2mp4`, `VidOutFc2mp4`.

- [ ] **Step 1: Write the failing tests**

`emulator/test_build.py`: change the import to `from build import cache_key, fc2mp4_sources` and append:

```python
class Fc2mp4SourcesTest(unittest.TestCase):
    def test_compiles_every_fc2mp4_source(self):
        names = [os.path.basename(p) for p in fc2mp4_sources()]
        self.assertEqual(names, ['fc2mp4_dump.cpp', 'fc2mp4_headless.cpp'])
```

`emulator/test_patcher.py`, inside `ShippedPatchSetTest`:

```python
    def test_every_recording_patch_is_guarded(self):
        # Without FC2MP4_* the emulator must behave like stock FBNeo.
        from patches import PATCHES
        recording = [p for p in PATCHES if p.name.startswith(('recording-', 'hide-'))]
        self.assertEqual(len(recording), 8)
        for p in recording:
            if p.name.endswith(('-select', '-window', '-box')):
                self.assertIn('Fc2mp4DumpActive()', p.replacement, p.name)
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:emulator`
Expected: FAIL — `ImportError: cannot import name 'fc2mp4_sources'`, and `0 != 8` for the recording patches.

- [ ] **Step 3: Implement**

`emulator/build.py` — add near the other helpers:

```python
def fc2mp4_sources(here=HERE):
    """fc2mp4's own C++ files, compiled together with the patched emulator."""
    src = os.path.join(here, 'src')
    return sorted(os.path.join(src, f) for f in os.listdir(src) if f.endswith('.cpp'))
```

and replace `    sources.append(os.path.join(HERE, 'src', 'fc2mp4_dump.cpp'))` with `    sources.extend(fc2mp4_sources())`.

`emulator/src/fc2mp4_headless.cpp`:

```cpp
// fc2mp4: audio and video plugins used while recording (FC2MP4_* set). Nothing is played or shown:
// FBNeo still fills nAudNextSound and pVidImage each frame, which fc2mp4_dump.cpp writes out.
#include "burner.h"
#include "vid_support.h"

// ---- Audio: the sound buffer FBNeo fills each frame, no device ----
static INT32 SilentBlank()
{
	if (nAudNextSound) memset(nAudNextSound, 0, nAudSegLen << 2);
	return 0;
}

static INT32 SilentInit()
{
	if (nAudSampleRate[0] <= 0) return 1;
	// Same segment length as DirectSound: one frame of 16-bit stereo samples.
	nAudSegLen = (nAudSampleRate[0] * 100 + (nAppVirtualFps >> 1)) / nAppVirtualFps;
	nAudAllocSegLen = nAudSegLen << 2;
	nAudNextSound = (INT16*)malloc(nAudAllocSegLen);
	if (nAudNextSound == NULL) return 1;
	SilentBlank();
	return 0;
}

static INT32 SilentExit()
{
	free(nAudNextSound);
	nAudNextSound = NULL;
	return 0;
}

static INT32 SilentNothing() { return 0; }
static INT32 SilentPlay() { bAudPlaying = 1; return 0; }
static INT32 SilentStop() { bAudPlaying = 0; return 0; }
static INT32 SilentSettings(InterfaceInfo*) { return 0; }

struct AudOut AudOutFc2mp4 = { SilentBlank, SilentInit, SilentExit, SilentNothing, SilentNothing, SilentPlay, SilentStop, SilentNothing, SilentSettings, _T("fc2mp4 recording (silent)") };

// ---- Video: frames drawn in memory, nothing on screen ----
static INT32 MemInit()
{
	// Before a game is loaded FBNeo starts video for its splash screen: succeed without a frame
	// buffer, so the splash is skipped (drawing it into our buffer crashes) and no error popup shows.
	if (!bDrvOkay) {
		VidSFreeVidImage();
		return 0;
	}
	BurnDrvGetVisibleSize(&nVidImageWidth, &nVidImageHeight);
	nVidImageDepth = 32;
	nVidImageBPP = 4;
	if (VidSAllocVidImage()) return 1;
	SetBurnHighCol(nVidImageDepth);	// colour conversion for this depth, as the real blitters do
	return 0;
}

static INT32 MemExit()
{
	VidSFreeVidImage();
	return 0;
}

static INT32 MemFrame(bool bRedraw)
{
	if (pVidImage == NULL || !bDrvOkay) return 1;
	if (bRedraw) {
		if (BurnDrvRedraw()) BurnDrvFrame();
	} else {
		BurnDrvFrame();
	}
	if ((BurnDrvGetFlags() & BDF_16BIT_ONLY) && pVidTransCallback) pVidTransCallback();
	return 0;
}

static INT32 MemPaint(INT32) { return 0; }
static INT32 MemScale(RECT*, INT32, INT32) { return 0; }
static INT32 MemSettings(InterfaceInfo*) { return 0; }

struct VidOut VidOutFc2mp4 = { MemInit, MemExit, MemFrame, MemPaint, MemScale, MemSettings, _T("fc2mp4 recording (memory)") };
```

`emulator/patches.py` — append to `PATCHES` (before the closing `]`):

```python
    # While recording: a silent audio plugin and a memory-only video plugin (fc2mp4_headless.cpp),
    # selected only when the dump is active. Nothing is played or shown.
    Patch(
        name='recording-audio-plugin',
        file='src/intf/audio/aud_interface.cpp',
        anchor='\textern struct AudOut AudOutWasapi;\n',
        replacement='\textern struct AudOut AudOutWasapi;\n\textern struct AudOut AudOutFc2mp4;\n',
    ),
    Patch(
        name='recording-audio-list',
        file='src/intf/audio/aud_interface.cpp',
        anchor='\t&AudOutWasapi,\n',
        replacement='\t&AudOutWasapi,\n\t&AudOutFc2mp4,\n',
    ),
    Patch(
        name='recording-audio-select',
        file='src/intf/audio/aud_interface.cpp',
        anchor='\tnAudActive = kNetSpectator ? 0 : nAudSelect;\n',
        replacement='\tnAudActive = kNetSpectator ? 0 : nAudSelect;\n'
        '\t{ extern int Fc2mp4DumpActive(); if (Fc2mp4DumpActive()) nAudActive = AUD_LEN - 1; }\n',
    ),
    Patch(
        name='recording-video-plugin',
        file='src/intf/video/vid_interface.cpp',
        anchor='\textern struct VidOut VidOutDX9Alt;\n',
        replacement='\textern struct VidOut VidOutDX9Alt;\n\textern struct VidOut VidOutFc2mp4;\n',
    ),
    Patch(
        name='recording-video-list',
        file='src/intf/video/vid_interface.cpp',
        anchor='\t&VidOutDX9Alt,\n#elif defined (BUILD_MACOS)',
        replacement='\t&VidOutDX9Alt,\n\t&VidOutFc2mp4,\n#elif defined (BUILD_MACOS)',
    ),
    Patch(
        name='recording-video-select',
        file='src/intf/video/vid_interface.cpp',
        anchor='\t\tnVidActive = nVidSelect;\n',
        replacement='\t\tnVidActive = nVidSelect;\n'
        '\t\t{ extern int Fc2mp4DumpActive(); if (Fc2mp4DumpActive()) nVidActive = VID_LEN - 1; }\n',
    ),
    # No window while recording: the main window is never shown, nor the "Loading…" box.
    Patch(
        name='hide-main-window',
        file='src/burner/win32/run.cpp',
        anchor='\t\tShowWindow(hScrnWnd, nAppShowCmd);',
        replacement='\t\tif (!Fc2mp4DumpActive()) ShowWindow(hScrnWnd, nAppShowCmd);',
    ),
    Patch(
        name='hide-progress-box',
        file='src/burner/win32/progress.cpp',
        anchor='int ProgressCreate()\n{\n',
        replacement='int Fc2mp4DumpActive();\n\nint ProgressCreate()\n{\n\tif (Fc2mp4DumpActive()) return 0;\n',
    ),
```

The eight appended patches, in order: `recording-audio-plugin`, `recording-audio-list`, `recording-audio-select`, `recording-video-plugin`, `recording-video-list`, `recording-video-select`, `hide-main-window`, `hide-progress-box`. `run.cpp` already declares `Fc2mp4DumpActive()` above `RunFrame` (line ~241, existing `dump-declarations-and-force-draw` patch), which precedes `RunMessageLoop` (line ~505), so `hide-main-window` needs no declaration.

- [ ] **Step 4: Run the Python suite**

Run: `npm run test:emulator`
Expected: PASS.

- [ ] **Step 5: Real build**

Run: `python3 emulator/build.py --source-dir <scratchpad>/fbneo-full --out-dir <scratchpad>/build-out --ggponet /Applications/FightCade2.app/Contents/MacOS/emulator/fbneo/ggponet.dll` (fetches the latest fightcade-fbneo)
Expected: exit 0, `build-info.json` printed — every anchor matched exactly once and the plugins compiled.

- [ ] **Step 6: Commit**

```bash
git add emulator/src/fc2mp4_headless.cpp emulator/patches.py emulator/build.py emulator/test_build.py emulator/test_patcher.py
git commit -m "feat(emulator): record without a window or sound device (silent audio + memory video plugins)"
```

---

### Task 2: Linux without a display

**Files:**
- Modify: `src/winePrefix.ts`, `src/convert.ts` (`prepareWine` default), `src/capture.ts` (`emulatorCommand`, comments), `src/install.ts` (`APT_HINT`, `checkTools`), `src/signals.ts` (comment)
- Test: `tests/winePrefix.test.ts`, `tests/capture.test.ts`, `tests/install.test.ts`

**Interfaces:**
- Produces: `ensureWinePrefix(prefix, deps: { exists, writeMarker, removeDir(p: string): Promise<void>, run, onSetup?, signal? })`; marker `.fc2mp4-ready-2`.

- [ ] **Step 1: Write the failing tests**

`tests/winePrefix.test.ts`:
- `const READY = \`${PREFIX}/.fc2mp4-ready-2\`;`
- in `fake()`, add to `deps`: `removeDir: async (p: string) => { calls.push(\`rm ${p}\`); },`
- replace the test `'creates the prefix headless, sets the virtual desktop, …'` with:

```ts
  it('starts from an empty prefix, sets the null display driver, waits for Wine, then marks it ready', async () => {
    const f = fake();
    let announced = false;
    await ensureWinePrefix(PREFIX, { ...f.deps, onSetup: () => (announced = true) });
    expect(announced).toBe(true);
    expect(f.calls).toEqual([
      `rm ${PREFIX}`,
      'wine wineboot -i',
      'wine reg add HKCU\\Software\\Wine\\Drivers /v Graphics /d null /f',
      'wineserver -w',
    ]);
    expect(f.envs[0]).toMatchObject({ WINEPREFIX: PREFIX, WINEDLLOVERRIDES: 'mscoree,mshtml=' });
    expect(f.files.has(READY)).toBe(true);
  });

  it('recreates a prefix set up by an older fc2mp4 (virtual desktop, old marker)', async () => {
    const f = fake();
    f.files.add(`${PREFIX}/.fc2mp4-ready`);
    await ensureWinePrefix(PREFIX, f.deps);
    expect(f.calls[0]).toBe(`rm ${PREFIX}`);
    expect(f.files.has(READY)).toBe(true);
  });

  it('never needs a display: no xvfb-run anywhere', async () => {
    const f = fake();
    await ensureWinePrefix(PREFIX, f.deps);
    expect(f.calls.some((c) => c.includes('xvfb-run'))).toBe(false);
  });
```

(`removeDir` records into `calls` but not `envs`, so `envs[0]` is the wineboot call.)

`tests/capture.test.ts` — replace the Linux launch test:

```ts
  it('launches the emulator with plain wine: no display needed, its exit code comes back', () => {
    expect(emulatorCommand(linux, rt, '1-2')).toEqual({
      command: 'wine',
      args: [`${rt}/fcadefbneo-fc2mp4.exe`, 'quark:stream,sfiii3nr1,1-2.7,7100'],
    });
  });
```

and rename the sweep test title to `'stops what the emulator process group left behind'`.

`tests/install.test.ts`:
- test `'needs wine and xvfb-run on Linux, with the apt hint'` becomes `'needs wine on Linux, with the apt hint'`: `which` returns null for `'wine'`, message contains `'wine'`, hint `'sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 ffmpeg'`.
- `checkTools` test: replace its body with

```ts
    await expect(checkTools('linux', async (c) => (c === 'wine' ? null : `/usr/bin/${c}`))).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: 'Missing on this system: wine',
      hint: 'sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 ffmpeg',
    });
    // Xvfb and PulseAudio are no longer needed.
    await expect(checkTools('linux', async (c) => (c === 'wine' ? '/usr/bin/wine' : null))).resolves.toBeUndefined();
    await expect(checkTools('darwin', async () => null)).resolves.toBeUndefined();
    await expect(checkTools('win32', async () => null)).resolves.toBeUndefined();
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/winePrefix.test.ts tests/capture.test.ts tests/install.test.ts`
Expected: FAIL — calls start with `xvfb-run`, launch command is `xvfb-run`, checkTools reports `xvfb-run`.

- [ ] **Step 3: Implement**

`src/winePrefix.ts`:

```ts
// Bumped when the prefix setup changes: an older prefix (v0.4–v0.5.1: virtual desktop on Xvfb) is
// deleted and set up again.
const READY_MARKER = '.fc2mp4-ready-2';

// Wine's null display driver, set once in our prefix: the emulator (which shows no window while
// recording) runs with plain `wine`, without any display, and its exit code reaches us.
const SETUP_STEPS: string[][] = [
  ['wineboot', '-i'],
  ['reg', 'add', 'HKCU\\Software\\Wine\\Drivers', '/v', 'Graphics', '/d', 'null', '/f'],
];
```

In `ensureWinePrefix`: add `removeDir(p: string): Promise<void>;` to `deps`; after `deps.onSetup?.();` add `await deps.removeDir(prefix);` (comment: `// Our own cache: start clean (also replaces an older fc2mp4's prefix).`); in the loop use `deps.run('wine', step, { env, timeoutMs: 5 * 60_000, signal: deps.signal, detached: true })` and in the error message use `step[0]` instead of `step[1]`.

`src/convert.ts` `prepareWine` default: pass `removeDir: (p) => rm(p, { recursive: true, force: true })` to `ensureWinePrefix`.

`src/capture.ts` Linux branch of `emulatorCommand`:

```ts
  if (install.platform === 'linux') {
    // No display: our prefix uses Wine's null display driver and the emulator shows no window while
    // recording. Launched directly, so its exit code comes back.
    return { command: 'wine', args: [exe, streamArg(quarkId)] };
  }
```

and update the two comments mentioning Xvfb: `detached: linux, // own process group, so every Wine process of the run is stopped together` and above `sweepProcessGroup`: `// Stop whatever is left in a process group once its leader is gone (e.g. Wine helpers).`

`src/install.ts`: `APT_HINT = 'sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 ffmpeg'`; `checkTools` loop over `['wine']`.

`src/signals.ts`: comment → `// SIGHUP (SSH session closed) and SIGTERM stop cleanly too, so a server never keeps Wine around.`

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/winePrefix.test.ts tests/capture.test.ts tests/install.test.ts && npx tsc --noEmit -p . && npm test`
Expected: PASS, suite green.

- [ ] **Step 5: Commit**

```bash
git add src/winePrefix.ts src/convert.ts src/capture.ts src/install.ts src/signals.ts tests/winePrefix.test.ts tests/capture.test.ts tests/install.test.ts
git commit -m "feat(linux): no display needed — Wine null driver in our prefix, plain wine launch"
```

---

### Task 3: Remove the PulseAudio sound server; image and README

**Files:**
- Delete: `src/silentAudio.ts`, `tests/silentAudio.test.ts`
- Modify: `src/convert.ts` (`startAudio`), `src/capture.ts` (`emulatorEnv`), `Dockerfile`, `README.md`
- Test: `tests/convert.test.ts`, `tests/capture.test.ts`

- [ ] **Step 1: Update the tests first**

`tests/convert.test.ts`: remove the `startAudio` entry from the harness; the capture call record becomes `calls.push(\`capture:${quarkId}:${opts.dir}\`);`; the order test expects `'wine', 'tmp', \`capture:${ID}:/tmp/run\`, 'mkdir:/out', …` (no `audio:` / `audio-stop`); the capture-failure test expects `calls.slice(-2)` to equal `['rmdir:/tmp/run', 'unlock']`.
`tests/capture.test.ts`: delete the test `'adds the extra emulator environment (Linux sound device)'`.
Delete `tests/silentAudio.test.ts`.

- [ ] **Step 2: Run to verify the convert tests fail**

Run: `npx vitest run tests/convert.test.ts`
Expected: FAIL — convert still calls `deps.startAudio`, which the harness no longer provides (`deps.startAudio is not a function`).

- [ ] **Step 3: Implement**

- `src/convert.ts`: remove the `silentAudio` import, the `startAudio` member of `ConvertDeps` and of `defaultDeps`, and restore the capture call:

```ts
    options.onProgress?.({ phase: 'connecting' });
    const captured = await deps.capture(install, ref.quarkId, ffmpeg, {
      dir,
      scale: options.scale,
      maxDurationMs: options.maxDurationMs,
      signal: options.signal,
      onProgress: (frames, elapsedMs) => options.onProgress?.({ phase: 'capturing', frames, elapsedMs }),
    });
```

- `src/capture.ts`: remove `emulatorEnv` from `CaptureOptions` (with its comment) and `...opts.emulatorEnv,` from the `startEmulator` call.
- `git rm src/silentAudio.ts tests/silentAudio.test.ts`
- `Dockerfile`: `apt-get install -y wine wine32:i386 ffmpeg ca-certificates tini`.
- `README.md` Linux bullet: apt line `sudo apt install wine wine32:i386 ffmpeg`; replace `No screen is needed: it runs on a virtual display.` with `No screen or sound device is needed.`; in "How it works", after the sentence about the patches add: `While recording, the emulator shows no window and plays no sound.`

- [ ] **Step 4: Run everything**

Run: `npm test && npx tsc --noEmit -p . && grep -rn -i "xvfb\|pulse" src tests Dockerfile README.md`
Expected: suite green, no type errors, grep finds nothing.

- [ ] **Step 5: Commit**

```bash
git add -A src tests Dockerfile README.md
git commit -m "feat(linux): drop the PulseAudio sound server and Xvfb from the requirements and the image"
```

---

### Task 4: Real macOS test through the CLI

**Files:** none (verification). Throwaway helper in the scratchpad.

- [ ] **Step 1: Window watcher** (scratchpad, not committed): `windows.swift`

```swift
import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list {
  let owner = (w[kCGWindowOwnerName as String] as? String ?? "").lowercased()
  if owner.contains("wine") || owner.contains("fbneo") { print("window:", owner) }
}
```

Build: `swiftc -O windows.swift -o windows`.

- [ ] **Step 2: Build the emulator locally for this patch set and convert**

```bash
npm run bundle
node build/fc2mp4.cjs rebuild-emulator
node build/fc2mp4.cjs 1791006077129-2245 -o <scratchpad>/short.mp4 &   # while it runs:
while kill -0 $! 2>/dev/null; do <scratchpad>/windows; sleep 0.3; done
```

Expected: `rebuild-emulator` prints "Emulator updated."; the conversion prints `Captured 2:18 of replay.`; the watcher prints nothing.

- [ ] **Step 3: Check the output**

Run: `ffprobe -v error -show_entries stream=codec_name,width,height,duration -of compact <scratchpad>/short.mp4` and extract the frame at 60 s (`ffmpeg -ss 60 -i … -frames:v 1 frame.png`), then look at it.
Expected: h264 1440×1080 ≈137.94 s, aac ≈137.93 s; the frame shows Ryu vs Gouki, timer 76, normal colours.

- [ ] **Step 4: Ledger the result** (no commit).

---

## After the plan (not tasks)

- Final whole-branch review; merge to `main` (ask) → `emulator.yml` publishes `emulator-<commit12>-<newhash12>`.
- Linux real test (Claude): Linux binary built in a `node:24` amd64 container, image built locally (its `prepare` downloads the new emulator), short replay with the copied Fightcade files: no xvfb/pulseaudio in the image, 8220 frames, frame at 60 s correct.
- Windows real test (user): PowerShell script — downloads the new emulator release into a temp copy of fc2mp4's runtime folder, runs it on the short replay with `FC2MP4_*` → files, reports frames/audio, encodes with fc2mp4's ffmpeg to an MP4 in Videos\Fightcade; the user confirms no window and no sound and watches the video.
- Then version `0.6.0`, tag `v0.6.0` (ask), and the WSL Docker script for 0.6.0.
