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
