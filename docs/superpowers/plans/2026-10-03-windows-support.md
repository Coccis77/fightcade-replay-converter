# fc2mp4 on Windows + Released Binaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `fc2mp4.exe <replay link>` works on Windows 11 with nothing installed but Fightcade; macOS keeps working; emulator and CLI binaries are built by GitHub Actions and downloaded automatically.

**Architecture:** CI (Linux) builds the patched emulator from the latest `fightcade-fbneo` and publishes it as a GitHub release tagged with the source commit and patch-set hash; the CLI downloads the release matching its own patch-set hash. Platform differences (install layout, launcher, ROMs link, video transport, ffmpeg source, kill command) are isolated behind small functions that take the platform as a parameter. On Windows, frames flow emulator → named pipe served by Node → ffmpeg stdin. The CLI ships as a Node 24 single executable built per OS in CI.

**Tech Stack:** Node 24 (ESM source, esbuild CJS bundle, SEA + postject), TypeScript 5.9, vitest 5; Python 3 + mingw-w64 (CI build); GitHub Actions; ffmpeg (Homebrew on macOS, pinned static build mirrored in our releases on Windows).

**Spec:** `docs/superpowers/specs/2026-10-03-windows-support-design.md` (builds on `2026-10-03-fightcade-replay-to-mp4-design.md` rev 2). Evidence: `docs/spike-findings.md`.

## Global Constraints

- Platforms: `darwin` and `win32`; anything else → Preflight error. Units take the platform as a parameter; only `defaultDeps` reads `process.platform`.
- Never modify the Fightcade install (spec criterion 6): read DLLs/ini, link `ROMs` read-only, run our own `fcadefbneo-fc2mp4.exe` from our runtime folder.
- Windows paths: install candidates `%USERPROFILE%\Documents\Fightcade`, `%USERPROFILE%\Fightcade`, `C:\Fightcade`, `%LOCALAPPDATA%\Programs\Fightcade`; layout `<root>\emulator\fbneo\…`; cache `%LOCALAPPDATA%\fc2mp4` (`runtime`, `ffmpeg`); output `%USERPROFILE%\Videos\Fightcade`.
- macOS paths unchanged: cache `~/Library/Caches/fc2mp4`, output `~/Movies/Fightcade`.
- Repo: `Coccis77/fightcade-replay-converter` (public). Emulator release tags `emulator-<sourceCommit[:12]>-<patchSetHash[:12]>` with assets `fcadefbneo-fc2mp4.exe`, `build-info.json`. ffmpeg mirror release `tools-ffmpeg-9.0.2` with `ffmpeg.exe`, `ffmpeg.exe.sha256`. CLI releases `v<version>` with `fc2mp4.exe`, `fc2mp4-macos-arm64`.
- Pinned upstream ffmpeg: `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-01-13-06/ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-9.0.zip`, sha256 `74827e097445a136b803febd4dcf80f7cba7f14a4c612fb80f7b5e5cedd3ffbe`.
- Patch-set hash: sha256 over files of `emulator/` (skip names starting with `test_` and `__pycache__`), relative paths with `/` separators sorted, each hashed as `path\0content\0`. Python and TypeScript must agree (shared fixture value `ad8f4307a17afa05c142df8811f108babff53a3509314d60b5196cd9a54894b4` for `{patches.py: "A", src/fc2mp4_dump.cpp: "B"}`).
- Emulator update check at most once per 24 h unless forced; downloads go to `<target>.download`, are verified (size + `MZ` header for the exe, sha256 for ffmpeg) and renamed into place only when valid.
- Encoding unchanged: `format=yuv444p` + sharp upscale, x264 `veryfast` crf 20.
- Pushing to GitHub and creating tags are outward actions: confirm with the user before each push in Task 10.

## Review Focus

1. **Offline / GitHub unreachable with a working emulator installed** → conversion proceeds with a warning. Pinned by "keeps the installed build when GitHub is unreachable" in Task 6.
2. **Interrupted or truncated download** → the previous emulator stays usable and nothing half-written is left. Pinned by "a truncated download never replaces the installed exe" in Task 6.
3. **Ctrl-C mid-capture on Windows** → emulator and ffmpeg killed, pipe server closed, temp dir removed. Pinned by "closes the transport on every exit path" in Task 5.
4. **Paths with spaces** (e.g. `C:\Users\Jean Pierre\Documents\Fightcade`) → detected and launched correctly. Pinned by the space-path tests in Tasks 3 and 5.
5. **Corrupted ffmpeg download** → rejected, not cached, clear error. Pinned by "rejects a checksum mismatch" in Task 7.

---

## File Structure

```
emulator/build.py              + case shims, missing-tool check
emulator/ggponet.def           export names of Fightcade's ggponet.dll
emulator/patchset.py           patch-set hash (shared definition with src/patchSet.ts)
emulator/test_build.py         + tests for shims, tools
emulator/test_patchset.py      fixture hash test
.github/workflows/emulator.yml CI emulator build + release
.github/workflows/tools.yml    mirror pinned ffmpeg.exe into our releases
.github/workflows/cli.yml      SEA binaries on v* tags
scripts/bundle.mjs             esbuild bundle with baked-in constants
scripts/sea.mjs                Node single executable from the bundle
src/platform.ts                Platform type, path flavour, app paths per OS
src/patchSet.ts                patchSetHash (moved from emulatorBuild.ts) + currentPatchSetHash
src/install.ts                 per-platform layout/candidates/launcher, preflight
src/outputPath.ts              resolveOutputPath(quarkId, output, defaultDir)
src/runtime.ts                 junction vs symlink
src/transport.ts               VideoTransport: FIFO (macOS) and named pipe relay (Windows)
src/capture.ts                 uses transport, per-platform launch/kill, ffmpeg path
src/emulatorRelease.ts         pick/download/verify emulator release, manifest, fallbacks
src/emulatorBuild.ts           reduced to the macOS local build (localBuild)
src/ffmpegLocator.ts           PATH / cached / mirrored download with checksum
src/exec.ts                    which() per platform
src/convert.ts                 wiring for both platforms, updateEmulator, buildEmulatorLocally
src/cliArgs.ts, src/cli.ts     update-emulator, rebuild-emulator (local), no top-level await
```

---

### Task 1: CI-ready emulator build (case shims, missing tools, ggponet.def)

**Files:**
- Modify: `emulator/build.py`
- Create: `emulator/ggponet.def`
- Test: `emulator/test_build.py`

**Interfaces:**
- Produces: `write_case_shims(directory) -> str` (writes `InitGuid.h` = `#include <initguid.h>`), `missing_tools(need_git: bool, which=shutil.which) -> list[str]`, `REQUIRED_TOOLS`. `build.py` exits 3 with stderr `MISSING TOOLS: a, b` when tools are absent. `--ggponet` accepts the DLL or an import library `.a`.

- [ ] **Step 1: Failing tests** — append to `emulator/test_build.py`:

```python
class CaseShimTest(unittest.TestCase):
    def test_writes_initguid_shim(self):
        from build import write_case_shims
        d = write_case_shims(os.path.join(tempfile.mkdtemp(), 'shims'))
        with open(os.path.join(d, 'InitGuid.h')) as f:
            self.assertEqual(f.read(), '#include <initguid.h>\n')


class MissingToolsTest(unittest.TestCase):
    def test_reports_missing_tools_and_git_only_when_fetching(self):
        from build import missing_tools
        present = {'perl', 'c++', 'cc', 'i686-w64-mingw32-gcc', 'i686-w64-mingw32-g++', 'i686-w64-mingw32-windres'}
        which = lambda tool: '/usr/bin/' + tool if tool in present else None
        self.assertEqual(missing_tools(True, which), ['git'])
        self.assertEqual(missing_tools(False, which), [])
        present.discard('perl')
        self.assertEqual(missing_tools(False, which), ['perl'])
```

- [ ] **Step 2: Run, watch fail**

Run: `python3 -m unittest discover -s emulator -p 'test_*.py'`
Expected: ERROR `cannot import name 'write_case_shims'`.

- [ ] **Step 3: Implement in `emulator/build.py`**

Add `import shutil` with the other imports. After `LIBS = [...]` add:

```python
REQUIRED_TOOLS = ['perl', 'c++', 'cc', CC, CXX, WINDRES]
# Sources include headers with a different case than mingw ships (Linux is case-sensitive).
CASE_SHIMS = {'InitGuid.h': '#include <initguid.h>\n'}


def write_case_shims(directory):
    os.makedirs(directory, exist_ok=True)
    for name, content in CASE_SHIMS.items():
        with open(os.path.join(directory, name), 'w') as f:
            f.write(content)
    return directory


def missing_tools(need_git, which=shutil.which):
    tools = (['git'] if need_git else []) + REQUIRED_TOOLS
    return [tool for tool in tools if which(tool) is None]
```

In `compile_all`, add a `shims` parameter and append it last to the include list:

```python
def compile_all(source_root, obj, gen, sources, includes, defines, jobs, shims):
    drv_includes = ['-I' + os.path.join(source_root, 'src/burn/drv', d) for d in GENERATED_INCLUDE_DIRS]
    common_includes = ['-I' + gen] + drv_includes + ['-I' + i for i in includes] + \
        ['-I' + os.path.join(source_root, 'src/dep/mingw/include'), '-I' + shims]
```

In `build`, after `generate(...)`:

```python
    shims = write_case_shims(os.path.join(obj, 'shims'))
    failures = compile_all(source_root, obj, gen, sources, includes, defines, jobs, shims)
```

(replacing the existing `failures = compile_all(...)` line). In `main`, change the `--ggponet` help to `"Fightcade's ggponet.dll, or an import library made from emulator/ggponet.def"` and right after `args = parser.parse_args(argv)` add:

```python
    missing = missing_tools(need_git=not args.skip_fetch)
    if missing:
        print(f'MISSING TOOLS: {", ".join(missing)}', file=sys.stderr)
        return EXIT_BUILD
```

- [ ] **Step 4: Create `emulator/ggponet.def`**

```
LIBRARY ggponet.dll
EXPORTS
ggpo_advance_frame
ggpo_client_chat
ggpo_client_connect
ggpo_client_set_game_event
ggpo_close_session
ggpo_get_stats
ggpo_idle
ggpo_log
ggpo_logv
ggpo_set_frame_delay
ggpo_start_replay
ggpo_start_session
ggpo_start_streaming
ggpo_start_synctest
ggpo_synchronize_input
```

- [ ] **Step 5: Run tests**

Run: `python3 -m unittest discover -s emulator -p 'test_*.py'`
Expected: OK.

- [ ] **Step 6: Prove a build linked against the `.def` works**

```sh
C=~/Library/Caches/fc2mp4; L=$(mktemp -d)
i686-w64-mingw32-dlltool -d emulator/ggponet.def -l $L/libggponet.a
python3 emulator/build.py --skip-fetch --source-dir $C/fightcade-fbneo --out-dir $L/out --ggponet $L/libggponet.a
i686-w64-mingw32-objdump -p $L/out/fcadefbneo-fc2mp4.exe | grep 'DLL Name: ggponet.dll'
```
Expected: exit 0, JSON line, `DLL Name: ggponet.dll`. Then run the short replay with that exe exactly as in the rev 2 plan Task 2 Step 4 (copy it over `$C/runtime/fcadefbneo-fc2mp4.exe` temporarily, keep a backup, restore after): 8220 frames, exit 0 by itself. `rm -rf $L`.

- [ ] **Step 7: Commit**

```bash
git add emulator/build.py emulator/test_build.py emulator/ggponet.def
git commit -m "feat: CI-ready emulator build (case shims, missing tools, ggponet.def)"
```

---

### Task 2: Shared patch-set hash + CI emulator workflow

**Files:**
- Create: `emulator/patchset.py`, `emulator/test_patchset.py`, `src/patchSet.ts`, `.github/workflows/emulator.yml`
- Modify: `src/emulatorBuild.ts` (remove `patchSetHash`/`listFiles`, import from `patchSet.ts`), `tests/emulatorBuild.test.ts` (import path)
- Test: `tests/patchSet.test.ts`

**Interfaces:**
- Produces: Python `patch_set_hash(directory) -> str`; CLI `python3 emulator/patchset.py [dir]` prints it. TS `patchSetHash(emulatorDir: string): Promise<string>` (paths normalised to `/`), `currentPatchSetHash(emulatorDir: () => string | null): Promise<string>` (returns the bundled constant `__FC2MP4_PATCH_SET__` when defined).

- [ ] **Step 1: Failing tests**

