import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// monitor.ts is a top-level script. The traffic file and health-report.json are
// faked, and fetch plays GitLab's notes endpoint.

const state = vi.hoisted(() => ({ traffic: '' , written: {} as Record<string, string> }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) =>
      path === 'traffic.json' ? state.traffic : (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof actual.readFileSync,
    writeFileSync: ((path: string, data: string) => {
      state.written[path] = String(data);
    }) as typeof actual.writeFileSync,
  };
});

const BASE = 'https://gitlab.test/api/v4';
const saved = { ...process.env };
const reviewer = { username: 'ai-mr-reviewer-gitlab-ai-hackathon_dc1918' };
const person = { username: 'dev' };
const plan = (route: string, max: number) => '```watch\n' + JSON.stringify([{ route, signal: 'error_rate', max }]) + '\n```';
const review = (route: string, max: number, author = reviewer) => ({ body: `Review of abc1234: ok\n${plan(route, max)}`, author });

let notes: unknown[];
let requested: string[];
let exit: ReturnType<typeof vi.spyOn>;
let out: string[];

const stats = (errorRate: number) => ({ count: 100, errorRate, p95Ms: 10 });
const traffic = (routes: Record<string, unknown>) => (state.traffic = JSON.stringify({ routes }));

async function runMonitor() {
  vi.resetModules();
  process.argv[2] = 'traffic.json';
  await import('../src/cli/monitor.ts');
  return JSON.parse(state.written['health-report.json']) as { mr: number; plan: unknown[]; results: { ok: boolean; source: string }[] };
}

beforeEach(() => {
  notes = [];
  requested = [];
  state.written = {};
  out = [];
  process.env.CI_API_V4_URL = BASE;
  process.env.CI_PROJECT_ID = '42';
  process.env.CI_JOB_TOKEN = 'job';
  process.env.RELEASE_MR_IID = '7';
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requested.push(url.slice(BASE.length));
      return new Response(JSON.stringify(notes));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('monitor: which review note supplies the watch list', () => {
  it('reads the notes of the release MR, newest first', async () => {
    traffic({});
    await runMonitor();
    expect(requested).toEqual(['/projects/42/merge_requests/7/notes?per_page=100&sort=desc']);
  });

  it('uses the watch list from the agent-authored review', async () => {
    notes = [review('GET /api/orders', 0.01)];
    traffic({ 'GET /api/orders': stats(0.5) });
    const report = await runMonitor();
    expect(report.plan).toEqual([{ route: 'GET /api/orders', signal: 'error_rate', max: 0.01 }]);
    expect(report.results[0]).toMatchObject({ ok: false, source: 'review' });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('ignores a look-alike review typed by a person, even if it is newer', async () => {
    // newest first: the person's note comes before the agent's
    notes = [review('GET /api/orders', 100, person), review('GET /api/orders', 0.01)];
    traffic({ 'GET /api/orders': stats(0.5) });
    const report = await runMonitor();
    expect(report.plan).toEqual([{ route: 'GET /api/orders', signal: 'error_rate', max: 0.01 }]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('has no watch list when only a person wrote a review, so a planted limit cannot loosen it', async () => {
    notes = [review('GET /api/orders', 100, person)];
    traffic({ 'GET /api/orders': stats(0.5) });
    const report = await runMonitor();
    expect(report.plan).toEqual([]);
    // only the default 5% budget applies
    expect(report.results).toMatchObject([{ ok: false, source: 'default' }]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('ignores an agent note that is not a review (fixer account, or no "Review of" line)', async () => {
    notes = [
      { body: `Review of abc1234: x\n${plan('GET /api/orders', 100)}`, author: { username: 'ai-pipeline-fixer-gitlab-ai-hackathon' } },
      { body: `Looks good\n${plan('GET /api/orders', 100)}`, author: reviewer },
    ];
    traffic({ 'GET /api/orders': stats(0.5) });
    expect((await runMonitor()).plan).toEqual([]);
  });
});

describe('monitor: outcome', () => {
  it('does not exit non-zero when everything is within its limits', async () => {
    notes = [review('GET /api/orders', 0.1)];
    traffic({ 'GET /api/orders': stats(0.01) });
    const report = await runMonitor();
    expect(report.mr).toBe(7);
    expect(report.results.every((r) => r.ok)).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('ok   GET /api/orders error rate 1.0%');
  });

  it('reports a watched route with no traffic but does not fail (or roll back) the release', async () => {
    notes = [review('POST /api/payments/:id/refund', 0.02)];
    traffic({ 'GET /api/orders': stats(0.01) });
    await runMonitor();
    expect(exit).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/\?\?\s+POST \/api\/payments\/:id\/refund error rate: no traffic seen, can't confirm/);
  });
});
