import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LEDGER_RULES, type Ledger } from '../src/ledger.ts';

const CLI = resolve('src/cli/ledger.ts');
const CONFIG = resolve('../.autonomy.yml');
const BUILDER = 'ai-issue-builder-group_e1c791';

/**
 * A repo shaped like the project's main: the policy, then the merge that adds
 * the go-ahead guard (where the ledger starts), then an issue-builder branch
 * merged as !7.
 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-'));
  const git = (at: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Mazen', '-c', 'user.email=mazen@example.com', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
    }).trim();
  git('2026-10-17T10:00:00Z', 'init', '-q', '-b', 'main');
  copyFileSync(CONFIG, join(dir, '.autonomy.yml'));
  git('2026-10-17T10:00:00Z', 'add', '.');
  git('2026-10-17T10:00:00Z', 'commit', '-qm', 'policy');
  git('2026-10-17T14:00:00Z', 'checkout', '-qb', 'guard');
  mkdirSync(join(dir, 'engine/src/cli'), { recursive: true });
  writeFileSync(join(dir, 'engine/src/cli/goahead.ts'), '// the guard');
  git('2026-10-17T14:00:00Z', 'add', '.');
  git('2026-10-17T14:00:00Z', 'commit', '-qm', 'the guard');
  git('2026-10-17T20:11:08Z', 'checkout', '-q', 'main');
  git('2026-10-17T20:11:08Z', 'merge', '-q', '--no-ff', '-m', 'Merge the guard', 'guard');
  const base = git('2026-10-17T20:11:08Z', 'rev-parse', 'HEAD');
  git('2026-10-17T22:13:00Z', 'checkout', '-qb', 'fix');
  writeFileSync(join(dir, 'a.txt'), 'the fix');
  git('2026-10-17T22:13:00Z', 'add', '.');
  git('2026-10-17T22:13:00Z', 'commit', '-qm', 'fix: the change (#22)');
  const head = git('2026-10-17T22:13:00Z', 'rev-parse', 'HEAD');
  git('2026-10-17T23:00:52Z', 'checkout', '-q', 'main');
  git('2026-10-17T23:00:52Z', 'merge', '-q', '--no-ff', '-m', "Merge branch 'fix'", 'fix');
  const merge = git('2026-10-17T23:00:52Z', 'rev-parse', 'HEAD');
  return { dir, base, head, merge };
}

const note = (id: number, at: string, author: string, body: string, updated = at) => ({
  id,
  body,
  system: false,
  created_at: `2026-10-17T${at}.000Z`,
  updated_at: `2026-10-17T${updated}.000Z`,
  author: { username: author },
});
const proposal = note(1, '20:56:18', BUILDER, 'Proposal for #22:\n\n**Change**\n- a.txt');
const goAhead = (updated?: string) => note(2, '22:09:49', 'Mazen-Ghanaym', `@${BUILDER} go-ahead`, updated);

/** Answers like GitLab's API for the given paths, plus the published ledger at /pages/ledger/ledger.json. */
function gitlab(routes: Record<string, unknown>) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const body = routes[url.pathname];
    if (body === undefined) {
      res.writeHead(404).end('{"message":"404 Not Found"}');
      return;
    }
    const page = url.searchParams.get('page') ?? '1';
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(Array.isArray(body) && page !== '1' ? [] : body));
  });
  return new Promise<{ url: string; close: () => void }>((ok) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      ok({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    }),
  );
}