`emulator/test_patchset.py`:
```python
import os
import tempfile
import unittest

from patchset import patch_set_hash

FIXTURE_HASH = 'ad8f4307a17afa05c142df8811f108babff53a3509314d60b5196cd9a54894b4'


class PatchSetHashTest(unittest.TestCase):
    def test_matches_the_value_shared_with_the_cli(self):
        d = tempfile.mkdtemp()
        os.makedirs(os.path.join(d, 'src'))
        os.makedirs(os.path.join(d, '__pycache__'))
        for rel, text in [('patches.py', 'A'), ('src/fc2mp4_dump.cpp', 'B'), ('test_x.py', 'ignored'), ('__pycache__/x.pyc', 'ignored')]:
            with open(os.path.join(d, rel), 'w') as f:
                f.write(text)
        self.assertEqual(patch_set_hash(d), FIXTURE_HASH)


if __name__ == '__main__':
    unittest.main()
```

`tests/patchSet.test.ts`:
```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { currentPatchSetHash, patchSetHash } from '../src/patchSet.js';

const FIXTURE_HASH = 'ad8f4307a17afa05c142df8811f108babff53a3509314d60b5196cd9a54894b4';

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fc2mp4-patchset-'));
  await mkdir(join(dir, 'src'));
  await mkdir(join(dir, '__pycache__'));
  await writeFile(join(dir, 'patches.py'), 'A');
  await writeFile(join(dir, 'src', 'fc2mp4_dump.cpp'), 'B');
  await writeFile(join(dir, 'test_x.py'), 'ignored');
  await writeFile(join(dir, '__pycache__', 'x.pyc'), 'ignored');
  return dir;
}

describe('patchSetHash', () => {
  it('matches the value computed by emulator/patchset.py', async () => {
    expect(await patchSetHash(await fixture())).toBe(FIXTURE_HASH);
  });
  it('changes when a patch file changes', async () => {
    const dir = await fixture();
    await writeFile(join(dir, 'src', 'fc2mp4_dump.cpp'), 'C');
    expect(await patchSetHash(dir)).not.toBe(FIXTURE_HASH);
  });
  it('falls back to hashing the emulator folder when not bundled', async () => {
    const dir = await fixture();
    expect(await currentPatchSetHash(() => dir)).toBe(FIXTURE_HASH);
  });
});
```

Delete the `describe('patchSetHash', ...)` block and the `patchSetHash` import from `tests/emulatorBuild.test.ts`.

- [ ] **Step 2: Run, watch fail**

Run: `python3 -m unittest discover -s emulator -p 'test_*.py'; npx vitest run tests/patchSet.test.ts`
Expected: Python ImportError for `patchset`; vitest "Cannot find module '../src/patchSet.js'".

- [ ] **Step 3: Implement**

`emulator/patchset.py`:
```python
#!/usr/bin/env python3
"""Patch-set hash, shared definition with src/patchSet.ts (CI tags releases with it)."""
import hashlib
import os
import sys


def patch_set_hash(directory):
    entries = []
    for root, dirs, files in os.walk(directory):
        dirs[:] = [d for d in dirs if d != '__pycache__' and not d.startswith('test_')]
        for name in files:
            if name.startswith('test_'):
                continue
            entries.append(os.path.relpath(os.path.join(root, name), directory).replace(os.sep, '/'))
    digest = hashlib.sha256()
    for rel in sorted(entries):
        digest.update(rel.encode() + b'\0')
        with open(os.path.join(directory, rel), 'rb') as f:
            digest.update(f.read() + b'\0')
    return digest.hexdigest()


if __name__ == '__main__':
    print(patch_set_hash(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))))
```

`src/patchSet.ts`:
```ts
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

// Defined by scripts/bundle.mjs in the single-executable build (no emulator/ folder there).
declare const __FC2MP4_PATCH_SET__: string | undefined;

async function listFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === '__pycache__' || entry.name.startsWith('test_')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full);
  }
  return files;
}

// Same definition as emulator/patchset.py: relative paths with "/" so every OS agrees.
export async function patchSetHash(emulatorDir: string): Promise<string> {
  const hash = createHash('sha256');
  const files = (await listFiles(emulatorDir)).map((f) => relative(emulatorDir, f).split(sep).join('/')).sort();
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(await readFile(join(emulatorDir, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export async function currentPatchSetHash(emulatorDir: () => string | null): Promise<string> {
  if (typeof __FC2MP4_PATCH_SET__ === 'string') return __FC2MP4_PATCH_SET__;
  const dir = emulatorDir();
  if (dir === null) throw new Error('No patch-set hash: not bundled and no emulator folder');
  return patchSetHash(dir);
}
```

In `src/emulatorBuild.ts`: delete `listFiles` and `patchSetHash`, remove `createHash`/`readdir`/`relative` imports that become unused, and add `import { patchSetHash } from './patchSet.js';`.

- [ ] **Step 4: Run tests**

Run: `python3 -m unittest discover -s emulator -p 'test_*.py' && npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Write `.github/workflows/emulator.yml`**

```yaml
name: emulator
on:
  schedule:
    - cron: '17 4 * * *'
  push:
    branches: [main]
    paths: ['emulator/**', '.github/workflows/emulator.yml']
  workflow_dispatch:
permissions:
  contents: write
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/checkout@v4
      - name: Decide the release tag
        id: tag
        run: |
          commit=$(git ls-remote https://github.com/fightcadeorg/fightcade-fbneo.git refs/heads/master | cut -f1)
          hash=$(python3 emulator/patchset.py emulator)
          tag="emulator-${commit:0:12}-${hash:0:12}"
          echo "tag=$tag" >> "$GITHUB_OUTPUT"
          echo "hash=$hash" >> "$GITHUB_OUTPUT"
          if gh release view "$tag" >/dev/null 2>&1; then echo "exists=true" >> "$GITHUB_OUTPUT"; else echo "exists=false" >> "$GITHUB_OUTPUT"; fi
      - name: Install toolchain
        if: steps.tag.outputs.exists == 'false'
        run: sudo apt-get update && sudo apt-get install -y --no-install-recommends g++-mingw-w64-i686 gcc-mingw-w64-i686 binutils-mingw-w64-i686 g++ perl
      - name: Build
        if: steps.tag.outputs.exists == 'false'
        run: |
          i686-w64-mingw32-dlltool -d emulator/ggponet.def -l "$RUNNER_TEMP/libggponet.a"
          python3 emulator/build.py --source-dir "$RUNNER_TEMP/fightcade-fbneo" --out-dir "$RUNNER_TEMP/out" --ggponet "$RUNNER_TEMP/libggponet.a" \
            || { cat "$RUNNER_TEMP/out/build.log" 2>/dev/null | tail -80; exit 1; }
          python3 - "$RUNNER_TEMP/out/build-info.json" "${{ steps.tag.outputs.hash }}" <<'EOF'
          import json, sys
          path, patch_hash = sys.argv[1], sys.argv[2]
          info = json.load(open(path))
          info['patchSetHash'] = patch_hash
          info.pop('exe', None)
          json.dump(info, open(path, 'w'), indent=2)
          EOF
      - name: Publish
        if: steps.tag.outputs.exists == 'false'
        run: |
          gh release create "${{ steps.tag.outputs.tag }}" \
            "$RUNNER_TEMP/out/fcadefbneo-fc2mp4.exe" "$RUNNER_TEMP/out/build-info.json" \
            --title "Emulator ${{ steps.tag.outputs.tag }}" \
            --notes "Patched Fightcade FBNeo (github.com/fightcadeorg/fightcade-fbneo) built by CI. Downloaded automatically by fc2mp4."
```

- [ ] **Step 6: Commit**

```bash
git add emulator/patchset.py emulator/test_patchset.py src/patchSet.ts src/emulatorBuild.ts tests/patchSet.test.ts tests/emulatorBuild.test.ts .github/workflows/emulator.yml
git commit -m "feat: shared patch-set hash and CI emulator build workflow"
```

---

### Task 3: Platform model, Windows install detection, output folder

**Files:**
- Create: `src/platform.ts`
- Modify: `src/install.ts`, `src/outputPath.ts`, `src/capture.ts` (rename `wineSh` → `launcher!`), `src/convert.ts` (call sites), `src/exec.ts` (`which` per platform)
- Test: `tests/platform.test.ts`, `tests/install.test.ts`, `tests/outputPath.test.ts`

**Interfaces:**
- Produces: `type Platform = 'darwin' | 'win32'`; `supportedPlatform(p: NodeJS.Platform): Platform`; `pathFor(p): path.PlatformPath`; `AppPaths { cacheDir; runtimeDir; sourceDir; ffmpegDir; outputDir }`; `appPaths(platform, home, env): AppPaths`.
- `FightcadeInstall { platform; root; fbneoDir; exe; ggponet; romsDir; rom; mainIni; launcher: string | null }`; `installLayout(root, platform = 'darwin')`; `candidateRoots(platform, home, env)`; `locateInstall({ platform, home, env, override?, exists })`; `PreflightDeps { exists }`; `preflight(install, deps)` (no ffmpeg check any more; moved to Task 7).
- `resolveOutputPath(quarkId, output, defaultDir, isDir?)`.
- `which(cmd, platform = process.platform)` (uses `where` on win32).

- [ ] **Step 1: Failing tests**

`tests/platform.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { appPaths, supportedPlatform } from '../src/platform.js';
import { ExitCode } from '../src/errors.js';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('platform', () => {
  it('accepts macOS and Windows only', () => {
    expect(supportedPlatform('darwin')).toBe('darwin');
    expect(supportedPlatform('win32')).toBe('win32');
    expect(thrown(() => supportedPlatform('linux'))).toMatchObject({ exitCode: ExitCode.Preflight });
  });

  it('places macOS files under Library/Caches and Movies', () => {
    expect(appPaths('darwin', '/Users/fran', {})).toEqual({
      cacheDir: '/Users/fran/Library/Caches/fc2mp4',
      runtimeDir: '/Users/fran/Library/Caches/fc2mp4/runtime',
      sourceDir: '/Users/fran/Library/Caches/fc2mp4/fightcade-fbneo',
      ffmpegDir: '/Users/fran/Library/Caches/fc2mp4/ffmpeg',
      outputDir: '/Users/fran/Movies/Fightcade',
    });
  });

  it('places Windows files under LOCALAPPDATA and Videos', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\Jean Pierre\\AppData\\Local', USERPROFILE: 'C:\\Users\\Jean Pierre' };
    expect(appPaths('win32', 'C:\\Users\\Jean Pierre', env)).toEqual({
      cacheDir: 'C:\\Users\\Jean Pierre\\AppData\\Local\\fc2mp4',
      runtimeDir: 'C:\\Users\\Jean Pierre\\AppData\\Local\\fc2mp4\\runtime',
      sourceDir: 'C:\\Users\\Jean Pierre\\AppData\\Local\\fc2mp4\\fightcade-fbneo',
      ffmpegDir: 'C:\\Users\\Jean Pierre\\AppData\\Local\\fc2mp4\\ffmpeg',
      outputDir: 'C:\\Users\\Jean Pierre\\Videos\\Fightcade',
    });
  });
});
```

Replace `tests/install.test.ts` with:
```ts
import { describe, expect, it } from 'vitest';
import { installLayout, locateInstall, preflight } from '../src/install.js';
import { ExitCode } from '../src/errors.js';

const MAC_ROOT = '/Applications/FightCade2.app';
const WIN_ROOT = 'C:\\Users\\Jean Pierre\\Documents\\Fightcade';

describe('installLayout', () => {
  it('maps the macOS app bundle with wine.sh as launcher', () => {
    const i = installLayout(MAC_ROOT, 'darwin');
    expect(i.platform).toBe('darwin');
    expect(i.fbneoDir).toBe(`${MAC_ROOT}/Contents/MacOS/emulator/fbneo`);
    expect(i.exe).toBe(`${i.fbneoDir}/fcadefbneo.exe`);
    expect(i.ggponet).toBe(`${i.fbneoDir}/ggponet.dll`);
    expect(i.romsDir).toBe(`${i.fbneoDir}/ROMs`);
    expect(i.rom).toBe(`${i.fbneoDir}/ROMs/sfiii3nr1.zip`);
    expect(i.mainIni).toBe(`${i.fbneoDir}/config/fcadefbneo.ini`);
    expect(i.launcher).toBe(`${MAC_ROOT}/Contents/Resources/wine.sh`);
  });
  it('maps a Windows folder (with spaces) and runs the exe directly', () => {
    const i = installLayout(WIN_ROOT, 'win32');
    expect(i.fbneoDir).toBe(`${WIN_ROOT}\\emulator\\fbneo`);
    expect(i.exe).toBe(`${WIN_ROOT}\\emulator\\fbneo\\fcadefbneo.exe`);
    expect(i.rom).toBe(`${WIN_ROOT}\\emulator\\fbneo\\ROMs\\sfiii3nr1.zip`);
    expect(i.launcher).toBeNull();
  });
});

