/**
 * @fileoverview Detects whether the terminal has a light or a dark background.
 * It reads the COLORFGBG variable first, then asks the terminal for its
 * background color with an OSC 11 query. Used to pick the color theme when
 * POLYMAN_THEME is not set.
 */

import chalk from 'chalk';
import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';

/**
 * Background brightness of the terminal.
 * @typedef Background
 */
export type Background = 'light' | 'dark';

/**
 * Red, green and blue channels, each between 0 and 1.
 * @typedef Rgb
 */
export type Rgb = [number, number, number];

/** Asks the terminal for its background color (OSC 11). */
export const OSC11_QUERY = '\u001b]11;?\u001b\\';

/** Primary Device Attributes query (DA1). Every terminal answers it. */
export const DA1_QUERY = '\u001b[c';

/** How long to wait for the terminal to answer, in milliseconds. */
export const QUERY_TIMEOUT_MS = 100;

/* eslint-disable no-control-regex -- terminal replies start with ESC */
// `rgb:RRRR/GGGG/BBBB` (or `rgba:` with a fourth channel) ended by BEL or ST.
const OSC11_REPLY =
  /\x1b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?(?:\x07|\x1b\\)/i;
const DA1_REPLY = /\x1b\[\?[0-9;]*c/;
/* eslint-enable no-control-regex */

/**
 * Stdin as used by the query. `process.stdin` matches it on a TTY.
 * @interface TerminalInput
 */
export interface TerminalInput {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  removeListener(
    event: 'data',
    listener: (chunk: Buffer | string) => void
  ): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * Stdout as used by the query. `process.stdout` matches it.
 * @interface TerminalOutput
 */
export interface TerminalOutput {
  isTTY?: boolean;
  write(data: string): unknown;
}

/**
 * Options for {@link detectBackground}. Every field has a default that reads
 * the real process; tests pass their own.
 * @interface DetectOptions
 */
export interface DetectOptions {
  platform?: NodeJS.Platform;
  colorLevel?: number;
  stdin?: TerminalInput;
  stdout?: TerminalOutput;
  isForeground?: () => boolean;
  timeoutMs?: number;
}

/**
 * Reads the background from COLORFGBG (for example `0;15`). The last field
 * is the background color index; 7 and 15 are white, other numbers are dark.
 * @param {string | undefined} value - Value of COLORFGBG
 * @returns {Background | null} The background, or null if it is not a number
 */
export function parseColorFgBg(value: string | undefined): Background | null {
  const last = value?.split(';').pop()?.trim() ?? '';
  if (!/^\d+$/.test(last)) return null;
  const index = Number(last);
  return index === 7 || index === 15 ? 'light' : 'dark';
}

/**
 * Finds an OSC 11 reply in the data read from the terminal.
 * @param {string} data - Bytes read from the terminal
 * @returns {Rgb | null} The background color, or null if there is no reply
 */
export function parseOsc11Reply(data: string): Rgb | null {
  const match = OSC11_REPLY.exec(data);
  if (!match) return null;
  const channel = (hex: string): number =>
    parseInt(hex, 16) / (16 ** hex.length - 1);
  return [channel(match[1]), channel(match[2]), channel(match[3])];
}

/**
 * Relative luminance of a color, as defined by WCAG (0 is black, 1 is white).
 * @param {Rgb} rgb - The color
 * @returns {number} The luminance
 */
export function relativeLuminance([r, g, b]: Rgb): number {
  const linear = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/**
 * Decides if a background color is light.
 * @param {Rgb} rgb - The background color
 * @returns {Background} 'light' when the luminance is above 0.5
 */
export function backgroundFromRgb(rgb: Rgb): Background {
  return relativeLuminance(rgb) > 0.5 ? 'light' : 'dark';
}

/**
 * Reads the process group and the terminal foreground group from the text of
 * `/proc/self/stat` or from `ps -o pgid= -o tpgid=`.
 * @param {string} text - The stat line or the ps output
 * @returns {boolean | null} True when the process is in the foreground
 */
export function parseForeground(text: string): boolean | null {
  // In /proc/self/stat the fields after the command name are:
  // state ppid pgrp session tty_nr tpgid
  const stat = /\)\s+\S+\s+\d+\s+(\d+)\s+\d+\s+\d+\s+(-?\d+)/.exec(text);
  const fields = stat ?? /^\s*(\d+)\s+(-?\d+)\s*$/.exec(text);
  if (!fields) return null;
  return fields[1] === fields[2];
}

/**
 * Checks that polyman runs as the foreground job of its terminal. A
 * background job that changes the terminal mode or reads stdin is stopped by
 * the shell, so the OSC 11 query is only sent from the foreground.
 * @returns {boolean} True when the process is in the foreground
 */
export function isForegroundJob(): boolean {
  try {
    const text =
      process.platform === 'linux'
        ? readFileSync('/proc/self/stat', 'utf8')
        : spawnSync(
            'ps',
            ['-o', 'pgid=', '-o', 'tpgid=', '-p', String(process.pid)],
            { encoding: 'utf8', timeout: 500 }
          ).stdout;
    return parseForeground(text) === true;
  } catch {
    return false;
  }
}

/**
 * Sends the OSC 11 and DA1 queries and reads the answers in raw mode.
 * Terminals answer in order, so the DA1 reply comes last: once it arrives no
 * more bytes are coming. A terminal without OSC 11 support only sends the DA1
 * reply. Stdin is always restored before the promise resolves.
 * @param {TerminalInput} input - Terminal stdin
 * @param {TerminalOutput} output - Terminal stdout
 * @param {number} [timeoutMs=QUERY_TIMEOUT_MS] - Longest time to wait
 * @returns {Promise<Background | null>} The background, or null if unknown
 */
export function queryBackground(
  input: TerminalInput,
  output: TerminalOutput,
  timeoutMs: number = QUERY_TIMEOUT_MS
): Promise<Background | null> {
  return new Promise(resolve => {
    const wasRaw = input.isRaw === true;
    let reply = '';
    let rgb: Rgb | null = null;
    let done = false;

    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.removeListener('data', onData);
      try {
        input.setRawMode?.(wasRaw);
      } catch {
        // the terminal is gone; nothing left to restore
      }
      input.pause();
      resolve(rgb ? backgroundFromRgb(rgb) : null);
    };

    const onData = (chunk: Buffer | string): void => {
      reply += typeof chunk === 'string' ? chunk : chunk.toString('latin1');
      rgb ??= parseOsc11Reply(reply);
      if (DA1_REPLY.test(reply)) finish();
    };

    const timer = setTimeout(finish, timeoutMs);
    try {
      input.setRawMode?.(true);
      input.on('data', onData);
      input.resume();
      output.write(OSC11_QUERY + DA1_QUERY);
    } catch {
      finish();
    }
  });
}

/**
 * Detects the terminal background. Returns null (so the caller uses the dark
 * theme) on Windows, when colors are off, when stdin or stdout is not a TTY,
 * when TERM=dumb, or when the terminal does not answer.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment to read
 * @param {DetectOptions} [options={}] - Overrides for the real process
 * @returns {Promise<Background | null>} The background, or null if unknown
 */
export async function detectBackground(
  env: NodeJS.ProcessEnv = process.env,
  options: DetectOptions = {}
): Promise<Background | null> {
  const {
    platform = process.platform,
    colorLevel = chalk.level,
    stdin = process.stdin,
    stdout = process.stdout,
    isForeground = isForegroundJob,
    timeoutMs = QUERY_TIMEOUT_MS,
  } = options;

  if (
    platform === 'win32' ||
    colorLevel === 0 ||
    env['TERM'] === 'dumb' ||
    stdin.isTTY !== true ||
    stdout.isTTY !== true ||
    typeof stdin.setRawMode !== 'function'
  ) {
    return null;
  }

  const fromEnv = parseColorFgBg(env['COLORFGBG']);
  if (fromEnv) return fromEnv;

  if (!isForeground()) return null;
  return queryBackground(stdin, stdout, timeoutMs);
}
