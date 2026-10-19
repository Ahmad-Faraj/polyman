/**
 * @fileoverview Decides how polyman talks to its surroundings: whether another
 * program (an agent, CI) runs it, and whether it may print ANSI colors.
 * chalk reads `FORCE_COLOR` and the TTY state but never `NO_COLOR`, so this
 * module applies that rule itself.
 */

import chalk from 'chalk';

/** Environment shape the helpers read; `process.env` fits it. */
type Env = Record<string, string | undefined>;

/**
 * Whether polyman runs under an agent runner (`POLYMAN_AGENT=1`).
 * In agent mode there are no spinners and no progress bars that redraw lines,
 * and colors are off. Any future progress output must check this first.
 *
 * @param env - Environment variables to read
 * @returns True when `POLYMAN_AGENT` is `1`
 *
 * @example
 * if (isAgentMode()) console.error('step 3 done');
 */
export function isAgentMode(env: Env = process.env): boolean {
  return env['POLYMAN_AGENT'] === '1';
}

/**
 * Whether ANSI colors must not be printed.
 * True for a non-empty `NO_COLOR` (see https://no-color.org), for agent mode,
 * and when stdout is not a terminal.
 *
 * @param env - Environment variables to read
 * @param stdoutIsTTY - Whether stdout is a terminal
 * @returns True when colors must be off
 *
 * @example
 * colorDisabled({ NO_COLOR: '1' }, true); // true
 */
export function colorDisabled(
  env: Env = process.env,
  stdoutIsTTY: boolean = process.stdout.isTTY === true
): boolean {
  const noColor = env['NO_COLOR'];
  if (noColor !== undefined && noColor !== '') return true;
  if (isAgentMode(env)) return true;
  return !stdoutIsTTY;
}

/**
 * Turns chalk off when colors are disabled. Call once at startup, before any
 * output, so every formatter and help function is covered.
 *
 * @param env - Environment variables to read
 * @param stdoutIsTTY - Whether stdout is a terminal
 *
 * @example
 * configureTerminal();
 */
export function configureTerminal(
  env: Env = process.env,
  stdoutIsTTY: boolean = process.stdout.isTTY === true
): void {
  if (colorDisabled(env, stdoutIsTTY)) {
    chalk.level = 0;
  }
}