describe('locateInstall', () => {
  it('finds the macOS user Applications install', async () => {
    const home = '/Users/fran';
    const root = `${home}/Applications/FightCade2.app`;
    const i = await locateInstall({ platform: 'darwin', home, env: {}, exists: async (p) => p.startsWith(root) });
    expect(i.root).toBe(root);
  });
  it('finds Fightcade in Documents on Windows', async () => {
    const env = { USERPROFILE: 'C:\\Users\\Jean Pierre', LOCALAPPDATA: 'C:\\Users\\Jean Pierre\\AppData\\Local' };
    const i = await locateInstall({ platform: 'win32', home: env.USERPROFILE, env, exists: async (p) => p.startsWith(WIN_ROOT) });
    expect(i.root).toBe(WIN_ROOT);
    expect(i.platform).toBe('win32');
  });
  it('tries C:\\Fightcade and Programs too', async () => {
    const env = { USERPROFILE: 'C:\\Users\\a', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
    const programs = 'C:\\Users\\a\\AppData\\Local\\Programs\\Fightcade';
    const i = await locateInstall({ platform: 'win32', home: env.USERPROFILE, env, exists: async (p) => p.startsWith(programs) });
    expect(i.root).toBe(programs);
  });
  it('explains a wrong --fightcade-dir per platform', async () => {
    await expect(locateInstall({ platform: 'win32', home: 'C:\\Users\\a', env: {}, override: 'D:\\nope', exists: async () => false })).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      hint: expect.stringContaining('D:\\nope'),
    });
  });
  it('rejects Linux for now', async () => {
    await expect(locateInstall({ platform: 'linux', home: '/home/a', env: {}, exists: async () => true })).rejects.toMatchObject({ exitCode: ExitCode.Preflight });
  });
});

describe('preflight', () => {
  it('needs the ROM, and wine.sh only on macOS', async () => {
    const mac = installLayout(MAC_ROOT, 'darwin');
    const win = installLayout(WIN_ROOT, 'win32');
    await expect(preflight(mac, { exists: async () => true })).resolves.toBeUndefined();
    await expect(preflight(win, { exists: async (p) => !p.endsWith('wine.sh') })).resolves.toBeUndefined();
    await expect(preflight(mac, { exists: async (p) => !p.endsWith('wine.sh') })).rejects.toMatchObject({ message: expect.stringMatching(/wine\.sh/) });
    await expect(preflight(win, { exists: async (p) => !p.endsWith('sfiii3nr1.zip') })).rejects.toMatchObject({ message: expect.stringMatching(/ROM not found/) });
  });
});
```

Keep the `sha256File` test: move it from the old `install.test.ts` into a new `tests/fsUtil.test.ts` unchanged.

Replace `tests/outputPath.test.ts` with:
```ts
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveOutputPath } from '../src/outputPath.js';

const DEFAULT = '/Users/fran/Movies/Fightcade';
const never = async () => false;

describe('resolveOutputPath', () => {
  it('defaults to <defaultDir>/<quarkId>.mp4', async () => {
    expect(await resolveOutputPath('1-2', undefined, DEFAULT, never)).toBe(`${DEFAULT}/1-2.mp4`);
  });
  it('treats an existing directory as the target folder', async () => {
    expect(await resolveOutputPath('1-2', '/tmp/out', DEFAULT, async (p) => p === '/tmp/out')).toBe('/tmp/out/1-2.mp4');
  });
  it('treats a trailing separator as a folder', async () => {
    expect(await resolveOutputPath('1-2', '/tmp/new/', DEFAULT, never)).toBe('/tmp/new/1-2.mp4');
  });
  it('keeps an explicit file path and makes relative paths absolute', async () => {
    expect(await resolveOutputPath('1-2', '/tmp/final.mp4', DEFAULT, never)).toBe('/tmp/final.mp4');
    expect(await resolveOutputPath('1-2', 'clips/a.mp4', DEFAULT, never)).toBe(resolve('clips/a.mp4'));
  });
});
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/platform.test.ts tests/install.test.ts tests/outputPath.test.ts`
Expected: FAIL (missing module `platform.js`, `launcher` undefined, wrong `resolveOutputPath` signature).

- [ ] **Step 3: Implement**

`src/platform.ts`:
```ts
import path from 'node:path';
import { ConvertError, ExitCode } from './errors.js';

export type Platform = 'darwin' | 'win32';

export function supportedPlatform(p: NodeJS.Platform): Platform {
  if (p === 'darwin' || p === 'win32') return p;
  throw new ConvertError(ExitCode.Preflight, `fc2mp4 supports macOS and Windows (this is ${p})`);
}

export function pathFor(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

export interface AppPaths {
  cacheDir: string;
  runtimeDir: string;
  sourceDir: string;
  ffmpegDir: string;
  outputDir: string;
}

export function appPaths(platform: Platform, home: string, env: Record<string, string | undefined>): AppPaths {
  const p = pathFor(platform);
  const cacheDir =
    platform === 'win32' ? p.join(env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local'), 'fc2mp4') : p.join(home, 'Library', 'Caches', 'fc2mp4');
  const outputDir = platform === 'win32' ? p.join(env.USERPROFILE ?? home, 'Videos', 'Fightcade') : p.join(home, 'Movies', 'Fightcade');
  return {
    cacheDir,
    runtimeDir: p.join(cacheDir, 'runtime'),
    sourceDir: p.join(cacheDir, 'fightcade-fbneo'),
    ffmpegDir: p.join(cacheDir, 'ffmpeg'),
    outputDir,
  };
}
```

`src/install.ts`:
```ts
import { GAME } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import { pathFor, supportedPlatform, type Platform } from './platform.js';

export interface FightcadeInstall {
  platform: Platform;
  root: string;
  fbneoDir: string;
  exe: string;
  ggponet: string;
  romsDir: string;
  rom: string;
  mainIni: string;
  // wine.sh on macOS; null on Windows, where the emulator runs directly.
  launcher: string | null;
}

export function installLayout(root: string, platform: Platform = 'darwin'): FightcadeInstall {
  const p = pathFor(platform);
  const fbneoDir = platform === 'darwin' ? p.join(root, 'Contents', 'MacOS', 'emulator', 'fbneo') : p.join(root, 'emulator', 'fbneo');
  return {
    platform,
    root,
    fbneoDir,
    exe: p.join(fbneoDir, 'fcadefbneo.exe'),
    ggponet: p.join(fbneoDir, 'ggponet.dll'),
    romsDir: p.join(fbneoDir, 'ROMs'),
    rom: p.join(fbneoDir, 'ROMs', `${GAME}.zip`),
    mainIni: p.join(fbneoDir, 'config', 'fcadefbneo.ini'),
    launcher: platform === 'darwin' ? p.join(root, 'Contents', 'Resources', 'wine.sh') : null,
  };
}

export function candidateRoots(platform: Platform, home: string, env: Record<string, string | undefined>): string[] {
  const p = pathFor(platform);
  if (platform === 'darwin') return ['/Applications/FightCade2.app', p.join(home, 'Applications', 'FightCade2.app')];
  const profile = env.USERPROFILE ?? home;
  const local = env.LOCALAPPDATA ?? p.join(profile, 'AppData', 'Local');
  return [p.join(profile, 'Documents', 'Fightcade'), p.join(profile, 'Fightcade'), 'C:\\Fightcade', p.join(local, 'Programs', 'Fightcade')];
}

export async function locateInstall(opts: {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
  override?: string;
  exists: (p: string) => Promise<boolean>;
}): Promise<FightcadeInstall> {
  const platform = supportedPlatform(opts.platform);
  for (const root of opts.override ? [opts.override] : candidateRoots(platform, opts.home, opts.env)) {
    const install = installLayout(root, platform);
    if ((await opts.exists(install.exe)) && (await opts.exists(install.ggponet))) return install;
  }
  const what = platform === 'darwin' ? 'FightCade2.app' : 'your Fightcade folder';
  throw new ConvertError(
    ExitCode.Preflight,
    'Fightcade install not found',
    opts.override ? `No emulator/fbneo/fcadefbneo.exe + ggponet.dll under ${opts.override}` : `Install Fightcade 2, or pass --fightcade-dir <path to ${what}>`,
  );
}

export interface PreflightDeps {
  exists(p: string): Promise<boolean>;
}

export async function preflight(install: FightcadeInstall, deps: PreflightDeps): Promise<void> {
  if (!(await deps.exists(install.rom))) {
    throw new ConvertError(ExitCode.Preflight, `3rd Strike ROM not found: ${install.rom}`, 'Open 3rd Strike once in Fightcade so it downloads the ROM');
  }
  if (install.launcher !== null && !(await deps.exists(install.launcher))) {
    throw new ConvertError(ExitCode.Preflight, `wine.sh not found: ${install.launcher}`, 'Reinstall Fightcade');
  }
}
```

`src/outputPath.ts`:
```ts
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

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
  defaultDir: string,
  isDir: (p: string) => Promise<boolean> = isDirectory,
): Promise<string> {
  const fileName = `${quarkId}.mp4`;
  if (output === undefined) return join(defaultDir, fileName);
  if (output.endsWith('/') || output.endsWith(sep) || (await isDir(output))) return resolve(output, fileName);
  return resolve(output);
}
```

`src/exec.ts` — replace `which`:
```ts
export async function which(cmd: string, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  const result = await run(platform === 'win32' ? 'where' : 'which', [cmd]).catch(() => null);
  if (!result || result.code !== 0) return null;
  return result.stdout.split(/\r?\n/)[0]!.trim() || null;
}
```

`src/capture.ts`: replace both `install.wineSh` with `install.launcher!` (Task 5 makes this platform-aware).

`src/convert.ts` `defaultDeps()`: replace the first lines with
```ts
  const home = homedir();
  const platform = supportedPlatform(process.platform);
  const app = appPaths(platform, home, process.env);
  const paths = { ...defaultEmulatorPaths(home), runtimeDir: app.runtimeDir, sourceDir: app.sourceDir };
```
and use `locateInstall({ platform: process.platform, home, env: process.env, override, exists: pathExists })`, `resolveOutputPath(quarkId, output, app.outputDir)`, `preflight(install, { exists: pathExists })`. Add imports `appPaths, supportedPlatform` from `./platform.js`. Remove the now-unused `which` import if the typecheck flags it.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: all pass (the ffmpeg preflight case was removed with the old install test).

- [ ] **Step 5: Commit**

```bash
git add src/platform.ts src/install.ts src/outputPath.ts src/exec.ts src/capture.ts src/convert.ts tests/platform.test.ts tests/install.test.ts tests/outputPath.test.ts tests/fsUtil.test.ts
git commit -m "feat: platform model with Windows install detection and paths"
```

---

### Task 4: Runtime folder on Windows (junction)

**Files:**
- Modify: `src/runtime.ts`
- Test: `tests/runtime.test.ts`

**Interfaces:**
- Produces: `romsLinkType(platform: Platform): 'junction' | 'dir'`; `prepareRuntime(install, runtimeDir, refreshDlls)` unchanged signature, now links with `romsLinkType(install.platform)`.

- [ ] **Step 1: Failing test** — append to `tests/runtime.test.ts` (and add `romsLinkType` to the `../src/runtime.js` import):

```ts
describe('romsLinkType', () => {
  it('uses a junction on Windows (no admin rights needed) and a symlink on macOS', () => {
    expect(romsLinkType('win32')).toBe('junction');
    expect(romsLinkType('darwin')).toBe('dir');
  });
});
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/runtime.test.ts`
Expected: FAIL, `romsLinkType` is not exported.

- [ ] **Step 3: Implement** in `src/runtime.ts`:

```ts
import type { Platform } from './platform.js';

export function romsLinkType(platform: Platform): 'junction' | 'dir' {
  return platform === 'win32' ? 'junction' : 'dir';
}
```
and change `await symlink(install.romsDir, romsLink);` to `await symlink(install.romsDir, romsLink, romsLinkType(install.platform));`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/runtime.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/runtime.ts tests/runtime.test.ts
git commit -m "feat: link ROMs with a junction on Windows"
```

---

### Task 5: Video transport (FIFO / named pipe) and per-platform emulator launch

**Files:**
- Create: `src/transport.ts`, `tests/transport.test.ts`
- Modify: `src/capture.ts`, `tests/capture.test.ts`

**Interfaces:**
- Produces:
  - `VideoTransport { emulatorPath: string; encoderInput: string; attach(stdin: Writable): void; close(): Promise<void> }`
  - `fifoTransport(dir: string, makeFifo: (p: string) => Promise<void>): Promise<VideoTransport>` (emulatorPath = `winPath(fifo)`, encoderInput = fifo path)
  - `pipeTransport(pipePath: string): Promise<VideoTransport>` (encoderInput `'pipe:0'`)
  - `pipeName(pid: number, random: string): string` → `\\.\pipe\fc2mp4-<pid>-<random>`
  - capture: `CaptureDeps` now `{ openTransport(dir): Promise<VideoTransport>; toEmulatorPath(p): string; startEncoder(args, onFrames, attach: ((stdin: Writable) => void) | null): CaptureProcess; startEmulator(env); readInfo(path); now(); sleep(ms) }`; `emulatorCommand(install, runtimeDir, quarkId): { command: string; args: string[] }`; `killCommand(install): { command: string; args: string[] }`; `defaultCaptureDeps(install, runtimeDir, quarkId, ffmpeg: string)`.
- `winPath` moves to `transport.ts`; `capture.ts` re-exports it (`export { winPath } from './transport.js';`) and deletes its own copy, so existing imports keep working and there is no import cycle.

- [ ] **Step 1: Failing transport tests**

`tests/transport.test.ts`:
```ts
import { connect } from 'node:net';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { fifoTransport, pipeName, pipeTransport } from '../src/transport.js';

// On macOS a Unix domain socket stands in for \\.\pipe\…: same node:net API.
async function socketPath(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'fc2mp4-pipe-')), 'video.sock');
}

function slowSink() {
  const chunks: Buffer[] = [];
  let finished = false;
  const sink = new Writable({
    highWaterMark: 1024,
    write(chunk, _enc, done) {
      chunks.push(chunk);
      setTimeout(done, 1);
    },
    final(done) {
      finished = true;
      done();
    },
  });
  return { sink, data: () => Buffer.concat(chunks), finished: () => finished };
}

describe('pipeTransport', () => {
  it('relays every byte in order into the encoder input and ends it when the emulator closes', async () => {
    const transport = await pipeTransport(await socketPath());
    expect(transport.encoderInput).toBe('pipe:0');
    const { sink, data, finished } = slowSink();
    transport.attach(sink);

    const payload = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    await new Promise<void>((resolve) => {
      const client = connect(transport.emulatorPath, () => client.end(payload));
      client.on('close', () => resolve());
    });
    await new Promise<void>((resolve) => sink.on('finish', () => resolve()));

    expect(finished()).toBe(true);
    expect(data().equals(payload)).toBe(true);
    await transport.close();
  });

  it('works when the encoder is attached after the emulator connected', async () => {
    const transport = await pipeTransport(await socketPath());
    const client = connect(transport.emulatorPath);
    await new Promise((resolve) => client.on('connect', resolve));
    client.write(Buffer.from('frame-1'));
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (c) => chunks.push(c));
    transport.attach(out);
    client.end(Buffer.from('frame-2'));
    await new Promise((resolve) => out.on('end', resolve));
    expect(Buffer.concat(chunks).toString()).toBe('frame-1frame-2');
    await transport.close();
  });

  it('close() releases the pipe even if the emulator never connected', async () => {
    const path = await socketPath();
    const transport = await pipeTransport(path);
    await transport.close();
    const again = await pipeTransport(path);
    await again.close();
  });
});

describe('fifoTransport', () => {
  it('makes the FIFO and maps it onto Wine drive Z:', async () => {
    const made: string[] = [];
    const t = await fifoTransport('/tmp/run x', async (p) => {
      made.push(p);
    });
    expect(made).toEqual(['/tmp/run x/video.fifo']);
    expect(t.emulatorPath).toBe('Z:\\tmp\\run x\\video.fifo');
    expect(t.encoderInput).toBe('/tmp/run x/video.fifo');
  });
});

describe('pipeName', () => {
  it('builds a Windows named pipe path', () => {
    expect(pipeName(1234, 'ab12')).toBe('\\\\.\\pipe\\fc2mp4-1234-ab12');
  });
});
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/transport.test.ts`
Expected: FAIL, "Cannot find module '../src/transport.js'".

- [ ] **Step 3: Implement `src/transport.ts`**

```ts
import { rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Writable } from 'node:stream';

// Under Wine, POSIX paths are reachable through drive Z:.
export function winPath(p: string): string {
  return `Z:${p.replace(/\//g, '\\')}`;
}

export interface VideoTransport {
  emulatorPath: string; // what FC2MP4_VIDEO is set to
  encoderInput: string; // ffmpeg -i argument
  attach(stdin: Writable): void; // connect the encoder's stdin (named pipe only)
  close(): Promise<void>;
}

export async function fifoTransport(dir: string, makeFifo: (p: string) => Promise<void>): Promise<VideoTransport> {
  const fifo = join(dir, 'video.fifo');
  await makeFifo(fifo);
  return { emulatorPath: winPath(fifo), encoderInput: fifo, attach: () => {}, close: async () => {} };
}

export function pipeName(pid: number, random: string): string {
  return `\\\\.\\pipe\\fc2mp4-${pid}-${random}`;
}

// Node serves the pipe; the emulator fopen()s it as a client; bytes are relayed to ffmpeg's stdin.
export async function pipeTransport(pipePath: string): Promise<VideoTransport> {
  let socket: Socket | null = null;
  let target: Writable | null = null;
  const server = createServer((incoming) => {
    if (socket) {
      incoming.destroy();
      return;
    }
    socket = incoming;
    if (target) incoming.pipe(target);
  });
  if (!pipePath.startsWith('\\\\.\\pipe\\')) await rm(pipePath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipePath, () => resolve());
  });
  return {
    emulatorPath: pipePath,
    encoderInput: 'pipe:0',
    attach(stdin) {
      target = stdin;
      if (socket) socket.pipe(stdin);
    },
    close: () =>
      new Promise((resolve) => {
        socket?.destroy();
        server.close(() => resolve());
      }),
  };
}
```

- [ ] **Step 4: Run transport tests**

Run: `npx vitest run tests/transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Failing capture tests** — in `tests/capture.test.ts`:

