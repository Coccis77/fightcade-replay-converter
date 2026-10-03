# Fightcade Replay → MP4 (rev 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `fc2mp4 <link-or-quarkId>` builds (when needed) a patched Fightcade FBNeo, replays the match faster than real time under Fightcade's Wine, streams every frame into ffmpeg, and writes a 1440×1080 H.264/AAC MP4. macOS only.

**Architecture:** A Python "patcher" (`emulator/`) fetches the latest `fightcade-fbneo`, applies anchored patches (frame/audio dump, forced fast-forward, self-exit when the stream goes idle) and cross-compiles it with mingw-w64. A TypeScript CLI decides when to rebuild (fingerprints of the installed Fightcade), prepares a private runtime folder, runs the emulator with video going into a FIFO read by a live ffmpeg encode and audio going to a temp file, then muxes the result.

**Tech Stack:** Python 3 (stdlib only), mingw-w64 i686, perl, git; Node ≥ 22.12 (ESM), TypeScript 5.9, vitest 5, tsx 4; ffmpeg/ffprobe; Fightcade's Wine (`wine.sh`).

**Spec:** `docs/superpowers/specs/2026-10-03-fightcade-replay-to-mp4-design.md` (rev 2). Evidence for every fact used here: `docs/spike-findings.md`.

## Global Constraints

- macOS only in v1; `locateInstall` rejects other platforms with a Preflight error.
- Only game `sfiii3nr1`. Stream argument: `quark:stream,sfiii3nr1,<quarkId>.7,7100`.
- Never write inside the Fightcade install. Everything we create lives in `~/Library/Caches/fc2mp4/` (`fightcade-fbneo/` source checkout, `runtime/` exe + DLL copies + ROMs symlink + config + manifest + build log + obj cache) or in a per-run temp dir.
- Emulator exe name: `fcadefbneo-fc2mp4.exe`. Launched as `<install>/Contents/Resources/wine.sh <runtime>/fcadefbneo-fc2mp4.exe <streamArg>` with cwd = runtime; exe path absolute.
- Emulator environment: `FC2MP4_VIDEO` (FIFO, Windows path `Z:\...`), `FC2MP4_AUDIO` (regular file), `FC2MP4_INFO` (file), `FC2MP4_IDLE_MS` (5000).
- Frame format (constant, verified against the info file): 384×224, bpp 4 (`bgr0`), fps_x100 5959, s16le stereo 44100 Hz.
- Runtime ini overrides: `nVidSelect 0`, `bVidFullStretch 1`, `bAutoPause 0`.
- Video encode: `-preset medium -crf 18 -pix_fmt yuv420p`, 1440×1080, `setsar=1`; mux: `-c:v copy`, AAC 192k, `-movflags +faststart`, written to `<out>.part.mp4` then renamed.
- Default output `~/Movies/Fightcade/<quarkId>.mp4`; `-o` file or existing directory.
- Patches are anchored and must match exactly once; a patch whose replacement is already present is skipped.
- Exit codes: Usage 2, Preflight 3, Busy 4, Emulator 5, Recording 6, Encode 7, Interrupted 130, unexpected 1. `emulator/build.py` exits 2 (patch), 3 (build), 4 (fetch).
- Timeouts: first frame 60 s, emulator idle 5 s, kill 15 s, poll 500 ms; default `--max-duration` 60 min.

## Review Focus

1. **Fightcade/source update breaks a patch.** The user expects the previous working emulator to keep converting, with a clear warning naming the patch. Pinned by `ensureEmulator` "build fails with a previous build" (Task 6) and the patcher's missing-anchor test (Task 1).
2. **Ctrl-C or a crash mid-capture.** No `fcadefbneo-fc2mp4.exe`, ffmpeg or temp dir is left behind, and the lock is released. Pinned by the capture abort test (Task 9) and the convert failure-cleanup test (Task 11).
3. **A bad or expired quark ID.** Fails within about a minute with a clear message instead of hanging. Pinned by capture's "never started" and "emulator exits before start" tests (Task 9).
4. **Re-running for the same quark, or the final mux failing.** The previous MP4 stays intact and no `.part.mp4` is left. Pinned by the mux failure test (Task 8).
5. **Link shapes** (trailing slash, query, whitespace, `fcade://`, another game). Pinned by the Task 3 tests.

---

## File Structure

```
emulator/patcher.py          apply anchored patches (idempotent, unique-anchor check)
emulator/patches.py          the fc2mp4 patch set (PATCHES list)
emulator/test_patcher.py     unittest for patcher + patch set sanity
emulator/build.py            fetch → patch → generate → compile → link → build-info.json
emulator/src/fc2mp4_dump.cpp dump + idle/disconnect exit (added to the build)
emulator/stubs/hq_shared32.cpp  replaces MSVC-asm scaler helpers
package.json, tsconfig.json, tsconfig.build.json
src/errors.ts                ConvertError + ExitCode
src/constants.ts             all fixed values
src/replayRef.ts             parseReplayRef
src/outputPath.ts            default output + -o resolution
src/fsUtil.ts                pathExists, sha256File
src/exec.ts                  run(), which()
src/install.ts               installLayout, locateInstall, preflight
src/emulatorBuild.ts         fingerprints, manifest, ensureEmulator, defaultEnsureDeps
src/iniPatch.ts              setIniValue
src/runtime.ts               runtimeIni, prepareRuntime
src/ffmpeg.ts                encode/mux args, progress, info parsing, runFfmpeg
src/capture.ts               FIFO + encoder + emulator orchestration, defaultCaptureDeps
src/lock.ts                  single-instance lock
src/convert.ts               convert(), rebuildEmulator(), defaultDeps
src/cliArgs.ts               argv parsing, durations, usage
src/cli.ts                   entry point
tests/*.test.ts              vitest; tests/e2e.test.ts opt-in
```

Obsolete from rev 1, removed in Task 1: `native/`, `vendor/`, `spike/`.

---

### Task 1: Patcher (Python) and the fc2mp4 patch set

**Files:**
- Delete: `native/`, `vendor/`, `spike/` (rev 1 helper and spike code; findings stay in `docs/spike-findings.md`)
- Create: `emulator/patcher.py`, `emulator/patches.py`, `emulator/test_patcher.py`
- Modify: `.gitignore` (add `__pycache__/`)

**Interfaces:**
- Produces: `Patch(name, file, anchor, replacement)` (frozen dataclass); `PatchError(Exception)`; `apply_patch(source_root: str, patch: Patch) -> bool` (True = changed, False = already applied); `apply_patches(source_root, patches) -> list[str]` (names changed); `patches.PATCHES: list[Patch]`.

- [ ] **Step 1: Remove obsolete rev 1 code**

```bash
git rm -r -q native vendor spike
printf '__pycache__/\n' >> .gitignore
```

- [ ] **Step 2: Write the failing tests**

`emulator/test_patcher.py`:
```python
import os
import tempfile
import unittest

from patcher import Patch, PatchError, apply_patch, apply_patches


class ApplyPatchTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.root, 'src'))
        self.path = os.path.join(self.root, 'src', 'run.cpp')
        self.write('int RunIdle()\n{\n\treturn 0;\n}\n')

    def write(self, text):
        with open(self.path, 'w', encoding='latin-1', newline='') as f:
            f.write(text)

    def read(self):
        with open(self.path, encoding='latin-1', newline='') as f:
            return f.read()

    def idle_patch(self):
        return Patch('idle-check', 'src/run.cpp', 'int RunIdle()\n{\n', 'int RunIdle()\n{\n\tCheck();\n')

    def test_replaces_the_anchor(self):
        self.assertTrue(apply_patch(self.root, self.idle_patch()))
        self.assertEqual(self.read(), 'int RunIdle()\n{\n\tCheck();\n\treturn 0;\n}\n')

    def test_is_idempotent(self):
        apply_patch(self.root, self.idle_patch())
        self.assertFalse(apply_patch(self.root, self.idle_patch()))
        self.assertEqual(self.read(), 'int RunIdle()\n{\n\tCheck();\n\treturn 0;\n}\n')

    def test_missing_anchor_names_the_patch_and_file(self):
        self.write('int Other()\n{\n}\n')
        with self.assertRaises(PatchError) as ctx:
            apply_patch(self.root, self.idle_patch())
        message = str(ctx.exception)
        self.assertIn('idle-check', message)
        self.assertIn('src/run.cpp', message)
        self.assertIn('not found', message)

    def test_ambiguous_anchor_is_an_error(self):
        self.write('int RunIdle()\n{\n}\nint RunIdle()\n{\n}\n')
        with self.assertRaisesRegex(PatchError, 'found 2 times'):
            apply_patch(self.root, self.idle_patch())

    def test_missing_file_is_an_error(self):
        with self.assertRaisesRegex(PatchError, 'file not found'):
            apply_patch(self.root, Patch('x', 'src/nope.cpp', 'a', 'b'))

    def test_keeps_non_utf8_bytes(self):
        self.write('// caf\xe9\nint RunIdle()\n{\n}\n')
        apply_patch(self.root, self.idle_patch())
        with open(self.path, 'rb') as f:
            self.assertIn(b'caf\xe9', f.read())

    def test_apply_patches_reports_only_changed(self):
        apply_patch(self.root, self.idle_patch())
        other = Patch('ret', 'src/run.cpp', '\treturn 0;\n', '\treturn 1;\n')
        self.assertEqual(apply_patches(self.root, [self.idle_patch(), other]), ['ret'])


class ShippedPatchSetTest(unittest.TestCase):
    def test_patch_set_is_well_formed(self):
        from patches import PATCHES
        names = [p.name for p in PATCHES]
        self.assertEqual(len(names), len(set(names)))
        for p in PATCHES:
            self.assertTrue(p.anchor)
            self.assertNotEqual(p.anchor, p.replacement)


if __name__ == '__main__':
    unittest.main()
```

- [ ] **Step 3: Run them and watch them fail**

Run: `python3 -m unittest discover -s emulator -p 'test_*.py' -v`
Expected: ERROR, `ModuleNotFoundError: No module named 'patcher'`.

- [ ] **Step 4: Implement `emulator/patcher.py`**

```python
"""Anchored source patches: each patch replaces one exact snippet that must occur exactly once."""
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Patch:
    name: str
    file: str
    anchor: str
    replacement: str


class PatchError(Exception):
    pass


def apply_patch(source_root: str, patch: Patch) -> bool:
    """Apply one patch. Returns True if the file changed, False if it was already applied."""
    path = os.path.join(source_root, patch.file)
    if not os.path.exists(path):
        raise PatchError(f'{patch.name}: file not found: {patch.file}')
    # latin-1 round-trips every byte; newline='' keeps line endings untouched.
    with open(path, encoding='latin-1', newline='') as f:
        text = f.read()
    if patch.replacement in text:
        return False
    count = text.count(patch.anchor)
    if count != 1:
        what = 'not found' if count == 0 else f'found {count} times'
        first_line = patch.anchor.splitlines()[0] if patch.anchor.strip() else patch.anchor
        raise PatchError(f'{patch.name}: anchor {what} in {patch.file}: {first_line!r}')
    with open(path, 'w', encoding='latin-1', newline='') as f:
        f.write(text.replace(patch.anchor, patch.replacement))
    return True


def apply_patches(source_root: str, patches) -> list:
    return [p.name for p in patches if apply_patch(source_root, p)]
```

- [ ] **Step 5: Write `emulator/patches.py`**

```python
"""fc2mp4's patch set for github.com/fightcadeorg/fightcade-fbneo (see docs/spike-findings.md)."""
from patcher import Patch

DECLARATIONS = (
    'int Fc2mp4DumpActive();\n'
    'void Fc2mp4DumpFrame(int bDraw);\n'
    'int Fc2mp4DumpIdleExpired();\n'
    'void Fc2mp4DumpEndAndExit();\n'
    '\n'
)

PATCHES = [
    # GCC rejects an ordered comparison of a pointer with 0 (MSVC accepts it).
    Patch(
        name='vid-overlay-pointer-compare',
        file='src/intf/video/win32/vid_overlay.cpp',
        anchor='while (ini > 0 && ini < end)',
        replacement='while (ini != 0 && ini < end)',
    ),
    # Every frame must be drawn while dumping, even in the fast-forward loop.
    Patch(
        name='dump-declarations-and-force-draw',
        file='src/burner/win32/run.cpp',
        anchor='int RunFrame(int bDraw, int bPause, int bInput)\n{\n',
        replacement=DECLARATIONS
        + 'int RunFrame(int bDraw, int bPause, int bInput)\n{\n\tif (Fc2mp4DumpActive()) bDraw = 1;\n',
    ),
    # Write the frame and its audio right after it is emulated (next to the AVI writer call).
    Patch(
        name='dump-each-frame',
        file='src/burner/win32/run.cpp',
        anchor='#ifdef INCLUDE_AVI_RECORDING\n\t\tif (nAviStatus) {\n\t\t\tif (AviRecordFrame(bDraw)) {',
        replacement='\t\tFc2mp4DumpFrame(bDraw);\n\n'
        '#ifdef INCLUDE_AVI_RECORDING\n\t\tif (nAviStatus) {\n\t\t\tif (AviRecordFrame(bDraw)) {',
    ),
    # Run the fast-forward loop while dumping: faster than real time.
    Patch(
        name='fast-forward-while-dumping',
        file='src/burner/win32/run.cpp',
        anchor='\t\tif (bAppDoFast) {\t\t\t\t    // do more frames',
        replacement='\t\tif (bAppDoFast || Fc2mp4DumpActive()) {\t\t\t\t    // do more frames',
    ),
    # The replay stream never disconnects at its end: exit once no frame came for FC2MP4_IDLE_MS.
    Patch(
        name='exit-when-stream-idle',
        file='src/burner/win32/run.cpp',
        anchor='int RunIdle()\n{\n',
        replacement='int RunIdle()\n{\n\tif (Fc2mp4DumpIdleExpired()) {\n\t\tFc2mp4DumpEndAndExit();\n\t}\n',
    ),
    # A real disconnect also ends the dump.
    Patch(
        name='exit-on-stream-disconnect',
        file='src/burner/win32/fbn_ggpo.cpp',
        anchor='void QuarkFinishReplay()\n{\n',
        replacement='int Fc2mp4DumpActive();\nvoid Fc2mp4DumpEndAndExit();\n\n'
        'void QuarkFinishReplay()\n{\n\tif (Fc2mp4DumpActive()) {\n\t\tFc2mp4DumpEndAndExit();\n\t}\n',
    ),
]
```

