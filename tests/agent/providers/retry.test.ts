import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MockProvider } from '../../../src/agent/providers/mock';
import { OpenAICompatibleProvider } from '../../../src/agent/providers/openai-compatible';
import {
  redact,
  retryDelay,
  sleep,
  withRetries,
  type RetryInfo,
  type RetryOptions,
} from '../../../src/agent/providers/retry';
import {
  ProviderError,
  type ChatRequest,
  type ModelInfo,
  type Provider,
  type StreamEvent,
} from '../../../src/agent/providers/types';
import { fixtureResponse, readFixture } from '../../fixtures/agent';

function request(text = 'hi'): ChatRequest {
  return {
    model: 'gpt-4.1-mini',
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

/** Starts a promise and keeps its result, so a rejection is never unhandled. */
function settle<T>(promise: Promise<T>) {
  const state: { value?: T; error?: unknown; done: boolean } = { done: false };
  const finished = promise.then(
    value => {
      state.value = value;
      state.done = true;
    },
    (error: unknown) => {
      state.error = error;
      state.done = true;
    }
  );
  return { state, finished };
}

const noStream: Provider['stream'] = (req, signal) =>
  new MockProvider([]).stream(req, signal);

const err = (
  kind: ConstructorParameters<typeof ProviderError>[0],
  message = `${kind} failed`,
  opts: ConstructorParameters<typeof ProviderError>[2] = {}
) => new ProviderError(kind, message, opts);

/** No jitter, so the delays are exact. */
const EXACT: RetryOptions = { random: () => 0 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('withRetries: retryable errors', () => {
  it('retries the 429 fixture after its retry-after, then streams the answer', async () => {
    const responses = [
      () => fixtureResponse(readFixture('openai', 'error')),
      () => fixtureResponse(readFixture('openai', 'text')),
    ];
    const fetchFn = vi.fn(() => {
      const next = responses.shift();
      if (!next) throw new Error('no response left');
      return Promise.resolve(next());
    });
    const onRetry = vi.fn<(info: RetryInfo) => void>();
    const provider = withRetries(
      new OpenAICompatibleProvider({
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test',
        fetch: fetchFn as never,
      }),
      { ...EXACT, onRetry }
    );

    const run = settle(collect(provider));
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(run.state.done).toBe(false);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ retry: 1, delayMs: 1000 })
    );
    expect(onRetry.mock.calls[0]?.[0].error.kind).toBe('rate_limit');

    await vi.advanceTimersByTimeAsync(1);
    await run.finished;
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(run.state.error).toBeUndefined();
    expect(run.state.value?.at(-1)).toEqual({
      type: 'done',
      stopReason: 'end',
    });
  });

  describe('429 with a retry-after header', () => {
    function rateLimited(headers: Record<string, string>) {
      const responses = [
        () =>
          new Response(
            JSON.stringify({ error: { message: 'Rate limit reached' } }),
            {
              status: 429,
              headers: { 'content-type': 'application/json', ...headers },
            }
          ),
        () => fixtureResponse(readFixture('openai', 'text')),
      ];
      const fetchFn = vi.fn(() => {
        const next = responses.shift();
        if (!next) throw new Error('no response left');
        return Promise.resolve(next());
      });
      const onRetry = vi.fn<(info: RetryInfo) => void>();
      const provider = withRetries(
        new OpenAICompatibleProvider({
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'test-key',
          fetch: fetchFn as never,
        }),
        { ...EXACT, onRetry }
      );
      return { fetchFn, onRetry, run: settle(collect(provider)) };
    }

    it.each([
      ['retry-after: 3', { 'retry-after': '3' }, 3000],
      ['retry-after-ms: 2500', { 'retry-after-ms': '2500' }, 2500],
    ])('waits the %s, not the backoff', async (_name, headers, wait) => {
      const { fetchFn, onRetry, run } = rateLimited(headers);

      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(run.state.done).toBe(false);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry.mock.calls[0]?.[0]).toMatchObject({
        retry: 1,
        delayMs: wait,
      });

      await vi.advanceTimersByTimeAsync(1);
      await run.finished;
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(run.state.error).toBeUndefined();
      expect(run.state.value?.at(-1)).toEqual({
        type: 'done',
        stopReason: 'end',
      });
    });

    it('retries at once on retry-after: 0', async () => {
      const { fetchFn, onRetry, run } = rateLimited({ 'retry-after': '0' });

      await vi.advanceTimersByTimeAsync(0);
      await run.finished;
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(onRetry.mock.calls[0]?.[0].delayMs).toBe(0);
      expect(run.state.error).toBeUndefined();
    });
  });

  it('backs off 1s, 2s, 4s on server errors, then succeeds', async () => {
    const mock = new MockProvider([
      { error: err('server') },
      { error: err('network') },
      { error: err('rate_limit') },
      { text: 'ok' },
    ]);
    const delays: number[] = [];
    const provider = withRetries(mock, {
      ...EXACT,
      onRetry: info => delays.push(info.delayMs),
    });

    const run = settle(collect(provider));
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 - 1);
    expect(run.state.done).toBe(false);
    expect(mock.requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await run.finished;

    expect(delays).toEqual([1000, 2000, 4000]);
    expect(mock.requests).toHaveLength(4);
    expect(run.state.value).toEqual([
      { type: 'text_delta', text: 'ok' },
      { type: 'done', stopReason: 'end' },
    ]);
  });

  it('gives up after 3 retries with the last error', async () => {
    const mock = new MockProvider([
      { error: err('server', 'HTTP 503: down') },
      { error: err('server', 'HTTP 503: down') },
      { error: err('server', 'HTTP 503: down') },
      { error: err('server', 'HTTP 503: still down', { status: 503 }) },
    ]);
    const run = settle(collect(withRetries(mock, EXACT)));
    await vi.advanceTimersByTimeAsync(7000);
    await run.finished;

    expect(mock.requests).toHaveLength(4);
    expect(mock.remaining).toBe(0);
    const error = run.state.error as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('server');
    expect(error.status).toBe(503);
    expect(error.retryable).toBe(false);
    expect(error.message).toBe(
      'HTTP 503: still down (gave up after 3 retries)'
    );
  });

  it('follows maxRetries', async () => {
    const mock = new MockProvider([
      { error: err('server') },
      { error: err('server') },
    ]);
    const run = settle(collect(withRetries(mock, { ...EXACT, maxRetries: 1 })));
    await vi.advanceTimersByTimeAsync(1000);
    await run.finished;
    expect(mock.requests).toHaveLength(2);
    expect((run.state.error as Error).message).toContain(
      'gave up after 1 retry)'
    );
  });

  it('does not wait a retry-after longer than maxDelayMs', async () => {
    const mock = new MockProvider([
      { error: err('rate_limit', 'HTTP 429', { retryAfterMs: 120_000 }) },
      { text: 'never' },
    ]);
    const run = settle(collect(withRetries(mock, { maxDelayMs: 30_000 })));
    await run.finished;
    expect(mock.requests).toHaveLength(1);
    const error = run.state.error as ProviderError;
    expect(error.kind).toBe('rate_limit');
    expect(error.message).toBe(
      'HTTP 429 (the server asked to wait 120s, more than the 30s limit)'
    );
  });
});