Replace the `makeFifo` fake in `harness` with:
```ts
    openTransport: async (dir) => {
      log.push(`transport:${dir}`);
      return {
        emulatorPath: 'Z:\\tmp\\fc2mp4-x\\video.fifo',
        encoderInput: `${dir}/video.fifo`,
        attach: () => {
          log.push('attach');
        },
        close: async () => {
          log.push('close:transport');
        },
      };
    },
    toEmulatorPath: (p) => winPath(p),
```
change `startEncoder: (args, frames) => {` to `startEncoder: (args, frames, attach) => {` and add `if (attach) attach(new PassThrough());` as its first line (import `PassThrough` from `node:stream`). Update the first test's expected log to
`[`transport:${DIR}`, `encoder:${DIR}/video.mp4`, 'emulator', 'close:transport']`, and add:

```ts
  it('closes the transport on every exit path', async () => {
    for (const world of [{}, { emulatorExitsAt: 2_000 }, { infoAt: 1_000, encoderExitsAt: 3_000, encoderCode: 1 }]) {
      const { deps, log } = harness(world);
      await capture(deps, base).catch(() => {});
      expect(log).toContain('close:transport');
    }
  });

  it('attaches the encoder stdin when the transport is a pipe', async () => {
    const { deps, log } = harness({ infoAt: 1_000, emulatorExitsAt: 10_000 });
    const open = deps.openTransport;
    deps.openTransport = async (dir) => ({ ...(await open(dir)), encoderInput: 'pipe:0', emulatorPath: '\\\\.\\pipe\\fc2mp4-1-a' });
    await capture(deps, base);
    expect(log).toContain('attach');
  });
```

and a launch-command block:
```ts
import { emulatorCommand, killCommand } from '../src/capture.js';
import { installLayout } from '../src/install.js';

describe('emulator launch per platform', () => {
  it('runs through wine.sh on macOS', () => {
    const mac = installLayout('/Applications/FightCade2.app', 'darwin');
    expect(emulatorCommand(mac, '/rt', '1-2')).toEqual({
      command: '/Applications/FightCade2.app/Contents/Resources/wine.sh',
      args: ['/rt/fcadefbneo-fc2mp4.exe', 'quark:stream,sfiii3nr1,1-2.7,7100'],
    });
    expect(killCommand(mac)).toEqual({ command: mac.launcher, args: ['taskkill', '/IM', 'fcadefbneo-fc2mp4.exe', '/F'] });
  });
  it('runs the exe directly on Windows, with spaces in the path', () => {
    const win = installLayout('C:\\Users\\Jean Pierre\\Documents\\Fightcade', 'win32');
    const rt = 'C:\\Users\\Jean Pierre\\AppData\\Local\\fc2mp4\\runtime';
    expect(emulatorCommand(win, rt, '1-2')).toEqual({
      command: `${rt}\\fcadefbneo-fc2mp4.exe`,
      args: ['quark:stream,sfiii3nr1,1-2.7,7100'],
    });
    expect(killCommand(win)).toEqual({ command: 'taskkill', args: ['/IM', 'fcadefbneo-fc2mp4.exe', '/F'] });
  });
});
```

- [ ] **Step 6: Run, watch fail**

Run: `npx vitest run tests/capture.test.ts`
Expected: FAIL (`openTransport` unused / `emulatorCommand` not exported).

- [ ] **Step 7: Implement in `src/capture.ts`**

Imports: add `import type { Writable } from 'node:stream';`, `import { randomBytes } from 'node:crypto';`, `import { fifoTransport, pipeName, pipeTransport, winPath, type VideoTransport } from './transport.js';`, `import { pathFor } from './platform.js';`. Delete the local `winPath` function and add `export { winPath } from './transport.js';`.

Replace the `CaptureDeps` interface with:
```ts
export interface CaptureDeps {
  openTransport(dir: string): Promise<VideoTransport>;
  toEmulatorPath(p: string): string;
  startEncoder(args: string[], onFrames: (frames: number) => void, attach: ((stdin: Writable) => void) | null): CaptureProcess;
  startEmulator(env: Record<string, string>): CaptureProcess;
  readInfo(path: string): Promise<string | null>;
  now(): number;
  sleep(ms: number): Promise<void>;
}
```

In `capture()`, replace the setup (from `const fifo = …` through `const emulator = deps.startEmulator({…});`) with:
```ts
  const video = join(opts.dir, 'video.mp4');
  const audio = join(opts.dir, 'audio.raw');
  const info = join(opts.dir, 'info.txt');

  const transport = await deps.openTransport(opts.dir);
  let frames = 0;
  const attach = transport.encoderInput === 'pipe:0' ? (stdin: Writable) => transport.attach(stdin) : null;
  const encoder = deps.startEncoder(videoEncodeArgs({ input: transport.encoderInput, output: video, scale: opts.scale }), (n) => (frames = n), attach);
  const emulator = deps.startEmulator({
    FC2MP4_VIDEO: transport.emulatorPath,
    FC2MP4_AUDIO: deps.toEmulatorPath(audio),
    FC2MP4_INFO: deps.toEmulatorPath(info),
    FC2MP4_IDLE_MS: String(TIMEOUTS.emulatorIdleMs),
  });
```
and in the `finally` block add `await transport.close().catch(() => {});` after the two kills.

Add (after the imports):
```ts
export function emulatorCommand(install: FightcadeInstall, runtimeDir: string, quarkId: string): { command: string; args: string[] } {
  const exe = pathFor(install.platform).join(runtimeDir, EMULATOR_EXE);
  if (install.launcher !== null) return { command: install.launcher, args: [exe, streamArg(quarkId)] };
  return { command: exe, args: [streamArg(quarkId)] };
}

export function killCommand(install: FightcadeInstall): { command: string; args: string[] } {
  const args = ['/IM', EMULATOR_EXE, '/F'];
  return install.launcher !== null ? { command: install.launcher, args: ['taskkill', ...args] } : { command: 'taskkill', args };
}
```

