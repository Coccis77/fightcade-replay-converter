import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { pathExists } from '../src/fsUtil.js';

const exec = promisify(execFile);
const SCRIPT = join(import.meta.dirname, '..', 'scripts', 'fc2mp4-docker');
const LINK = 'https://replay.fightcade.com/fbneo/garou/1-2';

// A sandbox: fake `docker` (records its arguments, prints a container path like fc2mp4 does), fake `uname`.
async function sandbox(os = 'Linux') {
  const root = await mkdtemp(join(tmpdir(), 'fc2mp4-docker-'));
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  await mkdir(bin);
  await mkdir(home);
  await writeFile(join(bin, 'docker'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/docker-args"\necho "/videos/garou - A vs B - 2026-10-12 - 1-2.mp4"\nexit \${FAKE_DOCKER_EXIT:-0}\n`);
  await writeFile(join(bin, 'uname'), `#!/bin/sh\nif [ "$1" = -m ]; then echo "\${FAKE_ARCH:-x86_64}"; else echo ${os}; fi\n`);
  await chmod(join(bin, 'docker'), 0o755);
  await chmod(join(bin, 'uname'), 0o755);
  const fightcade = async (dir: string) => {
    await mkdir(join(dir, 'emulator', 'fbneo'), { recursive: true });
    await writeFile(join(dir, 'emulator', 'fbneo', 'ggponet.dll'), '');
    return dir;
  };
  const run = async (args: string[], env: Record<string, string> = {}) => {
    try {
      const r = await exec('bash', [SCRIPT, ...args], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env } });
      return { code: 0, stdout: r.stdout, stderr: r.stderr, docker: await dockerArgs() };
    } catch (err) {
      const e = err as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr, docker: await dockerArgs() };
    }
  };
  const dockerArgs = async () => ((await pathExists(join(root, 'docker-args'))) ? (await readFile(join(root, 'docker-args'), 'utf8')).trimEnd().split('\n') : null);
  return { root, home, run, fightcade };
}

describe.skipIf(process.platform === 'win32')('fc2mp4-docker', () => {
  it('runs the image like fc2mp4: finds Fightcade, mounts it read-only and the default videos folder', async () => {
    const { home, run, fightcade } = await sandbox();
    await fightcade(join(home, 'Fightcade'));
    const r = await run([LINK]);
    expect(r.code).toBe(0);
    expect(r.docker).toEqual(expect.arrayContaining(['run', '--rm', '-v', `${home}/Fightcade:/fightcade:ro`, '-v', `${home}/Videos/Fightcade:/videos`, LINK]));
    expect(r.docker!.at(-2)).toBe('ghcr.io/coccis77/fc2mp4:latest');
    expect(await pathExists(join(home, 'Videos', 'Fightcade'))).toBe(true);
    // fc2mp4 in the container prints the user's own folder instead of /videos.
    expect(r.docker).toEqual(expect.arrayContaining(['-e', `FC2MP4_HOST_VIDEOS=${home}/Videos/Fightcade`]));
  });

  it('translates -o with a file name, and with a folder', async () => {
    const { root, home, run, fightcade } = await sandbox();
    await fightcade(join(home, 'Fightcade'));
    const file = await run([LINK, '-o', join(root, 'clips', 'match.mp4')]);
    expect(file.docker).toEqual(expect.arrayContaining(['-v', `${root}/clips:/videos`, '-o', '/videos/match.mp4']));
    expect(await pathExists(join(root, 'clips'))).toBe(true);
    const folder = await run(['--output', join(root, 'out') + '/', LINK]);
    expect(folder.docker).toEqual(expect.arrayContaining(['-v', `${root}/out:/videos`, '-o', '/videos/']));
  });

  it('uses --fightcade-dir (or FC2MP4_FIGHTCADE_DIR) for the mount and does not pass it on', async () => {
    const { root, run, fightcade } = await sandbox();
    const fc = await fightcade(join(root, 'Games', 'Fight cade'));
    const r = await run([LINK, '--fightcade-dir', fc]);
    expect(r.docker).toEqual(expect.arrayContaining(['-v', `${fc}:/fightcade:ro`]));
    expect(r.docker).not.toContain('--fightcade-dir');
    const env = await run([LINK], { FC2MP4_FIGHTCADE_DIR: fc });
    expect(env.docker).toEqual(expect.arrayContaining(['-v', `${fc}:/fightcade:ro`]));
  });

  it("on macOS mounts the app's emulator folder", async () => {
    const { root, run } = await sandbox('Darwin');
    const app = join(root, 'FightCade2.app');
    await mkdir(join(app, 'Contents', 'MacOS', 'emulator', 'fbneo'), { recursive: true });
    await writeFile(join(app, 'Contents', 'MacOS', 'emulator', 'fbneo', 'ggponet.dll'), '');
    const r = await run([LINK, '--fightcade-dir', app]);
    expect(r.docker).toEqual(expect.arrayContaining(['-v', `${app}/Contents/MacOS:/fightcade:ro`]));
  });

  it("on macOS stops with a clear hint when Docker Desktop doesn't share the Fightcade folder", async () => {
    const { root, run } = await sandbox('Darwin');
    const app = join(root, 'FightCade2.app');
    await mkdir(join(app, 'Contents', 'MacOS', 'emulator', 'fbneo'), { recursive: true });
    await writeFile(join(app, 'Contents', 'MacOS', 'emulator', 'fbneo', 'ggponet.dll'), '');
    const r = await run([LINK, '--fightcade-dir', app], { FC2MP4_DOCKER_SHARED: '/Users:/Volumes' });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("Docker Desktop doesn't share");
    expect(r.stderr).toContain('Settings → Resources → File sharing');
    expect(r.stderr).toContain('fc2mp4-macos-arm64');
    expect(r.docker).toBeNull();
    expect((await run([LINK, '--fightcade-dir', app], { FC2MP4_DOCKER_SHARED: root })).code).toBe(0);
  });

  it('asks Docker for the x86-64 image (no platform warning on Apple Silicon)', async () => {
    const { home, run, fightcade } = await sandbox();
    await fightcade(join(home, 'Fightcade'));
    expect((await run([LINK])).docker).toEqual(expect.arrayContaining(['--platform', 'linux/amd64']));
  });

  it('gives an emulated image (ARM machine) more time to start the replay', async () => {
    const { home, run, fightcade } = await sandbox();
    await fightcade(join(home, 'Fightcade'));
    expect((await run([LINK], { FAKE_ARCH: 'aarch64' })).docker).toEqual(expect.arrayContaining(['-e', 'FC2MP4_START_TIMEOUT_S=90']));
    expect((await run([LINK], { FAKE_ARCH: 'x86_64' })).docker).not.toContain('FC2MP4_START_TIMEOUT_S=90');
  });

  it('explains when Fightcade is not found, without running Docker', async () => {
    const { run } = await sandbox();
    const r = await run([LINK]);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Fightcade not found');
    expect(r.stderr).toContain('--fightcade-dir');
    expect(r.docker).toBeNull();
  });

  it("returns fc2mp4's exit code", async () => {
    const { home, run, fightcade } = await sandbox();
    await fightcade(join(home, 'Fightcade'));
    expect((await run([LINK], { FAKE_DOCKER_EXIT: '6' })).code).toBe(6);
  });

  it('uses the image of its own release, or FC2MP4_IMAGE', async () => {
    const { home, run, fightcade } = await sandbox();
    await fightcade(join(home, 'Fightcade'));
    expect((await run([LINK], { FC2MP4_IMAGE: 'my/fc2mp4:dev' })).docker!.at(-2)).toBe('my/fc2mp4:dev');
  });
});
