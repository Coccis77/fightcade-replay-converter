import { describe, expect, it } from 'vitest';
import { hostPath } from '../src/hostPath.js';

describe('hostPath', () => {
  it("shows a path under /videos as the user's own folder when run by fc2mp4-docker", () => {
    const env = { FC2MP4_HOST_VIDEOS: '/home/me/Videos/Fightcade' };
    expect(hostPath('/videos/garou - A vs B - 2026-10-12 - 1-2.mp4', env)).toBe('/home/me/Videos/Fightcade/garou - A vs B - 2026-10-12 - 1-2.mp4');
    expect(hostPath('/videos', env)).toBe('/home/me/Videos/Fightcade');
    expect(hostPath('/fightcade/emulator', env)).toBe('/fightcade/emulator');
  });
  it('changes nothing otherwise', () => {
    expect(hostPath('/videos/x.mp4', {})).toBe('/videos/x.mp4');
    expect(hostPath('/videos-other/x.mp4', { FC2MP4_HOST_VIDEOS: '/h' })).toBe('/videos-other/x.mp4');
  });
});