async function run(
  r: ReturnType<typeof repo>,
  opts: { issueNotes?: unknown[]; published?: Ledger; routes?: Record<string, unknown>; env?: Record<string, string> } = {},
) {
  const p = '/api/v4/projects/1';
  const api = await gitlab({
    [`${p}/merge_requests`]: [{ iid: 7, source_branch: 'fix' }],
    [`${p}/merge_requests/7`]: {
      iid: 7,
      state: 'merged',
      // composite identity: the MR is recorded under the person who gave the go-ahead
      author: { username: 'Mazen-Ghanaym' },
      created_at: '2026-10-17T22:13:10.000Z',
      merged_at: '2026-10-17T23:00:52.000Z',
      source_branch: 'fix',
      sha: r.head,
      merge_commit_sha: r.merge,
      squash_commit_sha: null,
      diff_refs: { base_sha: r.base, head_sha: r.head, start_sha: r.base },
      head_pipeline: { id: 100 },
    },
    [`${p}/events`]: [
      {
        created_at: '2026-10-17T22:13:04.562Z',
        author: { username: BUILDER },
        push_data: { ref: 'fix', ref_type: 'branch', action: 'created', commit_from: null, commit_to: r.head, commit_count: 1 },
      },
    ],
    [`${p}/pipelines/100/jobs`]: [
      { id: 5, name: 'autonomy:assess', status: 'success' },
      { id: 6, name: 'autonomy:goahead', status: 'success' },
    ],
    [`${p}/jobs/5/artifacts/risk-report.json`]: { score: 24, tier: 'low' },
    [`${p}/merge_requests/7/pipelines`]: [{ id: 100, sha: r.head, created_at: '2026-10-17T22:51:30.258Z' }],
    [`${p}/merge_requests/7/notes`]: [],
    [`${p}/merge_requests/7/closes_issues`]: [{ iid: 22, author: { username: 'Ahmad-Faraj' } }],
    [`${p}/issues/22/notes`]: opts.issueNotes ?? [proposal, goAhead()],
    ...(opts.published ? { '/pages/ledger/ledger.json': opts.published } : {}),
    ...Object.fromEntries(Object.entries(opts.routes ?? {}).map(([k, v]) => [`${p}${k}`, v])),
  });
  const out = join(r.dir, 'out');
  const child = spawn('node', [CLI, out], {
    cwd: r.dir,
    env: {
      ...process.env,
      CI_API_V4_URL: `${api.url}/api/v4`,
      CI_API_GRAPHQL_URL: `${api.url}/api/graphql`,
      CI_PROJECT_ID: '1',
      CI_PROJECT_PATH: 'group/showcase',
      CI_PROJECT_URL: 'https://gitlab.com/group/showcase',
      CI_PAGES_URL: `${api.url}/pages`,
      CI_JOB_TOKEN: 'job',
      CI_COMMIT_SHA: r.merge,
      AUTONOMY_CONFIG: '.autonomy.yml',
      ...opts.env,
    },
  });
  let text = '';
  child.stdout.on('data', (d) => (text += d));
  child.stderr.on('data', (d) => (text += d));
  const code = await new Promise<number | null>((ok) => child.on('close', ok));
  api.close();
  const read = (f: string) => readFileSync(join(out, f), 'utf8');
  return { code, text, ledger: () => JSON.parse(read('ledger.json')) as Ledger, page: () => read('index.html') };
}

