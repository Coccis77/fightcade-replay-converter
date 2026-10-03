import { GAME, QUARK_SUFFIX, STREAM_PORT } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';

export interface ReplayRef {
  game: typeof GAME;
  quarkId: string;
}

const BARE_ID = /^\d+-\d+$/;
const IN_LINK = /\/([A-Za-z0-9_]+)\/(\d+-\d+)(?=[/?#]|$)/;

export function parseReplayRef(input: string): ReplayRef {
  const value = input.trim();
  if (BARE_ID.test(value)) return { game: GAME, quarkId: value };

  const match = IN_LINK.exec(value);
  if (!match) {
    throw new ConvertError(
      ExitCode.Usage,
      `Not a Fightcade replay link or quark ID: "${value}"`,
      `Expected e.g. https://replay.fightcade.com/fbneo/${GAME}/1700000000000-1234 or 1700000000000-1234`,
    );
  }
  const [, game, quarkId] = match;
  if (game !== GAME) {
    throw new ConvertError(ExitCode.Usage, `Unsupported game "${game}": only ${GAME} (3rd Strike) is supported`);
  }
  return { game: GAME, quarkId: quarkId! };
}

export function streamArg(quarkId: string): string {
  return `quark:stream,${GAME},${quarkId}${QUARK_SUFFIX},${STREAM_PORT}`;
}
