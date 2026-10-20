export class SealedLoopError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SealedLoopError';
    this.code = code;
  }
}
