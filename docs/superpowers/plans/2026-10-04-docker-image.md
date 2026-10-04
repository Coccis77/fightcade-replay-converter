# fc2mp4 Docker Image Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a ready-to-convert `ghcr.io/coccis77/fc2mp4` image with every release, plus the two CLI additions it needs (`fc2mp4 prepare`, `FC2MP4_OUTPUT_DIR`).

**Architecture:** The CLI gains a `prepare` command (tools check → ffmpeg → forced emulator check → Wine setup, no Fightcade files) and an output-folder environment variable. A root `Dockerfile` installs Wine/Xvfb/ffmpeg/tini on Ubuntu 24.04, copies the release's Linux binary and runs `fc2mp4 prepare` at build time. The `cli` workflow builds and checks the image on every push and publishes it on version tags.

**Tech Stack:** TypeScript 5.9 / Node 24 SEA, vitest, Docker (BuildKit), GitHub Actions, GHCR.

**Spec:** `docs/superpowers/specs/2026-10-04-docker-image-design.md`

## Global Constraints

- Fightcade files (ROMs, `ggponet.dll`) are never put in the image; users mount them at `/fightcade` (read-only).
- Base image `ubuntu:24.04`; packages `wine wine32:i386 xvfb xauth ffmpeg ca-certificates tini` (with recommends, as in the verified WSL environment).
- Container user `fc2mp4`, uid/gid 1000, `HOME=/home/fc2mp4`; cache in `/home/fc2mp4/.cache/fc2mp4`.
- Image env: `FC2MP4_FIGHTCADE_DIR=/fightcade`, `FC2MP4_OUTPUT_DIR=/videos`; entrypoint `["/usr/bin/tini", "--", "fc2mp4"]`.
- Tags `ghcr.io/coccis77/fc2mp4:<version>` (no `v`) and `:latest`, pushed with the workflow `GITHUB_TOKEN` (`packages: write`), only on `v*` tags and only after the image checks pass.
- `FC2MP4_OUTPUT_DIR`: absolute path replaces the default output folder on all platforms; empty/relative ignored; `-o` wins.
- `fc2mp4 prepare`: no Fightcade files needed; takes the lock; order tools → ffmpeg → emulator (forced check) → Wine; emulator warning → exit code 5 (`ExitCode.Emulator`), as `update-emulator`.
- Existing exit codes and messages unchanged; Windows/macOS/Linux binaries behave as before apart from the additions.
- Node via `source ~/.nvm/nvm.sh && nvm use 24`. Test command: `npm test` (vitest) — the whole suite must stay green.
- Commits by the repo's local identity; end each message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never push or tag without asking the user.

## Review Focus

1. **Output folder not writable** (a `/videos` mount owned by another uid, or a read-only `-o` folder): expected a clear `Cannot write to …` error *before* the multi-minute capture, not an "Unexpected error" stack trace after it. → Task 1 test "fails before capturing when the output folder is not writable".
2. **`prepare` with no Fightcade folder anywhere** (the image build): must never look for Fightcade. → Task 2 test "prepares … without Fightcade files" (locateInstall throws in that harness).
3. **`prepare` offline/rate-limited with an existing emulator:** warning printed, exit 5, so a docker build that cannot reach GitHub fails loudly instead of shipping a stale image silently. → Task 2 test "passes on the emulator warning".
4. **Ctrl-C / `docker stop` during `prepare`'s Wine setup:** reported as Interrupted and the lock released. → Task 2 test "releases the lock and reports Interrupted…".
5. **Missing `wine`/`xvfb-run` when running `prepare` on a bare Linux host:** the apt hint, before any download. → Task 2 test "stops at missing tools…".

---

### Task 1: `FC2MP4_OUTPUT_DIR` and an early writable-output check

**Files:**
- Modify: `src/platform.ts` (end of the if/else in `appPaths`)
- Modify: `src/convert.ts` (`ConvertDeps`, `defaultDeps`, `convert`)
- Modify: `src/cliArgs.ts` (`USAGE`)
- Test: `tests/platform.test.ts`, `tests/convert.test.ts`

