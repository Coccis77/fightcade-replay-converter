export const GAME = 'sfiii3nr1';

// Fightcade's client appends ".7" to the quark ID from the link; without it the stream never loads.
export const QUARK_SUFFIX = '.7';
export const STREAM_PORT = 7100;

export const EMULATOR_EXE = 'fcadefbneo-fc2mp4.exe';

// Raw format written by the patched emulator for sfiii3nr1; checked against its info file.
export const FRAME_FORMAT = { width: 384, height: 224, bpp: 4, fpsX100: 5959, sampleRate: 44100 } as const;

export const TIMEOUTS = {
  firstFrameMs: 60_000,
  emulatorIdleMs: 5_000,
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
