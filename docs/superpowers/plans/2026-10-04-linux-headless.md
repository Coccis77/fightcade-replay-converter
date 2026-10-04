# fc2mp4 on Headless Linux Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `fc2mp4-linux-x64 <replay link>` converts a replay on x86_64 Linux with no screen, using Wine + Xvfb + Wine's virtual desktop, with the CI-built emulator.

**Architecture:** Add `linux` as a third `Platform`. Linux reuses the POSIX pieces (FIFO transport, `Z:` paths, XDG-style cache) and adds: Fightcade-files lookup accepting two folder layouts, a private Wine prefix created on first run, a headless launch command (`xvfb-run … wine explorer /desktop=…`), and a process-group + `wineserver -k` stop. CI builds a third single-executable binary.

**Tech Stack:** Node 24, TypeScript 5.9, vitest 5; system `wine` (32-bit), `xvfb-run`, `ffmpeg`; GitHub Actions `ubuntu-latest`.

**Spec:** `docs/superpowers/specs/2026-10-04-linux-headless-design.md`. Evidence: `docs/spike-findings.md` (spike 4).

## Global Constraints

- `Platform = 'darwin' | 'win32' | 'linux'`; anything else → Preflight error `fc2mp4 supports macOS, Windows and Linux (this is <p>)`.
- Linux paths: cache `$XDG_CACHE_HOME/fc2mp4` (default `~/.cache/fc2mp4`) with `runtime/`, `wineprefix/`, `ffmpeg/`, `fightcade-fbneo/`; output `~/Videos/Fightcade`.
- Linux Fightcade lookup order: `--fightcade-dir`, `FC2MP4_FIGHTCADE_DIR`, `~/Fightcade`, `~/fightcade`, `/opt/fightcade`. A path matches as a Fightcade root if `<dir>/emulator/fbneo/ggponet.dll` exists, or as the fbneo folder if `<dir>/ggponet.dll` exists. `fcadefbneo.exe` is not required on Linux.
- Launch: `xvfb-run -a -s "-screen 0 1024x768x24" wine explorer /desktop=fc2mp4,1024x768 <runtime>/fcadefbneo-fc2mp4.exe <streamArg>`, cwd = runtime, env adds `WINEARCH=win32`, `WINEPREFIX=<cache>/wineprefix`, `WINEDEBUG=-all`; spawned `detached` (own process group). Bare Xvfb without the virtual desktop must not be used.
- Stop: `wineserver -k` with the same env, then `SIGTERM` to the process group.
- Wine prefix: created with `xvfb-run -a wineboot -i` (same env) when `<prefix>/system.reg` is missing.
- Apt hint (exact): `sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 xvfb ffmpeg`.
- Never modify the Fightcade folder; never use the user's own `WINEPREFIX`.
- macOS and Windows behaviour unchanged.

## Review Focus

1. **Ctrl-C on Linux** → no orphaned `Xvfb`/`wine`/`wineserver` left. Pinned by `emulatorSpawnOptions` (detached on Linux) and `killCommand` tests in Task 3.
2. **32-bit Wine missing** (the most common Ubuntu setup mistake) → clear error with the apt hint. Pinned by the `ensureWinePrefix` test in Task 2.
3. **`--fightcade-dir` pointing at the wrong level** (e.g. the `ROMs` folder) → not-found error explaining both accepted layouts. Pinned by the install test in Task 1.
4. **User has their own Wine setup** (`WINEPREFIX` in the environment) → our prefix always wins. Pinned by the `wineEnv` / launch env test in Task 2.
5. **Linux desktop with a real `DISPLAY`** → still headless (always `xvfb-run`). Pinned by the launch command test in Task 3.

---

## File Structure

```
src/platform.ts       + 'linux', XDG cache, wineprefixDir
src/install.ts        + Linux candidates/layouts, which-based prerequisite check
src/winePrefix.ts     NEW: wineEnv, APT_HINT, ensureWinePrefix
src/capture.ts        + Linux launch/kill/spawn options, wine env
src/convert.ts        + prepareWine step; Linux wiring
src/ffmpegLocator.ts  + Linux hint
src/cliArgs.ts, src/cli.ts  usage text, 'setting-up-wine' progress
.github/workflows/cli.yml    + ubuntu-latest build of fc2mp4-linux-x64
README.md             Linux section
tests/platform.test.ts, tests/install.test.ts, tests/winePrefix.test.ts (new), tests/capture.test.ts, tests/ffmpegLocator.test.ts, tests/convert.test.ts
```

---

