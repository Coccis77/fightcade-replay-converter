// Video file names: "<game> - <P1> vs <P2> - <date> - <quark ID>.mp4". The quark ID keeps every video of
// the same two players apart (people often play the same opponent several times in a row).
export interface Players {
  p1: string;
  p2: string;
}

// Windows refuses < > : " / \ | ? * and control characters in file names, and trailing dots or spaces.
export function cleanPlayerName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/, '');
  return [...cleaned].slice(0, 32).join('').trim();
}

// The first part of a quark ID is the match's timestamp in milliseconds.
export function matchDate(quarkId: string): string {
  return new Date(Number(quarkId.split('-')[0])).toISOString().slice(0, 10);
}

export function videoFileName({ game, quarkId, players }: { game: string; quarkId: string; players: Players | null | undefined }): string {
  // Fightcade sends "name#rank,…,country" (e.g. "iorimg6680#3,0,MX"): only the name goes in the file name.
  const p1 = cleanPlayerName((players?.p1 ?? '').split('#')[0]!);
  const p2 = cleanPlayerName((players?.p2 ?? '').split('#')[0]!);
  const versus = p1 || p2 ? ` - ${p1 || '?'} vs ${p2 || '?'}` : '';
  return `${game}${versus} - ${matchDate(quarkId)} - ${quarkId}.mp4`;
}

// p1= and p2= in the emulator's info file; null when it does not report them (older emulator build).
export function playersFromInfo(text: string): Players | null {
  const value = (key: string) => text.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1]?.replace(/\r$/, '');
  const p1 = value('p1');
  const p2 = value('p2');
  return p1 === undefined && p2 === undefined ? null : { p1: p1 ?? '', p2: p2 ?? '' };
}
