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

  describe('escape sequences split across chunks', () => {
    const read = async (...chunks: string[]) => {
      const tty = new FakeTty();
      const result = readHiddenLine('Key: ', asInput(tty), sink().out);
      for (const chunk of chunks) tty.type(chunk);
      return result;
    };

    it('drops an arrow key split after ESC', async () => {
      await expect(read('abc\u001b', '[Adef\r')).resolves.toBe('abcdef');
    });

    it('drops an arrow key split after ESC [', async () => {
      await expect(read('abc\u001b[', 'Adef\r')).resolves.toBe('abcdef');
    });

    it('drops a paste end marker split in the middle', async () => {
      await expect(read('\u001b[200~abc\u001b[20', '1~\r')).resolves.toBe(
        'abc'
      );
    });

    it('takes a paste split at every byte offset', async () => {
      const paste = '\u001b[200~sk-pasted-12345\u001b[201~\r';
      for (let at = 0; at <= paste.length; at++) {
        await expect(
          read(paste.slice(0, at), paste.slice(at)),
          `split at ${at}`
        ).resolves.toBe('sk-pasted-12345');
      }
    });

    it('takes a paste sent one byte per chunk', async () => {
      await expect(
        read(...'\u001b[200~sk-pasted-12345\u001b[201~\r')
      ).resolves.toBe('sk-pasted-12345');
    });

    it('drops an SS3 arrow key (ESC O A, application cursor mode)', async () => {
      await expect(read('abc\u001bOAdef\r')).resolves.toBe('abcdef');
    });

    it('drops an SS3 arrow key split across chunks', async () => {
      await expect(read('abc\u001bO', 'Adef\r')).resolves.toBe('abcdef');
    });

    it('drops F1 (ESC O P)', async () => {
      await expect(read('\u001bOP\r')).resolves.toBe('');
    });

    it('drops ESC and the character after it (Alt+key)', async () => {
      await expect(read('ab\u001bxcd\r')).resolves.toBe('abcd');
    });

    it('drops a lone ESC chunk together with the next character', async () => {
      // Alt+a is sent as ESC a, so the a after a lone ESC chunk goes too.
      await expect(read('\u001b', 'abc\r')).resolves.toBe('bc');
    });

    it('ends on Enter right after a sequence', async () => {
      await expect(read('abc\u001b[A', '\r')).resolves.toBe('abc');
      await expect(read('abc\u001bOA\r')).resolves.toBe('abc');
    });

    it('ends on Enter right after a lone ESC', async () => {
      await expect(read('abc\u001b', '\r')).resolves.toBe('abc');
    });

    it('ends on Enter inside an unfinished sequence', async () => {
      await expect(read('abc\u001b[2', '\r')).resolves.toBe('abc');
    });

    it('cancels on Ctrl+C right after a sequence', async () => {
      await expect(read('abc\u001b[A', '\u0003')).rejects.toThrow('Cancelled.');
      await expect(read('abc\u001b', '\u0003')).rejects.toThrow('Cancelled.');
      await expect(read('abc\u001bO\u0003')).rejects.toThrow('Cancelled.');
    });

    it('handles backspace right after a sequence', async () => {
      await expect(read('abc\u001b[A', '\u007fd\r')).resolves.toBe('abd');
    });
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