### Task 1: Linux platform, paths and Fightcade-files lookup

**Files:**
- Modify: `src/platform.ts`, `src/install.ts`, `src/convert.ts` (preflight deps)
- Test: `tests/platform.test.ts`, `tests/install.test.ts`

**Interfaces:**
- Produces: `Platform` includes `'linux'`; `pathFor('linux') === path.posix`; `AppPaths` gains `wineprefixDir: string`; `installLayout(root, platform, fbneoDir?)` (optional explicit fbneo folder); `candidateRoots('linux', home, env)`; `locateInstall` accepts both Linux layouts and only requires `ggponet.dll` on Linux; `PreflightDeps { exists(p); which(cmd): Promise<string | null> }`; Linux preflight requires `wine` and `xvfb-run` on PATH (hint = `APT_HINT` from Task 2 — define the constant in `src/install.ts` now as `export const APT_HINT = 'sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 xvfb ffmpeg';` and re-export it from `winePrefix.ts` in Task 2).
- `FightcadeInstall.launcher` stays `string | null`: `wine.sh` (macOS), `null` (Windows), `null` (Linux — the headless command is built in Task 3).

- [ ] **Step 1: Failing tests**

Append to `tests/platform.test.ts`:
```ts
describe('platform (Linux)', () => {
  it('accepts Linux', () => {
    expect(supportedPlatform('linux')).toBe('linux');
    expect(thrown(() => supportedPlatform('freebsd'))).toMatchObject({ exitCode: ExitCode.Preflight, message: expect.stringContaining('Linux') });
  });
  it('uses XDG_CACHE_HOME when set, ~/.cache otherwise, and ~/Videos', () => {
    expect(appPaths('linux', '/home/a', { XDG_CACHE_HOME: '/data/cache' })).toEqual({
      cacheDir: '/data/cache/fc2mp4',
      runtimeDir: '/data/cache/fc2mp4/runtime',
      sourceDir: '/data/cache/fc2mp4/fightcade-fbneo',
      ffmpegDir: '/data/cache/fc2mp4/ffmpeg',
      wineprefixDir: '/data/cache/fc2mp4/wineprefix',
      outputDir: '/home/a/Videos/Fightcade',
    });
    expect(appPaths('linux', '/home/a', {}).cacheDir).toBe('/home/a/.cache/fc2mp4');
  });
});
```
Add `wineprefixDir` to the two existing `appPaths` expectations in that file:
macOS `'/Users/fran/Library/Caches/fc2mp4/wineprefix'`, Windows `'C:\\Users\\Jean Pierre\\AppData\\Local\\fc2mp4\\wineprefix'`.

Append to `tests/install.test.ts`:
```ts
describe('Linux Fightcade files', () => {
  const home = '/home/a';
  const which = async (cmd: string) => `/usr/bin/${cmd}`;

  it('accepts a Fightcade root (official install or a copy)', async () => {
    const root = '/srv/fightcade';
    const i = await locateInstall({ platform: 'linux', home, env: {}, override: root, exists: async (p) => p === `${root}/emulator/fbneo/ggponet.dll` });
    expect(i).toMatchObject({ platform: 'linux', root, fbneoDir: `${root}/emulator/fbneo`, launcher: null, rom: `${root}/emulator/fbneo/ROMs/sfiii3nr1.zip` });
  });
  it('accepts the fbneo folder itself (files-only server folder)', async () => {
    const dir = '/srv/fbneo-files';
    const i = await locateInstall({ platform: 'linux', home, env: {}, override: dir, exists: async (p) => p === `${dir}/ggponet.dll` });
    expect(i).toMatchObject({ fbneoDir: dir, ggponet: `${dir}/ggponet.dll`, romsDir: `${dir}/ROMs` });
  });
  it('reads FC2MP4_FIGHTCADE_DIR, then the usual install places', async () => {
    const env = { FC2MP4_FIGHTCADE_DIR: '/mnt/c/Users/Coccis/Documents/Fightcade' };
    const i = await locateInstall({ platform: 'linux', home, env, exists: async (p) => p.startsWith(env.FC2MP4_FIGHTCADE_DIR) && p.endsWith('/emulator/fbneo/ggponet.dll') });
    expect(i.root).toBe(env.FC2MP4_FIGHTCADE_DIR);
    const fallback = await locateInstall({ platform: 'linux', home, env: {}, exists: async (p) => p === '/opt/fightcade/emulator/fbneo/ggponet.dll' });
    expect(fallback.root).toBe('/opt/fightcade');
  });
  it('explains both accepted layouts when the folder is wrong', async () => {
    await expect(locateInstall({ platform: 'linux', home, env: {}, override: '/srv/fightcade/ROMs', exists: async () => false })).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      hint: expect.stringMatching(/emulator\/fbneo\/ggponet\.dll.*ggponet\.dll/),
    });
  });
  it('needs wine and xvfb-run on Linux, with the apt hint', async () => {
    const i = installLayout('/srv/fightcade', 'linux');
    await expect(preflight(i, { exists: async () => true, which })).resolves.toBeUndefined();
    await expect(preflight(i, { exists: async () => true, which: async (c) => (c === 'xvfb-run' ? null : `/usr/bin/${c}`) })).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: expect.stringContaining('xvfb-run'),
      hint: 'sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 xvfb ffmpeg',
    });
  });
});
```
In the existing `preflight` test of `tests/install.test.ts`, pass `which: async () => '/usr/bin/x'` in every deps object (the type now requires it).

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/platform.test.ts tests/install.test.ts`
Expected: FAIL (`linux` rejected, `wineprefixDir` missing, layouts not found, `which` unused).

- [ ] **Step 3: Implement**

`src/platform.ts`:
```ts
export type Platform = 'darwin' | 'win32' | 'linux';

