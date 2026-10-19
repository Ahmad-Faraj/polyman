import { describe, it, expect } from 'vitest';
import {
  ProviderError,
  type ProviderErrorKind,
  type StreamEvent,
} from '../../../src/agent/providers/types';
import type { Message } from '../../../src/agent/core/messages';

describe('ProviderError', () => {
  it('is an Error and a ProviderError', () => {
    const err = new ProviderError('auth', 'bad key');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.name).toBe('ProviderError');
  });

  it('keeps kind, message, status and retryAfterMs', () => {
    const err = new ProviderError('rate_limit', 'slow down', {
      status: 429,
      retryAfterMs: 1500,
    });
    expect(err.kind).toBe('rate_limit');
    expect(err.message).toBe('slow down');
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(1500);
  });

  it('leaves status and retryAfterMs unset when not given', () => {
    const err = new ProviderError('network', 'offline');
    expect(err.status).toBeUndefined();
    expect(err.retryAfterMs).toBeUndefined();
  });

  it.each<[ProviderErrorKind, boolean]>([
    ['auth', false],
    ['rate_limit', true],
    ['context_too_long', false],
    ['bad_request', false],
    ['server', true],
    ['network', true],
    ['tools_not_supported', false],
  ])('defaults retryable for %s to %s', (kind, retryable) => {
    expect(new ProviderError(kind, 'x').retryable).toBe(retryable);
  });

  it('lets opts.retryable override the default', () => {
    expect(
      new ProviderError('server', 'x', { retryable: false }).retryable
    ).toBe(false);
    expect(new ProviderError('auth', 'x', { retryable: true }).retryable).toBe(
      true
    );
  });
});

describe('message and stream types', () => {
  it('accepts every content part and stream event shape', () => {
    const msg: Message = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'hi' },
        { type: 'reasoning', text: 'thinking' },
        { type: 'tool_call', id: 'c1', name: 'run', args: { a: 1 } },
        { type: 'tool_result', callId: 'c1', content: 'ok', isError: false },
      ],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const events: StreamEvent[] = [
      { type: 'text_delta', text: 'a' },
      { type: 'reasoning_delta', text: 'b' },
      { type: 'tool_call', id: 'c1', name: 'run', args: {} },
      { type: 'usage', inputTokens: 1, outputTokens: 2, cachedTokens: 0 },
      { type: 'done', stopReason: 'end' },
    ];
    expect(msg.parts).toHaveLength(4);
    expect(events.map(e => e.type)).toEqual([
      'text_delta',
      'reasoning_delta',
      'tool_call',
      'usage',
      'done',
    ]);
  });
});