- [ ] **Step 6: Run the tests**

Run: `python3 -m unittest discover -s emulator -p 'test_*.py' -v`
Expected: 8 tests, all OK.

- [ ] **Step 7: Commit**

```bash
git add -A .gitignore emulator native vendor spike
git commit -m "feat: anchored source patcher and fc2mp4 patch set; drop rev 1 helper"
```

---

### Task 2: Emulator build script, dump source, and a real build + replay check

**Files:**
- Create: `emulator/build.py`, `emulator/src/fc2mp4_dump.cpp`, `emulator/stubs/hq_shared32.cpp`

**Interfaces:**
- Consumes: `apply_patches`, `PatchError` (Task 1), `PATCHES`.
- Produces: CLI `python3 emulator/build.py --source-dir DIR --out-dir DIR --ggponet PATH [--ref master] [--jobs N] [--skip-fetch]`. Exit 0 prints one JSON line `{"sourceCommit": "...", "exe": "...", "builtAt": "..."}` on stdout and writes `<out>/build-info.json`. Exit 2 on a patch error (stderr starts `PATCH FAILED:`), 3 on a compile/link error (stderr `BUILD FAILED: see <out>/build.log`), 4 on a fetch error. The exe is written to `<out>/fcadefbneo-fc2mp4.exe` only on success (via a temp name + rename), so a failed build keeps the previous exe.
- Emulator behaviour (env contract in Global Constraints): writes raw frames to `FC2MP4_VIDEO`, audio to `FC2MP4_AUDIO`, info on the first frame to `FC2MP4_INFO`, exits by itself `FC2MP4_IDLE_MS` after the last frame or on disconnect.

- [ ] **Step 1: Write the dump source**

`emulator/src/fc2mp4_dump.cpp`:
```cpp
// fc2mp4: stream every emulated frame (raw rows of pVidImage) to FC2MP4_VIDEO and its audio
// (s16le stereo) to FC2MP4_AUDIO, bypassing the AVI writer. Inactive unless both are set.
#include "burner.h"

static FILE* fVideo = NULL;
static FILE* fAudio = NULL;
static bool bChecked = false;
static bool bActive = false;
static bool bInfoWritten = false;
static UINT32 nDumpedFrames = 0;
static DWORD nLastFrameTick = 0;
static DWORD nIdleMs = 5000;

int Fc2mp4DumpActive()
{
	if (!bChecked) {
		bChecked = true;
		const char* video = getenv("FC2MP4_VIDEO");
		const char* audio = getenv("FC2MP4_AUDIO");
		const char* idle = getenv("FC2MP4_IDLE_MS");
		if (idle && atoi(idle) > 0) {
			nIdleMs = (DWORD)atoi(idle);
		}
		if (video && *video && audio && *audio) {
			fVideo = fopen(video, "wb");	// a FIFO: blocks until the encoder opens it
			fAudio = fopen(audio, "wb");
			bActive = fVideo && fAudio;
		}
	}
	return bActive;
}

static void WriteInfo()
{
	bInfoWritten = true;
	const char* path = getenv("FC2MP4_INFO");
	if (!path || !*path) return;
	FILE* f = fopen(path, "w");
	if (!f) return;
	fprintf(f, "width=%d\nheight=%d\nbpp=%d\nfps_x100=%d\nsample_rate=%d\n",
		nVidImageWidth, nVidImageHeight, nVidImageBPP, nBurnFPS, nBurnSoundRate);
	fclose(f);
}

void Fc2mp4DumpFrame(int bDraw)
{
	if (!Fc2mp4DumpActive() || !bDrvOkay || !bDraw || pVidImage == NULL) return;
	if (!bInfoWritten) WriteInfo();

	INT32 rowBytes = nVidImageWidth * nVidImageBPP;
	for (INT32 y = 0; y < nVidImageHeight; y++) {
		fwrite(pVidImage + y * nVidImagePitch, rowBytes, 1, fVideo);
	}
	if (nAudNextSound) {
		fwrite(nAudNextSound, nBurnSoundLen * 4, 1, fAudio);
	}
	nDumpedFrames++;
	nLastFrameTick = GetTickCount();
}

// True once frames have started and none came for nIdleMs: the replay stream has ended.
int Fc2mp4DumpIdleExpired()
{
	if (!bActive || nDumpedFrames == 0) return 0;
	return GetTickCount() - nLastFrameTick >= nIdleMs;
}

void Fc2mp4DumpEndAndExit()
{
	if (bActive) {
		bActive = false;
		fclose(fVideo);
		fclose(fAudio);
	}
	ExitProcess(0);
}
```

`emulator/stubs/hq_shared32.cpp`:
```cpp
// Stub for the MSVC-inline-asm hq scaler helpers (GCC cannot compile them); fc2mp4 never uses
// the hq3xs blitter effect.
void Interp1(unsigned char *, unsigned int, unsigned int) {}
void Interp2(unsigned char *, unsigned int, unsigned int, unsigned int) {}
void Interp3(unsigned char *, unsigned int, unsigned int) {}
void Interp4(unsigned char *, unsigned int, unsigned int, unsigned int) {}
void Interp5(unsigned char *, unsigned int, unsigned int) {}
void Interp1_16(unsigned char *, unsigned short, unsigned short) {}
void Interp2_16(unsigned char *, unsigned short, unsigned short, unsigned short) {}
void Interp3_16(unsigned char *, unsigned short, unsigned short) {}
void Interp4_16(unsigned char *, unsigned short, unsigned short, unsigned short) {}
void Interp5_16(unsigned char *, unsigned short, unsigned short) {}
bool Diff(unsigned int, unsigned int) { return false; }
unsigned int RGBtoYUV(unsigned int c) { return c; }
```

- [ ] **Step 2: Write `emulator/build.py`**

```python
#!/usr/bin/env python3
"""Fetch fightcade-fbneo, apply fc2mp4's patches and cross-compile it for Win32 with mingw-w64.

Self-contained so it can also run in CI later: inputs are a git ref and this folder; outputs are
<out>/fcadefbneo-fc2mp4.exe and <out>/build-info.json.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from patcher import PatchError, apply_patches
from patches import PATCHES

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = 'https://github.com/fightcadeorg/fightcade-fbneo.git'
EXE_NAME = 'fcadefbneo-fc2mp4.exe'
CC = 'i686-w64-mingw32-gcc'
CXX = 'i686-w64-mingw32-g++'
WINDRES = 'i686-w64-mingw32-windres'
EXIT_PATCH, EXIT_BUILD, EXIT_FETCH = 2, 3, 4

PERL_GENERATORS = [
    ('toa_gp9001_func.pl', 'toa_gp9001_func.h'),
    ('neo_sprite_func.pl', 'neo_sprite_func.h'),
    ('cave_tile_func.pl', 'cave_tile_func.h'),
    ('cave_sprite_func.pl', 'cave_sprite_func.h'),
    ('psikyo_tile_func.pl', 'psikyo_tile_func.h'),
]
HOST_GENERATORS = [
    ('src/burn/drv/capcom/ctv_make.cpp', 'ctv.h'),
    ('src/burn/drv/pgm/pgm_sprite_create.cpp', 'pgm_sprite.h'),
    ('src/dep/scripts/build_details.cpp', 'build_details.h'),
]
# Generated headers include *_render.h files that live next to these drivers.
GENERATED_INCLUDE_DIRS = ['capcom', 'cave', 'neogeo', 'psikyo', 'toaplan']
LIBS = ['-ld3dx9_43', '-ld3d9', '-ldinput8', '-ldsound', '-ldxguid', '-lksuser', '-lvfw32', '-lwininet',
        '-lws2_32', '-lsetupapi', '-lcomdlg32', '-lcomctl32', '-lshell32', '-lshlwapi', '-lwinmm',
        '-lole32', '-loleaut32', '-luuid', '-ladvapi32', '-lgdi32', '-luser32']


class BuildError(Exception):
    pass


def run(cmd, cwd=None):
    result = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, errors='replace')
    if result.returncode != 0:
        raise BuildError(f"{' '.join(cmd)}\n{result.stdout}{result.stderr}")
    return result.stdout


def fetch(source_dir, ref):
    if not os.path.isdir(os.path.join(source_dir, '.git')):
        os.makedirs(os.path.dirname(os.path.abspath(source_dir)), exist_ok=True)
        run(['git', 'clone', '--depth', '1', '--branch', ref, REPO, source_dir])
    else:
        run(['git', '-C', source_dir, 'fetch', '--depth', '1', 'origin', ref])
        run(['git', '-C', source_dir, 'checkout', '--force', 'FETCH_HEAD'])
        run(['git', '-C', source_dir, 'clean', '-fdx'])
    return run(['git', '-C', source_dir, 'rev-parse', 'HEAD']).strip()


def project_files(source_root):
    proj = os.path.join(source_root, 'projectfiles', 'visualstudio-2015')
    with open(os.path.join(proj, 'fbneo_vs2015.vcxproj'), encoding='utf-8-sig') as f:
        vcx = f.read()

    def norm(p):
        return os.path.normpath(os.path.join(proj, p.replace('\\', '/')))

    excluded = {norm(m) for m in re.findall(r'<ClCompile Include="([^"]+)">\s*<ExcludedFromBuild', vcx)}
    sources = [norm(m) for m in re.findall(r'<ClCompile Include="([^"]+)"', vcx) if norm(m) not in excluded]
    release = re.search(
        r"<ItemDefinitionGroup Condition=\"'\$\(Configuration\)\|\$\(Platform\)'=='Release\|Win32'\">(.*?)</ItemDefinitionGroup>",
        vcx, re.S).group(1)
    includes = [norm(i) for i in re.search(r'<AdditionalIncludeDirectories>([^<]*)', release).group(1).split(';')
                if i and not i.startswith('%')]
    defines = [d for d in re.search(r'<PreprocessorDefinitions>([^<]*)', release).group(1).split(';')
               if d and not d.startswith('%')]
    return sources, includes, defines


def generate(source_root, gen, host, sources):
    os.makedirs(gen, exist_ok=True)
    os.makedirs(host, exist_ok=True)
    scripts = os.path.join(source_root, 'src', 'dep', 'scripts')

    def missing(name):
        return not os.path.exists(os.path.join(gen, name))

    if missing('driverlist.h'):
        drivers = [s for s in sources if '/src/burn/drv/' in s and s.endswith('.cpp')]
        run(['perl', os.path.join(scripts, 'gamelist.pl'), '-o', os.path.join(gen, 'driverlist.h'),
             '-l', os.path.join(gen, 'gamelist.txt')] + drivers)
    for script, out in PERL_GENERATORS:
        if missing(out):
            run(['perl', os.path.join(scripts, script), '-o', os.path.join(gen, out)])
    for src, out in HOST_GENERATORS:
        if missing(out):
            exe = os.path.join(host, os.path.basename(src) + '.bin')
            run(['c++', '-O1', '-w', os.path.join(source_root, src), '-o', exe])
            with open(os.path.join(gen, out), 'w') as f:
                f.write(run([exe]))
    if missing('m68kops.c'):
        exe = os.path.join(host, 'm68kmake.bin')
        run(['cc', '-O1', '-w', '-DINLINE=static inline', os.path.join(source_root, 'src/cpu/m68k/m68kmake.c'), '-o', exe])
        run([exe, gen + '/', os.path.join(source_root, 'src/cpu/m68k/m68k_in.c')])
    if missing('license.rtf'):
        run(['perl', os.path.join(scripts, 'license2rtf.pl'), os.path.join(source_root, 'src/license.txt'),
             '-o', os.path.join(gen, 'license.rtf')])
    if missing('app_gnuc.rc'):
        run(['perl', os.path.join(scripts, 'fixrc.pl'), os.path.join(source_root, 'src/burner/win32/app.rc'),
             '-o', os.path.join(gen, 'app_gnuc.rc')])


def file_flags(src, source_root):
    """Per-file workarounds for code written for MSVC."""
    flags = []
    if src.endswith('.cpp'):
        flags.append('-D__int64=long long')
    if src.endswith('aud_xaudio2.cpp'):
        # FBNeo's bundled XAudio2 2.7 header (COM); mingw's 2.8 import fails in Fightcade's Wine.
        flags.append('-I' + os.path.join(source_root, 'src/dep/mingw/include/xaudio2'))
    if src.endswith('/burner/luaengine.cpp'):
        # A file-local static that GCC would merge with scrn.cpp's global of the same name.
        flags.append('-DnSavestateSlot=nLuaSavestateSlot')
    if src.endswith('vid_directx_support.cpp'):
        flags.append('-finput-charset=CP1252')
    return flags


def object_path(obj, source_root, src):
    if src.startswith(source_root + os.sep):
        rel = os.path.relpath(src, source_root)
    else:
        rel = os.path.join('fc2mp4', os.path.relpath(src, HERE))
    return os.path.join(obj, os.path.splitext(rel)[0] + '.o')


def compile_all(source_root, obj, gen, sources, includes, defines, jobs):
    drv_includes = ['-I' + os.path.join(source_root, 'src/burn/drv', d) for d in GENERATED_INCLUDE_DIRS]
    common_includes = ['-I' + gen] + drv_includes + ['-I' + i for i in includes] + \
        ['-I' + os.path.join(source_root, 'src/dep/mingw/include')]
    common_defines = ['-D' + d.replace('__inline static', 'static inline') for d in defines if not d.startswith('FASTCALL')]

    def compile_one(src):
        out = object_path(obj, source_root, src)
        if os.path.exists(out) and os.path.getmtime(out) > os.path.getmtime(src):
            return None
        os.makedirs(os.path.dirname(out), exist_ok=True)
        is_c = src.endswith('.c')
        cmd = [CC if is_c else CXX, '-c', src, '-o', out, '-O2', '-m32', '-w', '-fno-strict-aliasing',
               '-std=gnu99' if is_c else '-std=gnu++17', '-DUNICODE', '-D_UNICODE', '-D__fastcall=', '-DFASTCALL=']
        if not is_c:
            cmd.append('-fpermissive')
        cmd += common_defines + file_flags(src, source_root) + ['-I' + os.path.dirname(src)] + common_includes
        result = subprocess.run(cmd, capture_output=True, text=True, errors='replace')
        return (src, result.stderr) if result.returncode != 0 else None

    with ThreadPoolExecutor(jobs) as pool:
        return [f for f in pool.map(compile_one, sources) if f]


def build(source_root, out_dir, commit, ggponet, jobs):
    sources, includes, defines = project_files(source_root)
    obj = os.path.join(out_dir, 'obj', commit[:12])
    gen = os.path.join(obj, 'generated')
    stub = os.path.join(HERE, 'stubs', 'hq_shared32.cpp')
    sources = [stub if s.endswith('/scalers/hq_shared32.cpp') else s for s in sources]
    sources = [os.path.join(gen, os.path.basename(s)) if '/visualstudio-2015/generated/' in s else s for s in sources]
    sources.append(os.path.join(HERE, 'src', 'fc2mp4_dump.cpp'))
    generate(source_root, gen, os.path.join(obj, 'host'), sources)

    failures = compile_all(source_root, obj, gen, sources, includes, defines, jobs)
    if failures:
        details = '\n'.join(f'=== {os.path.relpath(src, source_root)}\n{err}' for src, err in failures)
        raise BuildError(f'{len(failures)} file(s) failed to compile\n{details}')

    rc = os.path.join(source_root, 'src/burner/win32/resource.rc')
    rc_obj = os.path.join(obj, 'resource.o')
    if not os.path.exists(rc_obj):
        run([WINDRES, '-DUNICODE', '-D_UNICODE', '-DBUILD_WIN32', '--codepage=1252', '-I' + gen,
             '-I' + os.path.dirname(rc), '-I' + os.path.join(source_root, 'src/burner/win32/resource'),
             '-I' + os.path.join(source_root, 'src/burner'), '-I' + os.path.join(source_root, 'src/burn'),
             '-I' + os.path.join(source_root, 'src/intf/video/win32'), rc, '-o', rc_obj], cwd=os.path.dirname(rc))

    objects = [object_path(obj, source_root, s) for s in sources] + [rc_obj]
    rsp = os.path.join(obj, 'objects.rsp')
    with open(rsp, 'w') as f:
        f.write('\n'.join(objects))
    exe = os.path.join(out_dir, EXE_NAME)
    tmp = exe + '.tmp'
    run([CXX, '-m32', '-mwindows', '-static', '-O2', '-s', '-o', tmp, '@' + rsp, ggponet] + LIBS)
    os.replace(tmp, exe)

    for old in os.listdir(os.path.join(out_dir, 'obj')):
        if old != commit[:12]:
            shutil.rmtree(os.path.join(out_dir, 'obj', old), ignore_errors=True)
    return exe


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-dir', required=True)
    parser.add_argument('--out-dir', required=True)
    parser.add_argument('--ggponet', required=True, help="Fightcade's ggponet.dll (linked against)")
    parser.add_argument('--ref', default='master')
    parser.add_argument('--jobs', type=int, default=os.cpu_count() or 4)
    parser.add_argument('--skip-fetch', action='store_true', help='build --source-dir as it is')
    args = parser.parse_args(argv)

    source_dir = os.path.abspath(args.source_dir)
    out_dir = os.path.abspath(args.out_dir)
    os.makedirs(out_dir, exist_ok=True)
    log_path = os.path.join(out_dir, 'build.log')

    try:
        commit = (run(['git', '-C', source_dir, 'rev-parse', 'HEAD']).strip() if args.skip_fetch
                  else fetch(source_dir, args.ref))
    except BuildError as err:
        print(f'FETCH FAILED: {err}', file=sys.stderr)
        return EXIT_FETCH
    try:
        apply_patches(source_dir, PATCHES)
    except PatchError as err:
        print(f'PATCH FAILED: {err}', file=sys.stderr)
        return EXIT_PATCH
    try:
        exe = build(source_dir, out_dir, commit, os.path.abspath(args.ggponet), args.jobs)
    except BuildError as err:
        with open(log_path, 'w') as f:
            f.write(str(err))
        print(f'BUILD FAILED: see {log_path}', file=sys.stderr)
        return EXIT_BUILD

    info = {'sourceCommit': commit, 'exe': exe, 'builtAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    with open(os.path.join(out_dir, 'build-info.json'), 'w') as f:
        json.dump(info, f, indent=2)
    print(json.dumps(info))
    return 0


if __name__ == '__main__':
    sys.exit(main())
```

