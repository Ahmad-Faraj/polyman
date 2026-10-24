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
 * Asks for a secret on the terminal with echo off. Enter ends the input,
 * Backspace removes the last character, Ctrl+C cancels. Escape sequences
 * (arrow keys) are ignored.
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

    const onData = (chunk: Buffer | string) => {
      const text = chunk.toString();
      if (text.startsWith('\u001b')) return;
      for (const ch of text) {
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