export function supportedPlatform(p: NodeJS.Platform): Platform {
  if (p === 'darwin' || p === 'win32' || p === 'linux') return p;
  throw new ConvertError(ExitCode.Preflight, `fc2mp4 supports macOS, Windows and Linux (this is ${p})`);
}
```
`pathFor` is unchanged (`win32` → `path.win32`, otherwise `path.posix`). In `AppPaths` add `wineprefixDir: string;` and replace the body of `appPaths` with:
```ts
  const p = pathFor(platform);
  let cacheDir: string;
  let outputDir: string;
  if (platform === 'win32') {
    cacheDir = p.join(env.LOCALAPPDATA ?? p.join(home, 'AppData', 'Local'), 'fc2mp4');
    outputDir = p.join(env.USERPROFILE ?? home, 'Videos', 'Fightcade');
  } else if (platform === 'linux') {
    cacheDir = p.join(env.XDG_CACHE_HOME ?? p.join(home, '.cache'), 'fc2mp4');
    outputDir = p.join(home, 'Videos', 'Fightcade');
  } else {
    cacheDir = p.join(home, 'Library', 'Caches', 'fc2mp4');
    outputDir = p.join(home, 'Movies', 'Fightcade');
  }
  return {
    cacheDir,
    runtimeDir: p.join(cacheDir, 'runtime'),
    sourceDir: p.join(cacheDir, 'fightcade-fbneo'),
    ffmpegDir: p.join(cacheDir, 'ffmpeg'),
    wineprefixDir: p.join(cacheDir, 'wineprefix'),
    outputDir,
  };
```

`src/install.ts`:
- Add after the imports:
```ts
export const APT_HINT = 'sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 xvfb ffmpeg';
```
- Replace `installLayout` with:
```ts
export function installLayout(root: string, platform: Platform = 'darwin', fbneoDir?: string): FightcadeInstall {
  const p = pathFor(platform);
  const fbneo =
    fbneoDir ?? (platform === 'darwin' ? p.join(root, 'Contents', 'MacOS', 'emulator', 'fbneo') : p.join(root, 'emulator', 'fbneo'));
  return {
    platform,
    root,
    fbneoDir: fbneo,
    exe: p.join(fbneo, 'fcadefbneo.exe'),
    ggponet: p.join(fbneo, 'ggponet.dll'),
    romsDir: p.join(fbneo, 'ROMs'),
    rom: p.join(fbneo, 'ROMs', `${GAME}.zip`),
    mainIni: p.join(fbneo, 'config', 'fcadefbneo.ini'),
    launcher: platform === 'darwin' ? p.join(root, 'Contents', 'Resources', 'wine.sh') : null,
  };
}
```
- In `candidateRoots`, before the Windows branch add:
```ts
  if (platform === 'linux') {
    return [env.FC2MP4_FIGHTCADE_DIR, p.join(home, 'Fightcade'), p.join(home, 'fightcade'), '/opt/fightcade'].filter((d): d is string => Boolean(d));
  }