- [ ] **Step 3: Build for real**

Run:
```sh
C=~/Library/Caches/fc2mp4
time python3 emulator/build.py --source-dir $C/fightcade-fbneo --out-dir $C/runtime \
  --ggponet /Applications/FightCade2.app/Contents/MacOS/emulator/fbneo/ggponet.dll
i686-w64-mingw32-objdump -p $C/runtime/fcadefbneo-fc2mp4.exe | grep -E 'ggponet|XAudio'
```
Expected: exit 0 and a JSON line with `sourceCommit`; objdump shows `DLL Name: ggponet.dll` and no XAudio line. If a patch fails, the anchors changed upstream since the spike: fix the anchor in `patches.py` (re-run Task 1's tests) and record a Ruling.

- [ ] **Step 4: Run the short replay with the dump going to files**

Prepare the runtime by hand (Task 7 automates this) and run:
```sh
C=~/Library/Caches/fc2mp4; RT=$C/runtime; F=/Applications/FightCade2.app/Contents/MacOS/emulator/fbneo
cp $F/*.dll $RT/ && ln -sfn $F/ROMs $RT/ROMs && mkdir -p $RT/config
sed -e 's/^nVidSelect .*/nVidSelect 0/' -e 's/^bVidFullStretch .*/bVidFullStretch 1/' -e 's/^bAutoPause .*/bAutoPause 0/' \
  $F/config/fcadefbneo.ini > $RT/config/fcadefbneo.ini
D=$(mktemp -d); W="Z:$(echo $D | tr / '\\')"
cd $RT && time env FC2MP4_VIDEO="$W\\video.raw" FC2MP4_AUDIO="$W\\audio.raw" FC2MP4_INFO="$W\\info.txt" FC2MP4_IDLE_MS=5000 \
  /Applications/FightCade2.app/Contents/Resources/wine.sh "$RT/fcadefbneo-fc2mp4.exe" quark:stream,sfiii3nr1,1791006077129-2245.7,7100
cat $D/info.txt
python3 -c "import os;v=os.path.getsize('$D/video.raw')/344064;a=os.path.getsize('$D/audio.raw')/4/44100;print(v, v/59.59, a)"
rm -rf $D
```
Expected: the command **returns by itself** within about 30 s (no Ctrl-C needed); `info.txt` shows `width=384 height=224 bpp=4 fps_x100=5959 sample_rate=44100`; about 8220 frames; video seconds and audio seconds differ by less than 0.02. A hang means the idle exit didn't fire: debug with superpowers:systematic-debugging.

- [ ] **Step 5: Commit**

```bash
git add emulator
git commit -m "feat: build script for patched Fightcade FBNeo with raw frame dump and idle exit"
```

---

### Task 3: TypeScript scaffold, errors, constants, `parseReplayRef`

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `src/errors.ts`, `src/constants.ts`, `src/replayRef.ts`
- Test: `tests/replayRef.test.ts`

**Interfaces:**
- Produces: `ExitCode`, `ExitCodeValue`, `ConvertError(exitCode, message, hint?)`; constants `GAME`, `QUARK_SUFFIX`, `STREAM_PORT`, `EMULATOR_EXE`, `FRAME_FORMAT`, `TIMEOUTS`, `DEFAULT_MAX_DURATION_MS`, `RUNTIME_INI`; `ReplayRef { game: 'sfiii3nr1'; quarkId: string }`, `parseReplayRef(input): ReplayRef`, `streamArg(quarkId): string`.

- [ ] **Step 1: Node version**

Run: `source ~/.nvm/nvm.sh && nvm use 24 && node --version`
Expected: `v24.x`. Use this Node for every later step (`nvm use 24` in each new shell).

- [ ] **Step 2: Package files**

`package.json`:
```json
{
  "name": "fc2mp4",
  "version": "0.2.0",
  "description": "Convert Fightcade Street Fighter III: 3rd Strike replays to MP4",
  "type": "module",
  "bin": { "fc2mp4": "dist/cli.js" },
  "files": ["dist", "emulator"],
  "engines": { "node": ">=22.12" },
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:emulator": "python3 -m unittest discover -s emulator -p 'test_*.py'",
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
Expected: no errors.

- [ ] **Step 3: `src/errors.ts` and `src/constants.ts`**

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

`src/constants.ts`:
```ts
export const GAME = 'sfiii3nr1';

// Fightcade's client appends ".7" to the quark ID from the link; without it the stream never loads.
export const QUARK_SUFFIX = '.7';
export const STREAM_PORT = 7100;

export const EMULATOR_EXE = 'fcadefbneo-fc2mp4.exe';

// Raw format written by the patched emulator for sfiii3nr1; checked against its info file.
export const FRAME_FORMAT = { width: 384, height: 224, bpp: 4, fpsX100: 5959, sampleRate: 44100 } as const;

export const TIMEOUTS = {
  firstFrameMs: 60_000,
  emulatorIdleMs: 5_000,
  killMs: 15_000,
  pollMs: 500,
} as const;

export const DEFAULT_MAX_DURATION_MS = 60 * 60_000;

// DirectDraw renderer (DX9 Alt crashes our build under Wine), no aspect maths, never auto-pause.
export const RUNTIME_INI: ReadonlyArray<readonly [string, string]> = [
  ['nVidSelect', '0'],
  ['bVidFullStretch', '1'],
  ['bAutoPause', '0'],
];
```

- [ ] **Step 4: Failing tests**

`tests/replayRef.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseReplayRef, streamArg } from '../src/replayRef.js';
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

  it('rejects another game with a usage error naming it', () => {
    let error: unknown;
    try {
      parseReplayRef(`https://replay.fightcade.com/fbneo/garou/${ID}`);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConvertError);
    expect(error).toMatchObject({ exitCode: ExitCode.Usage, message: expect.stringContaining('garou') });
  });

  it.each([[''], ['hello'], ['https://replay.fightcade.com/'], ['1700000000000']])('rejects %j', (input) => {
    expect(() => parseReplayRef(input)).toThrow(/Not a Fightcade replay/);
  });
});

describe('streamArg', () => {
  it('builds the quark:stream argument with the client suffix and port', () => {
    expect(streamArg(ID)).toBe(`quark:stream,sfiii3nr1,${ID}.7,7100`);
  });
});
```

- [ ] **Step 5: Run and watch them fail**

Run: `npx vitest run tests/replayRef.test.ts`
Expected: FAIL, cannot resolve `../src/replayRef.js`.

- [ ] **Step 6: Implement `src/replayRef.ts`**

```ts
import { GAME, QUARK_SUFFIX, STREAM_PORT } from './constants.js';
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
  return { game: GAME, quarkId: quarkId! };
}

export function streamArg(quarkId: string): string {
  return `quark:stream,${GAME},${quarkId}${QUARK_SUFFIX},${STREAM_PORT}`;
}
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npx vitest run tests/replayRef.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsconfig.build.json src tests
git commit -m "feat: scaffold TypeScript project and parse replay links"
```

---

### Task 4: Output path resolution

**Files:**
- Create: `src/outputPath.ts`
- Test: `tests/outputPath.test.ts`

**Interfaces:**
- Produces: `defaultOutputDir(home: string): string`; `resolveOutputPath(quarkId: string, output: string | undefined, home: string, isDir?: (p: string) => Promise<boolean>): Promise<string>` (absolute when `output` is relative: resolved against `process.cwd()`).

- [ ] **Step 1: Failing tests**

`tests/outputPath.test.ts`:
```ts
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultOutputDir, resolveOutputPath } from '../src/outputPath.js';

const HOME = '/Users/fran';
const never = async () => false;

