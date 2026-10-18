import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitlabUrl, tokenFetch } from '../src/project.ts';

afterEach(() => vi.unstubAllGlobals());

describe('requests that carry a token', () => {
  it('refuse redirects and keep everything else the caller set', async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response('{}');
    });
    await tokenFetch('https://gitlab.test/api/v4/x', { method: 'POST', headers: { 'PRIVATE-TOKEN': 't' }, redirect: 'follow' });
    expect(seen[0]).toMatchObject({ method: 'POST', headers: { 'PRIVATE-TOKEN': 't' }, redirect: 'error' });
  });

  it('go through tokenFetch everywhere: the only bare fetch calls send no credentials', () => {
    const dir = 'src';
    const files = [...readdirSync(dir).map((f) => join(dir, f)), ...readdirSync(join(dir, 'cli')).map((f) => join(dir, 'cli', f))].filter((f) => f.endsWith('.ts'));
    const bare = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .filter((line) => /\bawait fetch\(/.test(line))
        .map((line) => `${f}: ${line.trim()}`),
    );
    // the anonymous retry in gitlab.ts and the go-ahead guard's anonymous GraphQL read
    expect(bare).toEqual(['src/gitlab.ts: const anon = await fetch(url);', 'src/cli/goahead.ts: const res = await fetch(url, {']);
  });
});

describe('gitlabUrl', () => {
  it('needs https and a host, and drops trailing slashes', () => {
    expect(gitlabUrl('https://gitlab.example.com//')).toBe('https://gitlab.example.com');
    expect(() => gitlabUrl('https://')).toThrow('with a host');
    expect(() => gitlabUrl('http://gitlab.example.com')).toThrow('refusing to send your token');
  });
});
