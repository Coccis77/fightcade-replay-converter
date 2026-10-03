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
