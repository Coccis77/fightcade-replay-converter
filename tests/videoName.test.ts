import { describe, expect, it } from 'vitest';
import { cleanPlayerName, matchDate, videoFileName } from '../src/videoName.js';

describe('videoFileName', () => {
  it('names the game, both players, the match date and the quark ID', () => {
    expect(videoFileName({ game: 'garou', quarkId: '1791766846976-7757', players: { p1: 'PlayerA', p2: 'PlayerB' } })).toBe(
      'garou - PlayerA vs PlayerB - 2026-10-12 - 1791766846976-7757.mp4',
    );
  });

  it("keeps only the player's name from Fightcade's \"name#rank,…,country\"", () => {
    expect(videoFileName({ game: 'garou', quarkId: '1791766846976-7757', players: { p1: 'iorimg6680#3,0,MX', p2: 'WhiteGriffith#5,0,US' } })).toBe(
      'garou - iorimg6680 vs WhiteGriffith - 2026-10-12 - 1791766846976-7757.mp4',
    );
  });

  it('leaves the players out when they are unknown', () => {
    expect(videoFileName({ game: 'garou', quarkId: '1791766846976-7757', players: null })).toBe('garou - 2026-10-12 - 1791766846976-7757.mp4');
    expect(videoFileName({ game: 'sfa3', quarkId: '1791766846976-7757', players: { p1: '  ', p2: '' } })).toBe('sfa3 - 2026-10-12 - 1791766846976-7757.mp4');
  });

  it('keeps a name when only one player is known', () => {
    expect(videoFileName({ game: 'mk', quarkId: '1791766846976-7757', players: { p1: 'Solo', p2: '' } })).toBe('mk - Solo vs ? - 2026-10-12 - 1791766846976-7757.mp4');
  });
});

describe('matchDate', () => {
  it('reads the date (UTC) from the timestamp in the quark ID', () => {
    expect(matchDate('1791006077129-2245')).toBe('2026-10-03');
    expect(matchDate('1700000000000-1234')).toBe('2023-11-14');
  });
});

describe('cleanPlayerName', () => {
  it('replaces what Windows does not allow in file names', () => {
    expect(cleanPlayerName('a<b>c:d"e/f\\g|h?i*j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(cleanPlayerName('tab\tand\nnewline')).toBe('tab_and_newline');
  });
  it('trims spaces and dots at the ends, and caps the length at 32', () => {
    expect(cleanPlayerName('  Daigo.  ')).toBe('Daigo');
    expect(cleanPlayerName('x'.repeat(50))).toBe('x'.repeat(32));
  });
  it('keeps accents and other alphabets', () => {
    expect(cleanPlayerName('Éloïse ウメハラ')).toBe('Éloïse ウメハラ');
  });
});
