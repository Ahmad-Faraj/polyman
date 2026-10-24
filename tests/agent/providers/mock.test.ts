import { describe, it, expect } from 'vitest';
import { MockProvider } from '../../../src/agent/providers/mock';
import {
  ProviderError,
  type ChatRequest,
  type Provider,
  type StreamEvent,
} from '../../../src/agent/providers/types';

function request(text = 'hi'): ChatRequest {
  return {
    model: 'mock-model',
    system: 'You build problems.',
    messages: [
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text }],
        createdAt: '2026-10-24T00:00:00.000Z',
      },
    ],
    tools: [],
  };
}

async function collect(
  provider: Provider,
  req = request(),
  signal = new AbortController().signal
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of provider.stream(req, signal)) out.push(event);
  return out;
}

describe('MockProvider', () => {
  it('is a Provider with id mock by default', () => {
    const provider: Provider = new MockProvider([]);
    expect(provider.id).toBe('mock');
    expect(new MockProvider([], 'other').id).toBe('other');
  });

  it('plays one step per stream call, in order', async () => {
    const provider = new MockProvider([
      { toolCall: { name: 'verify', args: {} } },
      { text: 'ok' },
    ]);
    expect(provider.remaining).toBe(2);

    expect(await collect(provider)).toEqual([
      { type: 'tool_call', id: 'mock_call_1_1', name: 'verify', args: {} },
      { type: 'done', stopReason: 'tool_calls' },
    ]);
    expect(provider.remaining).toBe(1);

    expect(await collect(provider)).toEqual([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', stopReason: 'end' },
    ]);
    expect(provider.remaining).toBe(0);
  });

  it('plays reasoning, text, tool calls, usage and done in that order', async () => {
    const provider = new MockProvider([
      {
        reasoning: 'think',
        text: 'I will check two files.',
        toolCall: { name: 'read_file', args: { path: 'Config.json' } },
        toolCalls: [
          { id: 'given', name: 'list_files', args: { dir: 'generators' } },
          { name: 'verify', args: {} },
        ],
        usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 2 },
      },
    ]);
    expect(await collect(provider)).toEqual([
      { type: 'reasoning_delta', text: 'think' },
      { type: 'text_delta', text: 'I will check two files.' },
      {
        type: 'tool_call',
        id: 'mock_call_1_1',
        name: 'read_file',
        args: { path: 'Config.json' },
      },
      {
        type: 'tool_call',
        id: 'given',
        name: 'list_files',
        args: { dir: 'generators' },
      },
      { type: 'tool_call', id: 'mock_call_1_3', name: 'verify', args: {} },
      { type: 'usage', inputTokens: 10, outputTokens: 5, cachedTokens: 2 },
      { type: 'done', stopReason: 'tool_calls' },
    ]);
  });

  it('numbers default call ids by turn', async () => {
    const provider = new MockProvider([
      { text: 'first' },
      { toolCall: { name: 'verify', args: {} } },
    ]);
    await collect(provider);
    const events = await collect(provider);
    expect(events[0]).toMatchObject({ type: 'tool_call', id: 'mock_call_2_1' });
  });

  it('uses the given stop reason', async () => {
    const provider = new MockProvider([
      { text: 'cut', stopReason: 'max_tokens' },
    ]);
    expect((await collect(provider)).at(-1)).toEqual({
      type: 'done',
      stopReason: 'max_tokens',
    });
  });

  it('gives only done for an empty step', async () => {
    expect(await collect(new MockProvider([{}]))).toEqual([
      { type: 'done', stopReason: 'end' },
    ]);
  });

  it('records every request it got', async () => {
    const provider = new MockProvider([{ text: 'a' }, { text: 'b' }]);
    const first = request('one');
    const second = request('two');
    await collect(provider, first);
    await collect(provider, second);
    expect(provider.requests).toEqual([first, second]);
  });

  it('throws an error step before the first event', async () => {
    const err = new ProviderError('rate_limit', 'slow down', {
      retryAfterMs: 1000,
    });
    const provider = new MockProvider([{ error: err }, { text: 'ok' }]);
    const seen: StreamEvent[] = [];
    await expect(async () => {
      for await (const e of provider.stream(request(), signal())) seen.push(e);
    }).rejects.toBe(err);
    expect(seen).toEqual([]);
    // The failed call used its step, so a retry gets the next one.
    expect(await collect(provider)).toEqual([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', stopReason: 'end' },
    ]);
  });

  it('throws an error step after its text, with no usage or done', async () => {
    const err = new ProviderError('network', 'connection reset');
    const provider = new MockProvider([
      {
        text: 'half an ans',
        usage: { inputTokens: 1, outputTokens: 1 },
        error: err,
      },
    ]);
    const seen: StreamEvent[] = [];
    await expect(async () => {
      for await (const e of provider.stream(request(), signal())) seen.push(e);
    }).rejects.toBe(err);
    expect(seen).toEqual([{ type: 'text_delta', text: 'half an ans' }]);
  });

  it('throws a plain Error when the script runs out', async () => {
    const provider = new MockProvider([{ text: 'only one' }]);
    await collect(provider);
    const run = collect(provider);
    await expect(run).rejects.toThrow(
      'MockProvider: no step left for call 2, the script has 1 step(s)'
    );
    await expect(run).rejects.not.toBeInstanceOf(ProviderError);
  });

  it('does not use a step when the signal is already aborted', async () => {
    const provider = new MockProvider([{ text: 'ok' }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(provider, request(), controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(provider.remaining).toBe(1);
    expect(provider.requests).toEqual([]);
  });

  it('stops between events when the signal is aborted', async () => {
    const provider = new MockProvider([
      { reasoning: 'r', text: 't', toolCall: { name: 'verify', args: {} } },
    ]);
    const controller = new AbortController();
    const seen: StreamEvent[] = [];
    await expect(async () => {
      for await (const e of provider.stream(request(), controller.signal)) {
        seen.push(e);
        controller.abort();
      }
    }).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toEqual([{ type: 'reasoning_delta', text: 'r' }]);
  });

  it('does not change when the script array changes later', () => {
    const script = [{ text: 'a' }];
    const provider = new MockProvider(script);
    script.push({ text: 'b' });
    expect(provider.remaining).toBe(1);
  });
});

function signal(): AbortSignal {
  return new AbortController().signal;
}