describe('retryDelay', () => {
  it('uses retry-after when the error has it', () => {
    expect(retryDelay(err('rate_limit', 'x', { retryAfterMs: 2500 }), 0)).toBe(
      2500
    );
    expect(retryDelay(err('rate_limit', 'x', { retryAfterMs: 0 }), 2)).toBe(0);
  });

  it('doubles the backoff and adds jitter', () => {
    const server = err('server');
    expect(retryDelay(server, 0, EXACT)).toBe(1000);
    expect(retryDelay(server, 1, EXACT)).toBe(2000);
    expect(retryDelay(server, 2, EXACT)).toBe(4000);
    expect(retryDelay(server, 0, { random: () => 0.5 })).toBe(1100);
    expect(retryDelay(server, 2, { random: () => 0.99, jitter: 0.5 })).toBe(
      5980
    );
  });

  it('cuts the backoff to maxDelayMs', () => {
    expect(
      retryDelay(err('server'), 3, {
        ...EXACT,
        maxRetries: 10,
        maxDelayMs: 5000,
      })
    ).toBe(5000);
  });

  it('gives up on errors that are not retryable', () => {
    expect(retryDelay(err('auth'), 0)).toEqual({ giveUp: '' });
    expect(retryDelay(err('server', 'x', { retryable: false }), 0)).toEqual({
      giveUp: '',
    });
  });
});

