import { describe, expect, it } from 'vitest';
import { parseReplayRef, streamArg } from '../src/replayRef.js';
import { DEFAULT_GAME, GAMES } from '../src/constants.js';
import { ConvertError, ExitCode } from '../src/errors.js';

const ID = '1700000000000-1234';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('parseReplayRef', () => {
  it.each([
    [ID],
    [`  ${ID}\n`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}/`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}?t=42#x`],
    [`fcade://play/fbneo/sfiii3nr1/${ID}`],
  ])('reads %j as 3rd Strike', (input) => {
    expect(parseReplayRef(input)).toEqual({ game: GAMES.sfiii3nr1, quarkId: ID });
  });

  it.each([[`https://replay.fightcade.com/fbneo/garou/${ID}`], [`fcade://play/fbneo/garou/${ID}`]])('reads %j as Garou', (input) => {
    expect(parseReplayRef(input)).toEqual({ game: GAMES.garou, quarkId: ID });
  });

  it('reads an Alpha 3 link', () => {
    expect(parseReplayRef(`https://replay.fightcade.com/fbneo/sfa3/${ID}`)).toEqual({ game: GAMES.sfa3, quarkId: ID });
  });

  it('reads a Super SF2X link', () => {
    expect(parseReplayRef(`https://replay.fightcade.com/fbneo/ssf2xjr1/${ID}`)).toEqual({ game: GAMES.ssf2xjr1, quarkId: ID });
  });

  it('treats a bare quark ID as 3rd Strike', () => {
    expect(DEFAULT_GAME).toBe(GAMES.sfiii3nr1);
    expect(parseReplayRef(ID).game.id).toBe('sfiii3nr1');
  });

  it.each([['kof98'], ['constructor'], ['toString'], ['__proto__']])('rejects game %j with a usage error listing the supported games', (game) => {
    const error = thrown(() => parseReplayRef(`https://replay.fightcade.com/fbneo/${game}/${ID}`));
    expect(error).toBeInstanceOf(ConvertError);
    expect(error).toMatchObject({
      exitCode: ExitCode.Usage,
      message: `Unsupported game "${game}": supported games are sfiii3nr1 (3rd Strike), garou (Garou), ssf2xjr1 (Super SF2X), sfa3 (Alpha 3)`,
    });
  });

  it.each([[''], ['hello'], ['https://replay.fightcade.com/'], ['1700000000000']])('rejects %j', (input) => {
    expect(() => parseReplayRef(input)).toThrow(/Not a Fightcade replay/);
  });
});

describe('streamArg', () => {
  it('builds the quark:stream argument for the replay game, with the client suffix and port', () => {
    expect(streamArg({ game: GAMES.sfiii3nr1, quarkId: ID })).toBe(`quark:stream,sfiii3nr1,${ID}.7,7100`);
    expect(streamArg({ game: GAMES.garou, quarkId: ID })).toBe(`quark:stream,garou,${ID}.7,7100`);
  });
});

describe('GAMES', () => {
  it('holds the measured formats and required ROMs', () => {
    expect(GAMES.sfiii3nr1).toMatchObject({ roms: ['sfiii3nr1.zip', 'sfiii3.zip'], format: { width: 384, height: 224, bpp: 4, fpsX100: 5959, sampleRate: 44100 } });
    expect(GAMES.garou).toMatchObject({ roms: ['garou.zip', 'neogeo.zip'], format: { width: 320, height: 224, bpp: 4, fpsX100: 5918, sampleRate: 44100 } });
    expect(GAMES.sfa3).toMatchObject({
      title: 'Street Fighter Alpha 3',
      roms: ['sfa3.zip'],
      format: { width: 384, height: 224, bpp: 4, fpsX100: 5963, sampleRate: 44100 },
    });
    expect(GAMES.ssf2xjr1).toMatchObject({
      title: 'Super Street Fighter II X: Grand Master Challenge',
      roms: ['ssf2xjr1.zip', 'ssf2t.zip'],
      format: { width: 384, height: 224, bpp: 4, fpsX100: 5963, sampleRate: 44100 },
    });
  });
});