Replace `defaultCaptureDeps` with:
```ts
export function defaultCaptureDeps(install: FightcadeInstall, runtimeDir: string, quarkId: string, ffmpeg: string): CaptureDeps {
  return {
    openTransport: (dir) =>
      install.platform === 'win32'
        ? pipeTransport(pipeName(process.pid, randomBytes(4).toString('hex')))
        : fifoTransport(dir, async (path) => {
            const result = await run('mkfifo', [path]);
            if (result.code !== 0) throw new ConvertError(ExitCode.Recording, `mkfifo failed: ${result.stderr.trim()}`);
          }),
    toEmulatorPath: (p) => (install.platform === 'win32' ? p : winPath(p)),
    startEncoder: (args, onFrames, attach) => {
      const child = spawn(ffmpeg, args, { stdio: [attach ? 'pipe' : 'ignore', 'pipe', 'ignore'] });
      if (attach && child.stdin) {
        child.stdin.on('error', () => {}); // ffmpeg exiting early must not crash Node (EPIPE)
        attach(child.stdin);
      }
      child.stdout!.on('data', (d) => {
        const frames = parseProgressFrames(String(d));
        if (frames !== null) onFrames(frames);
      });
      return wrap(child, async () => {
        child.kill('SIGKILL');
      });
    },
    startEmulator: (env) => {
      const { command, args } = emulatorCommand(install, runtimeDir, quarkId);
      const child = spawn(command, args, { cwd: runtimeDir, env: { ...process.env, ...env }, stdio: 'ignore' });
      return wrap(child, async () => {
        const kill = killCommand(install);
        await run(kill.command, kill.args, { cwd: runtimeDir, timeoutMs: TIMEOUTS.killMs }).catch(() => {});
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

In `src/convert.ts` `defaultDeps`, temporarily pass `'ffmpeg'` as the 4th argument of `defaultCaptureDeps` (Task 7 replaces it with the located path).

- [ ] **Step 8: Run tests**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 9: Real macOS check (FIFO path unchanged)**

Run: `FC_E2E='https://replay.fightcade.com/fbneo/sfiii3nr1/1791006077129-2245' FC_E2E_EXPECTED_SECONDS=137.94 npx vitest run tests/e2e.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/transport.ts src/capture.ts src/convert.ts tests/transport.test.ts tests/capture.test.ts
git commit -m "feat: named-pipe video transport and per-platform emulator launch"
```

---

### Task 6: Emulator release client

**Files:**
- Create: `src/emulatorRelease.ts`, `tests/emulatorRelease.test.ts`
- Modify: `src/emulatorBuild.ts` (reduce to the local build), `tests/emulatorBuild.test.ts` (delete; covered by the new tests)

**Interfaces:**
- Consumes: `currentPatchSetHash` (Task 2), `EMULATOR_EXE`.
- Produces:
  - `REPO = 'Coccis77/fightcade-replay-converter'`
  - `Release { tag: string; publishedAt: string; assets: { name: string; url: string; size: number }[] }`
  - `pickRelease(releases: Release[], patchSetHash: string): Release | null`
  - `EmulatorManifest { source: 'release' | 'local'; tag: string | null; sourceCommit: string; patchSetHash: string; installedAt: string; checkedAt: string }`
  - `ReleaseDeps { listReleases(); download(url, dest); readManifest(); writeManifest(m); exeExists(); tempDownloadPath(): string; verifyDownload(tmp, expectedSize): Promise<void>; installExe(tmp); removeFile(p); localBuild: (() => Promise<{ sourceCommit: string }>) | null; now(): Date }`
  - `EnsureResult { updated: boolean; warning?: string }`
  - `ensureEmulator(opts: { patchSetHash: string; force: boolean; local: boolean }, deps: ReleaseDeps): Promise<EnsureResult>`
  - `defaultReleaseDeps(runtimeDir: string, localBuild: ReleaseDeps['localBuild']): ReleaseDeps`
  - `emulatorBuild.ts`: `localBuild(install: FightcadeInstall, paths: { emulatorDir: string; sourceDir: string; runtimeDir: string }): Promise<{ sourceCommit: string }>` (toolchain check + build.py, unchanged logic), `emulatorDir(): string | null` (null when bundled).

- [ ] **Step 1: Failing tests**

`tests/emulatorRelease.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ensureEmulator, pickRelease, type EmulatorManifest, type Release, type ReleaseDeps } from '../src/emulatorRelease.js';
import { ExitCode } from '../src/errors.js';

const HASH = 'abcdef123456' + '0'.repeat(52);
const NOW = new Date('2026-10-04T12:00:00.000Z');
const exeAsset = (tag: string) => ({ name: 'fcadefbneo-fc2mp4.exe', url: `https://x/${tag}/exe`, size: 1000 });
const rel = (tag: string, publishedAt: string): Release => ({ tag, publishedAt, assets: [exeAsset(tag)] });

describe('pickRelease', () => {
  it('picks the newest release built for our patch set', () => {
    const releases = [
      rel('emulator-aaaaaaaaaaaa-abcdef123456', '2026-10-01T00:00:00Z'),
      rel('emulator-bbbbbbbbbbbb-abcdef123456', '2026-10-03T00:00:00Z'),
      rel('emulator-cccccccccccc-999999999999', '2026-10-04T00:00:00Z'),
      rel('v0.3.0', '2026-10-04T00:00:00Z'),
    ];
    expect(pickRelease(releases, HASH)?.tag).toBe('emulator-bbbbbbbbbbbb-abcdef123456');
  });
  it('ignores releases without the exe and returns null when nothing matches', () => {
    expect(pickRelease([{ tag: 'emulator-aaaaaaaaaaaa-abcdef123456', publishedAt: '2026-10-01T00:00:00Z', assets: [] }], HASH)).toBeNull();
    expect(pickRelease([], HASH)).toBeNull();
  });
});

function harness(world: {
  manifest?: EmulatorManifest | null;
  exeExists?: boolean;
  releases?: Release[] | Error;
  downloadFails?: boolean;
  badFile?: boolean;
  local?: boolean;
}) {
  const calls: string[] = [];
  let written: EmulatorManifest | null = null;
  const deps: ReleaseDeps = {
    listReleases: async () => {
      calls.push('list');
      if (world.releases instanceof Error) throw world.releases;
      return world.releases ?? [rel('emulator-bbbbbbbbbbbb-abcdef123456', '2026-10-03T00:00:00Z')];
    },
    download: async (url, dest) => {
      calls.push(`download:${url}->${dest}`);
      if (world.downloadFails) throw new Error('connection reset');
    },
    readManifest: async () => (world.manifest === undefined ? null : world.manifest),
    writeManifest: async (m) => {
      written = m;
    },
    exeExists: async () => world.exeExists ?? false,
    tempDownloadPath: () => 'download',
    verifyDownload: async () => {
      if (world.badFile) throw new Error('downloaded file is incomplete or not a Windows executable');
    },
    installExe: async (tmp) => {
      calls.push(`install:${tmp}`);
    },
    removeFile: async (p) => {
      calls.push(`rm:${p}`);
    },
    localBuild: world.local
      ? async () => {
          calls.push('local-build');
          return { sourceCommit: 'c'.repeat(40) };
        }
      : null,
    now: () => NOW,
  };
  return { deps, calls, written: () => written };
}

const installed = (over: Partial<EmulatorManifest> = {}): EmulatorManifest => ({
  source: 'release',
  tag: 'emulator-aaaaaaaaaaaa-abcdef123456',
  sourceCommit: 'aaaaaaaaaaaa',
  patchSetHash: HASH,
  installedAt: '2026-10-01T00:00:00.000Z',
  checkedAt: '2026-10-04T06:00:00.000Z',
  ...over,
});

describe('ensureEmulator', () => {
  const opts = { patchSetHash: HASH, force: false, local: false };

  it('downloads the matching release on first run', async () => {
    const { deps, calls, written } = harness({});
    expect(await ensureEmulator(opts, deps)).toEqual({ updated: true });
    expect(calls).toEqual(['list', 'download:https://x/emulator-bbbbbbbbbbbb-abcdef123456/exe->download', 'install:download']);
    expect(written()).toMatchObject({ source: 'release', tag: 'emulator-bbbbbbbbbbbb-abcdef123456', sourceCommit: 'bbbbbbbbbbbb', patchSetHash: HASH });
  });

  it('does not contact GitHub again within 24 hours', async () => {
    const { deps, calls } = harness({ manifest: installed(), exeExists: true });
    expect(await ensureEmulator(opts, deps)).toEqual({ updated: false });
    expect(calls).toEqual([]);
  });

  it('updates to a newer release after 24 hours', async () => {
    const { deps, calls } = harness({ manifest: installed({ checkedAt: '2026-10-03T06:00:00.000Z' }), exeExists: true });
    expect((await ensureEmulator(opts, deps)).updated).toBe(true);
    expect(calls).toContain('install:download');
  });

  it('only refreshes the check time when already on the newest release', async () => {
    const { deps, calls, written } = harness({ manifest: installed({ tag: 'emulator-bbbbbbbbbbbb-abcdef123456', checkedAt: '2026-10-01T00:00:00.000Z' }), exeExists: true });
    expect(await ensureEmulator(opts, deps)).toEqual({ updated: false });
    expect(calls).toEqual(['list']);
    expect(written()?.checkedAt).toBe(NOW.toISOString());
  });

  it('keeps the installed build when GitHub is unreachable', async () => {
    const { deps } = harness({ manifest: installed({ checkedAt: '2026-10-01T00:00:00.000Z' }), exeExists: true, releases: new Error('getaddrinfo ENOTFOUND api.github.com') });
    const result = await ensureEmulator(opts, deps);
    expect(result.updated).toBe(false);
    expect(result.warning).toContain('ENOTFOUND');
  });

  it('fails clearly when GitHub is unreachable and nothing is installed', async () => {
    const { deps } = harness({ releases: new Error('getaddrinfo ENOTFOUND api.github.com') });
    await expect(ensureEmulator(opts, deps)).rejects.toMatchObject({ exitCode: ExitCode.Emulator });
  });

  it('a truncated download never replaces the installed exe', async () => {
    const { deps, calls } = harness({ manifest: installed({ checkedAt: '2026-10-01T00:00:00.000Z' }), exeExists: true, badFile: true });
    const result = await ensureEmulator(opts, deps);
    expect(result.updated).toBe(false);
    expect(result.warning).toContain('incomplete');
    expect(calls).not.toContain('install:download');
    expect(calls).toContain('rm:download');
  });

  it('builds locally on macOS when no release matches our patch set', async () => {
    const { deps, calls, written } = harness({ releases: [], local: true });
    const result = await ensureEmulator(opts, deps);
    expect(result.updated).toBe(true);
    expect(calls).toContain('local-build');
    expect(written()).toMatchObject({ source: 'local', tag: null, patchSetHash: HASH });
  });

  it('explains on Windows that no build is published yet', async () => {
    const { deps } = harness({ releases: [] });
    await expect(ensureEmulator(opts, deps)).rejects.toMatchObject({ exitCode: ExitCode.Emulator, message: expect.stringContaining('No emulator build') });
  });

  it('never runs an exe built for another patch set', async () => {
    const { deps } = harness({ manifest: installed({ patchSetHash: 'f'.repeat(64) }), exeExists: true, releases: new Error('offline') });
    await expect(ensureEmulator(opts, deps)).rejects.toMatchObject({ exitCode: ExitCode.Emulator });
  });

  it('force skips the 24-hour cache; local forces a local build', async () => {
    const forced = harness({ manifest: installed(), exeExists: true });
    await ensureEmulator({ ...opts, force: true }, forced.deps);
    expect(forced.calls).toContain('list');
    const local = harness({ manifest: installed(), exeExists: true, local: true });
    await ensureEmulator({ ...opts, local: true }, local.deps);
    expect(local.calls).toEqual(['local-build']);
    const noToolchain = harness({});
    await expect(ensureEmulator({ ...opts, local: true }, noToolchain.deps)).rejects.toMatchObject({ exitCode: ExitCode.Usage });
  });
});
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/emulatorRelease.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/emulatorRelease.ts`**

```ts
import { createWriteStream } from 'node:fs';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EMULATOR_EXE } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';
import { pathExists } from './fsUtil.js';

export const REPO = 'Coccis77/fightcade-replay-converter';
const DAY_MS = 24 * 60 * 60_000;

export interface Release {
  tag: string;
  publishedAt: string;
  assets: { name: string; url: string; size: number }[];
}

export interface EmulatorManifest {
  source: 'release' | 'local';
  tag: string | null;
  sourceCommit: string;
  patchSetHash: string;
  installedAt: string;
  checkedAt: string;
}

export interface ReleaseDeps {
  listReleases(): Promise<Release[]>;
  download(url: string, dest: string): Promise<void>;
  readManifest(): Promise<EmulatorManifest | null>;
  writeManifest(m: EmulatorManifest): Promise<void>;
  exeExists(): Promise<boolean>;
  tempDownloadPath(): string;
  verifyDownload(tmp: string, expectedSize: number): Promise<void>;
  installExe(tmp: string): Promise<void>;
  removeFile(p: string): Promise<void>;
  localBuild: (() => Promise<{ sourceCommit: string }>) | null;
  now(): Date;
}

