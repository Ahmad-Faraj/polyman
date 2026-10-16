import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchResult } from '../src/watch.ts';

// release.ts is a top-level script. Each test fakes the file system for
// health-report.json and the GitLab API, then imports the script fresh.

const files = vi.hoisted(() => ({ health: undefined as string | undefined, written: {} as Record<string, string> }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) =>
      path === 'health-report.json'
        ? files.health
        : (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof actual.readFileSync,
    writeFileSync: ((path: string, data: string) => {
      files.written[path] = String(data);
    }) as typeof actual.writeFileSync,
  };
});

const BASE = 'https://gitlab.test/api/v4';
const saved = { ...process.env };
let posts: { path: string; body: { description?: string } }[];
let mrNotes: { body: string; author: { username: string } }[] = [];

function fakeGitLab() {
  posts = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; body?: string }) => {
      const path = url.slice(BASE.length);
      const reply = (data: unknown) => new Response(JSON.stringify(data));
      if (init.method === 'POST') {
        posts.push({ path, body: JSON.parse(init.body ?? '{}') });
        return reply({});
      }
      if (path.includes('/repository/commits/')) {
        return reply([{ iid: 7, title: 'Add refunds', state: 'merged', labels: ['risk::high'], web_url: 'x', author: { username: 'dev' } }]);
      }
      if (path.includes('/notes')) return reply(mrNotes);
      return reply([]);
    }),
  );
}

async function runReport() {
  vi.resetModules();
  process.argv[2] = 'report';
  await import('../src/cli/release.ts');
  return posts.find((p) => p.path === '/projects/42/releases')?.body.description ?? '';
}

const result = (over: Partial<WatchResult> & { route?: string } = {}): WatchResult => ({
  item: { route: over.route ?? 'POST /api/payments/:id/refund', signal: 'error_rate', max: 0.02 },
  observed: 0.01,
  ok: true,
  source: 'review',
  ...over,
});
const health = (results: unknown) => JSON.stringify({ mr: 7, plan: [], results, routes: {} });