```
- Replace the loop and error of `locateInstall` with:
```ts
  const platform = supportedPlatform(opts.platform);
  for (const root of opts.override ? [opts.override] : candidateRoots(platform, opts.home, opts.env)) {
    if (platform === 'linux') {
      // Linux: a Fightcade root, or the fbneo folder itself (files-only server folder). No exe needed.
      const asRoot = installLayout(root, 'linux');
      if (await opts.exists(asRoot.ggponet)) return asRoot;
      const asFbneo = installLayout(root, 'linux', root);
      if (await opts.exists(asFbneo.ggponet)) return asFbneo;
      continue;
    }
    const install = installLayout(root, platform);
    if ((await opts.exists(install.exe)) && (await opts.exists(install.ggponet))) return install;
  }
  if (platform === 'linux') {
    throw new ConvertError(
      ExitCode.Preflight,
      'Fightcade files not found',
      `Pass --fightcade-dir (or set FC2MP4_FIGHTCADE_DIR) to a folder containing emulator/fbneo/ggponet.dll, or to the fbneo folder itself containing ggponet.dll and ROMs/${opts.override ? ` (checked ${opts.override})` : ''}`,
    );
  }
  const what = platform === 'darwin' ? 'FightCade2.app' : 'your Fightcade folder';
  throw new ConvertError(
    ExitCode.Preflight,
    'Fightcade install not found',
    opts.override ? `No emulator/fbneo/fcadefbneo.exe + ggponet.dll under ${opts.override}` : `Install Fightcade 2, or pass --fightcade-dir <path to ${what}>`,
  );
```
- Replace `PreflightDeps` and add the Linux check at the end of `preflight`:
```ts
export interface PreflightDeps {
  exists(p: string): Promise<boolean>;
  which(cmd: string): Promise<string | null>;
}
```
```ts
  if (install.platform === 'linux') {
    const missing: string[] = [];
    for (const tool of ['wine', 'xvfb-run']) if ((await deps.which(tool)) === null) missing.push(tool);
    if (missing.length > 0) throw new ConvertError(ExitCode.Preflight, `Missing on this system: ${missing.join(', ')}`, APT_HINT);
  }
```

`src/convert.ts` `defaultDeps`: `preflight: (install) => preflight(install, { exists: pathExists, which: (cmd) => which(cmd, platform) }),` and add `import { which } from './exec.js';`.

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/platform.ts src/install.ts src/convert.ts tests/platform.test.ts tests/install.test.ts
git commit -m "feat: Linux platform paths and Fightcade-files lookup"
```

---

### Task 2: Private Wine prefix (first-run setup) and convert wiring

**Files:**
- Create: `src/winePrefix.ts`, `tests/winePrefix.test.ts`
- Modify: `src/convert.ts`, `src/cli.ts`, `tests/convert.test.ts`

**Interfaces:**
- Consumes: `APT_HINT` (Task 1), `RunFn` (`src/exec.ts`), `AppPaths.wineprefixDir`.
- Produces: `wineEnv(prefix: string): Record<string, string>` → `{ WINEARCH: 'win32', WINEPREFIX: prefix, WINEDEBUG: '-all' }`; `export { APT_HINT } from './install.js'`; `ensureWinePrefix(prefix, deps: { exists(p): Promise<boolean>; run: RunFn; onSetup?: () => void }): Promise<void>`; `ConvertDeps.prepareWine(install: FightcadeInstall, onSetup: () => void): Promise<void>` (no-op off Linux); `ProgressEvent` gains `{ phase: 'setting-up-wine' }`.

- [ ] **Step 1: Failing tests**