**Interfaces:**
- Produces: `appPaths(platform, home, env)` honours `env.FC2MP4_OUTPUT_DIR`; `ConvertDeps.checkWritable(dir: string): Promise<void>` (throws `ConvertError(ExitCode.Preflight, 'Cannot write to <dir>', hint)`), called by `convert` right after `preflight`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/platform.test.ts`:

```ts
describe('FC2MP4_OUTPUT_DIR', () => {
  it('replaces the default output folder on every platform when absolute', () => {
    expect(appPaths('linux', '/home/a', { FC2MP4_OUTPUT_DIR: '/videos' }).outputDir).toBe('/videos');
    expect(appPaths('darwin', '/Users/a', { FC2MP4_OUTPUT_DIR: '/Volumes/Clips' }).outputDir).toBe('/Volumes/Clips');
    expect(appPaths('win32', 'C:\\Users\\a', { FC2MP4_OUTPUT_DIR: 'D:\\Clips' }).outputDir).toBe('D:\\Clips');
  });
  it('ignores an empty or relative value', () => {
    expect(appPaths('linux', '/home/a', { FC2MP4_OUTPUT_DIR: '' }).outputDir).toBe('/home/a/Videos/Fightcade');
    expect(appPaths('linux', '/home/a', { FC2MP4_OUTPUT_DIR: 'videos' }).outputDir).toBe('/home/a/Videos/Fightcade');
  });
});
```

In `tests/convert.test.ts`, add to the `harness` deps object (after `preflight`):

```ts
    checkWritable: async (dir) => {
      calls.push(`writable:${dir}`);
    },
```

Change the expected order in `'runs the pipeline in order'` to:

```ts
    expect(calls).toEqual([
      'lock', 'preflight', 'writable:/out', 'ffmpeg', 'ensure:false:false', 'runtime:false', 'wine', 'tmp', `capture:${ID}:/tmp/run`,
      'mkdir:/out', `mux:/out/${ID}.mp4`, 'rmdir:/tmp/run', 'unlock',
    ]);
