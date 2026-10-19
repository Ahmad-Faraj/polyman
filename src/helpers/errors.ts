/**
 * @fileoverview Error types shared by steps and actions.
 */

/** Exit code for a command that needs input it cannot ask for. */
export const EXIT_NON_INTERACTIVE = 2;

/**
 * Raised when a command would have to prompt but stdin is not a terminal.
 * The message names the flag to pass. Actions exit with
 * {@link EXIT_NON_INTERACTIVE} for it.
 *
 * @example
 * throw new NonInteractiveError('stdin is not a terminal; pass --yes');
 */
export class NonInteractiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonInteractiveError';
  }
}