`tests/winePrefix.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { APT_HINT, ensureWinePrefix, wineEnv } from '../src/winePrefix.js';
import type { RunFn } from '../src/exec.js';
import { ExitCode } from '../src/errors.js';

const PREFIX = '/home/a/.cache/fc2mp4/wineprefix';

describe('wineEnv', () => {
  it('always uses our own 32-bit prefix, whatever the user has set', () => {
    expect(wineEnv(PREFIX)).toEqual({ WINEARCH: 'win32', WINEPREFIX: PREFIX, WINEDEBUG: '-all' });
  });
});

describe('ensureWinePrefix', () => {
  function fake(result: { code: number; stdout?: string; stderr?: string }, createdAfterRun = true) {
    const calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
    let created = false;
    const run: RunFn = async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts?.env });
      created = createdAfterRun;
      return { code: result.code, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    };
    const exists = async () => created;
    return { calls, run, exists, setExisting: () => (created = true) };
  }

  it('does nothing when the prefix exists', async () => {
    const f = fake({ code: 0 });
    f.setExisting();
    let announced = false;
    await ensureWinePrefix(PREFIX, { exists: f.exists, run: f.run, onSetup: () => (announced = true) });
    expect(f.calls).toEqual([]);
    expect(announced).toBe(false);
  });

  it('creates it headless on first run with our environment', async () => {
    const f = fake({ code: 0 });
    let announced = false;
    await ensureWinePrefix(PREFIX, { exists: f.exists, run: f.run, onSetup: () => (announced = true) });
    expect(announced).toBe(true);
    expect(f.calls[0]).toMatchObject({ cmd: 'xvfb-run', args: ['-a', 'wineboot', '-i'] });
    expect(f.calls[0]!.env).toMatchObject({ WINEARCH: 'win32', WINEPREFIX: PREFIX });
  });

  it('turns "wine32 is missing" into the apt hint', async () => {
    const f = fake({ code: 1, stderr: 'it looks like wine32 is missing, you should install it.' }, false);
    await expect(ensureWinePrefix(PREFIX, { exists: f.exists, run: f.run })).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: expect.stringContaining('32-bit Wine'),
      hint: APT_HINT,
    });
  });

  it('reports any other failure', async () => {
    const f = fake({ code: 3, stderr: 'boom' }, false);
    await expect(ensureWinePrefix(PREFIX, { exists: f.exists, run: f.run })).rejects.toMatchObject({ exitCode: ExitCode.Emulator, message: expect.stringContaining('exit 3') });
  });
});
```

In `tests/convert.test.ts` harness add
```ts
    prepareWine: async (_install, onSetup) => {
      calls.push('wine');
      onSetup();
    },
```
update the expected pipeline order to
`['lock', 'preflight', 'ffmpeg', 'ensure:false:false', 'runtime:false', 'wine', 'tmp', `capture:${ID}:/tmp/run`, 'mkdir:/out', `mux:/out/${ID}.mp4`, 'rmdir:/tmp/run', 'unlock']`
and add:
```ts
  it('announces the one-time Wine setup', async () => {
    const { deps, calls } = harness();
    await convert(ID, { ...baseOptions, onProgress: (e) => calls.push(`progress:${e.phase}`) }, deps);
    expect(calls.indexOf('progress:setting-up-wine')).toBeGreaterThan(calls.indexOf('wine') - 1);
    expect(calls.indexOf('progress:setting-up-wine')).toBeLessThan(calls.indexOf('tmp'));
  });
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/winePrefix.test.ts tests/convert.test.ts`
Expected: FAIL (missing module; `prepareWine` not called).

- [ ] **Step 3: Implement**

`src/winePrefix.ts`:
```ts
import { join } from 'node:path';
import { ConvertError, ExitCode } from './errors.js';
import type { RunFn } from './exec.js';
import { APT_HINT } from './install.js';

export { APT_HINT } from './install.js';

// Our own 32-bit prefix: the user's WINEPREFIX (if any) is never used or modified.
export function wineEnv(prefix: string): Record<string, string> {
  return { WINEARCH: 'win32', WINEPREFIX: prefix, WINEDEBUG: '-all' };
}

export async function ensureWinePrefix(
  prefix: string,
  deps: { exists(p: string): Promise<boolean>; run: RunFn; onSetup?: () => void },
): Promise<void> {
  const marker = join(prefix, 'system.reg');
  if (await deps.exists(marker)) return;
  deps.onSetup?.();
  const result = await deps.run('xvfb-run', ['-a', 'wineboot', '-i'], { env: { ...process.env, ...wineEnv(prefix) }, timeoutMs: 5 * 60_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  if (/wine32 is missing|ELFCLASS32|wrong ELF class/i.test(output)) {
    throw new ConvertError(ExitCode.Preflight, '32-bit Wine is missing (needed by the Fightcade emulator)', APT_HINT);
  }
  if (result.code !== 0 || !(await deps.exists(marker))) {
    const tail = output.trim().split('\n').slice(-3).join(' ');
    throw new ConvertError(ExitCode.Emulator, `Could not set up Wine (exit ${result.code}): ${tail}`, 'Run with -v and check your Wine installation');
  }
}
```

`src/convert.ts`:
- `ProgressEvent`: add `| { phase: 'setting-up-wine' }`.
- `ConvertDeps`: add `prepareWine(install: FightcadeInstall, onSetup: () => void): Promise<void>;`.
- `defaultDeps`:
```ts
    prepareWine: async (install, onSetup) => {
      if (install.platform !== 'linux') return;
      await ensureWinePrefix(app.wineprefixDir, { exists: pathExists, run, onSetup });
    },
```
  with imports `import { run, which } from './exec.js';` and `import { ensureWinePrefix } from './winePrefix.js';`.