export interface EnsureResult {
  updated: boolean;
  warning?: string;
}

export function pickRelease(releases: Release[], patchSetHash: string): Release | null {
  const suffix = `-${patchSetHash.slice(0, 12)}`;
  const matching = releases.filter(
    (r) => r.tag.startsWith('emulator-') && r.tag.endsWith(suffix) && r.assets.some((a) => a.name === EMULATOR_EXE),
  );
  matching.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return matching[0] ?? null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function ensureEmulator(opts: { patchSetHash: string; force: boolean; local: boolean }, deps: ReleaseDeps): Promise<EnsureResult> {
  const manifest = await deps.readManifest();
  const exe = await deps.exeExists();
  const usable = exe && manifest !== null && manifest.patchSetHash === opts.patchSetHash;
  const now = deps.now();

  const buildLocally = async (): Promise<EnsureResult> => {
    if (!deps.localBuild) {
      throw new ConvertError(ExitCode.Usage, 'Local emulator builds are only available when running fc2mp4 from source on macOS');
    }
    const { sourceCommit } = await deps.localBuild();
    await deps.writeManifest({ source: 'local', tag: null, sourceCommit, patchSetHash: opts.patchSetHash, installedAt: now.toISOString(), checkedAt: now.toISOString() });
    return { updated: true };
  };

  if (opts.local) return buildLocally();
  if (usable && !opts.force && now.getTime() - Date.parse(manifest.checkedAt) < DAY_MS) return { updated: false };

  let releases: Release[];
  try {
    releases = await deps.listReleases();
  } catch (err) {
    if (usable) return { updated: false, warning: `Could not check for emulator updates (${message(err)}); using the installed build` };
    throw new ConvertError(ExitCode.Emulator, `Could not download the emulator: ${message(err)}`, 'Check your internet connection and retry');
  }

  const release = pickRelease(releases, opts.patchSetHash);
  if (!release) {
    if (usable && manifest.source === 'local') {
      await deps.writeManifest({ ...manifest, checkedAt: now.toISOString() });
      return { updated: false };
    }
    if (deps.localBuild) {
      const result = await buildLocally();
      return { ...result, warning: 'No published emulator build for this fc2mp4 version; built it locally' };
    }
    throw new ConvertError(ExitCode.Emulator, 'No emulator build is published for this fc2mp4 version yet', 'Wait for the GitHub Actions emulator build to finish, then retry');
  }

  if (usable && manifest.tag === release.tag) {
    await deps.writeManifest({ ...manifest, checkedAt: now.toISOString() });
    return { updated: false };
  }

  const asset = release.assets.find((a) => a.name === EMULATOR_EXE)!;
  const tmp = deps.tempDownloadPath();
  try {
    await deps.download(asset.url, tmp);
    await deps.verifyDownload(tmp, asset.size);
    await deps.installExe(tmp);
  } catch (err) {
    await deps.removeFile(tmp);
    if (usable) return { updated: false, warning: `Could not download the emulator update (${message(err)}); using the installed build` };
    throw new ConvertError(ExitCode.Emulator, `Could not download the emulator: ${message(err)}`, 'Check your internet connection and retry');
  }
  const sourceCommit = release.tag.split('-')[1] ?? '';
  await deps.writeManifest({ source: 'release', tag: release.tag, sourceCommit, patchSetHash: opts.patchSetHash, installedAt: now.toISOString(), checkedAt: now.toISOString() });
  return { updated: true };
}

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  assets: { name: string; browser_download_url: string; size: number }[];
}