beforeEach(() => {
  files.health = undefined;
  files.written = {};
  mrNotes = [];
  process.env.CI_API_V4_URL = BASE;
  process.env.CI_PROJECT_ID = '42';
  process.env.CI_JOB_TOKEN = 'job';
  process.env.CI_COMMIT_SHA = 'abcdef1234567890';
  process.env.CI_PIPELINE_ID = '99';
  process.env.CI_PIPELINE_URL = 'https://gitlab.test/p/99';
  process.env.AUTONOMY_CONFIG = 'does-not-exist.yml';
  process.env.AUTONOMY_REVIEWER_ACCOUNT = 'ai-mr-reviewer-gitlab-ai-hackathon_dc1918';
  process.env.AUTONOMY_FIXER_ACCOUNT = 'ai-pipeline-fixer-gitlab-ai-hackathon';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fakeGitLab();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('release notes: production watch section', () => {
  it('says so when health-report.json is missing, and still publishes the release', async () => {
    const notes = await runReport();
    expect(notes).toContain('No production check results were found.');
    expect(notes).toContain('Release pipeline: https://gitlab.test/p/99');
  });

  it('lists review watch items with ok / over the limit and what production did', async () => {
    files.health = health([
      result({ observed: 0.01, ok: true }),
      result({ route: 'POST /api/auth/login', item: { route: 'POST /api/auth/login', signal: 'p95_ms', max: 300 }, observed: 450, ok: false }),
    ]);
    const notes = await runReport();
    expect(notes).toContain('**What the review asked us to watch, and what production did:**');
    expect(notes).toContain('- ok: POST /api/payments/:id/refund error rate 1.0% (limit 2.0%)');
    expect(notes).toContain('- over the limit: POST /api/auth/login p95 450 ms (limit 300 ms) - over the limit');
  });

  it('shows only review items when default checks are present too', async () => {
    files.health = health([
      result(),
      result({ route: 'GET /api/orders', item: { route: 'GET /api/orders', signal: 'error_rate', max: 0.05 }, source: 'default' }),
    ]);
    const notes = await runReport();
    expect(notes).toContain('refund error rate');
    expect(notes).not.toContain('GET /api/orders');
    expect(notes).not.toContain('default checks only');
  });

  it('reports a review item with no traffic as over the limit', async () => {
    files.health = health([result({ observed: null, ok: false })]);
    const notes = await runReport();
    expect(notes).toContain("- over the limit: POST /api/payments/:id/refund error rate: no traffic seen, can't confirm");
  });

  it('falls back to the default checks when the review had no watch list', async () => {
    files.health = health([
      result({ route: 'GET /api/orders', item: { route: 'GET /api/orders', signal: 'error_rate', max: 0.05 }, observed: 0.001, source: 'default' }),
    ]);
    const notes = await runReport();
    expect(notes).toContain('The review had no watch list; default checks only:');
    expect(notes).toContain('- ok: GET /api/orders error rate 0.1% (limit 5.0%)');
    expect(notes).not.toContain('What the review asked us to watch');
  });

  it('says nothing was checked when no traffic was recorded', async () => {
    files.health = health([]);
    const notes = await runReport();
    expect(notes).toContain('No traffic was recorded, so nothing was checked.');
    expect(notes).not.toMatch(/^- (ok|over the limit)/m);
  });

  it('still publishes the release when health-report.json is malformed', async () => {
    files.health = '{not json';
    const notes = await runReport();
    expect(notes).toContain('No production check results were found.');
    expect(posts.map((p) => p.path)).toEqual(['/projects/42/releases']);
  });

  it('still publishes the release when health-report.json has no results array', async () => {
    files.health = JSON.stringify({ mr: 7 });
    const notes = await runReport();
    expect(notes).toContain('No traffic was recorded, so nothing was checked.');
    expect(posts.map((p) => p.path)).toEqual(['/projects/42/releases']);
  });

  // a results value that isn't an array (here a string) used to throw in watchSection
  it('still publishes the release when results is a string, not an array', async () => {
    files.health = JSON.stringify({ mr: 7, results: 'oops' });
    const notes = await runReport();
    expect(posts.map((p) => p.path)).toEqual(['/projects/42/releases']);
    expect(notes).toContain('Release pipeline:');
  });

  it.each([[null], [{}], [0]])('treats results %j as no traffic recorded and still publishes', async (results) => {
    files.health = JSON.stringify({ mr: 7, results });
    const notes = await runReport();
    expect(notes).toContain('No traffic was recorded, so nothing was checked.');
    expect(posts.map((p) => p.path)).toEqual(['/projects/42/releases']);
  });

  it("says the review couldn't be read when planSource is unreadable, and still lists the default checks", async () => {
    files.health = JSON.stringify({
      mr: 7,
      planSource: 'unreadable',
      plan: [],
      results: [
        result({ route: 'GET /api/orders', item: { route: 'GET /api/orders', signal: 'error_rate', max: 0.05 }, observed: 0.001, source: 'default' }),
      ],
    });
    const notes = await runReport();
    expect(notes).toContain("The review couldn't be read after the release, so only the default checks ran.");
    expect(notes).toContain('The review had no watch list; default checks only:');
    expect(notes).toContain('- ok: GET /api/orders error rate 0.1% (limit 5.0%)');
  });

  it('labels a watched route with no traffic "not measured", not "ok" or "over the limit"', async () => {
    files.health = health([
      result({ observed: null, ok: true, unconfirmed: true }),
      result({ route: 'POST /api/auth/login', item: { route: 'POST /api/auth/login', signal: 'error_rate', max: 0.02 }, observed: 0.5, ok: false }),
    ]);
    const notes = await runReport();
    expect(notes).toContain("- not measured: POST /api/payments/:id/refund error rate: no traffic seen, can't confirm");
    expect(notes).toContain('- over the limit: POST /api/auth/login error rate 50.0%');
    expect(notes).not.toContain('- ok: POST /api/payments/:id/refund');
  });

  it.each(['review', 'none', undefined])('does not show the unreadable notice when planSource is %s', async (planSource) => {
    files.health = JSON.stringify({ mr: 7, planSource, plan: [], results: [result()] });
    const notes = await runReport();
    expect(notes).not.toContain("couldn't be read");
  });

  it('shows no unreadable notice when there were no results at all', async () => {
    files.health = JSON.stringify({ mr: 7, planSource: 'unreadable', results: [] });
    const notes = await runReport();
    expect(notes).toContain('No traffic was recorded, so nothing was checked.');
    expect(notes).not.toContain("couldn't be read");
  });

  it('does not leave a blank line where the unreadable notice would be', async () => {
    files.health = health([result()]);
    const notes = await runReport();
    expect(notes).toContain('production did:**\n- ok:');
  });

  it('no longer posts a note on the MR', async () => {
    files.health = health([result()]);
    await runReport();
    expect(posts.map((p) => p.path)).toEqual(['/projects/42/releases']);
  });
});

describe('release notes: only agent-authored notes count', () => {
  const reviewer = { username: 'ai-mr-reviewer-gitlab-ai-hackathon_dc1918' };
  const fixer = { username: 'ai-pipeline-fixer-gitlab-ai-hackathon' };
  const person = { username: 'dev' };

  it('credits the agent review and counts only fixer notes', async () => {
    mrNotes = [
      { body: 'Pipeline fix: a', author: fixer },
      { body: 'Pipeline fix: b', author: fixer },
      { body: 'Pipeline fix: typed by a person', author: person },
      { body: 'Review of abc1234: ready.', author: reviewer },
    ];
    const notes = await runReport();
    expect(notes).toContain('| Agent review | yes, by @ai-mr-reviewer-gitlab-ai-hackathon_dc1918 |');
    expect(notes).toContain('| Pipeline fixes by agents | 2 |');
  });

  it('says no review note was found when only a person typed one', async () => {
    mrNotes = [{ body: 'Review of abc1234: ready.', author: person }];
    const notes = await runReport();
    expect(notes).toContain('| Agent review | no review note found |');
    expect(notes).toContain('| Pipeline fixes by agents | 0 |');
  });
});