- In `convert`, right after `await deps.prepareRuntime(install, ensured.updated);`:
```ts
    await deps.prepareWine(install, () => options.onProgress?.({ phase: 'setting-up-wine' }));
```

`src/cli.ts` `progressLine`: add
```ts
    case 'setting-up-wine':
      return 'Setting up Wine (first run, about a minute)…';
```

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/winePrefix.ts src/convert.ts src/cli.ts tests/winePrefix.test.ts tests/convert.test.ts
git commit -m "feat: private Wine prefix created on first Linux run"
```

---

### Task 3: Headless launch and stop on Linux

**Files:**
- Modify: `src/capture.ts`, `src/convert.ts`, `src/ffmpegLocator.ts`
- Test: `tests/capture.test.ts`, `tests/ffmpegLocator.test.ts`

**Interfaces:**
- Consumes: `wineEnv` (Task 2), `AppPaths.wineprefixDir`.
- Produces: `emulatorCommand(install, runtimeDir, quarkId)` (Linux: the `xvfb-run` command); `killCommand(install, winePrefix: string | null): { command: string; args: string[]; env?: Record<string, string> }`; `emulatorSpawnOptions(install, runtimeDir, env, winePrefix): { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: 'ignore' }`; `defaultCaptureDeps(install, runtimeDir, quarkId, ffmpeg, winePrefix: string | null)`.

- [ ] **Step 1: Failing tests**

Append to `tests/capture.test.ts` (add `emulatorSpawnOptions` to the `../src/capture.js` import):
```ts
describe('headless launch on Linux', () => {
  const linux = installLayout('/srv/fightcade', 'linux');
  const rt = '/home/a/.cache/fc2mp4/runtime';
  const prefix = '/home/a/.cache/fc2mp4/wineprefix';

  it('always runs under a virtual display with Wine’s virtual desktop', () => {
    expect(emulatorCommand(linux, rt, '1-2')).toEqual({
      command: 'xvfb-run',
      args: ['-a', '-s', '-screen 0 1024x768x24', 'wine', 'explorer', '/desktop=fc2mp4,1024x768', `${rt}/fcadefbneo-fc2mp4.exe`, 'quark:stream,sfiii3nr1,1-2.7,7100'],
    });
  });

  it('stops every Wine process of our prefix only', () => {
    expect(killCommand(linux, prefix)).toEqual({
      command: 'wineserver',
      args: ['-k'],
      env: { WINEARCH: 'win32', WINEPREFIX: prefix, WINEDEBUG: '-all' },
    });
  });

  it('starts in its own process group with our prefix, even if the user set WINEPREFIX', () => {
    const opts = emulatorSpawnOptions(linux, rt, { FC2MP4_VIDEO: 'Z:\\x' }, prefix, { WINEPREFIX: '/home/a/.wine', PATH: '/usr/bin' });
    expect(opts).toMatchObject({ cwd: rt, detached: true, stdio: 'ignore' });
    expect(opts.env).toMatchObject({ WINEPREFIX: prefix, WINEARCH: 'win32', FC2MP4_VIDEO: 'Z:\\x', PATH: '/usr/bin' });
  });

  it('keeps macOS and Windows launches as they were', () => {
    const mac = installLayout('/Applications/FightCade2.app', 'darwin');
    expect(emulatorSpawnOptions(mac, '/rt', {}, null, {})).toMatchObject({ detached: false });
    expect(killCommand(mac, null)).toEqual({ command: mac.launcher, args: ['taskkill', '/IM', 'fcadefbneo-fc2mp4.exe', '/F'] });
  });
});
```
Update the two existing `killCommand(mac)` / `killCommand(win)` calls in that file to `killCommand(mac, null)` / `killCommand(win, null)`.

Append to `tests/ffmpegLocator.test.ts`:
```ts
  it('asks Linux users to install ffmpeg with apt', async () => {
    const { deps } = fakeDeps({});
    await expect(locateFfmpeg('linux', '/x', deps)).rejects.toMatchObject({ exitCode: ExitCode.Preflight, hint: 'sudo apt install ffmpeg' });
  });
