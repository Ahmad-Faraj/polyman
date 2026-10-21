import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLab, GitLabError, SERVER_RETRIES, finishedJobs } from '../src/gitlab.ts';

const BASE = 'https://gitlab.test/api/v4';
const baseEnv = { CI_API_V4_URL: BASE, CI_PROJECT_ID: 'group/proj' };

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect?: string;
}

/** Fakes fetch: `replies` are returned in order, and every request is recorded. */
function fakeFetch(...replies: Response[]) {
  const seen: Seen[] = [];
  const queue = [...replies];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; redirect?: string } = {}) => {
      seen.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, redirect: init.redirect });
      const next = queue.shift();
      if (!next) throw new Error('unexpected extra request');
      return next;
    }),
  );
  return seen;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

afterEach(() => vi.unstubAllGlobals());

/** `n` replies, made fresh: a Response body can be read once */
const times = (n: number, reply: () => Response) => Array.from({ length: n }, reply);

describe('GitLab client construction', () => {
  it('needs the API URL and project ID', () => {
    expect(() => new GitLab({ CI_PROJECT_ID: '1' })).toThrow('CI_API_V4_URL');
    expect(() => new GitLab({ CI_API_V4_URL: BASE })).toThrow('CI_PROJECT_ID');
  });

  it('no longer requires AUTONOMY_BOT_TOKEN', () => {
    expect(() => new GitLab(baseEnv)).not.toThrow();
  });
});

describe('GitLab client auth header', () => {
  it('uses the job token when only CI_JOB_TOKEN is set', async () => {
    const seen = fakeFetch(json({}));
    await new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job-secret' }).get('/:project/merge_requests/1');
    expect(seen[0].headers['JOB-TOKEN']).toBe('job-secret');
    expect(seen[0].headers).not.toHaveProperty('PRIVATE-TOKEN');
  });

  it('uses AUTONOMY_BOT_TOKEN as PRIVATE-TOKEN when set', async () => {
    const seen = fakeFetch(json({}));
    await new GitLab({ ...baseEnv, AUTONOMY_BOT_TOKEN: 'bot-secret' }).get('/:project/x');
    expect(seen[0].headers['PRIVATE-TOKEN']).toBe('bot-secret');
    expect(seen[0].headers).not.toHaveProperty('JOB-TOKEN');
  });

  it('prefers AUTONOMY_BOT_TOKEN over CI_JOB_TOKEN and never sends both', async () => {
    const seen = fakeFetch(json({}));
    await new GitLab({ ...baseEnv, AUTONOMY_BOT_TOKEN: 'bot-secret', CI_JOB_TOKEN: 'job-secret' }).get('/:project/x');
    expect(seen[0].headers).toMatchObject({ 'PRIVATE-TOKEN': 'bot-secret' });
    expect(JSON.stringify(seen[0].headers)).not.toContain('job-secret');
  });

  it('sends no credentials when neither token is set', async () => {
    const seen = fakeFetch(json({}));
    await new GitLab(baseEnv).get('/:project/x');
    expect(Object.keys(seen[0].headers)).toEqual(['Content-Type']);
  });

  it('treats empty token variables as not set', async () => {
    const seen = fakeFetch(json({}));
    await new GitLab({ ...baseEnv, AUTONOMY_BOT_TOKEN: '', CI_JOB_TOKEN: 'job-secret' }).get('/:project/x');
    expect(seen[0].headers['JOB-TOKEN']).toBe('job-secret');
    const seen2 = fakeFetch(json({}));
    await new GitLab({ ...baseEnv, AUTONOMY_BOT_TOKEN: '', CI_JOB_TOKEN: '' }).get('/:project/x');
    expect(Object.keys(seen2[0].headers)).toEqual(['Content-Type']);
  });

  it('expands :project to the URL-encoded project ID', async () => {
    const seen = fakeFetch(json({}));
    await new GitLab({ ...baseEnv, CI_JOB_TOKEN: 't' }).get('/:project/merge_requests/1');
    expect(seen[0].url).toBe(`${BASE}/projects/group%2Fproj/merge_requests/1`);
  });
});

