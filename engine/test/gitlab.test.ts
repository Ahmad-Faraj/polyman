import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLab, GitLabError } from '../src/gitlab.ts';

const BASE = 'https://gitlab.test/api/v4';
const baseEnv = { CI_API_V4_URL: BASE, CI_PROJECT_ID: 'group/proj' };

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/** Fakes fetch: `replies` are returned in order, and every request is recorded. */
function fakeFetch(...replies: Response[]) {
  const seen: Seen[] = [];
  const queue = [...replies];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      seen.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {} });
      const next = queue.shift();
      if (!next) throw new Error('unexpected extra request');
      return next;
    }),
  );
  return seen;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

afterEach(() => vi.unstubAllGlobals());

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

  it.each([404, 500, 502])('does not retry a GET after a %i', async (status) => {
    const seen = fakeFetch(json({ message: 'nope' }, status), json({}));
    await expect(withJobToken().get('/:project/x')).rejects.toMatchObject({ status });
    expect(seen).toHaveLength(1);
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
    fakeFetch(json({ message: 'forbidden' }, 403), new Response('<html>oops</html>', { status: 502 }));
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
    fakeFetch(new Response('Bad Gateway', { status: 502 }));
    await expect(client().get('/:project/x')).rejects.toMatchObject({ status: 502, message: expect.stringContaining('Bad Gateway') });
  });
});

describe('GitLab client no longer writes MR notes on its own', () => {
  it('has no upsertMrNote', () => {
    expect('upsertMrNote' in GitLab.prototype).toBe(false);
  });
});