```

- [ ] **Step 2: Run, watch fail**

Run: `npx vitest run tests/capture.test.ts tests/ffmpegLocator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/capture.ts` — imports: add `import { wineEnv } from './winePrefix.js';`. Replace `emulatorCommand` and `killCommand`, and add `emulatorSpawnOptions`:
```ts
export function emulatorCommand(install: FightcadeInstall, runtimeDir: string, quarkId: string): { command: string; args: string[] } {
  const exe = pathFor(install.platform).join(runtimeDir, EMULATOR_EXE);
  if (install.platform === 'linux') {
    // Always headless: a virtual display plus Wine's virtual desktop (bare Xvfb fails: X_UnmapWindow BadWindow).
    return {
      command: 'xvfb-run',
      args: ['-a', '-s', '-screen 0 1024x768x24', 'wine', 'explorer', '/desktop=fc2mp4,1024x768', exe, streamArg(quarkId)],
    };
  }
  if (install.launcher !== null) return { command: install.launcher, args: [exe, streamArg(quarkId)] };
  return { command: exe, args: [streamArg(quarkId)] };
}

export function killCommand(install: FightcadeInstall, winePrefix: string | null): { command: string; args: string[]; env?: Record<string, string> } {
  if (install.platform === 'linux' && winePrefix !== null) return { command: 'wineserver', args: ['-k'], env: wineEnv(winePrefix) };
  const args = ['/IM', EMULATOR_EXE, '/F'];
  return install.launcher !== null ? { command: install.launcher, args: ['taskkill', ...args] } : { command: 'taskkill', args };
}

export function emulatorSpawnOptions(
  install: FightcadeInstall,
  runtimeDir: string,
  env: Record<string, string>,
  winePrefix: string | null,
  base: NodeJS.ProcessEnv = process.env,
): { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: 'ignore' } {
  const linux = install.platform === 'linux' && winePrefix !== null;
  return {
    cwd: runtimeDir,
    env: { ...base, ...(linux ? wineEnv(winePrefix) : {}), ...env },
    detached: linux, // own process group, so Xvfb and Wine are stopped together
    stdio: 'ignore',
  };
}
```
Change `defaultCaptureDeps` signature to `(install, runtimeDir, quarkId, ffmpeg, winePrefix: string | null)` and replace its `startEmulator` with:
```ts
    startEmulator: (env) => {
      // FBNeo divides by the screen size while sizing its window: a sleeping Mac display (size 0)
      // crashes it. Keep the display awake for as long as this process runs.
      const awake = install.platform === 'darwin' ? spawn('caffeinate', ['-d', '-u', '-w', String(process.pid)], { stdio: 'ignore' }) : null;
      awake?.on('error', () => {});
      const { command, args } = emulatorCommand(install, runtimeDir, quarkId);
      const options = emulatorSpawnOptions(install, runtimeDir, env, winePrefix);
      const child = spawn(command, args, options);
      child.on('exit', () => awake?.kill());
      return wrap(child, async () => {
        const kill = killCommand(install, winePrefix);
        await run(kill.command, kill.args, { cwd: runtimeDir, timeoutMs: TIMEOUTS.killMs, env: kill.env ? { ...process.env, ...kill.env } : undefined }).catch(() => {});
        if (options.detached && child.pid !== undefined) {
          try {
            process.kill(-child.pid, 'SIGTERM');
          } catch {
            // already gone
          }
        }
        child.kill('SIGKILL');
      });
    },
```

`src/convert.ts` `defaultDeps`: `capture: (install, quarkId, ffmpeg, opts) => capture(defaultCaptureDeps(install, app.runtimeDir, quarkId, ffmpeg, install.platform === 'linux' ? app.wineprefixDir : null), opts),`.

`src/ffmpegLocator.ts`: after the darwin line add
```ts
  if (platform === 'linux') throw new ConvertError(ExitCode.Preflight, 'ffmpeg not found on PATH', 'sudo apt install ffmpeg');
```

- [ ] **Step 4: Run tests**

Run: `npm test && npm run typecheck`
Expected: all pass.

- [ ] **Step 5: macOS regression check**

Run: `caffeinate -u -t 2; FC_E2E='https://replay.fightcade.com/fbneo/sfiii3nr1/1791006077129-2245' FC_E2E_EXPECTED_SECONDS=137.94 npx vitest run tests/e2e.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/capture.ts src/convert.ts src/ffmpegLocator.ts tests/capture.test.ts tests/ffmpegLocator.test.ts
git commit -m "feat: headless Linux launch (Xvfb + Wine virtual desktop) and clean stop"
```

---

### Task 4: Linux binary, usage text, README

**Files:**
- Modify: `.github/workflows/cli.yml`, `src/cliArgs.ts` (USAGE), `README.md`, `package.json` (version `0.4.0`)

**Interfaces:**
- Produces: release asset `fc2mp4-linux-x64`.

- [ ] **Step 1: `cli.yml`** — add a matrix entry and run the full suite on every non-Windows runner:
```yaml
          - os: ubuntu-latest
            artifact: build/fc2mp4
            name: fc2mp4-linux-x64
