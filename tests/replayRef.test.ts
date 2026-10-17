import { describe, expect, it } from 'vitest';
import { parseReplayRef, streamArg } from '../src/replayRef.js';
import { DEFAULT_GAME } from '../src/constants.js';

const ID = '1700000000000-1234';

describe('parseReplayRef', () => {
  it.each([
    [ID],
    [`  ${ID}\n`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}/`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}?t=42#x`],
    [`fcade://play/fbneo/sfiii3nr1/${ID}`],
  ])('reads %j as 3rd Strike', (input) => {
    expect(parseReplayRef(input)).toEqual({ game: 'sfiii3nr1', quarkId: ID });
  });

  it.each([[`https://replay.fightcade.com/fbneo/garou/${ID}`], [`fcade://play/fbneo/garou/${ID}`]])('reads %j as Garou', (input) => {
    expect(parseReplayRef(input)).toEqual({ game: 'garou', quarkId: ID });
  });

  it.each([['ssf2xjr1'], ['sfa3'], ['vsavj'], ['mk']])('takes any game name from a link: %s', (game) => {
    expect(parseReplayRef(`https://replay.fightcade.com/fbneo/${game}/${ID}`)).toEqual({ game, quarkId: ID });
  });

  it('treats a bare quark ID as 3rd Strike', () => {
    expect(DEFAULT_GAME).toBe('sfiii3nr1');
    expect(parseReplayRef(ID).game).toBe('sfiii3nr1');
  });

  it.each([[''], ['hello'], ['https://replay.fightcade.com/'], ['1700000000000']])('rejects %j', (input) => {
    expect(() => parseReplayRef(input)).toThrow(/Not a Fightcade replay/);
  });
});

describe('streamArg', () => {
  it('builds the quark:stream argument for the replay game, with the client suffix and port', () => {
    expect(streamArg({ game: 'sfiii3nr1', quarkId: ID })).toBe(`quark:stream,sfiii3nr1,${ID}.7,7100`);
    expect(streamArg({ game: 'garou', quarkId: ID })).toBe(`quark:stream,garou,${ID}.7,7100`);
  });
});