```

And add inside `describe('convert', …)`:

```ts
  it('fails before capturing when the output folder is not writable', async () => {
    const { deps, calls } = harness({
      checkWritable: async (dir) => {
        throw new ConvertError(ExitCode.Preflight, `Cannot write to ${dir}`);
      },
    });
    await expect(convert(ID, baseOptions, deps)).rejects.toMatchObject({ exitCode: ExitCode.Preflight, message: 'Cannot write to /out' });
    expect(calls).toEqual(['lock', 'preflight', 'unlock']);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/platform.test.ts tests/convert.test.ts`
Expected: FAIL — `FC2MP4_OUTPUT_DIR` tests get `/home/a/Videos/Fightcade` etc.; the order test lacks `writable:/out`; the new convert test resolves instead of rejecting. (TypeScript may also flag `checkWritable` as unknown in `ConvertDeps`; vitest still runs.)

- [ ] **Step 3: Implement**

`src/platform.ts`, right after the closing `}` of the `if (platform === 'win32') … else …` block in `appPaths`:

```ts
  // Docker and servers choose the output folder without passing -o on every run.
  const custom = env.FC2MP4_OUTPUT_DIR;
  if (custom && p.isAbsolute(custom)) outputDir = custom;
```

`src/convert.ts`:
- import: change `import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';` to `import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';` and add `import { constants } from 'node:fs';`
- in `ConvertDeps`, after `preflight(...)`: `checkWritable(dir: string): Promise<void>;`
- in `defaultDeps()`, after `preflight: …,`:

```ts
    checkWritable: async (dir) => {
      try {
        await mkdir(dir, { recursive: true });
        await access(dir, constants.W_OK);
      } catch {
        throw new ConvertError(
          ExitCode.Preflight,
          `Cannot write to ${dir}`,
          'Choose another folder with -o, or make this one writable (in Docker: the folder mounted at /videos must be writable by uid 1000)',
        );
      }
    },
```

- in `convert`, right after `await deps.preflight(install);`: `await deps.checkWritable(dirname(output));`

`src/cliArgs.ts` `USAGE`, replace the `(default: …)` line with:

```
                            (default: FC2MP4_OUTPUT_DIR, else ~/Movies/Fightcade, %USERPROFILE%\\Videos\\Fightcade or ~/Videos/Fightcade)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/platform.test.ts tests/convert.test.ts && npx tsc --noEmit -p .`
Expected: PASS, no type errors.

- [ ] **Step 5: Run the whole suite and commit**

Run: `npm test` — Expected: all pass.

```bash
git add src/platform.ts src/convert.ts src/cliArgs.ts tests/platform.test.ts tests/convert.test.ts
git commit -m "feat: FC2MP4_OUTPUT_DIR and an early check that the output folder is writable"
```

---

### Task 2: `fc2mp4 prepare`

**Files:**
- Modify: `src/install.ts` (new `checkTools`, used by `preflight`)
- Modify: `src/convert.ts` (`ConvertDeps` signatures, `defaultDeps`, new `prepare`)
- Modify: `src/cliArgs.ts` (`CliRequest`, `parseCli`, `USAGE`)
- Modify: `src/cli.ts`
- Test: `tests/install.test.ts`, `tests/convert.test.ts`, `tests/cliArgs.test.ts`

**Interfaces:**
- Consumes: `ConvertDeps.checkWritable` (Task 1) — unchanged here.
- Produces:
  - `checkTools(platform: Platform, which: (cmd: string) => Promise<string | null>): Promise<void>` in `src/install.ts`.
  - `ConvertDeps.checkTools(): Promise<void>`; `ConvertDeps.locateFfmpeg(install: FightcadeInstall | null, signal?)`, `ConvertDeps.ensureEmulator(install: FightcadeInstall | null, opts)`, `ConvertDeps.prepareWine(install: FightcadeInstall | null, onSetup, signal?)`.
  - `prepare(options: { signal?: AbortSignal; log?: (msg: string) => void; onProgress?: (e: ProgressEvent) => void }, deps?: ConvertDeps): Promise<PrepareResult>` with `PrepareResult = { emulatorUpdated: boolean; warning?: string }`.
  - `CliRequest` member `{ command: 'prepare'; verbose: boolean }`.

- [ ] **Step 1: Write the failing tests**

`tests/install.test.ts`: add `checkTools` to the import from `../src/install.js` (and `ExitCode` from `../src/errors.js` if not already imported), then append:

```ts
describe('checkTools', () => {
  it('needs wine and xvfb-run on Linux only, with the apt hint', async () => {
    await expect(checkTools('linux', async (c) => (c === 'wine' ? null : `/usr/bin/${c}`))).rejects.toMatchObject({
      exitCode: ExitCode.Preflight,
      message: 'Missing on this system: wine',
      hint: expect.stringContaining('apt install'),
    });
    await expect(checkTools('linux', async (c) => `/usr/bin/${c}`)).resolves.toBeUndefined();
    await expect(checkTools('darwin', async () => null)).resolves.toBeUndefined();
    await expect(checkTools('win32', async () => null)).resolves.toBeUndefined();
  });
});
```

`tests/convert.test.ts`: add `prepare` to the import from `../src/convert.js`; add to the harness deps object (after `checkWritable`):

```ts
    checkTools: async () => {
      calls.push('tools');
    },
```

Append:

```ts
describe('prepare', () => {
  it('prepares tools, ffmpeg, a fresh emulator check and Wine, without Fightcade files', async () => {
    const { deps, calls } = harness({
      locateInstall: async () => {
        throw new ConvertError(ExitCode.Preflight, 'Fightcade files not found');
      },
    });
    const phases: string[] = [];
    await expect(prepare({ onProgress: (e) => phases.push(e.phase) }, deps)).resolves.toEqual({ emulatorUpdated: false, warning: undefined });
    expect(calls).toEqual(['lock', 'tools', 'ffmpeg', 'ensure:true:false', 'wine', 'unlock']);
    expect(phases).toEqual(['preparing', 'setting-up-wine']);
  });

  it('passes on the emulator warning (offline, previous build kept)', async () => {
    const { deps } = harness({ ensureEmulator: async () => ({ updated: false, warning: 'GitHub unreachable; using the current emulator' }) });
    const logs: string[] = [];
    const result = await prepare({ log: (m) => logs.push(m) }, deps);
    expect(result.warning).toBe('GitHub unreachable; using the current emulator');
    expect(logs).toEqual(['Warning: GitHub unreachable; using the current emulator']);
  });

  it('releases the lock and reports Interrupted when stopped during Wine setup', async () => {
    const controller = new AbortController();
    const { deps, calls } = harness({
      prepareWine: async () => {
        controller.abort();
        throw new Error('wineboot killed');
      },
    });
    await expect(prepare({ signal: controller.signal }, deps)).rejects.toMatchObject({ exitCode: ExitCode.Interrupted });
    expect(calls.at(-1)).toBe('unlock');
  });

  it('stops at missing tools with the install hint, before any download', async () => {
    const { deps, calls } = harness({
      checkTools: async () => {
        throw new ConvertError(ExitCode.Preflight, 'Missing on this system: wine', 'sudo apt install wine');
      },
    });
    await expect(prepare({}, deps)).rejects.toMatchObject({ exitCode: ExitCode.Preflight, message: 'Missing on this system: wine' });
    expect(calls).toEqual(['lock', 'unlock']);
  });
});
```

`tests/cliArgs.test.ts`, inside `describe('parseCli', …)`:

```ts
  it('parses prepare', () => {
    expect(parseCli(['prepare'])).toEqual({ command: 'prepare', verbose: false });
    expect(parseCli(['prepare', '-v'])).toEqual({ command: 'prepare', verbose: true });
  });
```

and add `[['prepare', 'x']]` to the `it.each` list of rejected argv.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/install.test.ts tests/convert.test.ts tests/cliArgs.test.ts`
Expected: FAIL — `checkTools`/`prepare` are not exported (`is not a function`); `parseCli(['prepare'])` returns a `convert` request.

- [ ] **Step 3: Implement `checkTools`**

`src/install.ts` — add above `preflight` (import `type Platform` from `./platform.js` if not already imported):

```ts
// Tools fc2mp4 cannot download itself. ffmpeg is checked where it is located (ffmpegLocator).
export async function checkTools(platform: Platform, which: (cmd: string) => Promise<string | null>): Promise<void> {
  if (platform !== 'linux') return;
  const missing: string[] = [];
  for (const tool of ['wine', 'xvfb-run']) if ((await which(tool)) === null) missing.push(tool);
  if (missing.length > 0) throw new ConvertError(ExitCode.Preflight, `Missing on this system: ${missing.join(', ')}`, APT_HINT);
}
```

and replace the whole `if (install.platform === 'linux') { … }` block in `preflight` with `await checkTools(install.platform, deps.which);`.

- [ ] **Step 4: Implement `prepare`**

`src/convert.ts`:
- import `checkTools` from `./install.js` alongside `locateInstall, preflight`.
- `ConvertDeps`: add `checkTools(): Promise<void>;` and change three signatures:

```ts
  locateFfmpeg(install: FightcadeInstall | null, signal?: AbortSignal): Promise<string>;
  ensureEmulator(install: FightcadeInstall | null, opts: { force: boolean; local: boolean; signal?: AbortSignal }): Promise<EnsureResult>;
  prepareWine(install: FightcadeInstall | null, onSetup: () => void, signal?: AbortSignal): Promise<void>;
```

- `defaultDeps()`:
  - add `checkTools: () => checkTools(platform, (cmd) => which(cmd, platform)),`
  - in `ensureEmulator`, the local-build condition becomes `install !== null && install.platform === 'darwin' && dir !== null` (the rest unchanged).
  - in `prepareWine`, replace `if (install.platform !== 'linux') return;` with `if (platform !== 'linux') return;` (`platform` is the `supportedPlatform(process.platform)` already in scope).
- append:

```ts
export interface PrepareResult {
  emulatorUpdated: boolean;
  warning?: string;
}

// Everything a conversion needs except the Fightcade files: run at Docker image build time, or once on a
// server, so later conversions start immediately.
export async function prepare(
  options: { signal?: AbortSignal; log?: (msg: string) => void; onProgress?: (e: ProgressEvent) => void },
  deps: ConvertDeps = defaultDeps(),
): Promise<PrepareResult> {
  const release = await deps.acquireLock();
  try {
    await deps.checkTools();
    options.onProgress?.({ phase: 'preparing' });
    await deps.locateFfmpeg(null, options.signal);
    const ensured = await deps.ensureEmulator(null, { force: true, local: false, signal: options.signal });
    if (ensured.warning) options.log?.(`Warning: ${ensured.warning}`);
    await deps.prepareWine(null, () => options.onProgress?.({ phase: 'setting-up-wine' }), options.signal);
    return { emulatorUpdated: ensured.updated, warning: ensured.warning };
  } catch (err) {
    if (options.signal?.aborted && !(err instanceof ConvertError && err.exitCode === ExitCode.Interrupted)) {
      throw new ConvertError(ExitCode.Interrupted, 'Interrupted');
    }
    throw err;
  } finally {
    await release();
  }
}
```

- [ ] **Step 5: Implement the CLI command**

`src/cliArgs.ts`:
- `USAGE`: after the `rebuild-emulator` usage line add `       fc2mp4 prepare [-v]`, and at the end (after the `rebuild-emulator …` sentence) add a line:
  `prepare downloads the emulator and sets up Wine ahead of time (no Fightcade files needed; used by the Docker image).`
- `CliRequest`: add `| { command: 'prepare'; verbose: boolean }`.
- `parseCli`, right after `const command = positionals[0];`:

```ts
  if (command === 'prepare') {
    if (positionals.length !== 1) throw usage('prepare takes no arguments');
    return { command, verbose };
  }
```

`src/cli.ts`: import `prepare` from `./convert.js`; right before `if (request.command !== 'convert') {` add:

```ts
    if (request.command === 'prepare') {
      const result = await prepare({ signal: controller.signal, log, onProgress: (e) => process.stderr.write(`${progressLine(e)}\n`) });
      process.stdout.write(result.emulatorUpdated ? 'Ready (emulator downloaded).\n' : 'Ready.\n');
      return result.warning ? ExitCode.Emulator : 0;
    }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/install.test.ts tests/convert.test.ts tests/cliArgs.test.ts && npx tsc --noEmit -p .`
Expected: PASS, no type errors.

- [ ] **Step 7: Check the bundled CLI and commit**

Run: `npm test && npm run bundle && node build/fc2mp4.cjs --help | grep -n prepare`
Expected: suite green; two help lines mention `prepare`.

```bash
git add src/install.ts src/convert.ts src/cliArgs.ts src/cli.ts tests/install.test.ts tests/convert.test.ts tests/cliArgs.test.ts
git commit -m "feat: fc2mp4 prepare — emulator and Wine ready ahead of time, no Fightcade files needed"
```

---

### Task 3: Dockerfile and image checks

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `scripts/check-image.sh`

**Interfaces:**
- Consumes: `fc2mp4 prepare` (Task 2), `FC2MP4_OUTPUT_DIR` (Task 1); the build context must contain `fc2mp4-linux-x64` (a Linux SEA binary).
- Produces: `scripts/check-image.sh <image> <version>` — exit 0 and `Image checks passed`, or `FAIL: …` and exit 1.

- [ ] **Step 1: Write the image check first**

`scripts/check-image.sh`:

```bash
#!/bin/bash
# Checks a built fc2mp4 image before it is published.
# Usage: scripts/check-image.sh <image> <version>
set -euo pipefail
IMAGE=$1
VERSION=$2
fail() { echo "FAIL: $*" >&2; exit 1; }

got=$(docker run --rm "$IMAGE" --version)
[ "$got" = "$VERSION" ] || fail "--version printed '$got', expected '$VERSION'"

docker run --rm --entrypoint sh "$IMAGE" -c \
  'test -f "$HOME/.cache/fc2mp4/runtime/fcadefbneo-fc2mp4.exe" && test -f "$HOME/.cache/fc2mp4/wineprefix/.fc2mp4-ready"' \
  || fail "the emulator or the Wine environment is missing from the image"

set +e
out=$(docker run --rm "$IMAGE" 1791006077129-2245 2>&1)
code=$?
set -e
[ "$code" = 3 ] || fail "a run without /fightcade exited $code, expected 3: $out"
echo "$out" | grep -q 'Fightcade files not found' || fail "unexpected message without /fightcade: $out"

echo "Image checks passed"
```

Run: `chmod +x scripts/check-image.sh && bash -n scripts/check-image.sh && bash scripts/check-image.sh fc2mp4:none 0.0.0`
Expected: `bash -n` silent; the run FAILs (no such image: `docker run` errors, `set -e` exits non-zero) — the check cannot pass without a real image.

- [ ] **Step 2: Write the Dockerfile and .dockerignore**

`.dockerignore`:

```
*
!fc2mp4-linux-x64
```

`Dockerfile`:

```dockerfile
# fc2mp4: Fightcade 3rd Strike replay -> MP4, headless (x86-64 only).
# Mount your Fightcade folder at /fightcade (read-only) and an output folder at /videos:
#   docker run --rm -v /path/to/Fightcade:/fightcade:ro -v "$PWD/videos":/videos ghcr.io/coccis77/fc2mp4 <replay link>
# The build context must contain fc2mp4-linux-x64 (from the release workflow).
FROM ubuntu:24.04
ARG DEBIAN_FRONTEND=noninteractive
RUN dpkg --add-architecture i386 \
 && apt-get update \
 && apt-get install -y wine wine32:i386 xvfb xauth ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
# ubuntu:24.04 ships a user "ubuntu" with uid 1000; fc2mp4 takes that uid so the MP4s belong to the
# usual first user of a Linux host.
RUN userdel -r ubuntu \
 && groupadd -g 1000 fc2mp4 \
 && useradd -m -u 1000 -g 1000 fc2mp4 \
 && mkdir /videos /fightcade \
 && chown fc2mp4:fc2mp4 /videos
COPY --chmod=755 fc2mp4-linux-x64 /usr/local/bin/fc2mp4
USER fc2mp4
ENV FC2MP4_FIGHTCADE_DIR=/fightcade FC2MP4_OUTPUT_DIR=/videos
# The emulator and the Wine environment live in the image: every container starts converting at once.
RUN fc2mp4 prepare
WORKDIR /videos
ENTRYPOINT ["/usr/bin/tini", "--", "fc2mp4"]
```

- [ ] **Step 3: Build and check the image locally (best effort)**

A Linux binary of the current code is needed. Build it in a Linux container, then the image, both as amd64 (emulated on Apple Silicon):

```bash
docker run --rm --platform linux/amd64 -v "$PWD":/src -w /src node:24 bash -c 'npm ci && npm run bundle && npm run sea && cp build/fc2mp4 fc2mp4-linux-x64'
docker build --platform linux/amd64 -t fc2mp4:test .
bash scripts/check-image.sh fc2mp4:test "$(node -p "require('./package.json').version")"
rm -f fc2mp4-linux-x64
```

Expected: `Image checks passed`. Afterwards run `npm ci` again on the host (the container replaced `node_modules` with Linux builds). If the amd64 emulation itself fails (Wine under QEMU — not a Dockerfile problem), record `Task 3: Ruling: local amd64 check impossible here (<error>); verified in CI in Task 4` in the ledger and continue: Task 4 runs the same check on a real x86-64 runner.

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore scripts/check-image.sh
git commit -m "feat: Docker image (Ubuntu 24.04, Wine, prepared at build time) and its checks"
```

---

### Task 4: CI image job, publishing, README

**Files:**
- Modify: `.github/workflows/cli.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: `Dockerfile`, `scripts/check-image.sh` (Task 3); artifact `fc2mp4-linux-x64` from the `build` job.

- [ ] **Step 1: Workflow**

In `.github/workflows/cli.yml`:
- trigger: under `push:` add `branches: ['**']` above `tags: ['v*']` (every push builds and checks; only tags release).
- add this job after `build`:

```yaml
  image:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: fc2mp4-linux-x64
      - name: Build image
        run: docker build -t fc2mp4:test .
      - name: Check image
        run: bash scripts/check-image.sh fc2mp4:test "$(node -p "require('./package.json').version")"
      - name: Publish to ghcr.io
        if: startsWith(github.ref, 'refs/tags/v')
        run: |
          echo "${{ github.token }}" | docker login ghcr.io -u "${{ github.actor }}" --password-stdin
          version="${GITHUB_REF_NAME#v}"
          for tag in "$version" latest; do
            docker tag fc2mp4:test "ghcr.io/coccis77/fc2mp4:$tag"
            docker push "ghcr.io/coccis77/fc2mp4:$tag"
          done
```

- `release` job: `needs: build` → `needs: [build, image]`; release notes text becomes:
  `"Download fc2mp4.exe (Windows), fc2mp4-macos-arm64 (macOS) or fc2mp4-linux-x64 (Linux), then run it with a Fightcade replay link. Docker: ghcr.io/coccis77/fc2mp4:${GITHUB_REF_NAME#v} (see README). Unsigned: Windows SmartScreen may ask you to confirm (More info → Run anyway)."`

Run: `python3 -c "import yaml,sys; d=yaml.safe_load(open('.github/workflows/cli.yml')); print(sorted(d['jobs']), d['jobs']['release']['needs'])"`
Expected: `['build', 'image', 'release'] ['build', 'image']`.

- [ ] **Step 2: README**

Add a `## Docker` section to `README.md`, right before `## How it works`:

````markdown
## Docker

A ready-to-use image is published with every release (x86-64; on Apple Silicon Macs use the native
binary instead, Docker would emulate it slowly). Fightcade's files are not in the image: mount your
own Fightcade folder (or its `emulator/fbneo` folder) read-only.

```bash
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
````

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/cli.yml README.md
git commit -m "ci: build, check and publish the Docker image; README Docker section"
```

- [ ] **Step 4: Verify in CI (outward action — ask the user first)**

Ask the user before pushing the branch. After approval: `git push -u origin <branch>`; watch the `cli` run for the branch (public API: `https://api.github.com/repos/Coccis77/fightcade-replay-converter/actions/runs?branch=<branch>&per_page=1`).
Expected: `build` (3 OS) and `image` succeed; `release` skipped. If `image` fails, read the job log (`…/actions/runs/<id>/jobs`), fix with a test-first change where code is involved, and push again (asking again).

---

## After the plan (not tasks)

- Final whole-branch review, then merge to `main`, version `0.5.0`, tag `v0.5.0` — each push/tag asked first.
- User makes the `fc2mp4` package public once (GitHub → profile → Packages → fc2mp4 → Package settings → Change visibility → Public).
- Real test in WSL (script provided then): install Docker Engine in Ubuntu, pull the image, short + 9-min replays, Ctrl-C, emulator killed inside the container, Fightcade folder unchanged.