```
change `if: runner.os == 'macOS'` (unit tests) to `if: runner.os != 'Windows'`, and the release command to
`gh release create "${GITHUB_REF_NAME}" fc2mp4.exe fc2mp4-macos-arm64 fc2mp4-linux-x64 \` (rest unchanged).
Validate: `ruby -ryaml -e "YAML.load_file('.github/workflows/cli.yml'); puts 'ok'"` → `ok`.

- [ ] **Step 2: USAGE** in `src/cliArgs.ts` — replace the first lines of the usage text so it reads:
```
Records a Fightcade Street Fighter III: 3rd Strike replay to MP4 (macOS, Windows and Linux).

  -o, --output <path>       MP4 file, or an existing folder
                            (default: ~/Movies/Fightcade, %USERPROFILE%\Videos\Fightcade or ~/Videos/Fightcade)
      --scale sharp|smooth  Upscaling style (default: sharp)
      --max-duration <d>    Stop capturing after this long: 90s, 45m, 1h (default: 60m)
      --fightcade-dir <p>   Fightcade install (FightCade2.app on macOS, the Fightcade folder on Windows;
                            on Linux a Fightcade folder or its emulator/fbneo folder, also FC2MP4_FIGHTCADE_DIR)
```
(keep the other lines as they are). Run `npm test` → pass.

- [ ] **Step 3: README** — add after the macOS install bullet:
```markdown
- **Linux (x86_64, headless):** download `fc2mp4-linux-x64`, `chmod +x` it, and install the system
  packages once: `sudo dpkg --add-architecture i386 && sudo apt update && sudo apt install wine wine32:i386 xvfb ffmpeg`.
  Point it at Fightcade's files with `--fightcade-dir` (or `FC2MP4_FIGHTCADE_DIR`): either a Fightcade
  folder, or a copy of its `emulator/fbneo` folder containing `ggponet.dll` and `ROMs/sfiii3nr1.zip` +
  `ROMs/sfiii3.zip`. No screen is needed: it runs on a virtual display.
```
and in "Usage" mention `~/Videos/Fightcade` on Linux.

- [ ] **Step 4: Version, checks, commit**

Run: `npm version 0.4.0 --no-git-tag-version && npm test && npm run test:emulator && npm run typecheck`
```bash
git add .github/workflows/cli.yml src/cliArgs.ts README.md package.json package-lock.json
git commit -m "feat: Linux binary in releases; docs; v0.4.0"
```

---

### Task 5: Publish and verify in WSL (after the whole-branch review)

- [ ] **Step 1:** Ask the user, then merge to `main`, push, tag `v0.4.0`, push the tag. Wait for `cli.yml`; expected release `v0.4.0` with three binaries.

- [ ] **Step 2: User runs in WSL Ubuntu** (give these exact commands):
```bash
cd ~ && curl -sSfLO https://github.com/Coccis77/fightcade-replay-converter/releases/download/v0.4.0/fc2mp4-linux-x64 && chmod +x fc2mp4-linux-x64
export FC2MP4_FIGHTCADE_DIR=/mnt/c/Users/Coccis/Documents/Fightcade
./fc2mp4-linux-x64 https://replay.fightcade.com/fbneo/sfiii3nr1/1791006077129-2245
ffprobe -v error -show_entries stream=codec_type,width,height,duration -of compact ~/Videos/Fightcade/1791006077129-2245.mp4
time ./fc2mp4-linux-x64 https://replay.fightcade.com/fbneo/sfiii3nr1/1790980205888-4792
```
Then start the short replay again, Ctrl-C during "Capturing…", and run:
```bash
pgrep -fl 'wine|Xvfb|fcadefbneo' ; ls /tmp | grep fc2mp4- ; ls /tmp/fc2mp4.lock 2>/dev/null; echo done
```
Expected: 1440×1080 h264 + aac with video/audio durations within 0.05 s (≈137.94 s); the 9-min replay converts; after Ctrl-C only `done` is printed. Fightcade check from Windows PowerShell:
`Get-ChildItem -Recurse -File "C:\Users\Coccis\Documents\Fightcade\emulator\fbneo" | Where-Object { $_.LastWriteTime -gt (Get-Date).AddHours(-2) }` → no output.