describe('output path', () => {
  it('defaults to ~/Movies/Fightcade/<quarkId>.mp4', async () => {
    expect(defaultOutputDir(HOME)).toBe('/Users/fran/Movies/Fightcade');
    expect(await resolveOutputPath('1-2', undefined, HOME, never)).toBe('/Users/fran/Movies/Fightcade/1-2.mp4');
  });
  it('treats an existing directory as the target folder', async () => {
    expect(await resolveOutputPath('1-2', '/tmp/out', HOME, async (p) => p === '/tmp/out')).toBe('/tmp/out/1-2.mp4');
  });
  it('treats a trailing slash as a folder', async () => {
    expect(await resolveOutputPath('1-2', '/tmp/new/', HOME, never)).toBe('/tmp/new/1-2.mp4');
  });
  it('keeps an explicit file path and makes relative paths absolute', async () => {
    expect(await resolveOutputPath('1-2', '/tmp/final.mp4', HOME, never)).toBe('/tmp/final.mp4');
    expect(await resolveOutputPath('1-2', 'clips/a.mp4', HOME, never)).toBe(resolve('clips/a.mp4'));
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/outputPath.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/outputPath.ts`**

```ts
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export function defaultOutputDir(home: string): string {
  return join(home, 'Movies', 'Fightcade');
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
  home: string,
  isDir: (p: string) => Promise<boolean> = isDirectory,
): Promise<string> {
  const fileName = `${quarkId}.mp4`;
  if (output === undefined) return join(defaultOutputDir(home), fileName);
  if (output.endsWith('/') || output.endsWith(sep) || (await isDir(output))) return resolve(output, fileName);
  return resolve(output);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/outputPath.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/outputPath.ts tests/outputPath.test.ts
git commit -m "feat: resolve MP4 output path"
```

---

### Task 5: Process helpers, file helpers, Fightcade install + preflight

**Files:**
- Create: `src/exec.ts`, `src/fsUtil.ts`, `src/install.ts`
- Test: `tests/install.test.ts`

**Interfaces:**
- Produces:
  - `exec`: `RunResult { code: number | null; stdout: string; stderr: string }`; `RunFn = (cmd, args, opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }) => Promise<RunResult>`; `run: RunFn`; `which(cmd): Promise<string | null>`.
  - `fsUtil`: `pathExists(p): Promise<boolean>`; `sha256File(p): Promise<string>`.
  - `install`: `FightcadeInstall { root; fbneoDir; exe; ggponet; romsDir; rom; mainIni; wineSh }`; `installLayout(root)`; `candidateRoots(home)`; `locateInstall(opts: { platform: NodeJS.Platform; home: string; override?: string; exists: (p: string) => Promise<boolean> })`; `PreflightDeps { exists; which }`; `preflight(install, deps)`.

- [ ] **Step 1: Failing tests**

`tests/install.test.ts`:
```ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installLayout, locateInstall, preflight, type PreflightDeps } from '../src/install.js';
import { sha256File } from '../src/fsUtil.js';
import { ExitCode } from '../src/errors.js';

const ROOT = '/Applications/FightCade2.app';

describe('installLayout', () => {
  it('maps the macOS app bundle', () => {
    const i = installLayout(ROOT);
    expect(i.fbneoDir).toBe(`${ROOT}/Contents/MacOS/emulator/fbneo`);
    expect(i.exe).toBe(`${i.fbneoDir}/fcadefbneo.exe`);
    expect(i.ggponet).toBe(`${i.fbneoDir}/ggponet.dll`);
    expect(i.romsDir).toBe(`${i.fbneoDir}/ROMs`);
    expect(i.rom).toBe(`${i.fbneoDir}/ROMs/sfiii3nr1.zip`);
    expect(i.mainIni).toBe(`${i.fbneoDir}/config/fcadefbneo.ini`);
    expect(i.wineSh).toBe(`${ROOT}/Contents/Resources/wine.sh`);
  });
});

describe('locateInstall', () => {
  const home = '/Users/fran';
  it('finds the first candidate with the emulator and ggponet.dll', async () => {
    const userRoot = `${home}/Applications/FightCade2.app`;
    const exists = async (p: string) => p.startsWith(userRoot);
    expect((await locateInstall({ platform: 'darwin', home, exists })).root).toBe(userRoot);
  });
  it('explains a wrong --fightcade-dir', async () => {
    await expect(locateInstall({ platform: 'darwin', home, override: '/nope', exists: async () => false })).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      hint: expect.stringContaining('/nope'),
    });
  });
  it('rejects platforms other than macOS', async () => {
    await expect(locateInstall({ platform: 'linux', home, exists: async () => true })).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: expect.stringContaining('macOS'),
    });
  });
});

describe('preflight', () => {
  const install = installLayout(ROOT);
  const ok: PreflightDeps = { exists: async () => true, which: async () => '/opt/homebrew/bin/ffmpeg' };

  it('passes when everything is present', async () => {
    await expect(preflight(install, ok)).resolves.toBeUndefined();
  });
  it.each([
    ['ROM', { exists: async (p: string) => !p.endsWith('sfiii3nr1.zip') }, /ROM not found/],
    ['wine.sh', { exists: async (p: string) => !p.endsWith('wine.sh') }, /wine\.sh not found/],
    ['ffmpeg', { which: async () => null }, /ffmpeg not found/],
  ])('fails when %s is missing', async (_name, override, message) => {
    await expect(preflight(install, { ...ok, ...override })).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: expect.stringMatching(message),
    });
  });
});

describe('sha256File', () => {
  it('hashes file contents', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'fc2mp4-hash-')), 'a.txt');
    await writeFile(file, 'abc');
    expect(await sha256File(file)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/install.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/exec.ts`**

```ts
import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type RunFn = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<RunResult>;

export const run: RunFn = (cmd, args, opts = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const result = await run('which', [cmd]).catch(() => null);
  if (!result || result.code !== 0) return null;
  return result.stdout.trim() || null;
}
```

- [ ] **Step 4: Implement `src/fsUtil.ts`**

```ts
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export function sha256File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(p)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}
```

- [ ] **Step 5: Implement `src/install.ts`**

```ts
import { join } from 'node:path';
import { GAME } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';

export interface FightcadeInstall {
  root: string;
  fbneoDir: string;
  exe: string;
  ggponet: string;
  romsDir: string;
  rom: string;
  mainIni: string;
  wineSh: string;
}

export function installLayout(root: string): FightcadeInstall {
  const fbneoDir = join(root, 'Contents', 'MacOS', 'emulator', 'fbneo');
  return {
    root,
    fbneoDir,
    exe: join(fbneoDir, 'fcadefbneo.exe'),
    ggponet: join(fbneoDir, 'ggponet.dll'),
    romsDir: join(fbneoDir, 'ROMs'),
    rom: join(fbneoDir, 'ROMs', `${GAME}.zip`),
    mainIni: join(fbneoDir, 'config', 'fcadefbneo.ini'),
    wineSh: join(root, 'Contents', 'Resources', 'wine.sh'),
  };
}

export function candidateRoots(home: string): string[] {
  return ['/Applications/FightCade2.app', join(home, 'Applications', 'FightCade2.app')];
}

export async function locateInstall(opts: {
  platform: NodeJS.Platform;
  home: string;
  override?: string;
  exists: (p: string) => Promise<boolean>;
}): Promise<FightcadeInstall> {
  if (opts.platform !== 'darwin') {
    throw new ConvertError(ExitCode.Preflight, `fc2mp4 currently supports macOS only (this is ${opts.platform})`);
  }
  for (const root of opts.override ? [opts.override] : candidateRoots(opts.home)) {
    const install = installLayout(root);
    if ((await opts.exists(install.exe)) && (await opts.exists(install.ggponet))) return install;
  }
  throw new ConvertError(
    ExitCode.Preflight,
    'Fightcade install not found',
    opts.override
      ? `No Contents/MacOS/emulator/fbneo/fcadefbneo.exe + ggponet.dll under ${opts.override}`
      : 'Install Fightcade 2, or pass --fightcade-dir <path to FightCade2.app>',
  );
}

export interface PreflightDeps {
  exists(p: string): Promise<boolean>;
  which(cmd: string): Promise<string | null>;
}

export async function preflight(install: FightcadeInstall, deps: PreflightDeps): Promise<void> {
  if (!(await deps.exists(install.rom))) {
    throw new ConvertError(ExitCode.Preflight, `3rd Strike ROM not found: ${install.rom}`, 'Open 3rd Strike once in Fightcade so it downloads the ROM');
  }
  if (!(await deps.exists(install.wineSh))) {
    throw new ConvertError(ExitCode.Preflight, `wine.sh not found: ${install.wineSh}`, 'Reinstall Fightcade');
  }
  if ((await deps.which('ffmpeg')) === null) {
    throw new ConvertError(ExitCode.Preflight, 'ffmpeg not found on PATH', 'brew install ffmpeg');
  }
}
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/install.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/exec.ts src/fsUtil.ts src/install.ts tests/install.test.ts
git commit -m "feat: locate Fightcade install and run preflight checks"
```

---

### Task 6: Emulator build manager (fingerprints, manifest, last-good fallback)

**Files:**
- Create: `src/emulatorBuild.ts`
- Test: `tests/emulatorBuild.test.ts`

**Interfaces:**
- Consumes: `run`, `which` (Task 5), `sha256File`, `pathExists`, `FightcadeInstall`, `EMULATOR_EXE`, `ConvertError`.
- Produces:
  - `Fingerprint { fightcadeExeSha256: string; ggponetSha256: string; patchSetHash: string }`; `BuildManifest extends Fingerprint { sourceCommit: string; builtAt: string }`
  - `needsRebuild(manifest: BuildManifest | null, current: Fingerprint, exeExists: boolean): boolean`
  - `patchSetHash(emulatorDir: string): Promise<string>` (sha256 over every file in `emulator/` except `test_*.py` and `__pycache__`, sorted by relative path, hashing path + contents)
  - `EnsureDeps { fingerprint(); readManifest(); writeManifest(m); exeExists(); checkToolchain(); runBuild(): Promise<{ sourceCommit: string }>; now(): Date }`
  - `EnsureResult { rebuilt: boolean; warning?: string }`
  - `ensureEmulator(force: boolean, deps: EnsureDeps): Promise<EnsureResult>`
  - `EmulatorPaths { emulatorDir; sourceDir; runtimeDir }`; `defaultEmulatorPaths(home: string): EmulatorPaths` (`emulatorDir` = `<package root>/emulator`, `sourceDir` = `~/Library/Caches/fc2mp4/fightcade-fbneo`, `runtimeDir` = `~/Library/Caches/fc2mp4/runtime`)
  - `defaultEnsureDeps(install: FightcadeInstall, paths: EmulatorPaths, runFn?: RunFn): EnsureDeps`

- [ ] **Step 1: Failing tests**

`tests/emulatorBuild.test.ts`:
```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensureEmulator,
  needsRebuild,
  patchSetHash,
  type BuildManifest,
  type EnsureDeps,
  type Fingerprint,
} from '../src/emulatorBuild.js';
import { ConvertError, ExitCode } from '../src/errors.js';

const current: Fingerprint = { fightcadeExeSha256: 'exe1', ggponetSha256: 'dll1', patchSetHash: 'p1' };
const manifest: BuildManifest = { ...current, sourceCommit: 'abc', builtAt: '2026-10-01T00:00:00.000Z' };

describe('needsRebuild', () => {
  it('is false when nothing changed', () => {
    expect(needsRebuild(manifest, current, true)).toBe(false);
  });
  it.each([
    ['no manifest', null, current, true],
    ['exe missing', manifest, current, false],
    ['Fightcade emulator updated', manifest, { ...current, fightcadeExeSha256: 'exe2' }, true],
    ['ggponet updated', manifest, { ...current, ggponetSha256: 'dll2' }, true],
    ['patch set changed', manifest, { ...current, patchSetHash: 'p2' }, true],
  ] as const)('is true when %s', (_name, m, fp, exists) => {
    expect(needsRebuild(m, fp, exists)).toBe(true);
  });
});

function fakeDeps(opts: { manifest?: BuildManifest | null; exeExists?: boolean; build?: () => Promise<{ sourceCommit: string }>; toolchain?: () => Promise<void> }) {
  const calls: string[] = [];
  let written: BuildManifest | null = null;
  const deps: EnsureDeps = {
    fingerprint: async () => current,
    readManifest: async () => (opts.manifest === undefined ? manifest : opts.manifest),
    writeManifest: async (m) => {
      written = m;
    },
    exeExists: async () => opts.exeExists ?? true,
    checkToolchain: opts.toolchain ?? (async () => {}),
    runBuild: async () => {
      calls.push('build');
      return (opts.build ?? (async () => ({ sourceCommit: 'def' })))();
    },
    now: () => new Date('2026-10-03T12:00:00.000Z'),
  };
  return { deps, calls, written: () => written };
}

describe('ensureEmulator', () => {
  it('does nothing when the build is current', async () => {
    const { deps, calls } = fakeDeps({});
    expect(await ensureEmulator(false, deps)).toEqual({ rebuilt: false });
    expect(calls).toEqual([]);
  });

  it('rebuilds and records the new fingerprint when Fightcade changed', async () => {
    const { deps, calls, written } = fakeDeps({ manifest: { ...manifest, fightcadeExeSha256: 'old' } });
    expect(await ensureEmulator(false, deps)).toEqual({ rebuilt: true });
    expect(calls).toEqual(['build']);
    expect(written()).toEqual({ ...current, sourceCommit: 'def', builtAt: '2026-10-03T12:00:00.000Z' });
  });

  it('rebuilds when forced', async () => {
    const { deps, calls } = fakeDeps({});
    expect((await ensureEmulator(true, deps)).rebuilt).toBe(true);
    expect(calls).toEqual(['build']);
  });

  it('keeps the previous build with a warning when the rebuild fails', async () => {
    const { deps, written } = fakeDeps({
      manifest: { ...manifest, patchSetHash: 'old' },
      build: async () => {
        throw new ConvertError(ExitCode.Emulator, 'patch exit-when-stream-idle: anchor not found in src/burner/win32/run.cpp');
      },
    });
    const result = await ensureEmulator(false, deps);
    expect(result.rebuilt).toBe(false);
    expect(result.warning).toContain('exit-when-stream-idle');
    expect(result.warning).toContain('2026-10-01');
    expect(written()).toBeNull();
  });

  it('fails when the first build fails', async () => {
    const { deps } = fakeDeps({
      manifest: null,
      exeExists: false,
      build: async () => {
        throw new ConvertError(ExitCode.Emulator, 'BUILD FAILED');
      },
    });
    await expect(ensureEmulator(false, deps)).rejects.toMatchObject({ exitCode: ExitCode.Emulator });
  });

  it('reports a missing toolchain when there is no previous build', async () => {
    const { deps } = fakeDeps({
      manifest: null,
      exeExists: false,
      toolchain: async () => {
        throw new ConvertError(ExitCode.Preflight, 'Missing tools to build the emulator: i686-w64-mingw32-g++');
      },
    });
    await expect(ensureEmulator(false, deps)).rejects.toMatchObject({ exitCode: ExitCode.Preflight });
  });
});

