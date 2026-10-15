import { DEFAULT_GAME, GAMES, QUARK_SUFFIX, STREAM_PORT, type Game } from './constants.js';
import { ConvertError, ExitCode } from './errors.js';

export interface ReplayRef {
  game: Game;
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
      `Expected e.g. https://replay.fightcade.com/fbneo/${DEFAULT_GAME.id}/1700000000000-1234 or 1700000000000-1234`,
    );
  }
  const [, id, quarkId] = match;
  // hasOwn: "constructor" and friends are not games.
  const game = Object.hasOwn(GAMES, id!) ? GAMES[id!] : undefined;
  if (!game) {
    const supported = Object.values(GAMES).map((g) => `${g.id} (${g.shortTitle})`).join(', ');
    throw new ConvertError(ExitCode.Usage, `Unsupported game "${id}": supported games are ${supported}`);
  }
  return { game, quarkId: quarkId! };
}

export function streamArg(ref: ReplayRef): string {
  return `quark:stream,${ref.game.id},${ref.quarkId}${QUARK_SUFFIX},${STREAM_PORT}`;
}