describe('withRetries: errors that are not retried', () => {
  it.each(['bad_request', 'tools_not_supported'] as const)(
    'throws %s at once',
    async kind => {
      const error = err(kind);
      const mock = new MockProvider([{ error }, { text: 'never' }]);
      await expect(collect(withRetries(mock))).rejects.toBe(error);
      expect(mock.requests).toHaveLength(1);
    }
  );

  it('never retries a stream that broke after its first event', async () => {
    const mock = new MockProvider([
      { text: 'Hello! I can', error: err('server', 'Overloaded') },
      { text: 'never' },
    ]);
    const seen: StreamEvent[] = [];
    const run = async () => {
      for await (const e of withRetries(mock).stream(
        request(),
        new AbortController().signal
      )) {
        seen.push(e);
      }
    };
    const error = await run().catch((e: unknown) => e);

    expect(seen).toEqual([{ type: 'text_delta', text: 'Hello! I can' }]);
    expect(mock.requests).toHaveLength(1);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'server', retryable: false });
    expect((error as Error).message).toBe(
      'the mock stream broke in the middle of the turn, so it was not retried: Overloaded'
    );
  });

  it('passes errors that are not a ProviderError through', async () => {
    const mock = new MockProvider([]);
    await expect(collect(withRetries(mock))).rejects.toThrow(
      'MockProvider: no step left'
    );
  });
});

describe('withRetries: auth errors', () => {
  const KEY = 'sk-proj-Abc123def456Ghi789';

  function openai(status: number, message: string): Provider {
    const fetchFn = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message } }), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      )
    );
    return new OpenAICompatibleProvider({
      id: 'openai',
      baseUrl: 'https://api.example.com/v1',
      apiKey: KEY,
      fetch: fetchFn as never,
    });
  }

  it('gives a clear message with no key in it, and does not retry', async () => {
    const inner = openai(401, `Incorrect API key provided: ${KEY}.`);
    const error = await collect(withRetries(inner, { secrets: [KEY] })).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ kind: 'auth', status: 401 });
    const message = (error as Error).message;
    expect(message).toBe(
      'openai rejected the API key (HTTP 401). Check that the key is right and can use this model. The server said: Incorrect API key provided: ***.'
    );
    expect(message).not.toContain('Abc123');
  });

  it('hides a masked key echoed by the server even without secrets', async () => {
    const inner = openai(
      401,
      'Incorrect API key provided: sk-proj-Abc1*****************i789. You can find your API key at https://platform.openai.com/account/api-keys.'
    );
    const error = (await collect(withRetries(inner)).catch(
      (e: unknown) => e
    )) as Error;
    expect(error.message).not.toContain('Abc1');
    expect(error.message).not.toContain('i789');
    expect(error.message).toContain('Incorrect API key provided: ***.');
    expect(error.message).toContain('(HTTP 401)');
  });

  it('says forbidden keys clearly too', async () => {
    const error = (await collect(withRetries(openai(403, 'Forbidden'))).catch(
      (e: unknown) => e
    )) as Error;
    expect(error.message).toBe(
      'openai rejected the API key (HTTP 403). Check that the key is right and can use this model. The server said: Forbidden'
    );
  });
});

describe('redact', () => {
  it('hides the given secrets and strings that look like keys', () => {
    expect(redact('key is my-secret-value', ['my-secret-value'])).toBe(
      'key is ***'
    );
    expect(redact('got sk-abc123456 and gsk_ABCDEF123', [])).toBe(
      'got *** and ***'
    );
    expect(redact('AIzaSyA1234567890abcdef here', [])).toBe('*** here');
    expect(redact('token ' + 'a'.repeat(48) + ' end', [])).toBe(
      'token *** end'
    );
  });

  it('keeps normal text', () => {
    const text =
      'Rate limit reached for gpt-4.1-mini in organization org-polymanTest';
    expect(redact(text, [])).toBe(text);
  });

  // Long runs of key characters count as a token (40+ chars), so those inputs
  // come back as `***`; what matters here is that it takes no time.
  it.each([
    ['letters', 'a'.repeat(100_000), '***'],
    ['letters and dashes', 'a-'.repeat(50_000), '***-'],
    ['dashes', '-'.repeat(100_000), '-'.repeat(100_000)],
  ])('is fast on long input: %s', (_name, text, expected) => {
    const start = performance.now();
    const out = redact(text, []);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(200);
    expect(out === expected).toBe(true);
  });
});

