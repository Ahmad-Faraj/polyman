import { describe, it, expect } from 'vitest';
import {
  parseSse,
  type SseEvent,
} from '../../../src/agent/providers/sse-parser';
import {
  fixtureResponse,
  listFixtures,
  readFixture,
} from '../../fixtures/agent';

/** A body that gives each piece in its own read. */
function bodyOf(
  pieces: (string | Uint8Array)[],
  onCancel?: (reason: unknown) => void
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const piece = pieces[i++];
      if (piece === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(
        typeof piece === 'string' ? encoder.encode(piece) : piece
      );
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  });
}

async function collect(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const event of parseSse(body, signal)) out.push(event);
  return out;
}

describe('parseSse', () => {
  it('reads one event', async () => {
    expect(await collect(bodyOf(['data: hello\n\n']))).toEqual([
      { data: 'hello' },
    ]);
  });

  it('reads several events in one chunk', async () => {
    expect(
      await collect(bodyOf(['data: a\n\ndata: b\n\ndata: [DONE]\n\n']))
    ).toEqual([{ data: 'a' }, { data: 'b' }, { data: '[DONE]' }]);
  });

  it('reads lines and events split across chunks', async () => {
    const text = 'data: {"a":1}\n\nevent: ping\ndata: x\n\n';
    const expected = [{ data: '{"a":1}' }, { event: 'ping', data: 'x' }];
    for (let size = 1; size <= text.length; size++) {
      const pieces: string[] = [];
      for (let i = 0; i < text.length; i += size) {
        pieces.push(text.slice(i, i + size));
      }
      expect(await collect(bodyOf(pieces))).toEqual(expected);
    }
  });

  it('skips comment lines', async () => {
    expect(
      await collect(
        bodyOf([': OPENROUTER PROCESSING\n\ndata: a\n:keep-alive\n\n'])
      )
    ).toEqual([{ data: 'a' }]);
  });

  it('accepts \\r\\n and \\r line endings, also \\r\\n split in two reads', async () => {
    expect(await collect(bodyOf(['data: a\r\n\r\ndata: b\r\r']))).toEqual([
      { data: 'a' },
      { data: 'b' },
    ]);
    expect(
      await collect(bodyOf(['data: a\r', '\n\r', '\ndata: b\r\n\r\n']))
    ).toEqual([{ data: 'a' }, { data: 'b' }]);
  });

  it('joins several data lines with \\n', async () => {
    expect(await collect(bodyOf(['data: one\ndata: two\n\n']))).toEqual([
      { data: 'one\ntwo' },
    ]);
  });

  it('reads event and id fields, and values with no space after the colon', async () => {
    expect(
      await collect(bodyOf(['event:delta\nid:7\ndata:{"x":1}\nretry: 10\n\n']))
    ).toEqual([{ event: 'delta', id: '7', data: '{"x":1}' }]);
  });

  it('skips events with no data', async () => {
    expect(await collect(bodyOf(['event: ping\n\n\n\ndata: a\n\n']))).toEqual([
      { data: 'a' },
    ]);
  });

  it('gives the last event when the body ends without a blank line', async () => {
    expect(await collect(bodyOf(['data: a\n\ndata: [DONE]']))).toEqual([
      { data: 'a' },
      { data: '[DONE]' },
    ]);
  });

  it('decodes UTF-8 characters split across reads', async () => {
    const bytes = new TextEncoder().encode('data: héllo ✓\n\n');
    const pieces = Array.from(bytes, b => new Uint8Array([b]));
    expect(await collect(bodyOf(pieces))).toEqual([{ data: 'héllo ✓' }]);
  });

  it('drops a byte order mark at the start', async () => {
    expect(await collect(bodyOf(['﻿data: a\n\n']))).toEqual([{ data: 'a' }]);
  });

  it('cancels the body when the caller stops early', async () => {
    let cancelled = false;
    const body = bodyOf(['data: a\n\n', 'data: b\n\n'], () => {
      cancelled = true;
    });
    for await (const event of parseSse(body)) {
      expect(event.data).toBe('a');
      break;
    }
    expect(cancelled).toBe(true);
  });

  it('throws the abort reason and cancels the body when aborted', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = bodyOf(['data: a\n\n', 'data: b\n\n'], () => {
      cancelled = true;
    });
    const seen: string[] = [];
    const run = async () => {
      for await (const event of parseSse(body, controller.signal)) {
        seen.push(event.data);
        controller.abort(new Error('stop'));
      }
    };
    await expect(run()).rejects.toThrow('stop');
    expect(seen).toEqual(['a']);
    expect(cancelled).toBe(true);
  });

  it('throws at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('early'));
    await expect(
      collect(bodyOf(['data: a\n\n']), controller.signal)
    ).rejects.toThrow('early');
  });

  it.each(listFixtures('openai'))(
    'reads the openai/%s fixture the same way in any chunk size',
    async name => {
      const fixture = readFixture('openai', name);
      if (fixture.status !== 200) return;
      const whole = await collect(fixtureResponse(fixture).body!);
      expect(whole.length).toBeGreaterThan(1);
      expect(whole.at(-1)).toEqual({ data: '[DONE]' });
      for (const size of [1, 3, 17, 256]) {
        expect(await collect(fixtureResponse(fixture, size).body!)).toEqual(
          whole
        );
      }
    }
  );
});
