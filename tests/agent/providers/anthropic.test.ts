import { describe, it, expect, vi } from 'vitest';
import {
  ANTHROPIC_VERSION,
  AnthropicProvider,
  DEFAULT_MAX_TOKENS,
  requestBody,
  streamError,
  toWireMessages,
  type AnthropicOptions,
} from '../../../src/agent/providers/anthropic';
import {
  ProviderError,
  type ChatRequest,
  type Provider,
  type StreamEvent,
} from '../../../src/agent/providers/types';
import type { ContentPart, Message } from '../../../src/agent/core/messages';
import { fixtureResponse, readFixture } from '../../fixtures/agent';

const AT = '2026-10-24T00:00:00.000Z';

const SIGNATURE =
  'EqQBCkgIARABGAIiQL8mXz3pQ7v2rT9kLw4nYc1aB6dF0gH5jK8mN2pQ4sU7wX9zA1cE3gI5kM7oQ9sU1wY3aC5eG7iK9mO1qS3uW5yAEgzP4rT6vX8zB0dF2hJ4aDEl9nP3rT5vX7zB9dF1hJ';

function request(over: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'claude-sonnet-4-6',
    system: 'You build problems.',
    messages: [
      {
        id: 'm1',
        role: 'user',
        parts: [{ type: 'text', text: 'hi' }],
        createdAt: AT,
      },
    ],
    tools: [],
    ...over,
  };
}

type FetchArgs = Parameters<typeof fetch>;

/** A fake `fetch` that answers each call with the next response. */
function fakeFetch(...responses: (() => Response)[]) {
  return vi.fn(async (..._args: FetchArgs): Promise<Response> => {
    const next = responses.shift();
    if (!next) throw new Error('fakeFetch: no response left');
    return Promise.resolve(next());
  });
}

function provider(
  fetchFn: ReturnType<typeof fakeFetch>,
  opts: Partial<AnthropicOptions> = {}
): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: 'sk-ant-test',
    fetch: fetchFn,
    ...opts,
  });
}

function fixture(name: string, chunkSize?: number): () => Response {
  return () => fixtureResponse(readFixture('anthropic', name), chunkSize);
}

/** An SSE response made of these events, named by their `type`. */
function sse(events: Record<string, unknown>[]): () => Response {
  const body = events
    .map(e => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('');
  return () =>
    new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
}

function json(status: number, body: unknown, headers = {}): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
}

function apiError(type: string, message: string) {
  return { type: 'error', error: { type, message } };
}

const MESSAGE_START = {
  type: 'message_start',
  message: {
    id: 'msg_1',
    role: 'assistant',
    content: [],
    usage: { input_tokens: 10, output_tokens: 1 },
  },
};

function blockStart(index: number, block: Record<string, unknown>) {
  return { type: 'content_block_start', index, content_block: block };
}

function blockDelta(index: number, delta: Record<string, unknown>) {
  return { type: 'content_block_delta', index, delta };
}

function blockStop(index: number) {
  return { type: 'content_block_stop', index };
}

function messageEnd(stopReason: string, outputTokens = 5) {
  return [
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
    { type: 'message_stop' },
  ];
}

async function collect(
  p: Provider,
  req = request(),
  signal = new AbortController().signal
): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of p.stream(req, signal)) out.push(event);
  return out;
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    return err as ProviderError;
  }
  throw new Error('expected a ProviderError');
}

function texts(events: StreamEvent[], type: 'text_delta' | 'reasoning_delta') {
  return events.flatMap(e => (e.type === type ? [e.text] : [])).join('');
}

function sentBody(fetchFn: ReturnType<typeof fakeFetch>, call = 0) {
  const body = fetchFn.mock.calls[call]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('the body is not a string');
  return JSON.parse(body) as Record<string, unknown>;
}

const CHUNK_SIZES = [undefined, 1, 7, 64];

