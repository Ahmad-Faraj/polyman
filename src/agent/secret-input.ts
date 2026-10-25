/**
 * Reads a secret without it showing on screen or ending up in shell
 * history: a hidden prompt on a terminal, or the whole of stdin for
 * `--key-stdin`. Keys are never read from argv.
 */

import { PolymanError } from '../errors';

/** The parts of a TTY input stream the hidden prompt needs. */
export type SecretInput = Pick<
  NodeJS.ReadStream,
  | 'isTTY'
  | 'isRaw'
  | 'setRawMode'
  | 'on'
  | 'removeListener'
  | 'resume'
  | 'pause'
>;

/**
 * Where the hidden prompt is inside an escape sequence. The state is kept
 * between `data` events, so a sequence split across two chunks is still
 * removed whole.
 *
 * - `text`: normal input.
 * - `esc`: after ESC.
 * - `csi`: after ESC [ (arrow keys, Delete, the paste markers ESC[200~ and
 *   ESC[201~), until the final byte.
 * - `ss3`: after ESC O (arrow keys in application cursor mode, F1 to F4),
 *   until the final byte.
 */
type EscapeState = 'text' | 'esc' | 'csi' | 'ss3';

const ESC = '\u001b';

/** Parameter and intermediate bytes of a CSI or SS3 sequence (0x20-0x3F). */
const isSequenceMiddle = (ch: string) => ch >= ' ' && ch <= '?';

/**
 * Asks for a secret on the terminal with echo off. Enter ends the input,
 * Backspace removes the last character, Ctrl+C cancels. Escape sequences
 * are removed from the input, also when a chunk ends in the middle of one:
 * CSI (arrow keys, Delete, paste markers, keeping the pasted text), SS3
 * (ESC O and a key), and ESC with the one character after it (Alt+key).
 * A control character inside a sequence ends it and is handled as usual,
 * so Enter and Ctrl+C always work.
 */
export function readHiddenLine(
  question: string,
  input: SecretInput = process.stdin,
  output: NodeJS.WritableStream = process.stderr
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY || typeof input.setRawMode !== 'function') {
      reject(
        new PolymanError(
          'There is no terminal to type the key in.',
          2,
          'Pipe the key in with --key-stdin, for example: ' +
            'polyman ai login openai --key-stdin < key.txt'
        )
      );
      return;
    }
    const wasRaw = input.isRaw === true;
    let value = '';

    const finish = (error?: Error) => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    let state: EscapeState = 'text';

    /** Returns true when `ch` is part of an escape sequence and is dropped. */
    const inSequence = (ch: string): boolean => {
      if (state === 'text') {
        if (ch !== ESC) return false;
        state = 'esc';
        return true;
      }
      if (ch === ESC) {
        state = 'esc';
        return true;
      }
      if (ch < ' ' || ch === '\u007f') {
        // A control character never belongs to a sequence: drop what came
        // before it and handle it as a key.
        state = 'text';
        return false;
      }
      if (state === 'esc') {
        state = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : 'text';
        return true;
      }
      if (isSequenceMiddle(ch)) return true;
      // The final byte (0x40-0x7E) ends the sequence. Any other byte is not
      // valid there, so it ends the sequence too, and is dropped with it.
      state = 'text';
      return true;
    };

    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString()) {
        if (inSequence(ch)) continue;
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          finish();
          return;
        }
        if (ch === '\u0003') {
          finish(new PolymanError('Cancelled.', 1));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
      }
    };

    output.write(question);
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
  });
}

/**
 * Reads all of stdin, for `--key-stdin`. It refuses a terminal, since the
 * key would show on screen while typed; the hidden prompt is for that.
 */
export function readAllStdin(
  input: Pick<NodeJS.ReadStream, 'isTTY' | 'on'> = process.stdin
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (input.isTTY) {
      reject(
        new PolymanError(
          '--key-stdin reads the key from a pipe, not from the terminal.',
          2,
          'Leave out --key-stdin to type the key in a hidden prompt.'
        )
      );
      return;
    }
    const chunks: Buffer[] = [];
    input.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    input.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    input.on('error', reject);
  });
}
