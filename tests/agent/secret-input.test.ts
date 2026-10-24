import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  readAllStdin,
  readHiddenLine,
  type SecretInput,
} from '../../src/agent/secret-input';

/** A fake terminal: records raw mode, and lets the test type. */
class FakeTty extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawCalls: boolean[] = [];
  paused = false;

  setRawMode(mode: boolean) {
    this.isRaw = mode;
    this.rawCalls.push(mode);
    return this;
  }
  resume() {
    this.paused = false;
    return this;
  }
  pause() {
    this.paused = true;
    return this;
  }
  type(text: string) {
    this.emit('data', Buffer.from(text));
  }
}

const sink = () => {
  const out = new PassThrough();
  let written = '';
  out.on('data', (chunk: Buffer) => (written += chunk.toString()));
  return { out, written: () => written };
};

const asInput = (tty: FakeTty) => tty as unknown as SecretInput;

describe('readHiddenLine', () => {
  it('ignores an arrow key in the middle of a chunk', async () => {
    const tty = new FakeTty();
    const result = readHiddenLine('Key: ', asInput(tty), sink().out);
    tty.type('sk-abc\u001b[Adef12345\r');
    await expect(result).resolves.toBe('sk-abcdef12345');
  });

  it('ignores Delete (ESC [ 3 ~) in the middle of a chunk', async () => {
    const tty = new FakeTty();
    const result = readHiddenLine('Key: ', asInput(tty), sink().out);
    tty.type('sk-abc\u001b[3~def12345\r');
    await expect(result).resolves.toBe('sk-abcdef12345');
  });

  it('takes a bracketed paste with Enter in the same chunk', async () => {
    const tty = new FakeTty();
    const result = readHiddenLine('Key: ', asInput(tty), sink().out);
    tty.type('\u001b[200~sk-pasted-12345\u001b[201~\r');
    await expect(result).resolves.toBe('sk-pasted-12345');
  });

  it('takes a bracketed paste with Enter in a separate chunk', async () => {
    const tty = new FakeTty();
    const result = readHiddenLine('Key: ', asInput(tty), sink().out);
    tty.type('\u001b[200~sk-pasted-12345\u001b[201~');
    tty.type('\r');
    await expect(result).resolves.toBe('sk-pasted-12345');
  });

  it('returns what was typed and never echoes it', async () => {
    const tty = new FakeTty();
    const { out, written } = sink();
    const result = readHiddenLine('Key: ', asInput(tty), out);
    tty.type('sk-secret');
    tty.type('-123\r');
    await expect(result).resolves.toBe('sk-secret-123');
    await new Promise(resolve => setImmediate(resolve));
    expect(written()).toBe('Key: \n');
  });

  it('turns raw mode on, then back off, and stops listening', async () => {
    const tty = new FakeTty();
    const result = readHiddenLine('Key: ', asInput(tty), sink().out);
    tty.type('abc\n');
    await result;
    expect(tty.rawCalls).toEqual([true, false]);
    expect(tty.listenerCount('data')).toBe(0);
    expect(tty.paused).toBe(true);
  });

  it('handles backspace', async () => {
    const tty = new FakeTty();
    const result = readHiddenLine('Key: ', asInput(tty), sink().out);
    tty.type('abX\u007fc\bd\r');
    await expect(result).resolves.toBe('abd');
  });

  it('ignores escape sequences and other control characters', async () => {
    const tty = new FakeTty();
    const result = readHiddenLine('Key: ', asInput(tty), sink().out);
    tty.type('ab');
    tty.type('\u001b[A');
    tty.type('c\u0001d\r');
    await expect(result).resolves.toBe('abcd');
  });

  it('cancels on Ctrl+C', async () => {
    const tty = new FakeTty();
    const result = readHiddenLine('Key: ', asInput(tty), sink().out);
    tty.type('ab\u0003');
    await expect(result).rejects.toThrow('Cancelled.');
    expect(tty.isRaw).toBe(false);
  });

  it('ends on Ctrl+D', async () => {
    const tty = new FakeTty();
    const result = readHiddenLine('Key: ', asInput(tty), sink().out);
    tty.type('abc\u0004');
    await expect(result).resolves.toBe('abc');
  });

  it('refuses when stdin is not a terminal', async () => {
    const tty = new FakeTty();
    tty.isTTY = false;
    await expect(
      readHiddenLine('Key: ', asInput(tty), sink().out)
    ).rejects.toMatchObject({ exitCode: 2, hint: /--key-stdin/ });
  });
});

describe('readAllStdin', () => {
  it('reads everything from a pipe', async () => {
    const pipe = new PassThrough();
    const result = readAllStdin(pipe as unknown as NodeJS.ReadStream);
    pipe.write('sk-piped');
    pipe.end('-key\n');
    await expect(result).resolves.toBe('sk-piped-key\n');
  });

  it('refuses a terminal, where the key would show on screen', async () => {
    const tty = new FakeTty();
    await expect(
      readAllStdin(tty as unknown as NodeJS.ReadStream)
    ).rejects.toMatchObject({ exitCode: 2 });
  });
});
