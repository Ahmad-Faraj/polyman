/**
 * @fileoverview Error types shared by steps and actions.
 */

import { PolymanError } from '../errors';

/** Exit code for a command that needs input it cannot ask for. */
export const EXIT_NON_INTERACTIVE = 2;

/**
 * Raised when a command would have to prompt but stdin is not a terminal.
 * The message names the flag to pass. It is a usage error, so the CLI exits
 * with {@link EXIT_NON_INTERACTIVE}.
 *
 * @example
 * throw new NonInteractiveError('stdin is not a terminal; pass --yes');
 */
export class NonInteractiveError extends PolymanError {
  constructor(message: string) {
    super(message, EXIT_NON_INTERACTIVE);
    this.name = 'NonInteractiveError';
  }
}
