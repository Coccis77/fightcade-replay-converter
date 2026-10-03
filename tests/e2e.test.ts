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
