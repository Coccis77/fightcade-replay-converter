import { DEFAULT_GAME, QUARK_SUFFIX, STREAM_PORT } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';

// game: the FBNeo name from the link (checked against Fightcade's list before converting).
export interface ReplayRef {
  game: string;
  quarkId: string;
}

const BARE_ID = /^\d+-\d+$/;
const IN_LINK = /\/([A-Za-z0-9_]+)\/(\d+-\d+)(?=[/?#]|$)/;

export function parseReplayRef(input: string): ReplayRef {
  const value = input.trim();
  if (BARE_ID.test(value)) return { game: DEFAULT_GAME, quarkId: value };

  const match = IN_LINK.exec(value);
  if (!match) {
    throw new ConvertError(
      ExitCode.Usage,
      `Not a Fightcade replay link or quark ID: "${value}"`,
      `Expected e.g. https://replay.fightcade.com/fbneo/${DEFAULT_GAME}/1700000000000-1234 or 1700000000000-1234`,
    );
  }
  return { game: match[1]!, quarkId: match[2]! };
}

export function streamArg(ref: ReplayRef): string {
  return `quark:stream,${ref.game},${ref.quarkId}${QUARK_SUFFIX},${STREAM_PORT}`;
}