describe('AnthropicProvider: streaming fixtures', () => {
  it.each(CHUNK_SIZES)('streams text (chunk size %s)', async size => {
    const events = await collect(provider(fakeFetch(fixture('text', size))));
    expect(events).toEqual([
      { type: 'text_delta', text: 'Hello! I can help' },
      { type: 'text_delta', text: ' you build and test' },
      { type: 'text_delta', text: ' this problem.' },
      // 318 new input tokens + 2048 read from the cache.
      {
        type: 'usage',
        inputTokens: 2366,
        outputTokens: 13,
        cachedTokens: 2048,
      },
      { type: 'done', stopReason: 'end' },
    ]);
  });

  it.each(CHUNK_SIZES)(
    'maps thinking to reasoning_delta and ends the block with its signature (chunk size %s)',
    async size => {
      const events = await collect(
        provider(fakeFetch(fixture('reasoning', size)))
      );
      expect(texts(events, 'reasoning_delta')).toBe(
        'The user asks what the validator checks. It reads n and then n integers and checks their ranges.'
      );
      expect(texts(events, 'text_delta')).toBe(
        'The validator checks that n is between 1 and 10^5.'
      );
      // The signature closes the thinking block, before the answer.
      const signed = events.findIndex(
        e => e.type === 'reasoning_delta' && e.signature !== undefined
      );
      expect(events[signed]).toEqual({
        type: 'reasoning_delta',
        text: '',
        signature: SIGNATURE,
      });
      expect(events.filter(e => e.type === 'reasoning_delta')).toHaveLength(4);
      expect(signed).toBe(events.findIndex(e => e.type === 'text_delta') - 1);
      expect(events.slice(-2)).toEqual([
        { type: 'usage', inputTokens: 296, outputTokens: 71, cachedTokens: 0 },
        { type: 'done', stopReason: 'end' },
      ]);
    }
  );

  it.each(CHUNK_SIZES)(
    'joins input_json_delta pieces into one tool call (chunk size %s)',
    async size => {
      const events = await collect(
        provider(fakeFetch(fixture('tool-call', size)))
      );
      expect(texts(events, 'text_delta')).toBe(
        'I will read the main solution first.'
      );
      expect(events.slice(-3)).toEqual([
        {
          type: 'tool_call',
          id: 'toolu_01Qr7St9Uv1Wx3Yz5Ab7Cd9E',
          name: 'read_file',
          args: { path: 'solutions/main.cpp' },
        },
        {
          type: 'usage',
          inputTokens: 2450,
          outputTokens: 64,
          cachedTokens: 2048,
        },
        { type: 'done', stopReason: 'tool_calls' },
      ]);
    }
  );

  it.each(CHUNK_SIZES)(
    'gives two tool calls in block order (chunk size %s)',
    async size => {
      const events = await collect(
        provider(fakeFetch(fixture('two-tool-calls', size)))
      );
      expect(events).toEqual([
        {
          type: 'tool_call',
          id: 'toolu_01Ab2Cd4Ef6Gh8Ij0Kl2Mn4O',
          name: 'read_file',
          args: { path: 'Config.json' },
        },
        {
          type: 'tool_call',
          id: 'toolu_01Pq3Rs5Tu7Vw9Xy1Za3Bc5D',
          name: 'list_files',
          args: { dir: 'generators' },
        },
        {
          type: 'usage',
          inputTokens: 2450,
          outputTokens: 88,
          cachedTokens: 2048,
        },
        { type: 'done', stopReason: 'tool_calls' },
      ]);
    }
  );

  it.each(CHUNK_SIZES)(
    'throws a server error on an overloaded_error event in the middle (chunk size %s)',
    async size => {
      const fetchFn = fakeFetch(fixture('error', size));
      const events: StreamEvent[] = [];
      const run = async () => {
        for await (const e of provider(fetchFn).stream(
          request(),
          new AbortController().signal
        )) {
          events.push(e);
        }
      };
      const err = await failure(run());
      expect(err.kind).toBe('server');
      expect(err.retryable).toBe(true);
      expect(err.message).toContain('overloaded_error');
      expect(err.message).toContain('Overloaded');
      expect(events).toEqual([{ type: 'text_delta', text: 'Hello! I can' }]);
      // No retries here, that is #78.
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  );

  it('sends the thinking of the reasoning fixture back with its signature', async () => {
    const events = await collect(provider(fakeFetch(fixture('reasoning', 1))));
    // What the loop builds from the events.
    const parts: ContentPart[] = [
      {
        type: 'reasoning',
        text: texts(events, 'reasoning_delta'),
        signature: SIGNATURE,
      },
      { type: 'text', text: texts(events, 'text_delta') },
    ];
    const wire = toWireMessages([
      ...request().messages,
      { id: 'a1', role: 'assistant', parts, createdAt: AT },
    ]);
    expect(wire[1]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'thinking',
          thinking:
            'The user asks what the validator checks. It reads n and then n integers and checks their ranges.',
          signature: SIGNATURE,
        },
        {
          type: 'text',
          text: 'The validator checks that n is between 1 and 10^5.',
        },
      ],
    });
  });
});