describe('patchSetHash', () => {
  it('changes with patch files but ignores tests and caches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-patchset-'));
    await mkdir(join(dir, 'src'));
    await mkdir(join(dir, '__pycache__'));
    await writeFile(join(dir, 'patches.py'), 'A');
    await writeFile(join(dir, 'src', 'fc2mp4_dump.cpp'), 'B');
    const first = await patchSetHash(dir);

    await writeFile(join(dir, 'test_patcher.py'), 'tests');
    await writeFile(join(dir, '__pycache__', 'x.pyc'), 'cache');
    expect(await patchSetHash(dir)).toBe(first);

    await writeFile(join(dir, 'src', 'fc2mp4_dump.cpp'), 'C');
    expect(await patchSetHash(dir)).not.toBe(first);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/emulatorBuild.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/emulatorBuild.ts`**

```ts
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EMULATOR_EXE } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import { run, which, type RunFn } from './exec.js';
import { pathExists, sha256File } from './fsUtil.js';
import type { FightcadeInstall } from './install.js';

export interface Fingerprint {
  fightcadeExeSha256: string;
  ggponetSha256: string;
  patchSetHash: string;
}

export interface BuildManifest extends Fingerprint {
  sourceCommit: string;
  builtAt: string;
}

export function needsRebuild(manifest: BuildManifest | null, current: Fingerprint, exeExists: boolean): boolean {
  if (!manifest || !exeExists) return true;
  return (
    manifest.fightcadeExeSha256 !== current.fightcadeExeSha256 ||
    manifest.ggponetSha256 !== current.ggponetSha256 ||
    manifest.patchSetHash !== current.patchSetHash
  );
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === '__pycache__' || entry.name.startsWith('test_')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}