describe('GitLab anonymous GET retry', () => {
  const withJobToken = () => new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job-secret' });

  it.each([401, 403])('retries a GET without credentials after a %i and returns its data', async (status) => {
    const seen = fakeFetch(json({ message: 'denied' }, status), json({ id: 7 }));
    await expect(withJobToken().get('/:project/merge_requests/7')).resolves.toEqual({ id: 7 });
    expect(seen).toHaveLength(2);
    expect(seen[1].url).toBe(seen[0].url);
    expect(seen[1].method).toBe('GET');
    expect(seen[1].headers).toEqual({});
    expect(JSON.stringify(seen[1])).not.toContain('job-secret');
  });

  it('does not send the bot token on the anonymous retry either', async () => {
    const seen = fakeFetch(json({}, 403), json([]));
    await new GitLab({ ...baseEnv, AUTONOMY_BOT_TOKEN: 'bot-secret' }).get('/:project/x');
    expect(seen[1].headers).toEqual({});
  });

  it('returns undefined when the anonymous retry succeeds with an empty body', async () => {
    fakeFetch(json({}, 401), new Response('', { status: 200 }));
    await expect(withJobToken().get('/:project/x')).resolves.toBeUndefined();
  });

  it('throws the original error when the anonymous retry also fails', async () => {
    const seen = fakeFetch(json({ message: '403 Forbidden' }, 403), json({ message: '404 Not Found' }, 404));
    const err = await withJobToken().get('/:project/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitLabError);
    expect(err).toMatchObject({ status: 403 });
    expect((err as Error).message).toContain('403 Forbidden');
    expect(seen).toHaveLength(2);
  });

  it('throws when the anonymous retry fails with 401 as well', async () => {
    fakeFetch(json({ message: 'a' }, 401), json({ message: 'b' }, 401));
    await expect(withJobToken().get('/:project/x')).rejects.toMatchObject({ status: 401 });
  });

  it.each([
    ['POST', 'post'],
    ['PUT', 'put'],
  ] as const)('does not retry a %s after a 403', async (method, fn) => {
    const seen = fakeFetch(json({ message: 'denied' }, 403), json({}));
    await expect(withJobToken()[fn]('/:project/merge_requests/1/notes', { body: 'x' })).rejects.toMatchObject({ status: 403 });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe(method);
  });

  it('does not retry a GET after a 404', async () => {
    const seen = fakeFetch(json({ message: 'nope' }, 404), json({}));
    await expect(withJobToken().get('/:project/x')).rejects.toMatchObject({ status: 404 });
    expect(seen).toHaveLength(1);
  });

  it.each([500, 502])('a GET after a %i is an outage, not a refusal: sent again with the token, never anonymously', async (status) => {
    const seen = fakeFetch(...times(SERVER_RETRIES.times + 1, () => json({ message: 'nope' }, status)));
    await expect(withJobToken().get('/:project/x')).rejects.toMatchObject({ status });
    expect(seen).toHaveLength(SERVER_RETRIES.times + 1);
    for (const s of seen) expect(s.headers['JOB-TOKEN']).toBe('job-secret');
  });

  it('does not retry when there were no credentials to drop', async () => {
    const seen = fakeFetch(json({ message: 'denied' }, 401), json({}));
    await expect(new GitLab(baseEnv).get('/:project/x')).rejects.toMatchObject({ status: 401 });
    expect(seen).toHaveLength(1);
  });

  it('does not retry a successful GET', async () => {
    const seen = fakeFetch(json([1, 2]));
    await expect(withJobToken().get('/:project/x')).resolves.toEqual([1, 2]);
    expect(seen).toHaveLength(1);
  });
});

describe('GitLab anonymous retry warning', () => {
  const withJobToken = () => new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job-secret' });

  it('warns, naming the path, when it falls back to the public API', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeFetch(json({}, 403), json({ id: 1 }));
    await withJobToken().get('/:project/merge_requests/1/notes');
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0][0]);
    expect(msg).toContain('/:project/merge_requests/1/notes');
    expect(msg).toContain('public API');
    expect(msg).not.toContain('job-secret');
    warn.mockRestore();
  });

  it('does not warn when the first request works, or when the retry fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeFetch(json({ ok: 1 }));
    await withJobToken().get('/:project/x');
    fakeFetch(json({ message: 'denied' }, 403), json({ message: 'gone' }, 404));
    await expect(withJobToken().get('/:project/x')).rejects.toBeInstanceOf(GitLabError);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws the first reply (401), not the retry reply, when the retry also fails', async () => {
    fakeFetch(json({ message: 'token expired' }, 401), json({ message: 'not found' }, 404));
    const err = (await withJobToken().get('/:project/x').catch((e: unknown) => e)) as GitLabError;
    expect(err.status).toBe(401);
    expect(err.message).toContain('token expired');
    expect(err.message).not.toContain('not found');
  });

  it('throws the first reply even when the retry reply is a non-JSON error page', async () => {
    fakeFetch(json({ message: 'forbidden' }, 403), ...times(SERVER_RETRIES.times + 1, () => new Response('<html>oops</html>', { status: 502 })));
    await expect(withJobToken().get('/:project/x')).rejects.toMatchObject({ status: 403 });
  });
});

