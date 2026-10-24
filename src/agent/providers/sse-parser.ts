/**
 * A small parser for `text/event-stream` bodies, as sent by model providers
 * that stream their answers. It follows the WHATWG server-sent events rules
 * for lines and fields, and knows nothing about any provider's payload.
 */

import { ProviderError } from './types';

/** The longest line accepted, in UTF-16 units (about 2 to 4 MB of text). */
export const MAX_SSE_LINE = 2 * 1024 * 1024;

/** One server-sent event. */
export interface SseEvent {
  /** The `event:` field, when the server sent one. */
  event?: string;
  /** The `data:` lines, joined with `\n`. */
  data: string;
  /** The `id:` field, when the server sent one. */
  id?: string;
}

/**
 * Reads SSE events from a response body, in order.
 *
 * - Lines may end in `\n`, `\r\n` or `\r`, and may be split across reads.
 * - One read may hold several events.
 * - Comment lines (`: ...`) are skipped. Providers use them as keep-alives.
 * - A blank line ends an event. An event with no `data:` line is skipped.
 * - The last event is still given when the body ends without a blank line.
 *
 * Payloads such as `[DONE]` are given as normal `data`. The caller decides
 * when to stop. Stopping early (a `break` in `for await`) cancels the body.
 * Aborting `signal` cancels the body and throws the abort reason.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseEvent> {
  signal?.throwIfAborted();
  const reader = body.getReader();
  const onAbort = (): void => {
    reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  const decoder = new TextDecoder();
  const builder = new EventBuilder();
  // Text of a line that has no end yet. It is kept in pieces and joined only
  // when a line end arrives, so a long line costs linear time, not quadratic.
  let pending: string[] = [];
  let pendingLength = 0;
  let pendingEndsWithCr = false;
  let finished = false;
  let first = true;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      const text = done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      if (!done && !pendingEndsWithCr && !/[\r\n]/.test(text)) {
        pending.push(text);
        pendingLength += text.length;
        if (pendingLength > MAX_SSE_LINE) throw lineTooLong();
        continue;
      }
      let buffer = pending.join('') + text;
      pending = [];
      if (first && buffer.length > 0) {
        // A byte order mark is allowed before the first line.
        if (buffer.startsWith('﻿')) buffer = buffer.slice(1);
        first = false;
      }

      let start = 0;
      for (;;) {
        const end = lineEnd(buffer, start, done);
        if (end === undefined) break;
        if (end.at - start > MAX_SSE_LINE) throw lineTooLong();
        const event = builder.line(buffer.slice(start, end.at));
        start = end.next;
        if (event) yield event;
      }
      buffer = buffer.slice(start);
      if (buffer.length > MAX_SSE_LINE) throw lineTooLong();

      if (done) {
        if (buffer !== '') {
          const event = builder.line(buffer);
          if (event) yield event;
        }
        const last = builder.dispatch();
        if (last) yield last;
        finished = true;
        return;
      }
      if (buffer !== '') pending.push(buffer);
      pendingLength = buffer.length;
      pendingEndsWithCr = buffer.endsWith('\r');
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function lineTooLong(): ProviderError {
  return new ProviderError(
    'server',
    `an SSE line is longer than ${MAX_SSE_LINE} characters`
  );
}

/**
 * Finds the end of the line that starts at `from`. A `\r` at the very end of
 * the buffer may be the first half of `\r\n`, so it waits for more input
 * unless the body is over.
 */
function lineEnd(
  buffer: string,
  from: number,
  eof: boolean
): { at: number; next: number } | undefined {
  for (let i = from; i < buffer.length; i++) {
    const c = buffer[i];
    if (c === '\n') return { at: i, next: i + 1 };
    if (c === '\r') {
      if (i + 1 < buffer.length) {
        return { at: i, next: buffer[i + 1] === '\n' ? i + 2 : i + 1 };
      }
      return eof ? { at: i, next: i + 1 } : undefined;
    }
  }
  return undefined;
}

/** Collects the fields of one event, line by line. */
class EventBuilder {
  private data: string[] = [];
  private event: string | undefined;
  private id: string | undefined;

  /** Takes one line. Returns an event when the line ends one. */
  line(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') this.data.push(value);
    else if (field === 'event') this.event = value;
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    // `retry` and unknown fields are ignored.
    return undefined;
  }

  /** Ends the current event. Returns it when it has data. */
  dispatch(): SseEvent | undefined {
    const hasData = this.data.length > 0;
    const out: SseEvent = { data: this.data.join('\n') };
    if (this.event !== undefined) out.event = this.event;
    if (this.id !== undefined) out.id = this.id;
    this.data = [];
    this.event = undefined;
    // The last event id stays for the next events, as in the spec.
    return hasData ? out : undefined;
  }
}