describe('AnthropicProvider: request', () => {
  it('posts to /v1/messages with the key, the version and the signal', async () => {
    const fetchFn = fakeFetch(fixture('text'));
    const controller = new AbortController();
    const p = provider(fetchFn);
    await collect(p, request(), controller.signal);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBe(controller.signal);
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': ANTHROPIC_VERSION,
      'x-api-key': 'sk-ant-test',
    });
    expect(p.id).toBe('anthropic');
  });

  it('takes a base URL with or without /v1, extra headers and an id', async () => {
    for (const baseUrl of [
      'https://proxy.example.com/',
      'https://proxy.example.com/v1',
    ]) {
      const fetchFn = fakeFetch(fixture('text'));
      const p = new AnthropicProvider({
        id: 'claude',
        baseUrl,
        headers: { 'anthropic-beta': 'x' },
        fetch: fetchFn,
      });
      await collect(p);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe('https://proxy.example.com/v1/messages');
      const headers = init!.headers as Record<string, string>;
      expect(headers['anthropic-beta']).toBe('x');
      expect(headers['x-api-key']).toBeUndefined();
      expect(p.id).toBe('claude');
    }
  });

  it('caches the system prompt and the tool list', async () => {
    const fetchFn = fakeFetch(fixture('tool-call'));
    await collect(
      provider(fetchFn),
      request({
        tools: [
          {
            name: 'read_file',
            description: 'Reads a file.',
            parameters: { type: 'object', properties: {} },
          },
          {
            name: 'list_files',
            description: 'Lists files.',
            parameters: { type: 'object', properties: {} },
          },
        ],
        maxOutputTokens: 1000,
        temperature: 0.2,
      })
    );
    expect(sentBody(fetchFn)).toEqual({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: [
        {
          type: 'text',
          text: 'You build problems.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [
        {
          name: 'read_file',
          description: 'Reads a file.',
          input_schema: { type: 'object', properties: {} },
        },
        {
          name: 'list_files',
          description: 'Lists files.',
          input_schema: { type: 'object', properties: {} },
          // One breakpoint after the last tool caches the whole list.
          cache_control: { type: 'ephemeral' },
        },
      ],
      stream: true,
      temperature: 0.2,
    });
  });

  it('leaves out an empty system prompt and tools, and uses the default max tokens', () => {
    const body = requestBody(request({ system: '' }));
    expect(body['system']).toBeUndefined();
    expect(body['tools']).toBeUndefined();
    expect(body['thinking']).toBeUndefined();
    expect(body['max_tokens']).toBe(DEFAULT_MAX_TOKENS);
    expect(requestBody(request(), 4096)['max_tokens']).toBe(4096);
  });

  it('uses defaultMaxTokens of the options', async () => {
    const fetchFn = fakeFetch(fixture('text'));
    await collect(provider(fetchFn, { defaultMaxTokens: 8000 }));
    expect(sentBody(fetchFn)['max_tokens']).toBe(8000);
  });

  it('turns reasoningEffort into adaptive thinking with a summary', () => {
    const body = requestBody(request({ reasoningEffort: 'high' }));
    expect(body['thinking']).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(body['output_config']).toEqual({ effort: 'high' });
  });

  it('sends temperature only without reasoningEffort', () => {
    const both = requestBody(
      request({ temperature: 0.2, reasoningEffort: 'high' })
    );
    expect(both['thinking']).toBeDefined();
    expect(both).not.toHaveProperty('temperature');
    const plain = requestBody(request({ temperature: 0.2 }));
    expect(plain['temperature']).toBe(0.2);
    expect(plain).not.toHaveProperty('thinking');
  });
});