describe('GitLab non-JSON replies', () => {
  const client = () => new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job-secret' });

  it('reports a 200 with an HTML body as "expected JSON" with the status and path', async () => {
    fakeFetch(new Response('<html>Sign in</html>', { status: 200 }));
    const err = (await client().get('/:project/x').catch((e: unknown) => e)) as GitLabError;
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.status).toBe(200);
    expect(err.message).toContain('expected JSON, got: <html>Sign in</html>');
    expect(err.message).toContain('GET /:project/x');
  });

  it('only quotes the first 100 characters of the body', async () => {
    fakeFetch(new Response('x'.repeat(100) + 'TAIL', { status: 200 }));
    const err = (await client().get('/:project/x').catch((e: unknown) => e)) as GitLabError;
    expect(err.message).toContain('x'.repeat(100));
    expect(err.message).not.toContain('TAIL');
  });

  it('also checks the body of a successful POST', async () => {
    fakeFetch(new Response('created!', { status: 201 }));
    await expect(client().post('/:project/x', {})).rejects.toMatchObject({ status: 201 });
  });

  it('checks the body of a successful anonymous retry too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeFetch(json({}, 403), new Response('<html>login</html>', { status: 200 }));
    await expect(client().get('/:project/x')).rejects.toThrow(/expected JSON/);
    warn.mockRestore();
  });

  it('still returns undefined for an empty body and parsed data for valid JSON', async () => {
    fakeFetch(new Response(null, { status: 204 }));
    await expect(client().get('/:project/x')).resolves.toBeUndefined();
    fakeFetch(json({ a: [1] }));
    await expect(client().get('/:project/x')).resolves.toEqual({ a: [1] });
  });

  it('an error status with a non-JSON body still reports the error status and body', async () => {
    fakeFetch(...times(SERVER_RETRIES.times + 1, () => new Response('Bad Gateway', { status: 502 })));
    await expect(client().get('/:project/x')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('Bad Gateway') });
  });
});

describe('GitLab client no longer writes MR notes on its own', () => {
  it('has no upsertMrNote', () => {
    expect('upsertMrNote' in GitLab.prototype).toBe(false);
  });
});

describe('GitLab client and redirects', () => {
  it('refuses redirects on every request that carries a token, GET, POST and PUT', async () => {
    const seen = fakeFetch(json({}), json({}), json({}));
    const gl = new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job' });
    await gl.get('/x');
    await gl.post('/x', {});
    await gl.put('/x', {});
    expect(seen.map((r) => r.redirect)).toEqual(['error', 'error', 'error']);
  });

  it('sends no credentials on the anonymous retry', async () => {
    const seen = fakeFetch(json({ message: '401' }, 401), json({ ok: true }));
    await new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job' }).get('/x');
    expect(seen[1].headers).toEqual({});
  });
});