export function defaultReleaseDeps(runtimeDir: string, localBuild: ReleaseDeps['localBuild']): ReleaseDeps {
  const manifestPath = join(runtimeDir, 'manifest.json');
  const exePath = join(runtimeDir, EMULATOR_EXE);
  const headers = { 'User-Agent': 'fc2mp4', Accept: 'application/vnd.github+json' };
  return {
    listReleases: async () => {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100`, { headers, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`GitHub API ${res.status}`);
      const body = (await res.json()) as GitHubRelease[];
      return body.map((r) => ({
        tag: r.tag_name,
        publishedAt: r.published_at,
        assets: r.assets.map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size })),
      }));
    },
    download: async (url, dest) => {
      const res = await fetch(url, { headers: { 'User-Agent': 'fc2mp4' }, signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest));
    },
    readManifest: async () => {
      try {
        const m = JSON.parse(await readFile(manifestPath, 'utf8')) as Partial<EmulatorManifest>;
        return m.source && m.patchSetHash && m.checkedAt ? (m as EmulatorManifest) : null;
      } catch {
        return null;
      }
    },
    writeManifest: (m) => writeFile(manifestPath, `${JSON.stringify(m, null, 2)}\n`),
    exeExists: () => pathExists(exePath),
    tempDownloadPath: () => `${exePath}.download`,
    verifyDownload: async (tmp, expectedSize) => {
      const size = (await stat(tmp)).size;
      const handle = await open(tmp, 'r');
      const header = Buffer.alloc(2);
      await handle.read(header, 0, 2, 0);
      await handle.close();
      if (size !== expectedSize || header.toString('latin1') !== 'MZ') {
        throw new Error('downloaded file is incomplete or not a Windows executable');
      }
    },
    installExe: (tmp) => rename(tmp, exePath),
    removeFile: (p) => rm(p, { force: true }),
    localBuild,
    now: () => new Date(),
  };
}
```

Note: an old-format `manifest.json` (rev 2, no `source` field) is treated as missing by `readManifest`, so the first run after upgrading downloads a release.

`src/emulatorBuild.ts` — replace the whole file with:
```ts
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConvertError, ExitCode } from './errors.js';
import { run, which, type RunFn } from './exec.js';
import type { FightcadeInstall } from './install.js';

declare const __FC2MP4_BUNDLED__: boolean | undefined;

// The emulator/ folder ships with the source checkout, not with the single executable.
export function emulatorDir(): string | null {
  if (typeof __FC2MP4_BUNDLED__ === 'boolean' && __FC2MP4_BUNDLED__) return null;
  return fileURLToPath(new URL('../emulator', import.meta.url));
}

const TOOLCHAIN = ['git', 'perl', 'python3', 'i686-w64-mingw32-g++'];

export async function localBuild(
  install: FightcadeInstall,
  paths: { emulatorDir: string; sourceDir: string; runtimeDir: string },
  runFn: RunFn = run,
): Promise<{ sourceCommit: string }> {
  const missing: string[] = [];
  for (const tool of TOOLCHAIN) if ((await which(tool)) === null) missing.push(tool);
  if (missing.length > 0) {
    throw new ConvertError(ExitCode.Preflight, `Missing tools to build the emulator: ${missing.join(', ')}`, 'brew install mingw-w64 git');
  }
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
}
```

Delete `tests/emulatorBuild.test.ts` (`git rm`). In `src/convert.ts`, temporarily keep compiling by replacing the `ensureEmulator` dependency with Task 8's wiring — or, to keep this task self-contained, change `defaultDeps().ensureEmulator` to:
```ts
    ensureEmulator: async (install, force) => {
      const dir = emulatorDir();
      const hash = await currentPatchSetHash(emulatorDir);
      const local = install.platform === 'darwin' && dir !== null
        ? () => localBuild(install, { emulatorDir: dir, sourceDir: app.sourceDir, runtimeDir: app.runtimeDir })
        : null;
      return ensureEmulator({ patchSetHash: hash, force, local: false }, defaultReleaseDeps(app.runtimeDir, local));
    },
```
and `prepareRuntime(install, ensured.updated)` (rename `rebuilt` → `updated` in `convert`); delete the `const paths = { ...defaultEmulatorPaths(home), … }` line added in Task 3; with imports `emulatorDir, localBuild` from `./emulatorBuild.js`, `currentPatchSetHash` from `./patchSet.js`, `ensureEmulator, defaultReleaseDeps, type EnsureResult` from `./emulatorRelease.js`; remove `defaultEmulatorPaths`/`defaultEnsureDeps`. Update `tests/convert.test.ts` fakes: `ensureEmulator` returns `{ updated: false }` / `{ updated: true }` instead of `rebuilt`.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/emulatorRelease.ts src/emulatorBuild.ts src/convert.ts tests/emulatorRelease.test.ts tests/convert.test.ts
git rm -q tests/emulatorBuild.test.ts
git commit -m "feat: download the emulator from GitHub releases matching the patch set"
```

---

### Task 7: ffmpeg locator (PATH, cached, mirrored download) + mirror workflow

**Files:**
- Create: `src/ffmpegLocator.ts`, `tests/ffmpegLocator.test.ts`, `.github/workflows/tools.yml`
- Modify: `src/ffmpeg.ts` (`mux(args, ffmpeg = 'ffmpeg')`, existing tests keep working), `src/convert.ts` (locate once, pass the path), `tests/convert.test.ts`

**Interfaces:**
- Produces: `FFMPEG_MIRROR = { tag: 'tools-ffmpeg-9.0.2', exe: 'ffmpeg.exe', checksum: 'ffmpeg.exe.sha256' }`; `FfmpegDeps { which(cmd): Promise<string | null>; exists(p); readText(url): Promise<string>; download(url, dest); sha256(p): Promise<string>; rename(from, to); remove(p); mkdir(dir) }`; `locateFfmpeg(platform: Platform, ffmpegDir: string, deps: FfmpegDeps): Promise<string>`; `defaultFfmpegDeps(platform): FfmpegDeps`; `mux(args, ffmpeg: string)`.
- ConvertDeps gains `locateFfmpeg(install): Promise<string>`; `capture(install, quarkId, ffmpeg, opts)`; `mux(args, ffmpeg)`.

- [ ] **Step 1: Failing tests**

`tests/ffmpegLocator.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { locateFfmpeg, type FfmpegDeps } from '../src/ffmpegLocator.js';
import { ExitCode } from '../src/errors.js';

const DIR = 'C:\\Users\\a\\AppData\\Local\\fc2mp4\\ffmpeg';
const GOOD = 'a'.repeat(64);

function fakeDeps(world: { onPath?: string; cached?: boolean; actualSha?: string }) {
  const calls: string[] = [];
  const deps: FfmpegDeps = {
    which: async () => world.onPath ?? null,
    exists: async () => world.cached ?? false,
    readText: async (url) => {
      calls.push(`read:${url}`);
      return `${GOOD}  ffmpeg.exe\n`;
    },
    download: async (url, dest) => {
      calls.push(`download:${url}->${dest}`);
    },
    sha256: async () => world.actualSha ?? GOOD,
    rename: async (from, to) => {
      calls.push(`rename:${from}->${to}`);
    },
    remove: async (p) => {
      calls.push(`rm:${p}`);
    },
    mkdir: async () => {},
  };
  return { deps, calls };
}

describe('locateFfmpeg', () => {
  it('prefers ffmpeg on PATH', async () => {
    const { deps, calls } = fakeDeps({ onPath: 'C:\\tools\\ffmpeg.exe' });
    expect(await locateFfmpeg('win32', DIR, deps)).toBe('C:\\tools\\ffmpeg.exe');
    expect(calls).toEqual([]);
  });
  it('uses the cached copy on Windows', async () => {
    const { deps, calls } = fakeDeps({ cached: true });
    expect(await locateFfmpeg('win32', DIR, deps)).toBe(`${DIR}\\ffmpeg.exe`);
    expect(calls).toEqual([]);
  });
  it('downloads and verifies the mirrored build on first use', async () => {
    const { deps, calls } = fakeDeps({});
    expect(await locateFfmpeg('win32', DIR, deps)).toBe(`${DIR}\\ffmpeg.exe`);
    const base = 'https://github.com/Coccis77/fightcade-replay-converter/releases/download/tools-ffmpeg-9.0.2';
    expect(calls).toEqual([
      `read:${base}/ffmpeg.exe.sha256`,
      `download:${base}/ffmpeg.exe->${DIR}\\ffmpeg.exe.download`,
      `rename:${DIR}\\ffmpeg.exe.download->${DIR}\\ffmpeg.exe`,
    ]);
  });
  it('rejects a checksum mismatch and caches nothing', async () => {
    const { deps, calls } = fakeDeps({ actualSha: 'b'.repeat(64) });
    await expect(locateFfmpeg('win32', DIR, deps)).rejects.toMatchObject({ exitCode: ExitCode.Preflight, message: expect.stringContaining('checksum') });
    expect(calls.some((c) => c.startsWith('rename'))).toBe(false);
    expect(calls).toContain(`rm:${DIR}\\ffmpeg.exe.download`);
  });
  it('asks macOS users to install ffmpeg with Homebrew', async () => {
    const { deps } = fakeDeps({});
    await expect(locateFfmpeg('darwin', '/x', deps)).rejects.toMatchObject({ exitCode: ExitCode.Preflight, hint: 'brew install ffmpeg' });
  });
});
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/ffmpegLocator.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/ffmpegLocator.ts`**

```ts
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { REPO } from './emulatorRelease.js';
import { ConvertError, ExitCode } from './errors.js';
import { which } from './exec.js';
import { pathExists } from './fsUtil.js';
import { pathFor, type Platform } from './platform.js';

// Pinned static ffmpeg mirrored into our releases by .github/workflows/tools.yml.
export const FFMPEG_MIRROR = { tag: 'tools-ffmpeg-9.0.2', exe: 'ffmpeg.exe', checksum: 'ffmpeg.exe.sha256' } as const;

export interface FfmpegDeps {
  which(cmd: string): Promise<string | null>;
  exists(p: string): Promise<boolean>;
  readText(url: string): Promise<string>;
  download(url: string, dest: string): Promise<void>;
  sha256(p: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  remove(p: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
}

export async function locateFfmpeg(platform: Platform, ffmpegDir: string, deps: FfmpegDeps): Promise<string> {
  const onPath = await deps.which(platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (onPath) return onPath;
  if (platform === 'darwin') throw new ConvertError(ExitCode.Preflight, 'ffmpeg not found on PATH', 'brew install ffmpeg');

  const target = pathFor(platform).join(ffmpegDir, FFMPEG_MIRROR.exe);
  if (await deps.exists(target)) return target;

  const base = `https://github.com/${REPO}/releases/download/${FFMPEG_MIRROR.tag}`;
  const tmp = `${target}.download`;
  try {
    const expected = (await deps.readText(`${base}/${FFMPEG_MIRROR.checksum}`)).trim().split(/\s+/)[0]!.toLowerCase();
    await deps.mkdir(ffmpegDir);
    await deps.download(`${base}/${FFMPEG_MIRROR.exe}`, tmp);
    if ((await deps.sha256(tmp)).toLowerCase() !== expected) throw new Error('downloaded ffmpeg failed its checksum check');
    await deps.rename(tmp, target);
    return target;
  } catch (err) {
    await deps.remove(tmp);
    const message = err instanceof Error ? err.message : String(err);
    throw new ConvertError(ExitCode.Preflight, `Could not get ffmpeg: ${message}`, 'Check your internet connection, or install ffmpeg and put it on PATH');
  }
}

export function defaultFfmpegDeps(platform: Platform): FfmpegDeps {
  return {
    which: (cmd) => which(cmd, platform),
    exists: pathExists,
    readText: async (url) => {
      const res = await fetch(url, { headers: { 'User-Agent': 'fc2mp4' }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return res.text();
    },
    download: async (url, dest) => {
      const res = await fetch(url, { headers: { 'User-Agent': 'fc2mp4' }, signal: AbortSignal.timeout(15 * 60_000) });
      if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(dest));
    },
    sha256: (p) =>
      new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(p).on('data', (c) => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
      }),
    rename: (from, to) => rename(from, to),
    remove: (p) => rm(p, { force: true }),
    mkdir: async (dir) => {
      await mkdir(dir, { recursive: true });
    },
  };
}
```

`src/ffmpeg.ts`: change `mux` to take the ffmpeg path:
```ts
export async function mux(args: { video: string; audio: string; output: string }, ffmpeg = 'ffmpeg'): Promise<void> {
  const part = partPath(args.output);
  try {
    await runFfmpeg(muxArgs({ video: args.video, audio: args.audio, output: part }), ffmpeg);
    await rename(part, args.output);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}
```

`src/convert.ts`:
- `ConvertDeps`: add `locateFfmpeg(install: FightcadeInstall): Promise<string>;`, change `capture(install, quarkId, ffmpeg: string, opts)` and `mux(args, ffmpeg: string)`.
- `defaultDeps`: `locateFfmpeg: () => locateFfmpeg(platform, app.ffmpegDir, defaultFfmpegDeps(platform))`, `capture: (install, quarkId, ffmpeg, opts) => capture(defaultCaptureDeps(install, app.runtimeDir, quarkId, ffmpeg), opts)`, `mux: (args, ffmpeg) => mux(args, ffmpeg)`.
- `convert`: after `await deps.preflight(install);` add `const ffmpeg = await deps.locateFfmpeg(install);` (log `debug(\`ffmpeg: ${ffmpeg}\`)`), pass `ffmpeg` to `capture` and `mux`.

`tests/convert.test.ts` harness: add
```ts
    locateFfmpeg: async () => {
      calls.push('ffmpeg');
      return '/usr/bin/ffmpeg';
    },
```
change `capture: async (_install, quarkId, opts)` to `capture: async (_install, quarkId, _ffmpeg, opts)`, and update the expected order to
`['lock', 'preflight', 'ffmpeg', 'ensure:false', 'runtime:false', 'tmp', `capture:${ID}:/tmp/run`, 'mkdir:/out', `mux:/out/${ID}.mp4`, 'rmdir:/tmp/run', 'unlock']`.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Write `.github/workflows/tools.yml`**

```yaml
name: tools
on:
  push:
    branches: [main]
    paths: ['.github/workflows/tools.yml']
  workflow_dispatch:
permissions:
  contents: write
jobs:
  mirror-ffmpeg:
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: ${{ github.token }}
      TAG: tools-ffmpeg-9.0.2
      ZIP_URL: https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-01-13-06/ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-9.0.zip
      ZIP_SHA256: 74827e097445a136b803febd4dcf80f7cba7f14a4c612fb80f7b5e5cedd3ffbe
    steps:
      - uses: actions/checkout@v4
      - name: Mirror the pinned Windows ffmpeg
        run: |
          if gh release view "$TAG" >/dev/null 2>&1; then echo "already mirrored"; exit 0; fi
          curl -sSfL "$ZIP_URL" -o ffmpeg.zip
          echo "$ZIP_SHA256  ffmpeg.zip" | sha256sum -c -
          unzip -q ffmpeg.zip
          cp ffmpeg-*/bin/ffmpeg.exe ffmpeg.exe
          cp ffmpeg-*/LICENSE.txt FFMPEG-LICENSE.txt
          sha256sum ffmpeg.exe > ffmpeg.exe.sha256
          gh release create "$TAG" ffmpeg.exe ffmpeg.exe.sha256 FFMPEG-LICENSE.txt \
            --title "ffmpeg 9.0.2 (Windows, mirrored)" \
            --notes "Unmodified ffmpeg.exe from $ZIP_URL (BtbN/FFmpeg-Builds, GPL). Source: https://github.com/FFmpeg/FFmpeg/tree/n9.0.2 and https://github.com/BtbN/FFmpeg-Builds. Downloaded automatically by fc2mp4 on Windows."
```

- [ ] **Step 6: Commit**

```bash
git add src/ffmpegLocator.ts src/ffmpeg.ts src/convert.ts tests/ffmpegLocator.test.ts tests/convert.test.ts .github/workflows/tools.yml
git commit -m "feat: locate or download ffmpeg; mirror the pinned Windows build"
```

---

### Task 8: CLI commands for both platforms

**Files:**
- Modify: `src/convert.ts` (`updateEmulator`, `buildEmulatorLocally` replace `rebuildEmulator`), `src/cliArgs.ts`, `src/cli.ts`, `tests/cliArgs.test.ts`, `tests/convert.test.ts`

**Interfaces:**
- Produces: `ConvertDeps.ensureEmulator(install, opts: { force: boolean; local: boolean })`; `updateEmulator(options, deps)` (force) and `buildEmulatorLocally(options, deps)` (local), both returning `EnsureResult`; `CliRequest` commands `'help' | 'convert' | 'update-emulator' | 'rebuild-emulator'`.

- [ ] **Step 1: Failing tests**

In `tests/cliArgs.test.ts`, replace the rebuild test with:
```ts
  it('parses the emulator commands', () => {
    expect(parseCli(['update-emulator'])).toEqual({ command: 'update-emulator', fightcadeDir: undefined, verbose: false });
    expect(parseCli(['rebuild-emulator', '--fightcade-dir', '/F'])).toEqual({ command: 'rebuild-emulator', fightcadeDir: '/F', verbose: false });
  });
```
and add `[['update-emulator', 'x']]` to the rejected cases.

In `tests/convert.test.ts`: change the harness `ensureEmulator` to
```ts
    ensureEmulator: async (_install, opts) => {
      calls.push(`ensure:${opts.force}:${opts.local}`);
      return { updated: false };
    },
```
update the expected pipeline order's `'ensure:false'` to `'ensure:false:false'`, replace the `rebuildEmulator` describe with:
```ts
describe('emulator commands', () => {
  it('update-emulator forces a release check under the lock', async () => {
    const { deps, calls } = harness({
      ensureEmulator: async (_install, opts) => {
        calls.push(`ensure:${opts.force}:${opts.local}`);
        return { updated: true };
      },
    });
    expect(await updateEmulator({}, deps)).toEqual({ updated: true });
    expect(calls).toEqual(['lock', 'ensure:true:false', 'unlock']);
  });
  it('rebuild-emulator builds locally', async () => {
    const { deps, calls } = harness({
      ensureEmulator: async (_install, opts) => {
        calls.push(`ensure:${opts.force}:${opts.local}`);
        return { updated: true };
      },
    });
    await buildEmulatorLocally({}, deps);
    expect(calls).toEqual(['lock', 'ensure:false:true', 'unlock']);
  });
});
```
and import `updateEmulator, buildEmulatorLocally` instead of `rebuildEmulator`. The "refreshes the runtime DLLs only after a successful rebuild" test returns `{ updated: true }`.

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/cliArgs.test.ts tests/convert.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/convert.ts`:
- `ConvertDeps.ensureEmulator(install: FightcadeInstall, opts: { force: boolean; local: boolean }): Promise<EnsureResult>`; in `defaultDeps` pass `{ patchSetHash: hash, force: opts.force, local: opts.local }`.
- In `convert`: `const ensured = await deps.ensureEmulator(install, { force: false, local: false });` and `if (ensured.updated) debug('Emulator updated');`.
- Replace `rebuildEmulator` with:
```ts
async function runEmulatorCommand(
  opts: { force: boolean; local: boolean },
  options: { fightcadeDir?: string; log?: (msg: string) => void },
  deps: ConvertDeps,
): Promise<EnsureResult> {
  const install = await deps.locateInstall(options.fightcadeDir);
  const release = await deps.acquireLock();
  try {
    const result = await deps.ensureEmulator(install, opts);
    if (result.warning) options.log?.(`Warning: ${result.warning}`);
    return result;
  } finally {
    await release();
  }
}

export function updateEmulator(options: { fightcadeDir?: string; log?: (msg: string) => void }, deps: ConvertDeps = defaultDeps()): Promise<EnsureResult> {
  return runEmulatorCommand({ force: true, local: false }, options, deps);
}

export function buildEmulatorLocally(options: { fightcadeDir?: string; log?: (msg: string) => void }, deps: ConvertDeps = defaultDeps()): Promise<EnsureResult> {
  return runEmulatorCommand({ force: false, local: true }, options, deps);
}
```

`src/cliArgs.ts`:
- `USAGE`:
```ts
export const USAGE = `Usage: fc2mp4 <replay-link-or-quarkId> [options]
       fc2mp4 update-emulator [--fightcade-dir <p>] [-v]
       fc2mp4 rebuild-emulator [--fightcade-dir <p>] [-v]

Records a Fightcade Street Fighter III: 3rd Strike replay to MP4 (macOS and Windows).

  -o, --output <path>       MP4 file, or an existing folder
                            (default: ~/Movies/Fightcade or %USERPROFILE%\\Videos\\Fightcade)
      --scale sharp|smooth  Upscaling style (default: sharp)
      --max-duration <d>    Stop capturing after this long: 90s, 45m, 1h (default: 60m)
      --fightcade-dir <p>   Fightcade install (FightCade2.app on macOS, the Fightcade folder on Windows)
  -v, --verbose             Print debug details
  -h, --help                Show this help

update-emulator checks GitHub for a newer emulator build now (otherwise once a day).
rebuild-emulator builds the emulator locally (macOS, from a source checkout; needs mingw-w64).`;
```
- `CliRequest`: replace the rebuild variant with `| { command: 'update-emulator' | 'rebuild-emulator'; fightcadeDir?: string; verbose: boolean }`.
- In `parseCli`, replace the rebuild branch with:
```ts
  const command = positionals[0];
  if (command === 'update-emulator' || command === 'rebuild-emulator') {
    if (positionals.length !== 1) throw usage(`${command} takes no arguments`);
    return { command, fightcadeDir: values['fightcade-dir'], verbose };
  }
```

`src/cli.ts`:
- import `updateEmulator, buildEmulatorLocally` instead of `rebuildEmulator`;
- replace the rebuild block with:
```ts
    if (request.command === 'update-emulator' || request.command === 'rebuild-emulator') {
      const run = request.command === 'update-emulator' ? updateEmulator : buildEmulatorLocally;
      const result = await run({ fightcadeDir: request.fightcadeDir, log });
      process.stdout.write(result.updated ? 'Emulator updated.\n' : 'Emulator already up to date.\n');
      return result.warning ? ExitCode.Emulator : 0;
    }
```
- `progressLine` `'preparing-emulator'` text → `'Preparing the emulator…'`;
- replace the last line `process.exitCode = await main();` with
```ts
main().then((code) => {
  process.exitCode = code;
});
```
(no top-level await, so the esbuild CommonJS bundle works).

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck && npm run build && node dist/cli.js --help | head -3`
Expected: all pass; usage starts with `Usage: fc2mp4 <replay-link-or-quarkId> [options]`.

- [ ] **Step 5: Commit**

```bash
git add src/convert.ts src/cliArgs.ts src/cli.ts tests/cliArgs.test.ts tests/convert.test.ts
git commit -m "feat: update-emulator and rebuild-emulator commands for both platforms"
```

---

### Task 9: Single-executable packaging + CLI release workflow

**Files:**
- Create: `scripts/bundle.mjs`, `scripts/sea.mjs`, `.github/workflows/cli.yml`
- Modify: `package.json` (devDependencies `esbuild`, `postject`; scripts `bundle`, `sea`), `.gitignore` (`build/`)

**Interfaces:**
- Produces: `npm run bundle` → `build/fc2mp4.cjs` with `__FC2MP4_PATCH_SET__`, `__FC2MP4_BUNDLED__`, `__FC2MP4_VERSION__` defined; `npm run sea` → `build/fc2mp4.exe` (Windows) or `build/fc2mp4` (macOS).

- [ ] **Step 1: Install tools**

Run: `npm install --save-dev esbuild postject && printf 'build/\n' >> .gitignore`

- [ ] **Step 2: `scripts/bundle.mjs`**

```js
// Bundle the CLI into one CommonJS file for a Node single executable.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const python = process.platform === 'win32' ? 'python' : 'python3';
const patchSet = execFileSync(python, ['emulator/patchset.py', 'emulator'], { encoding: 'utf8' }).trim();
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

await build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  outfile: 'build/fc2mp4.cjs',
  define: {
    __FC2MP4_PATCH_SET__: JSON.stringify(patchSet),
    __FC2MP4_BUNDLED__: 'true',
    __FC2MP4_VERSION__: JSON.stringify(version),
  },
  logOverride: { 'empty-import-meta': 'silent' },
});
console.log(`bundled build/fc2mp4.cjs (patch set ${patchSet.slice(0, 12)}, v${version})`);
```

- [ ] **Step 3: `scripts/sea.mjs`**

```js
// Turn build/fc2mp4.cjs into a single executable with this Node binary (docs: Node 24 SEA).
import { execFileSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';

const win = process.platform === 'win32';
const mac = process.platform === 'darwin';
const out = win ? 'build/fc2mp4.exe' : 'build/fc2mp4';

writeFileSync(
  'build/sea-config.json',
  JSON.stringify({ main: 'build/fc2mp4.cjs', output: 'build/sea-prep.blob', disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }),
);
execFileSync(process.execPath, ['--experimental-sea-config', 'build/sea-config.json'], { stdio: 'inherit' });
copyFileSync(process.execPath, out);
if (mac) execFileSync('codesign', ['--remove-signature', out], { stdio: 'inherit' });
const postject = ['postject', out, 'NODE_SEA_BLOB', 'build/sea-prep.blob', '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (mac) postject.push('--macho-segment-name', 'NODE_SEA');
execFileSync(win ? 'npx.cmd' : 'npx', postject, { stdio: 'inherit', shell: win });
if (mac) execFileSync('codesign', ['--sign', '-', out], { stdio: 'inherit' });
console.log(`built ${out}`);
```

`package.json` scripts: add `"bundle": "node scripts/bundle.mjs"` and `"sea": "node scripts/sea.mjs"`.

`src/cli.ts`: support `--version` cheaply — at the top of `main()`:
```ts
declare const __FC2MP4_VERSION__: string | undefined;
```
(module level) and in `main` before parsing: `if (process.argv.includes('--version')) { process.stdout.write(\`${typeof __FC2MP4_VERSION__ === 'string' ? __FC2MP4_VERSION__ : 'dev'}\n\`); return 0; }`.

- [ ] **Step 4: Build and check the macOS binary locally**

Run:
```sh
npm run bundle && npm run sea
./build/fc2mp4 --version
./build/fc2mp4 --help | head -2
./build/fc2mp4 not-a-link; echo "exit=$?"
```
Expected: version `0.2.0` (bump happens in Task 10); usage text; `Error: Not a Fightcade replay link…`, `exit=2`. This also proves `process.argv.slice(2)` is right inside a single executable; if the arguments are shifted, fix `parseCli(process.argv.slice(2))` accordingly and record a Ruling.

- [ ] **Step 5: `.github/workflows/cli.yml`**

```yaml
name: cli
on:
  push:
    tags: ['v*']
  workflow_dispatch:
permissions:
  contents: write
jobs:
  build:
    strategy:
      matrix:
        include:
          - os: windows-latest
            artifact: build/fc2mp4.exe
            name: fc2mp4.exe
          - os: macos-latest
            artifact: build/fc2mp4
            name: fc2mp4-macos-arm64
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - run: npm ci
      - name: Unit tests (macOS paths)
        if: runner.os == 'macOS'
        run: npm test
      - name: Real Windows named-pipe test
        if: runner.os == 'Windows'
        run: npx vitest run tests/transport.test.ts -t pipeTransport
      - run: npm run bundle
      - run: npm run sea
      - name: Smoke test
        shell: bash
        run: ./${{ matrix.artifact }} --help | head -1
      - shell: bash
        run: cp ${{ matrix.artifact }} ${{ matrix.name }}
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.name }}
          path: ${{ matrix.name }}
  release:
    needs: build
    runs-on: ubuntu-latest
    if: startsWith(github.ref, 'refs/tags/v')
    env:
      GH_TOKEN: ${{ github.token }}
    steps:
      - uses: actions/download-artifact@v4
        with:
          merge-multiple: true
      - run: |
          gh release create "${GITHUB_REF_NAME}" fc2mp4.exe fc2mp4-macos-arm64 \
            --repo "${GITHUB_REPOSITORY}" --title "fc2mp4 ${GITHUB_REF_NAME}" \
            --notes "Download fc2mp4.exe (Windows) or fc2mp4-macos-arm64 (macOS), then run it with a Fightcade replay link. Unsigned: Windows SmartScreen may ask you to confirm (More info → Run anyway)."
```

The unit tests assert macOS-style paths, so CI runs the full suite on macOS only; on Windows it runs the pipe-transport tests against a **real** `\\.\pipe\`. For that, make `socketPath()` in `tests/transport.test.ts`:
```ts
async function socketPath(): Promise<string> {
  if (process.platform === 'win32') return pipeName(process.pid, String(Math.random()).slice(2, 8));
  return join(await mkdtemp(join(tmpdir(), 'fc2mp4-pipe-')), 'video.sock');
}
```

- [ ] **Step 6: Run tests and commit**

Run: `npm test && npm run typecheck`
Expected: pass.

```bash
git add scripts package.json package-lock.json .gitignore src/cli.ts tests/transport.test.ts .github/workflows/cli.yml
git commit -m "feat: single-executable packaging and CLI release workflow"
```

---

### Task 10: Publish, verify on macOS, verify on Windows

**Files:**
- Modify: `package.json` (`version` → `0.3.0`), `README.md`

- [ ] **Step 1: README** — replace the Requirements/Usage sections with:

````markdown
## Install

- **Windows:** download `fc2mp4.exe` from the latest `v*` release on the
  [releases page](https://github.com/Coccis77/fightcade-replay-converter/releases). Windows may warn
  that it is unsigned: click *More info* → *Run anyway*. Needs Fightcade 2 with 3rd Strike opened once.
- **macOS:** download `fc2mp4-macos-arm64`, `chmod +x` it, and install ffmpeg (`brew install ffmpeg`).

## Usage

```sh
fc2mp4 https://replay.fightcade.com/fbneo/sfiii3nr1/1700000000000-1234
```

Videos go to `~/Movies/Fightcade` (macOS) or `%USERPROFILE%\Videos\Fightcade` (Windows). The
patched emulator (built by GitHub Actions from Fightcade's public source) and, on Windows, ffmpeg
are downloaded automatically on first use. Your Fightcade install is never modified.

## Development

`npm install && npm run build && node dist/cli.js <link>`; `npm test`; `npm run test:emulator`.
`fc2mp4 rebuild-emulator` builds the emulator locally (macOS, `brew install mingw-w64`).
````

- [ ] **Step 2: Bump version, run everything, commit**

Run: `npm version 0.3.0 --no-git-tag-version && npm test && npm run test:emulator && npm run typecheck`
```bash
git add README.md package.json package-lock.json
git commit -m "docs: install instructions for released binaries; v0.3.0"
```

- [ ] **Step 3: Push main (ask the user first)**

Ask the user to confirm, then `git push`. This triggers `emulator.yml` (emulator/** changed) and `tools.yml` (new workflow file).
Watch until both finish:
```sh
for i in $(seq 1 60); do curl -s https://api.github.com/repos/Coccis77/fightcade-replay-converter/releases | python3 -c "import sys,json;print([r['tag_name'] for r in json.load(sys.stdin)])"; sleep 60; done
```
Expected: an `emulator-…-<hash12>` release whose hash12 equals `python3 emulator/patchset.py emulator | cut -c1-12`, and `tools-ffmpeg-9.0.2`. If a workflow fails, read its log at `https://github.com/Coccis77/fightcade-replay-converter/actions` (public) and fix with superpowers:systematic-debugging.

- [ ] **Step 4: macOS uses the downloaded emulator**

```sh
mv ~/Library/Caches/fc2mp4/runtime/manifest.json /tmp/manifest.backup.json
FC_E2E='https://replay.fightcade.com/fbneo/sfiii3nr1/1791006077129-2245' FC_E2E_EXPECTED_SECONDS=137.94 npx vitest run tests/e2e.test.ts
cat ~/Library/Caches/fc2mp4/runtime/manifest.json
```
Expected: PASS; manifest shows `"source": "release"` and the CI tag.

- [ ] **Step 5: Tag the CLI release (ask the user first)**

Ask the user, then `git tag v0.3.0 && git push origin v0.3.0`. Wait for `cli.yml`; expected: release `v0.3.0` with `fc2mp4.exe` and `fc2mp4-macos-arm64`.

- [ ] **Step 6: Windows verification (user runs; give these exact steps)**

1. Download `fc2mp4.exe` from the `v0.3.0` release into `Downloads`.
2. In PowerShell, snapshot Fightcade:
   `Get-ChildItem -Recurse -File "C:\Users\Coccis\Documents\Fightcade\emulator\fbneo" | Get-FileHash | Sort-Object Path | Out-File $env:TEMP\fc-before.txt`
3. `cd $env:USERPROFILE\Downloads; .\fc2mp4.exe https://replay.fightcade.com/fbneo/sfiii3nr1/1791006077129-2245` → paste output; open the MP4 it prints.
4. `Measure-Command { .\fc2mp4.exe https://replay.fightcade.com/fbneo/sfiii3nr1/1790980205888-4792 }` → paste the time.
5. Start the short replay again and press Ctrl-C during "Capturing…", then run:
   `Get-Process fcadefbneo-fc2mp4,ffmpeg -ErrorAction SilentlyContinue; Get-ChildItem $env:TEMP -Filter 'fc2mp4-*'; Test-Path $env:TEMP\fc2mp4.lock` → paste (expected: nothing, nothing, False).
6. Repeat step 2 into `fc-after.txt`, then `Compare-Object (Get-Content $env:TEMP\fc-before.txt) (Get-Content $env:TEMP\fc-after.txt)` → paste (expected: no output).

Expected: MP4 1440×1080 with sound, plays to the end; Ctrl-C leaves nothing; Fightcade files identical.