describe('toWireMessages', () => {
  it('maps a whole tool step: thinking, text, tool_use, then tool_result', () => {
    const messages: Message[] = [
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'read it' }],
        createdAt: AT,
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [
          { type: 'reasoning', text: 'I should read it.', signature: 'sig1' },
          { type: 'reasoning', text: '', redacted: 'opaque' },
          { type: 'reasoning', text: 'from another provider' },
          { type: 'text', text: 'Reading.' },
          { type: 'text', text: '' },
          {
            type: 'tool_call',
            id: 'toolu_1',
            name: 'read_file',
            args: { path: 'a' },
          },
          { type: 'tool_call', id: 'toolu_2', name: 'bad', args: '{"x":' },
          { type: 'tool_call', id: 'toolu_3', name: 'raw', args: '{"y":2}' },
        ],
        createdAt: AT,
      },
      {
        id: 't1',
        role: 'tool',
        parts: [
          {
            type: 'tool_result',
            callId: 'toolu_1',
            content: 'file text',
            isError: false,
          },
          {
            type: 'tool_result',
            callId: 'toolu_2',
            content: 'bad JSON',
            isError: true,
          },
          {
            type: 'tool_result',
            callId: 'toolu_3',
            content: '',
            isError: false,
          },
        ],
        createdAt: AT,
      },
      {
        id: 'u2',
        role: 'user',
        parts: [{ type: 'text', text: 'and then?' }],
        createdAt: AT,
      },
      {
        id: 'a2',
        role: 'assistant',
        parts: [{ type: 'reasoning', text: 'unsigned only' }],
        createdAt: AT,
      },
    ];
    expect(toWireMessages(messages)).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'thinking',
            thinking: 'I should read it.',
            signature: 'sig1',
          },
          { type: 'redacted_thinking', data: 'opaque' },
          { type: 'text', text: 'Reading.' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'read_file',
            input: { path: 'a' },
          },
          // Arguments that were not valid JSON go back as {}.
          { type: 'tool_use', id: 'toolu_2', name: 'bad', input: {} },
          { type: 'tool_use', id: 'toolu_3', name: 'raw', input: { y: 2 } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'file text' },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_2',
            content: 'bad JSON',
            is_error: true,
          },
          { type: 'tool_result', tool_use_id: 'toolu_3' },
          { type: 'text', text: 'and then?' },
        ],
      },
    ]);
    // Reasoning without a signature is never sent back.
    const wire = JSON.stringify(toWireMessages(messages));
    expect(wire).not.toContain('another provider');
    expect(wire).not.toContain('unsigned only');
  });

  it('puts tool results before the text of the same user message', () => {
    const wire = toWireMessages([
      {
        id: 'u1',
        role: 'user',
        parts: [
          { type: 'text', text: 'here' },
          { type: 'tool_result', callId: 'c1', content: 'ok', isError: false },
        ],
        createdAt: AT,
      },
    ]);
    expect(wire).toEqual([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'c1', content: 'ok' },
          { type: 'text', text: 'here' },
        ],
      },
    ]);
  });
});

describe('AnthropicProvider: errors', () => {
  it.each<[number, unknown, string, boolean]>([
    [401, apiError('authentication_error', 'invalid x-api-key'), 'auth', false],
    [403, apiError('permission_error', 'no access'), 'auth', false],
    [
      400,
      apiError(
        'invalid_request_error',
        'prompt is too long: 210000 tokens > 200000 maximum'
      ),
      'context_too_long',
      false,
    ],
    [
      413,
      apiError('request_too_large', 'Request exceeds the maximum size'),
      'context_too_long',
      false,
    ],
    [
      400,
      apiError('invalid_request_error', 'tools.0.name: bad pattern'),
      'bad_request',
      false,
    ],
    [404, apiError('not_found_error', 'model: claude-x'), 'bad_request', false],
    [500, apiError('api_error', 'Internal server error'), 'server', true],
    [529, apiError('overloaded_error', 'Overloaded'), 'server', true],
  ])(
    'maps HTTP %i to the right kind',
    async (status, body, kind, retryable) => {
      const fetchFn = fakeFetch(json(status, body));
      const err = await failure(collect(provider(fetchFn)));
      expect(err.kind).toBe(kind);
      expect(err.status).toBe(status);
      expect(err.retryable).toBe(retryable);
      expect(err.message).toContain(`HTTP ${status}`);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    }
  );

  it('reads retry-after on a 429', async () => {
    const fetchFn = fakeFetch(
      json(429, apiError('rate_limit_error', 'Number of requests'), {
        'retry-after': '3',
      })
    );
    const err = await failure(collect(provider(fetchFn)));
    expect(err.kind).toBe('rate_limit');
    expect(err.retryAfterMs).toBe(3000);
    expect(err.message).toContain('Number of requests');
  });

  it.each<[string, string, string]>([
    ['overloaded_error', 'Overloaded', 'server'],
    ['api_error', 'boom', 'server'],
    ['something_new', 'x', 'server'],
    ['rate_limit_error', 'slow down', 'rate_limit'],
    ['authentication_error', 'bad key', 'auth'],
    ['permission_error', 'no', 'auth'],
    ['request_too_large', 'big', 'context_too_long'],
    ['invalid_request_error', 'prompt is too long', 'context_too_long'],
    ['invalid_request_error', 'bad field', 'bad_request'],
  ])('maps a stream error %s to %s', (type, message, kind) => {
    const err = streamError({ type, message });
    expect(err.kind).toBe(kind);
    expect(err.message).toBe(`error in the stream: ${type}: ${message}`);
  });

  it('gives a server error for an error event with no details', () => {
    const err = streamError(undefined);
    expect(err.kind).toBe('server');
    expect(err.message).toBe('error in the stream: unknown');
  });

  it('turns a failed fetch into a retryable network error', async () => {
    const fetchFn = vi.fn(() => Promise.reject(new TypeError('fetch failed')));
    const err = await failure(collect(provider(fetchFn as never)));
    expect(err.kind).toBe('network');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('fetch failed');
  });

  it('gives a network error when the stream ends before the turn', async () => {
    const fetchFn = fakeFetch(
      sse([
        MESSAGE_START,
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'text_delta', text: 'Hel' }),
      ])
    );
    const events: StreamEvent[] = [];
    const run = async () => {
      for await (const e of provider(fetchFn).stream(
        request(),
        new AbortController().signal
      )) {
        events.push(e);
      }
    };
    const err = await failure(run());
    expect(err.kind).toBe('network');
    expect(events).toEqual([{ type: 'text_delta', text: 'Hel' }]);
  });

  it('throws a server error on bad JSON in the stream', async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve(new Response('data: {oops\n\n', { status: 200 }))
    );
    const err = await failure(collect(provider(fetchFn as never)));
    expect(err.kind).toBe('server');
  });
});

