export const ExitCode = {
  Usage: 2,
  Preflight: 3,
  Busy: 4,
  Emulator: 5,
  Recording: 6,
  Encode: 7,
  Interrupted: 130,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export class ConvertError extends Error {
  constructor(
    readonly exitCode: ExitCodeValue,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ConvertError';
  }
}
