import { describe, expect, it } from 'vitest';
import { parseReplayRef, streamArg } from '../src/replayRef.js';
import { ConvertError, ExitCode } from '../src/errors.js';

const ID = '1700000000000-1234';

describe('parseReplayRef', () => {
  it.each([
    [ID],
    [`  ${ID}\n`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}/`],
    [`https://replay.fightcade.com/fbneo/sfiii3nr1/${ID}?t=42#x`],
    [`fcade://play/fbneo/sfiii3nr1/${ID}`],
  ])('accepts %j', (input) => {
    expect(parseReplayRef(input)).toEqual({ game: 'sfiii3nr1', quarkId: ID });
  });

  it('rejects another game with a usage error naming it', () => {
    let error: unknown;
    try {
      parseReplayRef(`https://replay.fightcade.com/fbneo/garou/${ID}`);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ConvertError);
    expect(error).toMatchObject({ exitCode: ExitCode.Usage, message: expect.stringContaining('garou') });
  });

  it.each([[''], ['hello'], ['https://replay.fightcade.com/'], ['1700000000000']])('rejects %j', (input) => {
    expect(() => parseReplayRef(input)).toThrow(/Not a Fightcade replay/);
  });
});

describe('streamArg', () => {
  it('builds the quark:stream argument with the client suffix and port', () => {
    expect(streamArg(ID)).toBe(`quark:stream,sfiii3nr1,${ID}.7,7100`);
  });
});