export async function patchSetHash(emulatorDir: string): Promise<string> {
  const hash = createHash('sha256');
  const files = (await listFiles(emulatorDir)).map((f) => relative(emulatorDir, f)).sort();
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(join(emulatorDir, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export interface EnsureDeps {
  fingerprint(): Promise<Fingerprint>;
  readManifest(): Promise<BuildManifest | null>;
  writeManifest(m: BuildManifest): Promise<void>;
  exeExists(): Promise<boolean>;
  checkToolchain(): Promise<void>;
  runBuild(): Promise<{ sourceCommit: string }>;
  now(): Date;
}

export interface EnsureResult {
  rebuilt: boolean;
  warning?: string;
}

export async function ensureEmulator(force: boolean, deps: EnsureDeps): Promise<EnsureResult> {
  const current = await deps.fingerprint();
  const manifest = await deps.readManifest();
  const exeExists = await deps.exeExists();
  if (!force && !needsRebuild(manifest, current, exeExists)) return { rebuilt: false };

  try {
    await deps.checkToolchain();
    const { sourceCommit } = await deps.runBuild();
    await deps.writeManifest({ ...current, sourceCommit, builtAt: deps.now().toISOString() });
    return { rebuilt: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (manifest && exeExists) {
      return { rebuilt: false, warning: `Could not rebuild the emulator (${message}); using the previous build from ${manifest.builtAt}` };
    }
    throw err instanceof ConvertError ? err : new ConvertError(ExitCode.Emulator, `Could not build the emulator: ${message}`);
  }
}

export interface EmulatorPaths {
  emulatorDir: string;
  sourceDir: string;
  runtimeDir: string;
}

export function defaultEmulatorPaths(home: string): EmulatorPaths {
  const cache = join(home, 'Library', 'Caches', 'fc2mp4');
  return {
    emulatorDir: fileURLToPath(new URL('../emulator', import.meta.url)),
    sourceDir: join(cache, 'fightcade-fbneo'),
    runtimeDir: join(cache, 'runtime'),
  };
}

const TOOLCHAIN = ['git', 'perl', 'python3', 'i686-w64-mingw32-g++'];

export function defaultEnsureDeps(install: FightcadeInstall, paths: EmulatorPaths, runFn: RunFn = run): EnsureDeps {
  const manifestPath = join(paths.runtimeDir, 'manifest.json');
  return {
    fingerprint: async () => ({
      fightcadeExeSha256: await sha256File(install.exe),
      ggponetSha256: await sha256File(install.ggponet),
      patchSetHash: await patchSetHash(paths.emulatorDir),
    }),
    readManifest: async () => {
      try {
        return JSON.parse(await readFile(manifestPath, 'utf8')) as BuildManifest;
      } catch {
        return null;
      }
    },
    writeManifest: (m) => writeFile(manifestPath, `${JSON.stringify(m, null, 2)}\n`),
    exeExists: () => pathExists(join(paths.runtimeDir, EMULATOR_EXE)),
    checkToolchain: async () => {
      const missing: string[] = [];
      for (const tool of TOOLCHAIN) if ((await which(tool)) === null) missing.push(tool);
      if (missing.length > 0) {
        throw new ConvertError(ExitCode.Preflight, `Missing tools to build the emulator: ${missing.join(', ')}`, 'brew install mingw-w64 git');
      }
    },
    runBuild: async () => {
      const result = await runFn(
        'python3',
        [join(paths.emulatorDir, 'build.py'), '--source-dir', paths.sourceDir, '--out-dir', paths.runtimeDir, '--ggponet', install.ggponet],
        { timeoutMs: 30 * 60_000 },
      );
      if (result.code !== 0) {
        const detail = result.stderr.trim().split('\n').slice(-3).join(' ');
        throw new ConvertError(ExitCode.Emulator, `Emulator build failed (exit ${result.code}): ${detail}`, `Build log: ${join(paths.runtimeDir, 'build.log')}`);
      }
      const lastLine = result.stdout.trim().split('\n').at(-1) ?? '{}';
      return { sourceCommit: (JSON.parse(lastLine) as { sourceCommit: string }).sourceCommit };
    },
    now: () => new Date(),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/emulatorBuild.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/emulatorBuild.ts tests/emulatorBuild.test.ts
git commit -m "feat: rebuild the emulator when Fightcade or the patch set changes, keep last good build"
```

---

### Task 7: Runtime folder

**Files:**
- Create: `src/iniPatch.ts`, `src/runtime.ts`
- Test: `tests/runtime.test.ts`

**Interfaces:**
- Consumes: `FightcadeInstall`, `RUNTIME_INI`, `pathExists`.
- Produces: `setIniValue(text, key, value): string`; `runtimeIni(base: string): string`; `prepareRuntime(install: FightcadeInstall, runtimeDir: string): Promise<void>` (copies every `*.dll` from `install.fbneoDir`, (re)creates the `ROMs` symlink → `install.romsDir`, writes `config/fcadefbneo.ini` = install ini with `RUNTIME_INI` applied, or only those keys if the install has none).

- [ ] **Step 1: Failing tests**

`tests/runtime.test.ts`:
```ts
import { mkdir, mkdtemp, readFile, readlink, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setIniValue } from '../src/iniPatch.js';
import { prepareRuntime, runtimeIni } from '../src/runtime.js';
import { installLayout } from '../src/install.js';

describe('setIniValue', () => {
  it('replaces, appends, keeps CRLF and ignores comments and prefixes', () => {
    expect(setIniValue('a 1\nnVidSelect 4\n', 'nVidSelect', '0')).toBe('a 1\nnVidSelect 0\n');
    expect(setIniValue('a 1', 'k', 'v')).toBe('a 1\nk v\n');
    expect(setIniValue('bAutoPause 1\r\nx 2\r\n', 'bAutoPause', '0')).toBe('bAutoPause 0\r\nx 2\r\n');
    expect(setIniValue('// bAutoPause x\nbAutoPause 1\n', 'bAutoPause', '0')).toBe('// bAutoPause x\nbAutoPause 0\n');
    expect(setIniValue('nVidSelectX 5\n', 'nVidSelect', '0')).toBe('nVidSelectX 5\nnVidSelect 0\n');
  });
});

describe('runtimeIni', () => {
  it('forces the DirectDraw renderer, full stretch and no auto-pause', () => {
    expect(runtimeIni('nVidSelect 4\nbVidFullStretch 0\nbAutoPause 1\nnAudSampleRate[0] 44100\n')).toBe(
      'nVidSelect 0\nbVidFullStretch 1\nbAutoPause 0\nnAudSampleRate[0] 44100\n',
    );
    expect(runtimeIni('')).toBe('nVidSelect 0\nbVidFullStretch 1\nbAutoPause 0\n');
  });
});

describe('prepareRuntime', () => {
  it('copies DLLs, links ROMs and writes our ini, idempotently', async () => {
    const base = await mkdtemp(join(tmpdir(), 'fc2mp4-rt-'));
    const install = installLayout(join(base, 'FightCade2.app'));
    await mkdir(join(install.fbneoDir, 'config'), { recursive: true });
    await mkdir(install.romsDir);
    await writeFile(join(install.fbneoDir, 'ggponet.dll'), 'g');
    await writeFile(join(install.fbneoDir, 'LUA51.DLL'), 'l');
    await writeFile(join(install.fbneoDir, 'notes.txt'), 'n');
    await writeFile(install.mainIni, 'nVidSelect 4\n');
    const runtime = join(base, 'runtime');

    await prepareRuntime(install, runtime);
    await prepareRuntime(install, runtime);

    expect((await readdir(runtime)).sort()).toEqual(['LUA51.DLL', 'ROMs', 'config', 'ggponet.dll']);
    expect(await readlink(join(runtime, 'ROMs'))).toBe(install.romsDir);
    expect(await readFile(join(runtime, 'config', 'fcadefbneo.ini'), 'latin1')).toBe(
      'nVidSelect 0\nbVidFullStretch 1\nbAutoPause 0\n',
    );
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/runtime.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/iniPatch.ts`**

```ts
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// FBNeo ini lines look like `key value`; `.` stops before \r so CRLF files keep their endings.
export function setIniValue(text: string, key: string, value: string): string {
  const pattern = new RegExp(`^${escapeRegExp(key)}[ \\t]+.*$`, 'm');
  const line = `${key} ${value}`;
  if (pattern.test(text)) return text.replace(pattern, line);
  if (text === '' || text.endsWith('\n')) return `${text}${line}\n`;
  return `${text}\n${line}\n`;
}
```

- [ ] **Step 4: Implement `src/runtime.ts`**

```ts
import { copyFile, mkdir, readdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RUNTIME_INI } from './constants.js';
import { pathExists } from './fsUtil.js';
import { setIniValue } from './iniPatch.js';
import type { FightcadeInstall } from './install.js';

export function runtimeIni(base: string): string {
  return RUNTIME_INI.reduce((text, [key, value]) => setIniValue(text, key, value), base);
}

export async function prepareRuntime(install: FightcadeInstall, runtimeDir: string): Promise<void> {
  await mkdir(join(runtimeDir, 'config'), { recursive: true });

  for (const name of await readdir(install.fbneoDir)) {
    if (/\.dll$/i.test(name)) await copyFile(join(install.fbneoDir, name), join(runtimeDir, name));
  }

  const romsLink = join(runtimeDir, 'ROMs');
  try {
    await unlink(romsLink);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await symlink(install.romsDir, romsLink);

  const base = (await pathExists(install.mainIni)) ? await readFile(install.mainIni, 'latin1') : '';
  await writeFile(join(runtimeDir, 'config', 'fcadefbneo.ini'), runtimeIni(base), 'latin1');
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/runtime.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/iniPatch.ts src/runtime.ts tests/runtime.test.ts
git commit -m "feat: prepare a private emulator runtime folder"
```

---

### Task 8: ffmpeg arguments, progress, info check, runner

**Files:**
- Create: `src/ffmpeg.ts`
- Test: `tests/ffmpeg.test.ts`

**Interfaces:**
- Consumes: `FRAME_FORMAT`, `ConvertError`, `ExitCode`.
- Produces: `ScaleMode = 'sharp' | 'smooth'`; `VIDEO_FILTERS`; `videoEncodeArgs({ input, output, scale }): string[]`; `muxArgs({ video, audio, output }): string[]`; `parseProgressFrames(chunk: string): number | null`; `FrameInfo { width; height; bpp; fpsX100; sampleRate }`; `parseInfo(text): FrameInfo`; `checkInfo(info): void`; `partPath(output): string`; `runFfmpeg(args: string[], ffmpeg?: string): Promise<void>` (rejects `ConvertError(Encode)` with the stderr tail); `mux({ video, audio, output }): Promise<void>` (writes `partPath(output)`, renames on success, removes the part file on failure).

- [ ] **Step 1: Failing tests**

`tests/ffmpeg.test.ts`:
```ts
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { checkInfo, mux, muxArgs, parseInfo, parseProgressFrames, partPath, runFfmpeg, videoEncodeArgs } from '../src/ffmpeg.js';
import { ExitCode } from '../src/errors.js';
import { pathExists } from '../src/fsUtil.js';

const exec = promisify(execFile);
const hasFfmpeg = await exec('ffmpeg', ['-version']).then(() => true, () => false);

describe('ffmpeg arguments', () => {
  it('encodes raw BGRA frames to 1440x1080 H.264 without audio', () => {
    expect(videoEncodeArgs({ input: '/t/video.fifo', output: '/t/video.mp4', scale: 'sharp' })).toEqual([
      '-hide_banner', '-nostats', '-progress', 'pipe:1', '-y',
      '-f', 'rawvideo', '-pix_fmt', 'bgr0', '-s', '384x224', '-r', '59.59', '-i', '/t/video.fifo',
      '-vf', 'scale=iw*4:ih*4:flags=neighbor,scale=1440:1080:flags=lanczos,setsar=1',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-an',
      '/t/video.mp4',
    ]);
    expect(videoEncodeArgs({ input: 'i', output: 'o', scale: 'smooth' })).toContain('scale=1440:1080:flags=lanczos,setsar=1');
  });

  it('muxes the video with the raw audio', () => {
    expect(muxArgs({ video: '/t/video.mp4', audio: '/t/audio.raw', output: '/o/x.part.mp4' })).toEqual([
      '-hide_banner', '-nostats', '-y',
      '-i', '/t/video.mp4',
      '-f', 's16le', '-ar', '44100', '-ac', '2', '-i', '/t/audio.raw',
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', '/o/x.part.mp4',
    ]);
  });

  it('reads the last frame count from progress output', () => {
    expect(parseProgressFrames('frame=10\nfps=0\nframe=42\nprogress=continue\n')).toBe(42);
    expect(parseProgressFrames('progress=continue\n')).toBeNull();
  });

  it('derives a .part.mp4 path', () => {
    expect(partPath('/o/1-2.mp4')).toBe('/o/1-2.part.mp4');
  });
});

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('emulator info', () => {
  const good = 'width=384\nheight=224\nbpp=4\nfps_x100=5959\nsample_rate=44100\n';
  it('parses and accepts the expected format', () => {
    const info = parseInfo(good);
    expect(info).toEqual({ width: 384, height: 224, bpp: 4, fpsX100: 5959, sampleRate: 44100 });
    expect(() => checkInfo(info)).not.toThrow();
  });
  it('rejects another format with a Recording error describing both', () => {
    expect(thrown(() => checkInfo(parseInfo(good.replace('bpp=4', 'bpp=2'))))).toMatchObject({
      exitCode: ExitCode.Recording,
      message: expect.stringContaining('bpp 2'),
    });
  });
  it('rejects an incomplete info file', () => {
    expect(thrown(() => parseInfo('width=384\n'))).toMatchObject({ exitCode: ExitCode.Recording });
  });
});

describe.skipIf(!hasFfmpeg)('encode + mux (real ffmpeg)', () => {
  async function rawInputs(dir: string) {
    const video = join(dir, 'video.raw');
    const audio = join(dir, 'audio.raw');
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=384x224:rate=59.59', '-t', '1', '-f', 'rawvideo', '-pix_fmt', 'bgr0', video]);
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1', '-ac', '2', '-f', 's16le', audio]);
    return { video, audio };
  }

  it('produces a 1440x1080 h264/aac MP4 with matching durations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-ff-'));
    const raw = await rawInputs(dir);
    const videoMp4 = join(dir, 'video.mp4');
    const output = join(dir, 'out.mp4');
    await runFfmpeg(videoEncodeArgs({ input: raw.video, output: videoMp4, scale: 'sharp' }));
    await mux({ video: videoMp4, audio: raw.audio, output });

    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,duration', '-of', 'json', output]);
    const streams = (JSON.parse(stdout) as { streams: Record<string, string | number>[] }).streams;
    const v = streams.find((s) => s.codec_type === 'video')!;
    const a = streams.find((s) => s.codec_type === 'audio')!;
    expect(v).toMatchObject({ codec_name: 'h264', width: 1440, height: 1080 });
    expect(a).toMatchObject({ codec_name: 'aac' });
    expect(Math.abs(Number(v.duration) - Number(a.duration))).toBeLessThan(0.05);
    expect(await pathExists(partPath(output))).toBe(false);
  }, 60_000);

  it('keeps an existing MP4 and leaves no part file when muxing fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-ff-'));
    const output = join(dir, 'out.mp4');
    await writeFile(output, 'OLD VIDEO');
    await expect(mux({ video: join(dir, 'missing.mp4'), audio: join(dir, 'missing.raw'), output })).rejects.toMatchObject({ exitCode: ExitCode.Encode });
    expect(await readFile(output, 'utf8')).toBe('OLD VIDEO');
    expect(await pathExists(partPath(output))).toBe(false);
  }, 60_000);
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/ffmpeg.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/ffmpeg.ts`**

```ts
import { spawn } from 'node:child_process';
import { rename, rm } from 'node:fs/promises';
import { FRAME_FORMAT } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';

export type ScaleMode = 'sharp' | 'smooth';

export const VIDEO_FILTERS: Record<ScaleMode, string> = {
  sharp: 'scale=iw*4:ih*4:flags=neighbor,scale=1440:1080:flags=lanczos,setsar=1',
  smooth: 'scale=1440:1080:flags=lanczos,setsar=1',
};

const FPS = String(FRAME_FORMAT.fpsX100 / 100);

export function videoEncodeArgs({ input, output, scale }: { input: string; output: string; scale: ScaleMode }): string[] {
  return [
    '-hide_banner', '-nostats', '-progress', 'pipe:1', '-y',
    '-f', 'rawvideo', '-pix_fmt', 'bgr0', '-s', `${FRAME_FORMAT.width}x${FRAME_FORMAT.height}`, '-r', FPS, '-i', input,
    '-vf', VIDEO_FILTERS[scale],
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-an',
    output,
  ];
}

export function muxArgs({ video, audio, output }: { video: string; audio: string; output: string }): string[] {
  return [
    '-hide_banner', '-nostats', '-y',
    '-i', video,
    '-f', 's16le', '-ar', String(FRAME_FORMAT.sampleRate), '-ac', '2', '-i', audio,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', output,
  ];
}

export function parseProgressFrames(chunk: string): number | null {
  const matches = [...chunk.matchAll(/^frame=(\d+)$/gm)];
  return matches.length > 0 ? Number(matches.at(-1)![1]) : null;
}

export interface FrameInfo {
  width: number;
  height: number;
  bpp: number;
  fpsX100: number;
  sampleRate: number;
}

export function parseInfo(text: string): FrameInfo {
  const values = new Map(text.split(/\r?\n/).filter(Boolean).map((line) => line.split('=', 2) as [string, string]));
  const read = (key: string) => {
    const value = Number(values.get(key));
    if (!Number.isFinite(value)) throw new ConvertError(ExitCode.Recording, `Emulator info file is missing "${key}"`);
    return value;
  };
  return { width: read('width'), height: read('height'), bpp: read('bpp'), fpsX100: read('fps_x100'), sampleRate: read('sample_rate') };
}

export function checkInfo(info: FrameInfo): void {
  const e = FRAME_FORMAT;
  if (info.width !== e.width || info.height !== e.height || info.bpp !== e.bpp || info.fpsX100 !== e.fpsX100 || info.sampleRate !== e.sampleRate) {
    const describe = (f: FrameInfo) => `${f.width}x${f.height} bpp ${f.bpp} @ ${f.fpsX100 / 100} fps, ${f.sampleRate} Hz`;
    throw new ConvertError(
      ExitCode.Recording,
      `Unexpected frame format from the emulator: ${describe(info)} (expected ${describe(e)})`,
      'The emulator build may not match this fc2mp4 version; run fc2mp4 rebuild-emulator',
    );
  }
}

export function partPath(output: string): string {
  return `${output.replace(/\.mp4$/i, '')}.part.mp4`;
}

export function runFfmpeg(args: string[], ffmpeg = 'ffmpeg'): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4_000)));
    child.on('error', (err) => reject(new ConvertError(ExitCode.Encode, `Could not run ffmpeg: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new ConvertError(ExitCode.Encode, `ffmpeg failed (exit ${code})`, stderr.trim().split('\n').slice(-5).join('\n')));
    });
  });
}

export async function mux(args: { video: string; audio: string; output: string }): Promise<void> {
  const part = partPath(args.output);
  try {
    await runFfmpeg(muxArgs({ video: args.video, audio: args.audio, output: part }));
    await rename(part, args.output);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/ffmpeg.test.ts && npm run typecheck`
Expected: PASS (real-ffmpeg block included).

- [ ] **Step 5: Commit**

```bash
git add src/ffmpeg.ts tests/ffmpeg.test.ts
git commit -m "feat: ffmpeg encode/mux arguments, progress and frame-format check"
```

---

### Task 9: Capture orchestration (FIFO, encoder, emulator)

**Files:**
- Create: `src/capture.ts`
- Test: `tests/capture.test.ts`

**Interfaces:**
- Consumes: `videoEncodeArgs`, `parseProgressFrames`, `parseInfo`, `checkInfo`, `ScaleMode` (Task 8); `TIMEOUTS`, `EMULATOR_EXE`; `streamArg` (Task 3); `run` (Task 5); `FightcadeInstall`.
- Produces:
  - `CaptureProcess { readonly exited: boolean; wait(): Promise<number | null>; kill(): Promise<void> }`
  - `CaptureDeps { makeFifo(path); startEncoder(args, onFrames: (n: number) => void): CaptureProcess; startEmulator(env: Record<string, string>): CaptureProcess; readInfo(path): Promise<string | null>; now(): number; sleep(ms): Promise<void> }`
  - `CaptureOptions { dir: string; scale: ScaleMode; maxDurationMs: number; signal?: AbortSignal; onProgress?: (frames: number, elapsedMs: number) => void }`
  - `CaptureResult { video: string; audio: string; frames: number; endReason: 'ended' | 'max-duration' }`
  - `winPath(p: string): string` (`/a/b` → `Z:\a\b`)
  - `capture(deps, opts): Promise<CaptureResult>`
  - `defaultCaptureDeps(install: FightcadeInstall, runtimeDir: string, quarkId: string): CaptureDeps`

Rules the tests pin: the run counts as started when the info file appears (written on the first frame); no info within `firstFrameMs` → Recording error; the emulator exiting before the info appears → Emulator error; the encoder exiting while the emulator still runs → Encode error; `maxDurationMs` → kill the emulator, let the encoder drain, `endReason: 'max-duration'`; abort → Interrupted; every exit path kills whatever is still running.

- [ ] **Step 1: Failing tests**

`tests/capture.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { capture, winPath, type CaptureDeps, type CaptureProcess } from '../src/capture.js';
import { ExitCode } from '../src/errors.js';

const INFO = 'width=384\nheight=224\nbpp=4\nfps_x100=5959\nsample_rate=44100\n';
const DIR = '/tmp/fc2mp4-x';

// Simulated time advances only in sleep(); processes exit at a scripted time or when killed.
function harness(world: { infoAt?: number; info?: string; emulatorExitsAt?: number; encoderExitsAt?: number; encoderCode?: number } = {}) {
  let t = 0;
  const log: string[] = [];
  let emulatorEnv: Record<string, string> = {};
  let onFrames: (n: number) => void = () => {};

  function proc(name: string, exitAt: number | undefined, code = 0): CaptureProcess {
    let done = false;
    let exitCode: number | null = null;
    return {
      get exited() {
        if (!done && exitAt !== undefined && t >= exitAt) {
          done = true;
          exitCode = code;
        }
        return done;
      },
      wait: async () => {
        done = true;
        return exitCode ?? code;
      },
      kill: async () => {
        log.push(`kill:${name}`);
        done = true;
        exitCode = null;
      },
    };
  }

  const deps: CaptureDeps = {
    makeFifo: async (p) => {
      log.push(`fifo:${p}`);
    },
    startEncoder: (args, frames) => {
      log.push(`encoder:${args.at(-1)}`);
      onFrames = frames;
      return proc('encoder', world.encoderExitsAt, world.encoderCode ?? 0);
    },
    startEmulator: (env) => {
      emulatorEnv = env;
      log.push('emulator');
      return proc('emulator', world.emulatorExitsAt);
    },
    readInfo: async () => (world.infoAt !== undefined && t >= world.infoAt ? (world.info ?? INFO) : null),
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      if (world.infoAt !== undefined && t >= world.infoAt) onFrames(Math.round((t - world.infoAt) / 16.78));
    },
  };
  return { deps, log, env: () => emulatorEnv, time: () => t };
}

const base = { dir: DIR, scale: 'sharp' as const, maxDurationMs: 3_600_000 };

describe('capture', () => {
  it('passes Windows paths to the emulator and finishes when it exits', async () => {
    const { deps, log, env } = harness({ infoAt: 1_000, emulatorExitsAt: 10_000 });
    const result = await capture(deps, base);
    expect(result).toMatchObject({ video: `${DIR}/video.mp4`, audio: `${DIR}/audio.raw`, endReason: 'ended' });
    expect(result.frames).toBeGreaterThan(0);
    expect(env()).toEqual({
      FC2MP4_VIDEO: 'Z:\\tmp\\fc2mp4-x\\video.fifo',
      FC2MP4_AUDIO: 'Z:\\tmp\\fc2mp4-x\\audio.raw',
      FC2MP4_INFO: 'Z:\\tmp\\fc2mp4-x\\info.txt',
      FC2MP4_IDLE_MS: '5000',
    });
    expect(log).toEqual([`fifo:${DIR}/video.fifo`, `encoder:${DIR}/video.mp4`, 'emulator']);
  });

  it('fails within firstFrameMs when the stream never starts, killing both processes', async () => {
    const { deps, log, time } = harness({});
    await expect(capture(deps, base)).rejects.toMatchObject({ exitCode: ExitCode.Recording });
    expect(time()).toBe(60_000);
    expect(log).toContain('kill:emulator');
    expect(log).toContain('kill:encoder');
  });

  it('reports an emulator that exits before the first frame', async () => {
    const { deps, log } = harness({ emulatorExitsAt: 2_000 });
    await expect(capture(deps, base)).rejects.toMatchObject({ exitCode: ExitCode.Emulator });
    expect(log).toContain('kill:encoder');
  });

  it('reports an encoder that dies while capturing', async () => {
    const { deps, log } = harness({ infoAt: 1_000, encoderExitsAt: 3_000, encoderCode: 1 });
    await expect(capture(deps, base)).rejects.toMatchObject({ exitCode: ExitCode.Encode });
    expect(log).toContain('kill:emulator');
  });

  it('stops at maxDurationMs and keeps what was captured', async () => {
    const { deps, log } = harness({ infoAt: 1_000 });
    const result = await capture(deps, { ...base, maxDurationMs: 5_000 });
    expect(result.endReason).toBe('max-duration');
    expect(log).toContain('kill:emulator');
    expect(log).not.toContain('kill:encoder');
  });

  it('rejects a wrong frame format', async () => {
    const { deps } = harness({ infoAt: 1_000, info: INFO.replace('bpp=4', 'bpp=2') });
    await expect(capture(deps, base)).rejects.toMatchObject({ exitCode: ExitCode.Recording, message: expect.stringContaining('bpp 2') });
  });

  it('cleans up on Ctrl-C', async () => {
    const { deps, log } = harness({ infoAt: 1_000 });
    const controller = new AbortController();
    const sleep = deps.sleep;
    deps.sleep = async (ms) => {
      await sleep(ms);
      if (ms > 0) controller.abort();
    };
    await expect(capture(deps, { ...base, signal: controller.signal })).rejects.toMatchObject({ exitCode: ExitCode.Interrupted });
    expect(log).toContain('kill:emulator');
    expect(log).toContain('kill:encoder');
  });
});

describe('winPath', () => {
  it('maps a POSIX path onto Wine drive Z:', () => {
    expect(winPath('/Users/a b/x.fifo')).toBe('Z:\\Users\\a b\\x.fifo');
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/capture.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/capture.ts`**

```ts
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { EMULATOR_EXE, TIMEOUTS } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import { run } from './exec.js';
import { checkInfo, parseInfo, parseProgressFrames, videoEncodeArgs, type ScaleMode } from './ffmpeg.js';
import type { FightcadeInstall } from './install.js';
import { streamArg } from './replayRef.js';

export interface CaptureProcess {
  readonly exited: boolean;
  wait(): Promise<number | null>;
  kill(): Promise<void>;
}

export interface CaptureDeps {
  makeFifo(path: string): Promise<void>;
  startEncoder(args: string[], onFrames: (frames: number) => void): CaptureProcess;
  startEmulator(env: Record<string, string>): CaptureProcess;
  readInfo(path: string): Promise<string | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface CaptureOptions {
  dir: string;
  scale: ScaleMode;
  maxDurationMs: number;
  signal?: AbortSignal;
  onProgress?: (frames: number, elapsedMs: number) => void;
}

export interface CaptureResult {
  video: string;
  audio: string;
  frames: number;
  endReason: 'ended' | 'max-duration';
}

export function winPath(p: string): string {
  return `Z:${p.replace(/\//g, '\\')}`;
}

export async function capture(deps: CaptureDeps, opts: CaptureOptions): Promise<CaptureResult> {
  const fifo = join(opts.dir, 'video.fifo');
  const video = join(opts.dir, 'video.mp4');
  const audio = join(opts.dir, 'audio.raw');
  const info = join(opts.dir, 'info.txt');

  await deps.makeFifo(fifo);
  let frames = 0;
  const encoder = deps.startEncoder(videoEncodeArgs({ input: fifo, output: video, scale: opts.scale }), (n) => (frames = n));
  const emulator = deps.startEmulator({
    FC2MP4_VIDEO: winPath(fifo),
    FC2MP4_AUDIO: winPath(audio),
    FC2MP4_INFO: winPath(info),
    FC2MP4_IDLE_MS: String(TIMEOUTS.emulatorIdleMs),
  });

  const start = deps.now();
  let started = false;
  let endReason: CaptureResult['endReason'] = 'ended';
  try {
    for (;;) {
      if (opts.signal?.aborted) throw new ConvertError(ExitCode.Interrupted, 'Interrupted');
      if (!started) {
        const text = await deps.readInfo(info);
        if (text !== null) {
          checkInfo(parseInfo(text));
          started = true;
        }
      }
      if (emulator.exited) {
        if (!started) {
          throw new ConvertError(ExitCode.Emulator, 'The emulator exited before the replay started', 'Check the quark ID; the replay may no longer exist');
        }
        break;
      }
      if (encoder.exited) throw new ConvertError(ExitCode.Encode, 'The video encoder stopped unexpectedly');
      const elapsed = deps.now() - start;
      if (!started && elapsed >= TIMEOUTS.firstFrameMs) {
        throw new ConvertError(ExitCode.Recording, 'The replay stream never started', 'Check the quark ID and that Fightcade replay servers are reachable');
      }
      if (elapsed >= opts.maxDurationMs) {
        endReason = 'max-duration';
        await emulator.kill();
        break;
      }
      opts.onProgress?.(frames, elapsed);
      await deps.sleep(TIMEOUTS.pollMs);
    }
    const code = await encoder.wait();
    if (code !== 0) throw new ConvertError(ExitCode.Encode, `The video encoder failed (exit ${code})`);
    return { video, audio, frames, endReason };
  } finally {
    if (!emulator.exited) await emulator.kill().catch(() => {});
    if (!encoder.exited) await encoder.kill().catch(() => {});
  }
}

function wrap(child: ReturnType<typeof spawn>, kill: () => Promise<void>): CaptureProcess {
  let exited = false;
  let exitCode: number | null = null;
  const done = new Promise<number | null>((resolve) => {
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      resolve(code);
    });
    child.on('error', () => {
      exited = true;
      resolve(null);
    });
  });
  return {
    get exited() {
      return exited;
    },
    wait: () => (exited ? Promise.resolve(exitCode) : done),
    kill,
  };
}

export function defaultCaptureDeps(install: FightcadeInstall, runtimeDir: string, quarkId: string): CaptureDeps {
  return {
    makeFifo: async (path) => {
      const result = await run('mkfifo', [path]);
      if (result.code !== 0) throw new ConvertError(ExitCode.Recording, `mkfifo failed: ${result.stderr.trim()}`);
    },
    startEncoder: (args, onFrames) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout!.on('data', (d) => {
        const frames = parseProgressFrames(String(d));
        if (frames !== null) onFrames(frames);
      });
      return wrap(child, async () => {
        child.kill('SIGKILL');
      });
    },
    startEmulator: (env) => {
      const child = spawn(install.wineSh, [join(runtimeDir, EMULATOR_EXE), streamArg(quarkId)], {
        cwd: runtimeDir,
        env: { ...process.env, ...env },
        stdio: 'ignore',
      });
      return wrap(child, async () => {
        await run(install.wineSh, ['taskkill', '/IM', EMULATOR_EXE, '/F'], { cwd: runtimeDir, timeoutMs: TIMEOUTS.killMs });
        child.kill('SIGKILL');
      });
    },
    readInfo: async (path) => {
      try {
        const text = await readFile(path, 'utf8');
        return text.includes('sample_rate=') ? text : null;
      } catch {
        return null;
      }
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/capture.test.ts && npm run typecheck`
Expected: PASS. If a timing assertion is off by one poll, trace the loop by hand (time advances only in `sleep`) and fix the implementation, not the expected value, unless the trace proves the test wrong.

- [ ] **Step 5: Commit**

```bash
git add src/capture.ts tests/capture.test.ts
git commit -m "feat: capture orchestration over a video FIFO with emulator and encoder supervision"
```

---

### Task 10: Single-instance lock

**Files:**
- Create: `src/lock.ts`
- Test: `tests/lock.test.ts`

**Interfaces:**
- Produces: `acquireLock(file?: string, isAlive?: (pid: number) => boolean): Promise<() => Promise<void>>` (default `join(tmpdir(), 'fc2mp4.lock')`); `pidAlive(pid): boolean`.

- [ ] **Step 1: Failing tests**

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

- [ ] **Step 2: Run and watch them fail**

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

### Task 11: `convert()` and `rebuildEmulator()`

**Files:**
- Create: `src/convert.ts`
- Test: `tests/convert.test.ts`

**Interfaces:**
- Consumes: `parseReplayRef`; `resolveOutputPath`; `locateInstall`, `preflight`, `FightcadeInstall`; `ensureEmulator`, `defaultEnsureDeps`, `defaultEmulatorPaths`, `EnsureResult`; `prepareRuntime`; `capture`, `defaultCaptureDeps`, `CaptureOptions`, `CaptureResult`; `mux`; `acquireLock`; `pathExists`, `which`.
- Produces:
  - `ProgressEvent = { phase: 'preparing-emulator' } | { phase: 'connecting' } | { phase: 'capturing'; frames: number; elapsedMs: number } | { phase: 'finalizing' }`
  - `ConvertOptions { output?: string; scale: ScaleMode; maxDurationMs: number; fightcadeDir?: string; signal?: AbortSignal; onProgress?: (e: ProgressEvent) => void; log?: (msg: string) => void; debug?: (msg: string) => void }`
  - `ConvertResult { output: string; frames: number; endReason: 'ended' | 'max-duration' }`
  - `ConvertDeps` (see code), `defaultDeps(): ConvertDeps`
  - `convert(input, options, deps?): Promise<ConvertResult>`
  - `rebuildEmulator(options: { fightcadeDir?: string; log?: (msg: string) => void }, deps?): Promise<EnsureResult>`

Order (pinned by tests): locate → resolve output → lock → preflight → ensure emulator (warning → `log`) → prepare runtime → temp dir → capture → mkdir(output dir) → mux → finally remove temp dir, release lock.

- [ ] **Step 1: Failing tests**

`tests/convert.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { convert, rebuildEmulator, type ConvertDeps, type ConvertOptions } from '../src/convert.js';
import { installLayout } from '../src/install.js';
import { ConvertError, ExitCode } from '../src/errors.js';

const install = installLayout('/Apps/FightCade2.app');
const ID = '1700000000000-1234';
const baseOptions: ConvertOptions = { scale: 'sharp', maxDurationMs: 3_600_000 };

function harness(over: Partial<ConvertDeps> = {}) {
  const calls: string[] = [];
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
    ensureEmulator: async (_install, force) => {
      calls.push(`ensure:${force}`);
      return { rebuilt: false };
    },
    prepareRuntime: async () => {
      calls.push('runtime');
    },
    makeTempDir: async () => {
      calls.push('tmp');
      return '/tmp/run';
    },
    capture: async (_install, quarkId, opts) => {
      calls.push(`capture:${quarkId}:${opts.dir}`);
      return { video: '/tmp/run/video.mp4', audio: '/tmp/run/audio.raw', frames: 8220, endReason: 'ended' };
    },
    mkdir: async (dir) => {
      calls.push(`mkdir:${dir}`);
    },
    mux: async ({ output }) => {
      calls.push(`mux:${output}`);
    },
    removeDir: async (dir) => {
      calls.push(`rmdir:${dir}`);
    },
    ...over,
  };
  return { deps, calls };
}

describe('convert', () => {
  it('runs the pipeline in order', async () => {
    const { deps, calls } = harness();
    const result = await convert(`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}`, baseOptions, deps);
    expect(result).toEqual({ output: `/out/${ID}.mp4`, frames: 8220, endReason: 'ended' });
    expect(calls).toEqual([
      'lock', 'preflight', 'ensure:false', 'runtime', 'tmp', `capture:${ID}:/tmp/run`,
      'mkdir:/out', `mux:/out/${ID}.mp4`, 'rmdir:/tmp/run', 'unlock',
    ]);
  });

  it('removes the temp dir and releases the lock when capture fails, without muxing', async () => {
    const { deps, calls } = harness({
      capture: async () => {
        throw new ConvertError(ExitCode.Recording, 'The replay stream never started');
      },
    });
    await expect(convert(ID, baseOptions, deps)).rejects.toMatchObject({ exitCode: ExitCode.Recording });
    expect(calls.slice(-2)).toEqual(['rmdir:/tmp/run', 'unlock']);
    expect(calls.some((c) => c.startsWith('mux'))).toBe(false);
  });

  it('logs the emulator warning and carries on', async () => {
    const logs: string[] = [];
    const { deps } = harness({ ensureEmulator: async () => ({ rebuilt: false, warning: 'using the previous build' }) });
    await convert(ID, { ...baseOptions, log: (m) => logs.push(m) }, deps);
    expect(logs).toContain('Warning: using the previous build');
  });

  it('warns when max-duration cut the capture short', async () => {
    const logs: string[] = [];
    const { deps } = harness({
      capture: async () => ({ video: 'v', audio: 'a', frames: 10, endReason: 'max-duration' }),
    });
    await convert(ID, { ...baseOptions, log: (m) => logs.push(m) }, deps);
    expect(logs.some((m) => m.includes('--max-duration'))).toBe(true);
  });

  it('does nothing else when another conversion holds the lock', async () => {
    const { deps, calls } = harness({
      acquireLock: async () => {
        throw new ConvertError(ExitCode.Busy, 'Another fc2mp4 conversion is running (pid 1)');
      },
    });
    await expect(convert(ID, baseOptions, deps)).rejects.toMatchObject({ exitCode: ExitCode.Busy });
    expect(calls).toEqual([]);
  });

  it('rejects a bad link before touching anything', async () => {
    const { deps, calls } = harness();
    await expect(convert('hello', baseOptions, deps)).rejects.toMatchObject({ exitCode: ExitCode.Usage });
    expect(calls).toEqual([]);
  });
});

describe('rebuildEmulator', () => {
  it('forces a rebuild under the lock', async () => {
    const { deps, calls } = harness({
      ensureEmulator: async (_install, force) => {
        calls.push(`ensure:${force}`);
        return { rebuilt: true };
      },
    });
    expect(await rebuildEmulator({}, deps)).toEqual({ rebuilt: true });
    expect(calls).toEqual(['lock', 'ensure:true', 'unlock']);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/convert.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/convert.ts`**

```ts
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { capture, defaultCaptureDeps, type CaptureOptions, type CaptureResult } from './capture.js';
import { defaultEmulatorPaths, defaultEnsureDeps, ensureEmulator, type EnsureResult } from './emulatorBuild.js';
import { which } from './exec.js';
import { mux, type ScaleMode } from './ffmpeg.js';
import { pathExists } from './fsUtil.js';
import { locateInstall, preflight, type FightcadeInstall } from './install.js';
import { acquireLock } from './lock.js';
import { resolveOutputPath } from './outputPath.js';
import { parseReplayRef } from './replayRef.js';
import { prepareRuntime } from './runtime.js';

export type ProgressEvent =
  | { phase: 'preparing-emulator' }
  | { phase: 'connecting' }
  | { phase: 'capturing'; frames: number; elapsedMs: number }
  | { phase: 'finalizing' };

export interface ConvertOptions {
  output?: string;
  scale: ScaleMode;
  maxDurationMs: number;
  fightcadeDir?: string;
  signal?: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
  log?: (msg: string) => void;
  debug?: (msg: string) => void;
}

export interface ConvertResult {
  output: string;
  frames: number;
  endReason: CaptureResult['endReason'];
}

export interface ConvertDeps {
  locateInstall(override?: string): Promise<FightcadeInstall>;
  resolveOutput(quarkId: string, output?: string): Promise<string>;
  acquireLock(): Promise<() => Promise<void>>;
  preflight(install: FightcadeInstall): Promise<void>;
  ensureEmulator(install: FightcadeInstall, force: boolean): Promise<EnsureResult>;
  prepareRuntime(install: FightcadeInstall): Promise<void>;
  makeTempDir(): Promise<string>;
  capture(install: FightcadeInstall, quarkId: string, opts: CaptureOptions): Promise<CaptureResult>;
  mkdir(dir: string): Promise<void>;
  mux(args: { video: string; audio: string; output: string }): Promise<void>;
  removeDir(dir: string): Promise<void>;
}

export function defaultDeps(): ConvertDeps {
  const home = homedir();
  const paths = defaultEmulatorPaths(home);
  return {
    locateInstall: (override) => locateInstall({ platform: process.platform, home, override, exists: pathExists }),
    resolveOutput: (quarkId, output) => resolveOutputPath(quarkId, output, home),
    acquireLock: () => acquireLock(),
    preflight: (install) => preflight(install, { exists: pathExists, which }),
    ensureEmulator: (install, force) => ensureEmulator(force, defaultEnsureDeps(install, paths)),
    prepareRuntime: (install) => prepareRuntime(install, paths.runtimeDir),
    makeTempDir: () => mkdtemp(join(tmpdir(), 'fc2mp4-')),
    capture: (install, quarkId, opts) => capture(defaultCaptureDeps(install, paths.runtimeDir, quarkId), opts),
    mkdir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
    mux,
    removeDir: (dir) => rm(dir, { recursive: true, force: true }),
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

  const release = await deps.acquireLock();
  let dir: string | undefined;
  try {
    await deps.preflight(install);
    options.onProgress?.({ phase: 'preparing-emulator' });
    const ensured = await deps.ensureEmulator(install, false);
    if (ensured.warning) log(`Warning: ${ensured.warning}`);
    if (ensured.rebuilt) debug('Emulator rebuilt');
    await deps.prepareRuntime(install);

    dir = await deps.makeTempDir();
    options.onProgress?.({ phase: 'connecting' });
    const captured = await deps.capture(install, ref.quarkId, {
      dir,
      scale: options.scale,
      maxDurationMs: options.maxDurationMs,
      signal: options.signal,
      onProgress: (frames, elapsedMs) => options.onProgress?.({ phase: 'capturing', frames, elapsedMs }),
    });
    if (captured.endReason === 'max-duration') log('Warning: reached --max-duration; the video may be cut short');

    options.onProgress?.({ phase: 'finalizing' });
    await deps.mkdir(dirname(output));
    await deps.mux({ video: captured.video, audio: captured.audio, output });
    return { output, frames: captured.frames, endReason: captured.endReason };
  } finally {
    if (dir !== undefined) await deps.removeDir(dir);
    await release();
  }
}

export async function rebuildEmulator(
  options: { fightcadeDir?: string; log?: (msg: string) => void },
  deps: ConvertDeps = defaultDeps(),
): Promise<EnsureResult> {
  const install = await deps.locateInstall(options.fightcadeDir);
  const release = await deps.acquireLock();
  try {
    const result = await deps.ensureEmulator(install, true);
    if (result.warning) options.log?.(`Warning: ${result.warning}`);
    return result;
  } finally {
    await release();
  }
}
```

- [ ] **Step 4: Run tests and the full suite**

Run: `npx vitest run tests/convert.test.ts && npm test && npm run typecheck && npm run test:emulator`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/convert.ts tests/convert.test.ts
git commit -m "feat: convert() pipeline and rebuildEmulator()"
```

---

### Task 12: CLI, end-to-end test, README

**Files:**
- Create: `src/cliArgs.ts`, `src/cli.ts`, `tests/cliArgs.test.ts`, `tests/e2e.test.ts`, `README.md`

**Interfaces:**
- Consumes: `convert`, `rebuildEmulator`, `ProgressEvent`, `ConvertError`, `ExitCode`, `DEFAULT_MAX_DURATION_MS`, `ScaleMode`.
- Produces: `USAGE`; `parseDuration(text): number`; `CliRequest = { command: 'help' } | { command: 'convert'; input: string; output?: string; scale: ScaleMode; maxDurationMs: number; fightcadeDir?: string; verbose: boolean } | { command: 'rebuild-emulator'; fightcadeDir?: string; verbose: boolean }`; `parseCli(argv): CliRequest`.

- [ ] **Step 1: Failing tests**

`tests/cliArgs.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { parseCli, parseDuration } from '../src/cliArgs.js';
import { ExitCode } from '../src/errors.js';
import { DEFAULT_MAX_DURATION_MS } from '../src/constants.js';

function usageError(argv: string[]): unknown {
  try {
    parseCli(argv);
  } catch (err) {
    return err;
  }
  return undefined;
}

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
      command: 'convert',
      input: '1-2',
      output: undefined,
      scale: 'sharp',
      maxDurationMs: DEFAULT_MAX_DURATION_MS,
      fightcadeDir: undefined,
      verbose: false,
    });
  });
  it('reads every option', () => {
    expect(parseCli(['-o', '/tmp/x.mp4', '--scale', 'smooth', '--max-duration', '20m', '--fightcade-dir', '/F', '-v', '1-2'])).toEqual({
      command: 'convert',
      input: '1-2',
      output: '/tmp/x.mp4',
      scale: 'smooth',
      maxDurationMs: 1_200_000,
      fightcadeDir: '/F',
      verbose: true,
    });
  });
  it('parses the rebuild-emulator command', () => {
    expect(parseCli(['rebuild-emulator', '--fightcade-dir', '/F'])).toEqual({ command: 'rebuild-emulator', fightcadeDir: '/F', verbose: false });
  });
  it('returns help', () => {
    expect(parseCli(['--help'])).toEqual({ command: 'help' });
  });
  it.each([[[]], [['a', 'b']], [['--scale', 'blurry', '1-2']], [['--bogus', '1-2']], [['rebuild-emulator', 'x']]])('rejects %j', (argv) => {
    expect(usageError(argv)).toMatchObject({ exitCode: ExitCode.Usage });
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/cliArgs.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/cliArgs.ts`**

```ts
import { parseArgs } from 'node:util';
import { DEFAULT_MAX_DURATION_MS } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import type { ScaleMode } from './ffmpeg.js';

export const USAGE = `Usage: fc2mp4 <replay-link-or-quarkId> [options]
       fc2mp4 rebuild-emulator [--fightcade-dir <p>] [-v]

Records a Fightcade Street Fighter III: 3rd Strike replay to MP4 (macOS).

  -o, --output <path>       MP4 file, or an existing folder (default: ~/Movies/Fightcade)
      --scale sharp|smooth  Upscaling style (default: sharp)
      --max-duration <d>    Stop capturing after this long: 90s, 45m, 1h (default: 60m)
      --fightcade-dir <p>   Fightcade install (FightCade2.app)
  -v, --verbose             Print debug details
  -h, --help                Show this help

rebuild-emulator fetches the latest Fightcade FBNeo source, patches and rebuilds it
(this also happens automatically when Fightcade updates).`;

export type CliRequest =
  | { command: 'help' }
  | { command: 'convert'; input: string; output?: string; scale: ScaleMode; maxDurationMs: number; fightcadeDir?: string; verbose: boolean }
  | { command: 'rebuild-emulator'; fightcadeDir?: string; verbose: boolean };

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)([smh])?$/.exec(text.trim());
  const ms = match ? Number(match[1]) * UNIT_MS[(match[2] ?? 'm') as keyof typeof UNIT_MS] : NaN;
  if (!(ms > 0)) throw new ConvertError(ExitCode.Usage, `Invalid duration "${text}"`, 'Use e.g. 90s, 45m or 1h');
  return ms;
}

function usage(message: string): ConvertError {
  return new ConvertError(ExitCode.Usage, message, 'Run fc2mp4 --help');
}

export function parseCli(argv: string[]): CliRequest {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: 'string', short: 'o' },
        scale: { type: 'string' },
        'max-duration': { type: 'string' },
        'fightcade-dir': { type: 'string' },
        verbose: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (err) {
    throw usage((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help) return { command: 'help' };
  const verbose = values.verbose ?? false;

  if (positionals[0] === 'rebuild-emulator') {
    if (positionals.length !== 1) throw usage('rebuild-emulator takes no arguments');
    return { command: 'rebuild-emulator', fightcadeDir: values['fightcade-dir'], verbose };
  }
  if (positionals.length !== 1) throw usage('Expected exactly one replay link or quark ID');
  const scale = values.scale ?? 'sharp';
  if (scale !== 'sharp' && scale !== 'smooth') throw new ConvertError(ExitCode.Usage, `Invalid --scale "${scale}"`, 'Use sharp or smooth');
  return {
    command: 'convert',
    input: positionals[0]!,
    output: values.output,
    scale,
    maxDurationMs: values['max-duration'] ? parseDuration(values['max-duration']) : DEFAULT_MAX_DURATION_MS,
    fightcadeDir: values['fightcade-dir'],
    verbose,
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
import { convert, rebuildEmulator, type ProgressEvent } from './convert.js';
import { ConvertError, ExitCode } from './errors.js';

function progressLine(e: ProgressEvent): string {
  switch (e.phase) {
    case 'preparing-emulator':
      return 'Preparing the emulator (a rebuild takes about a minute)…';
    case 'connecting':
      return 'Connecting to the replay stream…';
    case 'capturing': {
      const seconds = e.frames / 59.59;
      const speed = e.elapsedMs > 0 ? (seconds * 1000) / e.elapsedMs : 0;
      return `Capturing… ${Math.round(seconds)}s of replay (${e.frames} frames, ×${speed.toFixed(1)})`;
    }
    case 'finalizing':
      return 'Finalizing the MP4…';
  }
}

async function main(): Promise<number> {
  const controller = new AbortController();
  let interrupts = 0;
  process.on('SIGINT', () => {
    interrupts += 1;
    if (interrupts > 1) process.exit(ExitCode.Interrupted);
    process.stderr.write('\nStopping (Ctrl-C again to force quit)…\n');
    controller.abort();
  });
  process.on('SIGTERM', () => controller.abort());

  const tty = process.stderr.isTTY;
  const log = (msg: string) => process.stderr.write(`${tty ? '\n' : ''}${msg}\n`);
  try {
    const request = parseCli(process.argv.slice(2));
    if (request.command === 'help') {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    const debug = request.verbose ? (msg: string) => process.stderr.write(`[debug] ${msg}\n`) : undefined;
    if (request.command === 'rebuild-emulator') {
      const result = await rebuildEmulator({ fightcadeDir: request.fightcadeDir, log });
      process.stdout.write(result.rebuilt ? 'Emulator rebuilt.\n' : 'Kept the previous emulator build.\n');
      return 0;
    }
    const result = await convert(request.input, {
      output: request.output,
      scale: request.scale,
      maxDurationMs: request.maxDurationMs,
      fightcadeDir: request.fightcadeDir,
      signal: controller.signal,
      log,
      debug,
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

- [ ] **Step 6: Opt-in end-to-end test**

`tests/e2e.test.ts`:
```ts
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/convert.js';

const exec = promisify(execFile);
const replay = process.env.FC_E2E;

// FC_E2E=<link or quark ID> npx vitest run tests/e2e.test.ts
// Optional FC_E2E_EXPECTED_SECONDS=<replay length> checks the duration within 2%.
describe.skipIf(!replay)('end-to-end', () => {
  it('converts a real replay to a 1440x1080 h264/aac MP4 with aligned audio', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-e2e-'));
    const result = await convert(replay!, { output: dir, scale: 'sharp', maxDurationMs: 30 * 60_000 });
    expect(result.endReason).toBe('ended');

    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,duration', '-of', 'json', result.output]);
    const streams = (JSON.parse(stdout) as { streams: Record<string, string | number>[] }).streams;
    const v = streams.find((s) => s.codec_type === 'video')!;
    const a = streams.find((s) => s.codec_type === 'audio')!;
    expect(v).toMatchObject({ codec_name: 'h264', width: 1440, height: 1080 });
    expect(a).toMatchObject({ codec_name: 'aac' });
    expect(Math.abs(Number(v.duration) - Number(a.duration))).toBeLessThan(0.05);
    const expected = Number(process.env.FC_E2E_EXPECTED_SECONDS);
    if (Number.isFinite(expected)) expect(Math.abs(Number(v.duration) - expected)).toBeLessThan(expected * 0.02);
  }, 40 * 60_000);
});
```

Run: `npm test`
Expected: all PASS, e2e skipped.

- [ ] **Step 7: Run end-to-end for real**

Run:
```sh
FC_E2E='https://replay.fightcade.com/fbneo/sfiii3nr1/1791006077129-2245' FC_E2E_EXPECTED_SECONDS=137.94 npx vitest run tests/e2e.test.ts
npm run dev -- 'https://replay.fightcade.com/fbneo/sfiii3nr1/1790980205888-4792'
```
Expected: e2e PASS. The long replay prints progress with a speed factor above ×1, ends by itself, and prints `~/Movies/Fightcade/1790980205888-4792.mp4`. Open it and check by eye: 4:3, sound in sync, ends after the final round. Then run `npm run dev -- <short link>` again and press Ctrl-C during capture: `pgrep -f fcadefbneo-fc2mp4` prints nothing, `ls $TMPDIR | grep fc2mp4-` shows no leftover run dir, and a new run starts without a "Busy" error. Finally, confirm the Fightcade install was not modified: `ls -laT /Applications/FightCade2.app/Contents/MacOS/emulator/fbneo/config` shows the same timestamps as before the runs (note them before Step 7).

- [ ] **Step 8: README**

`README.md`:
````markdown
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
````

- [ ] **Step 9: Commit**

```bash
git add src/cliArgs.ts src/cli.ts tests/cliArgs.test.ts tests/e2e.test.ts README.md
git commit -m "feat: fc2mp4 CLI with rebuild-emulator, e2e test and README"
```