describe('withRetries: context_too_long', () => {
  it('calls onContextTooLong once and tries the smaller request', async () => {
    const tooLong = err('context_too_long', 'HTTP 400: too many tokens');
    const mock = new MockProvider([{ error: tooLong }, { text: 'ok' }]);
    const smaller = request('short');
    const onContextTooLong = vi.fn(() => Promise.resolve(smaller));

    const events = await collect(withRetries(mock, { onContextTooLong }));

    expect(onContextTooLong).toHaveBeenCalledTimes(1);
    expect(onContextTooLong).toHaveBeenCalledWith(
      request(),
      tooLong,
      expect.any(AbortSignal)
    );
    expect(mock.requests[1]).toBe(smaller);
    expect(events[0]).toEqual({ type: 'text_delta', text: 'ok' });
  });

  it('gives up when the smaller request is still too long', async () => {
    const mock = new MockProvider([
      { error: err('context_too_long', 'HTTP 400: too many tokens') },
      { error: err('context_too_long', 'HTTP 400: too many tokens') },
      { text: 'never' },
    ]);
    const onContextTooLong = vi.fn((req: ChatRequest) => req);

    const error = (await collect(withRetries(mock, { onContextTooLong })).catch(
      (e: unknown) => e
    )) as ProviderError;

    expect(onContextTooLong).toHaveBeenCalledTimes(1);
    expect(mock.requests).toHaveLength(2);
    expect(error.kind).toBe('context_too_long');
    expect(error.message).toBe(
      'HTTP 400: too many tokens (still too long after compacting)'
    );
  });

  it('gives up when the hook returns undefined, or there is no hook', async () => {
    const tooLong = err('context_too_long');
    const withHook = new MockProvider([{ error: tooLong }, { text: 'never' }]);
    await expect(
      collect(withRetries(withHook, { onContextTooLong: () => undefined }))
    ).rejects.toBe(tooLong);
    expect(withHook.requests).toHaveLength(1);

    const noHook = new MockProvider([{ error: tooLong }, { text: 'never' }]);
    await expect(collect(withRetries(noHook))).rejects.toBe(tooLong);
    expect(noHook.requests).toHaveLength(1);
  });
});

describe('withRetries: abort', () => {
  it('stops waiting when the signal aborts', async () => {
    const mock = new MockProvider([
      { error: err('server') },
      { text: 'never' },
    ]);
    const controller = new AbortController();
    const run = settle(
      collect(withRetries(mock, EXACT), request(), controller.signal)
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(run.state.done).toBe(false);

    controller.abort();
    await run.finished;
    expect(run.state.error).toMatchObject({ name: 'AbortError' });
    expect(run.state.error).not.toBeInstanceOf(ProviderError);
    expect(mock.requests).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry when already aborted', async () => {
    const mock = new MockProvider([{ text: 'never' }]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      collect(withRetries(mock), request(), controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mock.requests).toHaveLength(0);
  });

  it('sleep rejects at once on an aborted signal and resolves after ms', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1000, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(vi.getTimerCount()).toBe(0);

    const run = settle(sleep(1000, new AbortController().signal));
    await vi.advanceTimersByTimeAsync(1000);
    await run.finished;
    expect(run.state.error).toBeUndefined();
  });
});

describe('withRetries: listModels', () => {
  it('retries listModels and keeps the provider id', async () => {
    const models: ModelInfo[] = [{ id: 'gpt-4.1-mini' }];
    const listModels = vi
      .fn<(signal: AbortSignal) => Promise<ModelInfo[]>>()
      .mockRejectedValueOnce(err('network'))
      .mockResolvedValueOnce(models);
    const provider = withRetries(
      { id: 'openai', stream: noStream, listModels },
      EXACT
    );
    expect(provider.id).toBe('openai');

    const run = settle(provider.listModels!(new AbortController().signal));
    await vi.advanceTimersByTimeAsync(1000);
    await run.finished;
    expect(listModels).toHaveBeenCalledTimes(2);
    expect(run.state.value).toBe(models);
  });

  it('gives a clear auth message from listModels', async () => {
    const listModels = vi.fn(() =>
      Promise.reject(err('auth', 'HTTP 401', { status: 401 }))
    );
    const provider = withRetries({
      id: 'groq',
      stream: noStream,
      listModels,
    });
    await expect(
      provider.listModels!(new AbortController().signal)
    ).rejects.toThrow(
      'groq rejected the API key (HTTP 401). Check that the key is right and can use this model.'
    );
    expect(listModels).toHaveBeenCalledTimes(1);
  });

  it('has no listModels when the provider has none', () => {
    expect('listModels' in withRetries(new MockProvider([]))).toBe(false);
  });
});
