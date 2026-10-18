export interface FrameFormat {
  readonly width: number;
  readonly height: number;
  readonly bpp: number;
  readonly fpsX100: number;
  readonly sampleRate: number;
}

// A bare quark ID (no link) is a 3rd Strike replay.
export const DEFAULT_GAME = 'sfiii3nr1';

// Fightcade's client appends ".7" to the quark ID from the link; without it the stream never loads.
export const QUARK_SUFFIX = '.7';
export const STREAM_PORT = 7100;

export const EMULATOR_EXE = 'fcadefbneo-fc2mp4.exe';

export const TIMEOUTS = {
  // A replay that doesn't exist gets no answer at all from Fightcade's server (no event, 2026-10-18);
  // real replays start within about 4 s, so 20 s leaves a wide margin.
  firstFrameMs: 20_000,
  // The stream never signals its end; the emulator exits after this long without input. Fightcade's
  // server sends the inputs ahead: the longest pause measured between frames over 5 replays (≈59000
  // frames, 2026-10-17) was 41 ms, so 3 s keeps a wide margin while saving 12 s per conversion.
  emulatorIdleMs: 3_000,
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