describe("GitLab.com's rate limit", () => {
  const limited = () => new Response('{"message":"Rate limit exceeded"}', { status: 429, headers: { 'Retry-After': '0' } });

  it('waits as long as a 429 asks and sends the request again', async () => {
    const seen = fakeFetch(limited(), json({ iid: 7 }));
    expect(await new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job' }).get('/:project/merge_requests/7')).toEqual({ iid: 7 });
    expect(seen).toHaveLength(2);
  });

  it('does the same for the public retry, and says it was the limit when that runs out', async () => {
    fakeFetch(json({}, 401), limited(), limited(), limited(), limited());
    const err = (await new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job' }).get('/:project/merge_requests/7/notes').catch((e: unknown) => e)) as GitLabError;
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.status).toBe(429);
  });
});

describe('server errors and dropped connections (#98)', () => {
  const failed = (status = 500) => new Response('Internal Server Error', { status });
  /** like fakeFetch, but a reply that is an Error is thrown, as fetch does when a connection drops */
  function flakyFetch(...replies: (Response | Error)[]) {
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { method?: string } = {}) => {
        seen.push(init.method ?? 'GET');
        const next = replies.shift();
        if (!next) throw new Error('unexpected extra request');
        if (next instanceof Error) throw next;
        return next;
      }),
    );
    return seen;
  }

  it('sends a read again after a 5xx', async () => {
    const seen = flakyFetch(failed(500), failed(503), json({ tier: 'low' }));
    expect(await new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job' }).get('/:project/jobs/1/artifacts/risk-report.json')).toEqual({ tier: 'low' });
    expect(seen).toEqual(['GET', 'GET', 'GET']);
  });

  it('sends a read again after the connection drops', async () => {
    const seen = flakyFetch(new TypeError('fetch failed'), json({ iid: 7 }));
    expect(await new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job' }).get('/:project/merge_requests/7')).toEqual({ iid: 7 });
    expect(seen).toHaveLength(2);
  });

  it(`gives up after ${SERVER_RETRIES.times} more tries and reports the server error`, async () => {
    const seen = flakyFetch(failed(), failed(), failed(), failed());
    const err = (await new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job' }).get('/:project/jobs/1/artifacts/x.json').catch((e: unknown) => e)) as GitLabError;
    expect(err).toBeInstanceOf(GitLabError);
    expect(err.status).toBe(500);
    expect(seen).toHaveLength(SERVER_RETRIES.times + 1);
  });

  it('passes the last dropped connection on, not a made-up answer', async () => {
    flakyFetch(...Array.from({ length: SERVER_RETRIES.times + 1 }, () => new TypeError('fetch failed')));
    await expect(new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job' }).get('/:project/merge_requests/7')).rejects.toThrow('fetch failed');
  });

  it('the anonymous fallback also tries a read again after a 5xx', async () => {
    const seen = flakyFetch(json({ message: '403 Forbidden' }, 403), failed(503), json({ id: 1 }));
    expect(await new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job' }).get('/:project/merge_requests/1/notes')).toEqual({ id: 1 });
    expect(seen).toEqual(['GET', 'GET', 'GET']);
  });

  it('a 429 then a 5xx still ends in the answer: the rate-limit re-send is a read too', async () => {
    const limited = new Response('{"message":"Rate limit exceeded"}', { status: 429, headers: { 'Retry-After': '0' } });
    const seen = flakyFetch(limited, failed(500), json({ iid: 7 }));
    expect(await new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job' }).get('/:project/merge_requests/7')).toEqual({ iid: 7 });
    expect(seen).toHaveLength(3);
  });

  it('never sends a write twice: it may have happened before the error', async () => {
    const seen = flakyFetch(failed());
    const err = (await new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job' }).post('/:project/releases', { tag_name: 'v1' }).catch((e: unknown) => e)) as GitLabError;
    expect(err.status).toBe(500);
    expect(seen).toEqual(['POST']);
  });

  it('a 4xx is an answer, not an outage: it is not sent again', async () => {
    const seen = flakyFetch(json({ message: '404 Not found' }, 404));
    const err = (await new GitLab({ ...baseEnv, CI_JOB_TOKEN: 'job' }).get('/:project/jobs/1/artifacts/x.json').catch((e: unknown) => e)) as GitLabError;
    expect(err.status).toBe(404);
    expect(seen).toHaveLength(1);
  });
});

describe('finishedJobs', () => {
  const jobs = (n: number, duration: number | null = 30) => Array.from({ length: n }, (_, i) => ({ name: `j${i}`, status: 'success', duration }));
  /** a client whose pages come from `pages[pipeline]`, in order */
  const fake = (pages: Record<number, unknown[][]>) => {
    const seen: string[] = [];
    return {
      seen,
      get: async <T>(path: string) => {
        seen.push(path);
        const [, id, n] = path.match(/pipelines\/(\d+)\/jobs\?per_page=100&include_retried=true&page=(\d+)$/)!;
        return (pages[Number(id)][Number(n) - 1] ?? []) as T;
      },
    };
  };

  it('asks for the next page only after a full one', async () => {
    const full = fake({ 1: [jobs(100), []] });
    expect(await finishedJobs(full, [1])).toHaveLength(100);
    expect(full.seen).toEqual(['/:project/pipelines/1/jobs?per_page=100&include_retried=true&page=1', '/:project/pipelines/1/jobs?per_page=100&include_retried=true&page=2']);
    const short = fake({ 1: [jobs(99)] });
    expect(await finishedJobs(short, [1])).toHaveLength(99);
    expect(short.seen).toHaveLength(1);
  });

  it('fails on a page that is not a list, instead of counting nothing', async () => {
    await expect(finishedJobs(fake({ 1: [{} as unknown as unknown[]] }), [1])).rejects.toThrow(/jobs\?per_page=100&include_retried=true&page=1 did not return a list: \{\}/);
  });

  it('reads every page of every pipeline, and leaves out jobs with no runner time', async () => {
    const gl = fake({ 1: [jobs(100), [...jobs(2), ...jobs(3, null), ...jobs(1, 0)]], 2: [jobs(4)] });
    const got = await finishedJobs(gl, [1, 2]);
    expect(got).toHaveLength(106);
    expect(got.every((j) => j.duration === 30)).toBe(true);
    expect(gl.seen).toHaveLength(3);
  });
});
