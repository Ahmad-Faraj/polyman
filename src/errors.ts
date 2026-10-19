/**
 * @fileoverview Errors that carry the process exit code.
 *
 * Helpers throw a {@link PolymanError} instead of calling `process.exit`, and
 * `cli.ts` is the one place that prints it and exits with its code:
 *
 * | Code | Meaning                                                     |
 * | ---- | ----------------------------------------------------------- |
 * | `1`  | The command ran, but the problem is wrong                   |
 * | `2`  | Bad arguments, unknown name, invalid `Config.json`          |
 * | `3`  | Missing tool (`g++`, `java`, ...) or Polygon credentials    |
 * | `4`  | Polygon API or network failed                               |
 *
 * Any other error exits with `1`.
 */

/** Exit codes a {@link PolymanError} can carry. */
export type PolymanExitCode = 1 | 2 | 3 | 4;

/**
 * An error that knows which exit code the CLI should end with.
 *
 * @example
 * throw new PolymanError('No validator defined', 2, 'Add "validator" to Config.json');
 */
export class PolymanError extends Error {
  constructor(
    message: string,
    readonly exitCode: PolymanExitCode,
    readonly hint?: string
  ) {
    super(message);
    this.name = 'PolymanError';
  }
}

/**
 * Raised when a generator, validator or checker unexpectedly goes over the
 * time or memory limit. It stops the whole run (exit code 1), so per-test
 * loops must rethrow it instead of counting it as one failed test.
 */
export class LimitExceededError extends PolymanError {
  constructor(message: string) {
    super(message, 1);
    this.name = 'LimitExceededError';
  }
}

/**
 * Returns the exit code for an error: its own for a {@link PolymanError},
 * `1` for anything else.
 */
export function exitCodeFor(error: unknown): PolymanExitCode {
  return error instanceof PolymanError ? error.exitCode : 1;
}
