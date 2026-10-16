export interface FrameFormat {
  readonly width: number;
  readonly height: number;
  readonly bpp: number;
  readonly fpsX100: number;
  readonly sampleRate: number;
}

export interface Game {
  readonly id: string; // ROM name, as in replay links and quark:stream
  readonly title: string;
  readonly shortTitle: string;
  readonly roms: readonly string[]; // files the emulator needs in Fightcade's ROMs folder
  readonly format: FrameFormat; // what the patched emulator reports in its info file
}

// Formats other than 3rd Strike's were measured on real replays (Garou 2026-10-15, Super SF2X and Alpha 3 2026-10-16).
export const GAMES: Readonly<Record<string, Game>> = {
  sfiii3nr1: {
    id: 'sfiii3nr1',
    title: 'Street Fighter III: 3rd Strike',
    shortTitle: '3rd Strike',
    roms: ['sfiii3nr1.zip', 'sfiii3.zip'],
    format: { width: 384, height: 224, bpp: 4, fpsX100: 5959, sampleRate: 44100 },
  },
  garou: {
    id: 'garou',
    title: 'Garou: Mark of the Wolves',
    shortTitle: 'Garou',
    roms: ['garou.zip', 'neogeo.zip'],
    format: { width: 320, height: 224, bpp: 4, fpsX100: 5918, sampleRate: 44100 },
  },
  ssf2xjr1: {
    id: 'ssf2xjr1',
    title: 'Super Street Fighter II X: Grand Master Challenge',
    shortTitle: 'Super SF2X',
    roms: ['ssf2xjr1.zip', 'ssf2t.zip'], // ssf2t is its parent in FBNeo (d_cps2.cpp)
    format: { width: 384, height: 224, bpp: 4, fpsX100: 5963, sampleRate: 44100 },
  },
  sfa3: {
    id: 'sfa3',
    title: 'Street Fighter Alpha 3',
    shortTitle: 'Alpha 3',
    roms: ['sfa3.zip'], // no parent or BIOS in FBNeo (d_cps2.cpp)
    format: { width: 384, height: 224, bpp: 4, fpsX100: 5963, sampleRate: 44100 },
  },
};

// A bare quark ID (no link) is a 3rd Strike replay, as before Garou was supported.
export const DEFAULT_GAME: Game = GAMES.sfiii3nr1;

// Fightcade's client appends ".7" to the quark ID from the link; without it the stream never loads.
export const QUARK_SUFFIX = '.7';
export const STREAM_PORT = 7100;

export const EMULATOR_EXE = 'fcadefbneo-fc2mp4.exe';

export const TIMEOUTS = {
  firstFrameMs: 60_000,
  // The stream never signals its end; the emulator exits after this long without input.
  // Long enough to ride out network hiccups, which would otherwise look like the end.
  emulatorIdleMs: 15_000,
  // Node-side watchdog: no new frame for this long once started means the emulator is stuck.
  stallMs: 45_000,
  killMs: 15_000,
  pollMs: 500,
} as const;

export const DEFAULT_MAX_DURATION_MS = 60 * 60_000;

// DirectDraw renderer (DX9 Alt crashes our build under Wine), no aspect maths, never auto-pause.
export const RUNTIME_INI: ReadonlyArray<readonly [string, string]> = [
  ['nVidSelect', '0'],
  ['bVidFullStretch', '1'],
  ['bAutoPause', '0'],
];