describe('autonomy:ledger against a git repo and a stand-in for GitLab', () => {
  it('starts the chain when nothing is published yet, with the push and its go-ahead', async () => {
    const r = repo();
    const { code, text, ledger, page } = await run(r);
    expect(text).toContain('this one starts the chain');
    expect(code).toBe(0);
    const l = ledger();
    expect(l.since.at).toBe('2026-10-17T20:11:08Z');
    expect(l.records).toHaveLength(1);
    expect(l.records[0]).toMatchObject({
      seq: 1,
      mr: 7,
      agent: BUILDER,
      commits: [r.head],
      thread: { kind: 'issue', iid: 22 },
      proposal: { note: 1 },
      go_ahead: { note: 2, by: 'Mazen-Ghanaym' },
      requesters: ['Ahmad-Faraj'],
      approver_not_requester: true,
      tier: 'low',
      accepted: true,
      guard: { pipeline: 100, job: 6, status: 'success' },
    });
    expect(page()).toContain('<h1>Go-ahead ledger</h1>');
  });

  it('passes when the published ledger comes back unchanged', async () => {
    const r = repo();
    const first = (await run(r)).ledger();
    const { code, text } = await run(r, { published: first });
    expect(text).toMatch(/the published ledger \(1 record\(s\), head \w+\) is the start of this one/);
    expect(code).toBe(0);
  });

  it('fails when the go-ahead behind a published record was edited afterwards', async () => {
    const r = repo();
    const first = (await run(r)).ledger();
    const { code, text } = await run(r, { published: first, issueNotes: [proposal, goAhead('23:30:00')] });
    expect(text).toMatch(/record 1 \(!7, push at 2026-10-17T22:13:04Z by @ai-issue-builder\S*\) changed: accepted was true, now false/);
    expect(text).toMatch(/Pages keeps the published one/);
    expect(code).toBe(1);
  });

  it('fails when the published file was edited', async () => {
    const r = repo();
    const first = (await run(r)).ledger();
    first.records[0].go_ahead!.by = 'HamzaHassanain';
    const { code, text } = await run(r, { published: first });
    expect(text).toMatch(/go_ahead was \{.*"by":"HamzaHassanain".*\}, now \{.*"by":"Mazen-Ghanaym"/);
    expect(code).toBe(1);
  });

  it("starts the chain at the guard's merge on the default branch, not at a later merge of main into this branch", async () => {
    const r = repo();
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Mazen', '-c', 'user.email=mazen@example.com', ...args], {
        cwd: r.dir,
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_DATE: '2026-10-18T08:00:00Z', GIT_COMMITTER_DATE: '2026-10-18T08:00:00Z' },
      }).trim();
    // what an MR pipeline has: main as origin/main, and a branch cut before the guard that merged main in
    git('update-ref', 'refs/remotes/origin/main', 'main');
    git('checkout', '-qb', 'old', 'main~2');
    git('merge', '-q', '--no-ff', '-m', 'Merge main into old', 'main');
    const { code, ledger } = await run(r, { env: { CI_DEFAULT_BRANCH: 'main' } });
    expect(code).toBe(0);
    expect(ledger().since.at).toBe('2026-10-17T20:11:08Z');
  });

  it("takes a merged MR's tier from the published ledger once its risk-report.json expired", async () => {
    const r = repo();
    const first = (await run(r)).ledger();
    const expired = { '/jobs/5/artifacts/risk-report.json': undefined };
    const { code, ledger } = await run(r, { published: first, routes: expired });
    expect(code).toBe(0);
    expect(ledger().records[0].tier).toBe('low');
    const none = await run(r, { routes: expired });
    expect(none.text).toMatch(/can't read the risk tier of !7/);
    expect(none.code).toBe(1);
  });

  it('records a merged agent MR the guard never ran on as refused, instead of leaving it out', async () => {
    const r = repo();
    const { code, ledger, text } = await run(r, { routes: { '/pipelines/100/jobs': [{ id: 5, name: 'autonomy:assess', status: 'success' }] } });
    expect(code).toBe(0);
    expect(ledger().records[0]).toMatchObject({ mr: 7, accepted: false, guard: { pipeline: 100, job: null, status: 'none' } });
    expect(text).toMatch(/refused: autonomy:goahead never ran on this MR/);
  });

  it('records a merged agent MR with no pipeline at all as refused', async () => {
    const r = repo();
    const mr = { iid: 7, state: 'merged', author: { username: 'Mazen-Ghanaym' }, created_at: '2026-10-17T22:13:10.000Z', merged_at: '2026-10-17T23:00:52.000Z', source_branch: 'fix', sha: r.head, merge_commit_sha: r.merge, squash_commit_sha: null, diff_refs: { base_sha: r.base, head_sha: r.head, start_sha: r.base }, head_pipeline: null };
    const { code, ledger } = await run(r, { routes: { '/merge_requests/7': mr } });
    expect(code).toBe(0);
    expect(ledger().records[0]).toMatchObject({ mr: 7, accepted: false, tier: 'high', guard: { pipeline: null, job: null, status: 'none' } });
  });

  it('starts a new chain, naming the old head, when the published one was judged by other rules', async () => {
    const r = repo();
    const first = (await run(r)).ledger();
    const old = { ...first, rules: 0, records: [{ ...first.records[0], tier: 'high' as const }] };
    const { code, text, ledger } = await run(r, { published: old });
    expect(text).toMatch(new RegExp(`judged by rules 0 and this one by rules ${LEDGER_RULES}: a new chain starts`));
    expect(ledger().replaces).toEqual({ rules: 0, head: first.head, records: 1 });
    expect(code).toBe(0);
  });
});