describe('AnthropicProvider: abort', () => {
  it('throws without calling fetch when already aborted', async () => {
    const fetchFn = fakeFetch(fixture('text'));
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(provider(fetchFn), request(), controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('stops the stream when aborted in the middle', async () => {
    const fetchFn = fakeFetch(fixture('text', 16));
    const controller = new AbortController();
    const seen: StreamEvent[] = [];
    const run = async () => {
      for await (const e of provider(fetchFn).stream(
        request(),
        controller.signal
      )) {
        seen.push(e);
        if (seen.length === 2) controller.abort();
      }
    };
    await expect(run()).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toHaveLength(2);
    expect(seen.some(e => e.type === 'done')).toBe(false);
  });

  it('rethrows the abort when fetch fails because of it', async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn(() => {
      controller.abort();
      return Promise.reject(new DOMException('aborted', 'AbortError'));
    });
    const err: unknown = await collect(
      provider(fetchFn as never),
      request(),
      controller.signal
    ).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ name: 'AbortError' });
  });
});

describe('AnthropicProvider: stream details', () => {
  it('gives the raw arguments and argsError when the JSON is cut', async () => {
    const fetchFn = fakeFetch(
      sse([
        MESSAGE_START,
        blockStart(0, {
          type: 'tool_use',
          id: 't1',
          name: 'write_file',
          input: {},
        }),
        blockDelta(0, {
          type: 'input_json_delta',
          partial_json: '{"path": "a',
        }),
        blockStop(0),
        ...messageEnd('max_tokens'),
      ])
    );
    const [call, , done] = await collect(provider(fetchFn));
    expect(call).toMatchObject({
      type: 'tool_call',
      id: 't1',
      name: 'write_file',
      args: '{"path": "a',
    });
    expect(call?.type === 'tool_call' && call.argsError).toContain(
      'not valid JSON'
    );
    expect(done).toEqual({ type: 'done', stopReason: 'max_tokens' });
  });

  it.each(['[1]', 'null', '"x"', '3'])(
    'gives argsError and the raw string when the arguments are %s, not an object',
    async raw => {
      const fetchFn = fakeFetch(
        sse([
          MESSAGE_START,
          blockStart(0, {
            type: 'tool_use',
            id: 't1',
            name: 'write_file',
            input: {},
          }),
          blockDelta(0, { type: 'input_json_delta', partial_json: raw }),
          blockStop(0),
          ...messageEnd('tool_use'),
        ])
      );
      const events = await collect(provider(fetchFn));
      expect(events.filter(e => e.type === 'tool_call')).toEqual([
        {
          type: 'tool_call',
          id: 't1',
          name: 'write_file',
          args: raw,
          argsError: 'tool arguments are not a JSON object',
        },
      ]);
    }
  );

  it('flushes a tool_use block that has no content_block_stop', async () => {
    const fetchFn = fakeFetch(
      sse([
        MESSAGE_START,
        blockStart(1, {
          type: 'tool_use',
          id: 't2',
          name: 'verify',
          input: {},
        }),
        blockStart(0, {
          type: 'tool_use',
          id: 't1',
          name: 'write_file',
          input: {},
        }),
        blockDelta(0, { type: 'input_json_delta', partial_json: '{"a":1}' }),
        blockDelta(1, { type: 'input_json_delta', partial_json: '{"b":' }),
        ...messageEnd('tool_use'),
      ])
    );
    const events = await collect(provider(fetchFn));
    expect(events.filter(e => e.type === 'tool_call')).toEqual([
      { type: 'tool_call', id: 't1', name: 'write_file', args: { a: 1 } },
      {
        type: 'tool_call',
        id: 't2',
        name: 'verify',
        args: '{"b":',
        argsError: expect.stringContaining('not valid JSON') as string,
      },
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_calls' });
    expect(events.findIndex(e => e.type === 'usage')).toBeGreaterThan(
      events.findLastIndex(e => e.type === 'tool_call')
    );
  });

  it('uses the start input when no input_json_delta comes', async () => {
    const fetchFn = fakeFetch(
      sse([
        MESSAGE_START,
        blockStart(0, {
          type: 'tool_use',
          id: 't1',
          name: 'verify',
          input: { all: true },
        }),
        blockStop(0),
        blockStart(1, {
          type: 'tool_use',
          id: 't2',
          name: 'list_files',
          input: {},
        }),
        blockStop(1),
        ...messageEnd('tool_use'),
      ])
    );
    const events = await collect(provider(fetchFn));
    expect(events.filter(e => e.type === 'tool_call')).toEqual([
      { type: 'tool_call', id: 't1', name: 'verify', args: { all: true } },
      { type: 'tool_call', id: 't2', name: 'list_files', args: {} },
    ]);
  });

  it('gives a redacted thinking block as one reasoning_delta with its data', async () => {
    const fetchFn = fakeFetch(
      sse([
        MESSAGE_START,
        blockStart(0, { type: 'redacted_thinking', data: 'EmwKAhgB' }),
        blockStop(0),
        blockStart(1, { type: 'text', text: 'ok' }),
        blockStop(1),
        ...messageEnd('end_turn'),
      ])
    );
    const events = await collect(provider(fetchFn));
    expect(events.slice(0, 2)).toEqual([
      { type: 'reasoning_delta', text: '', redacted: 'EmwKAhgB' },
      { type: 'text_delta', text: 'ok' },
    ]);
  });

  it('keeps the signature of an empty (omitted) thinking block', async () => {
    const fetchFn = fakeFetch(
      sse([
        MESSAGE_START,
        blockStart(0, { type: 'thinking', thinking: '' }),
        blockDelta(0, { type: 'signature_delta', signature: 'abc' }),
        blockStop(0),
        blockStart(1, { type: 'text', text: '' }),
        blockDelta(1, { type: 'text_delta', text: 'hi' }),
        blockStop(1),
        ...messageEnd('end_turn'),
      ])
    );
    const events = await collect(provider(fetchFn));
    expect(events.slice(0, 2)).toEqual([
      { type: 'reasoning_delta', text: '', signature: 'abc' },
      { type: 'text_delta', text: 'hi' },
    ]);
  });

  it.each<[string, string]>([
    ['end_turn', 'end'],
    ['stop_sequence', 'end'],
    ['pause_turn', 'end'],
    ['tool_use', 'tool_calls'],
    ['max_tokens', 'max_tokens'],
    ['model_context_window_exceeded', 'max_tokens'],
    ['refusal', 'content_filter'],
  ])('maps stop_reason %s to %s', async (reason, stop) => {
    const events = await collect(
      provider(fakeFetch(sse([MESSAGE_START, ...messageEnd(reason)])))
    );
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: stop });
  });

  it('ignores ping and unknown events, and finishes without message_stop after a stop_reason', async () => {
    const fetchFn = fakeFetch(
      sse([
        MESSAGE_START,
        { type: 'ping' },
        { type: 'something_new', index: 0 },
        blockStart(0, { type: 'text', text: '' }),
        blockDelta(0, { type: 'citations_delta', citation: {} }),
        blockDelta(0, { type: 'text_delta', text: 'ok' }),
        blockStop(0),
        messageEnd('end_turn', 2)[0],
      ])
    );
    expect(await collect(provider(fetchFn))).toEqual([
      { type: 'text_delta', text: 'ok' },
      { type: 'usage', inputTokens: 10, outputTokens: 2 },
      { type: 'done', stopReason: 'end' },
    ]);
  });
});
