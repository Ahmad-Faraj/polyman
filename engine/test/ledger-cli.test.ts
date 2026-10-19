import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { LEDGER_RULES, type Ledger, chain } from '../src/ledger.ts';

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
  return { dir, base, head, merge, git };
}

const REVIEWER = 'ai-mr-reviewer-group_e50080';

/**
 * The repo above, plus a closed agent MR !8 on branch `first`: the builder's
 * accepted push, then a reviewer push nobody approved. A person merged !9 from
 * the accepted commit, or from the refused one on top of it. With `other`, the
 * builder's MR !10 on branch `other` merged then too.
 */
function moved(from: 'accepted' | 'refused', other?: string) {
  const r = repo();
  const commit = (at: string, file: string, message: string) => {
    writeFileSync(join(r.dir, file), message);
    r.git(at, 'add', '.');
    r.git(at, 'commit', '-qm', message);
    return r.git(at, 'rev-parse', 'HEAD');
  };
  r.git('2026-10-17T22:30:00Z', 'checkout', '-qb', 'first', r.base);
  const accepted = commit('2026-10-17T22:30:00Z', 'b.txt', 'fix: the other change (#30)');
  const refused = commit('2026-10-17T23:10:00Z', 'c.txt', 'tests nobody approved');
  r.git('2026-10-17T22:40:00Z', 'checkout', '-qb', 'other', r.base);
  const third = commit('2026-10-17T22:40:00Z', 'd.txt', 'fix: a third change (#40)');
  // the merges into main, in the order they happened
  const merges = [{ at: '2026-10-17T23:20:00Z', branch: 'moved', sha: from === 'accepted' ? accepted : refused }, ...(other ? [{ at: other, branch: 'other', sha: third }] : [])];
  const merged: Record<string, string> = {};
  for (const m of merges.sort((a, b) => a.at.localeCompare(b.at))) {
    r.git(m.at, 'checkout', '-q', 'main');
    r.git(m.at, 'merge', '-q', '--no-ff', '-m', `Merge branch '${m.branch}'`, m.sha);
    merged[m.branch] = r.git(m.at, 'rev-parse', 'HEAD');
  }
  const carrier = { iid: 9, state: 'merged', merged_at: '2026-10-17T23:20:00.000Z', target_branch: 'main' };
  const closed = { iid: 8, state: 'closed', merged_at: null, target_branch: 'main' };
  const push = (at: string, author: string, fromSha: string | null, to: string, ref = 'first') => ({
    created_at: at,
    author: { username: author },
    push_data: { ref, ref_type: 'branch', action: fromSha ? 'pushed' : 'created', commit_from: fromSha, commit_to: to, commit_count: 1 },
  });
  // !10, a builder MR with its own go-ahead, merged at `other`
  const mr10 = {
    '/merge_requests/10': {
      iid: 10,
      state: 'merged',
      author: { username: 'Mazen-Ghanaym' },
      created_at: '2026-10-17T22:41:00.000Z',
      merged_at: other,
      closed_at: null,
      source_branch: 'other',
      sha: third,
      merge_commit_sha: merged.other,
      squash_commit_sha: null,
      diff_refs: { base_sha: r.base, head_sha: third, start_sha: r.base },
      head_pipeline: { id: 102 },
    },
    '/pipelines/102/jobs': [
      { id: 9, name: 'autonomy:assess', status: 'success' },
      { id: 10, name: 'autonomy:goahead', status: 'success' },
    ],
    '/jobs/9/artifacts/risk-report.json': { score: 10, tier: 'low' },
    '/merge_requests/10/pipelines': [{ id: 102, sha: third, created_at: '2026-10-17T22:41:00.000Z' }],
    '/merge_requests/10/notes': [],
    '/merge_requests/10/closes_issues': [{ iid: 40, author: { username: 'Ahmad-Faraj' } }],
    '/issues/40/notes': [note(21, '22:35:00', BUILDER, 'Proposal for #40:\n\n**Change**\n- d.txt'), note(22, '22:36:00', 'Mazen-Ghanaym', `@${BUILDER} go-ahead`)],
  };
  const routes = {
    '/merge_requests': [
      { iid: 7, source_branch: 'fix' },
      { iid: 8, source_branch: 'first' },
      ...(other ? [{ iid: 10, source_branch: 'other' }] : []),
    ],
    '/merge_requests/8': {
      iid: 8,
      state: 'closed',
      author: { username: 'HamzaHassanain' },
      created_at: '2026-10-17T22:31:00.000Z',
      merged_at: null,
      closed_at: '2026-10-17T23:30:00.000Z',
      source_branch: 'first',
      sha: refused,
      merge_commit_sha: null,
      squash_commit_sha: null,
      diff_refs: { base_sha: r.base, head_sha: refused, start_sha: r.base },
      head_pipeline: { id: 101 },
    },
    '/events': [
      {
        created_at: '2026-10-17T22:13:04.562Z',
        author: { username: BUILDER },
        push_data: { ref: 'fix', ref_type: 'branch', action: 'created', commit_from: null, commit_to: r.head, commit_count: 1 },
      },
      push('2026-10-17T22:30:30.000Z', BUILDER, null, accepted),
      ...(other ? [push('2026-10-17T22:40:30.000Z', BUILDER, null, third, 'other')] : []),
      push('2026-10-17T23:10:30.000Z', REVIEWER, accepted, refused),
    ],
    '/pipelines/101/jobs': [
      { id: 7, name: 'autonomy:assess', status: 'success' },
      { id: 8, name: 'autonomy:goahead', status: 'failed' },
    ],
    '/jobs/7/artifacts/risk-report.json': { score: 20, tier: 'low' },
    '/merge_requests/8/pipelines': [{ id: 101, sha: refused, created_at: '2026-10-17T23:11:00.000Z' }],
    '/merge_requests/8/notes': [],
    '/merge_requests/8/closes_issues': [{ iid: 30, author: { username: 'Ahmad-Faraj' } }],
    '/issues/30/notes': [note(11, '22:20:00', BUILDER, 'Proposal for #30:\n\n**Change**\n- b.txt'), note(12, '22:25:00', 'HamzaHassanain', `@${BUILDER} go-ahead`)],
    '/merge_requests/9': { ...carrier, merged_by: { username: 'Ahmad-Faraj' } },
    [`/repository/commits/${accepted}/merge_requests`]: [carrier, closed],
    [`/repository/commits/${refused}/merge_requests`]: from === 'refused' ? [carrier, closed] : [closed],
    ...(other ? mr10 : {}),
  };
  return { ...r, accepted, refused, routes, push };
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
      merged_by: { username: 'HamzaHassanain' },
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
  return { code, text, ledger: () => JSON.parse(read('ledger.json')) as Ledger, page: () => read('index.html'), loops: () => JSON.parse(read('loops.json')) };
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

  it('shows the merged MR as one loop, with its merger and the grams of its sessions', async () => {
    const r = repo();
    const sessions = join(r.dir, 'loop-sessions.json');
    writeFileSync(
      sessions,
      JSON.stringify({
        counted_up_to: '2026-10-18T00:00:00Z',
        source: 'test',
        sessions: [
          { workflow: 1, pipeline: 1, at: '2026-10-17T22:09:00Z', flow: 'issue-builder', mr: null, issue: 22, seconds: 120, calls: 10 },
          { workflow: 2, pipeline: 2, at: '2026-10-17T22:55:00Z', flow: 'mr-reviewer', mr: 7, issue: null, seconds: 60, calls: 20 },
          { workflow: 3, pipeline: 3, at: '2026-10-17T22:55:00Z', flow: 'mr-reviewer', mr: 8, issue: null, seconds: 60, calls: 20 },
        ],
      }),
    );
    const { code, text, loops, page } = await run(r, {
      issueNotes: [proposal, note(3, '21:00:00', 'Ahmad-Faraj', `@${BUILDER} go-ahead`), goAhead()],
      env: { LOOP_SESSIONS: sessions },
    });
    expect(code).toBe(0);
    const out = loops();
    expect(out.sessions_counted_up_to).toBe('2026-10-18T00:00:00Z');
    expect(out.loops).toHaveLength(1);
    expect(out.loops[0]).toMatchObject({
      mr: 7,
      issues: [22],
      requesters: ['Ahmad-Faraj'],
      go_ahead: { note: 2, by: 'Mazen-Ghanaym' },
      merged_by: 'HamzaHassanain',
      minutes: 51,
      fix_rounds: 0,
      refused_go_aheads: [{ note: 3, by: 'Ahmad-Faraj' }],
      giver_merged: false,
      grams: { sessions: 2, uncounted: 0 },
    });
    expect(out.summary).toMatchObject({ loops: 1, approverNotRequester: 1, giverMerged: 0 });
    expect(text).toContain('1 loop; go-ahead never from the requester (1/1); in 0 of 1 the go-ahead giver also merged;');
    expect(page()).toContain('<h2>One row per loop</h2>');
  });

  it('shows the loops without grams when no session counts are committed', async () => {
    const r = repo();
    const { code, text, loops } = await run(r);
    expect(code).toBe(0);
    expect(text).toContain('so the loops are shown without grams');
    expect(loops()).toMatchObject({ sessions_counted_up_to: null, loops: [{ mr: 7, grams: null }] });
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
    // the edit breaks the hash chain, so it is caught before anything in it is trusted
    expect(text).toMatch(/published ledger: the ledger's head is \w+, but its last record hashes to \w+/);
    expect(text).toMatch(/doesn't verify/);
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
    // a chain judged by older rules: other tiers, but its links hold
    const old = { ...chain(first.project, first.since, [{ ...first.records[0], tier: 'high' as const }]), rules: 0 };
    const { code, text, ledger } = await run(r, { published: old });
    expect(LEDGER_RULES).toBe(3);
    expect(text).toMatch(/judged by rules 0 and this one by rules 3: a new chain starts/);
    expect(ledger().replaces).toEqual({ rules: 0, head: old.head, records: 1 });
    expect(code).toBe(0);
  });

  it('fails on a published ledger whose chain is broken, before it trusts a tier from it', async () => {
    const r = repo();
    const first = (await run(r)).ledger();
    // after a rules bump nothing compares the old chain, so an edited tier would be copied as is
    const old = { ...first, rules: 0, records: [{ ...first.records[0], tier: 'high' as const }] };
    const expired = { '/jobs/5/artifacts/risk-report.json': undefined };
    const { code, text } = await run(r, { published: old, routes: expired });
    expect(text).toMatch(/published ledger: the ledger's head is \w+, but its last record hashes to \w+/);
    expect(text).toMatch(/doesn't verify, so the tiers in it can't be trusted/);
    expect(code).toBe(1);
  });

  it("fails on a published ledger of another project", async () => {
    const r = repo();
    const first = (await run(r)).ledger();
    const { code, text } = await run(r, { published: { ...first, project: 'someone/else' } });
    expect(text).toContain('published ledger: it is the ledger of someone/else, not of group/showcase');
    expect(code).toBe(1);
  });

  it('leaves an open agent MR the guard has not run on yet out, as not judged, instead of refusing it', async () => {
    const r = repo();
    const mr = { iid: 7, state: 'opened', author: { username: 'Mazen-Ghanaym' }, created_at: '2026-10-17T22:13:10.000Z', merged_at: null, source_branch: 'fix', sha: r.head, merge_commit_sha: null, squash_commit_sha: null, diff_refs: { base_sha: r.base, head_sha: r.head, start_sha: r.base }, head_pipeline: null };
    const { code, ledger, text, page } = await run(r, { routes: { '/merge_requests/7': mr } });
    expect(code).toBe(0);
    expect(ledger().records).toEqual([]);
    expect(text).toContain("not in the ledger: !7: open, and autonomy:goahead hasn't run on it yet, so not judged yet");
    expect(text).not.toMatch(/open !7 push/);
    expect(page()).not.toContain('never ran on this MR');
  });

  it('warns when it reads the chain start on HEAD', async () => {
    const r = repo();
    const unset = await run(r, { env: { CI_DEFAULT_BRANCH: '' } });
    expect(unset.text).toContain('warning: no CI_DEFAULT_BRANCH, so the chain start is read on HEAD');
    const missing = await run(r, { env: { CI_DEFAULT_BRANCH: 'main' } });
    expect(missing.text).toContain("warning: origin/main isn't fetched, so the chain start is read on HEAD");
    expect(missing.code).toBe(0);
  });

  describe('a closed MR whose commits a person moved to a merged MR (!8 -> !9)', () => {
    it('chains the accepted push with the go-ahead given on !8, after the close, and keeps the refused push open', async () => {
      const m = moved('accepted');
      const { code, text, ledger, page, loops } = await run(m, { routes: m.routes, env: { CI_DEFAULT_BRANCH: 'main' } });
      expect(code).toBe(0);
      const records = ledger().records;
      expect(records.map((r) => r.mr)).toEqual([7, 8]);
      expect(records[1]).toMatchObject({
        mr: 8,
        carried_by: { mr: 9, mr_url: 'https://gitlab.com/group/showcase/-/merge_requests/9' },
        merged_at: '2026-10-17T23:20:00Z',
        agent: BUILDER,
        commits: [m.accepted],
        go_ahead: { note: 12, by: 'HamzaHassanain' },
        accepted: true,
      });
      expect(text).toContain(`!8 (merged in !9) push at 2026-10-17T22:30:30Z by @${BUILDER}: go-ahead in note 12 by @HamzaHassanain`);
      expect(text).toMatch(new RegExp(`open !8 push at 2026-10-17T23:10:30Z by @${REVIEWER}: refused`));
      expect(page()).toContain('<span class="muted">merged in</span> <a href="https://gitlab.com/group/showcase/-/merge_requests/9">!9</a>');
      // the loop is !9, moved from !8, with the push refused on !8
      expect(loops().loops[1]).toMatchObject({ mr: 9, moved_from: [8], merged_by: 'Ahmad-Faraj', issues: [30], refused_pushes: [{ mr: 8, agent: REVIEWER }] });
    });

    it('chains a refused push whose commit reached main too, as refused', async () => {
      const m = moved('refused');
      const { code, text, ledger } = await run(m, { routes: m.routes, env: { CI_DEFAULT_BRANCH: 'main' } });
      expect(code).toBe(0);
      const records = ledger().records;
      expect(records.map((r) => [r.mr, r.accepted])).toEqual([
        [7, true],
        [8, true],
        [8, false],
      ]);
      expect(records[2]).toMatchObject({ agent: REVIEWER, commits: [m.refused], carried_by: { mr: 9 }, go_ahead: null });
      expect(text).toContain('3 record(s), 2 let through, 1 refused');
      expect(text).not.toMatch(/open !8 push/);
    });

    it('carries nothing without CI_DEFAULT_BRANCH, and says so', async () => {
      const m = moved('accepted');
      const { code, text, ledger } = await run(m, { routes: m.routes, env: { CI_DEFAULT_BRANCH: '' } });
      expect(code).toBe(0);
      expect(ledger().records.map((r) => r.mr)).toEqual([7]);
      expect(text).toContain("warning: no CI_DEFAULT_BRANCH, so !8's pushes can't be matched to a merge on it and stay in the open list");
    });

    it('judges the closed MR by the policy on main when it was closed, not today\'s', async () => {
      const m = moved('accepted');
      // a later policy that drops the person who gave the go-ahead must not re-judge !8
      writeFileSync(join(m.dir, '.autonomy.yml'), readFileSync(join(m.dir, '.autonomy.yml'), 'utf8').replace(/HamzaHassanain/g, 'SomeoneElse'));
      m.git('2026-10-18T09:00:00Z', 'commit', '-qam', 'policy: a later change');
      const { ledger } = await run(m, { routes: m.routes, env: { CI_DEFAULT_BRANCH: 'main' } });
      expect(ledger().records[1]).toMatchObject({ mr: 8, accepted: true, go_ahead: { by: 'HamzaHassanain' } });
    });

    it("leaves the closed MR out, instead of judging it by today's policy, when no commit on main is older than its close", async () => {
      const m = moved('accepted');
      const routes = { ...m.routes, '/merge_requests/8': { ...m.routes['/merge_requests/8'], closed_at: '2026-10-17T09:00:00.000Z' } };
      const { code, text, ledger } = await run(m, { routes, env: { CI_DEFAULT_BRANCH: 'main' } });
      expect(code).toBe(0);
      expect(ledger().records.map((r) => r.mr)).toEqual([7]);
      expect(text).toContain("not in the ledger: !8: closed at 2026-10-17T09:00:00Z, before any commit on HEAD, so the policy it was closed under can't be read");
    });

    it('keeps a closed MR with no closed_at in the open list, and says so', async () => {
      const m = moved('accepted');
      const routes = { ...m.routes, '/merge_requests/8': { ...m.routes['/merge_requests/8'], closed_at: null } };
      const { code, text, ledger } = await run(m, { routes, env: { CI_DEFAULT_BRANCH: 'main' } });
      expect(code).toBe(0);
      expect(ledger().records.map((r) => r.mr)).toEqual([7]);
      expect(text).toContain("warning: !8 is closed but GitLab gives no closed_at, so its pushes can't be matched to a merge on the default branch and stay in the open list");
      expect(text).toMatch(/open !8 push at 2026-10-17T22:30:30Z/);
    });

    it('leaves out a push on the same branch after the close: the guard never judged it on !8', async () => {
      const m = moved('accepted');
      // a push back to the commit that already reached main, so it would be carried too
      const routes = { ...m.routes, '/events': [...m.routes['/events'], m.push('2026-10-17T23:40:00.000Z', REVIEWER, m.refused, m.accepted)] };
      const { code, text, ledger } = await run(m, { routes, env: { CI_DEFAULT_BRANCH: 'main' } });
      expect(code).toBe(0);
      expect(ledger().records.map((r) => [r.mr, r.pushed_at])).toEqual([
        [7, '2026-10-17T22:13:04Z'],
        [8, '2026-10-17T22:30:30Z'],
      ]);
      expect(text).not.toContain('2026-10-17T23:40:00Z');
    });

    it("chains a carried push after an MR merged between its carrier's merge and its close", async () => {
      // !9 merges at 23:20, !10 at 23:25 and !8 closes at 23:30: a run at 23:27 could have published !10 already
      const m = moved('accepted', '2026-10-17T23:25:00Z');
      const { code, ledger } = await run(m, { routes: m.routes, env: { CI_DEFAULT_BRANCH: 'main' } });
      expect(code).toBe(0);
      expect(ledger().records.map((r) => [r.mr, r.merged_at])).toEqual([
        [7, '2026-10-17T23:00:52Z'],
        [10, '2026-10-17T23:25:00Z'],
        [8, '2026-10-17T23:20:00Z'],
      ]);
    });

    it("chains a carried push at its carrier's merge when its MR closed before that merge", async () => {
      // !8 closes at 23:15, !10 merges at 23:17 and !9 at 23:20: nothing carried !8's push before 23:20
      const m = moved('accepted', '2026-10-17T23:17:00Z');
      const routes = { ...m.routes, '/merge_requests/8': { ...m.routes['/merge_requests/8'], closed_at: '2026-10-17T23:15:00.000Z' } };
      const { code, ledger } = await run(m, { routes, env: { CI_DEFAULT_BRANCH: 'main' } });
      expect(code).toBe(0);
      expect(ledger().records.map((r) => r.mr)).toEqual([7, 10, 8]);
    });

    it("takes a closed MR's tier from the published ledger once its risk-report.json expired", async () => {
      const m = moved('accepted');
      const env = { CI_DEFAULT_BRANCH: 'main' };
      const first = (await run(m, { routes: m.routes, env })).ledger();
      const expired = { ...m.routes, '/jobs/7/artifacts/risk-report.json': undefined };
      const { code, ledger } = await run(m, { routes: expired, env, published: first });
      expect(code).toBe(0);
      expect(ledger().records[1]).toMatchObject({ mr: 8, tier: 'low' });
    });

    it("judges a closed MR as high, with a warning, when its risk-report.json expired and nothing published has its tier", async () => {
      const m = moved('accepted');
      const expired = { ...m.routes, '/jobs/7/artifacts/risk-report.json': undefined };
      const { code, text, ledger } = await run(m, { routes: expired, env: { CI_DEFAULT_BRANCH: 'main' } });
      expect(code).toBe(0);
      expect(text).toContain('warning: !8 has no risk tier yet; judged as high, as the guard does');
      expect(ledger().records[1]).toMatchObject({ mr: 8, tier: 'high' });
    });

    it('judges a closed MR the guard never ran on, as refused, and chains its pushes that reached main', async () => {
      const m = moved('accepted');
      const routes = { ...m.routes, '/merge_requests/8': { ...m.routes['/merge_requests/8'], head_pipeline: null } };
      const { code, text, ledger } = await run(m, { routes, env: { CI_DEFAULT_BRANCH: 'main' } });
      expect(code).toBe(0);
      expect(ledger().records[1]).toMatchObject({ mr: 8, carried_by: { mr: 9 }, accepted: false, guard: { pipeline: null, job: null, status: 'none' } });
      expect(text).not.toMatch(/not in the ledger: !8/);
    });

    it('takes as carrier the first merge into the default branch by another MR', async () => {
      const m = moved('accepted');
      const mr = (iid: number, state: string, at: string, target_branch = 'main') => ({ iid, state, merged_at: `2026-10-17T${at}.000Z`, target_branch });
      // each of the others would come first if it counted
      const listed = [mr(11, 'merged', '23:50:00'), mr(8, 'merged', '23:01:00'), mr(12, 'opened', '23:02:00'), mr(13, 'merged', '23:03:00', 'release'), mr(9, 'merged', '23:20:00')];
      const routes = { ...m.routes, [`/repository/commits/${m.accepted}/merge_requests`]: listed };
      const { code, ledger } = await run(m, { routes, env: { CI_DEFAULT_BRANCH: 'main' } });
      expect(code).toBe(0);
      expect(ledger().records[1]).toMatchObject({ mr: 8, carried_by: { mr: 9 }, merged_at: '2026-10-17T23:20:00Z' });
    });
  });
});
