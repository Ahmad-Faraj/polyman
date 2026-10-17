import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const CLI = resolve('src/cli/goahead.ts');
const CONFIG = resolve('../.autonomy.yml');
const AGENT = 'ai-mr-reviewer-group_e50080';
const BUILDER = 'ai-issue-builder-group_e1c791';

/** A git repo with a base commit and `count` more on top, all with the given author email. */
function repo(count: number, email = 'service_account_group_1@noreply.gitlab.com', file = 'a.txt') {
  const dir = mkdtempSync(join(tmpdir(), 'goahead-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git('add', '.');
  git('-c', 'user.name=Mazen', '-c', 'user.email=mazen@example.com', 'commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const shas: string[] = [];
  for (let i = 0; i < count; i++) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), `change ${i}`);
    git('add', '.');
    git('-c', 'user.name=someone', '-c', `user.email=${email}`, 'commit', '-qm', `change ${i}`);
    shas.push(git('rev-parse', 'HEAD'));
  }
  return { dir, base, shas };
}

/** Answers like GitLab's API for the given paths (arrays are paged). */
function gitlab(routes: Record<string, unknown>) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const body = routes[url.pathname];
    if (body === undefined) {
      res.writeHead(404).end('{}');
      return;
    }
    const page = url.searchParams.get('page') ?? '1';
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(Array.isArray(body) && page !== '1' ? [] : body));
  });
  return new Promise<{ url: string; close: () => void }>((ok) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      ok({ url: `http://127.0.0.1:${port}/api/v4`, close: () => server.close() });
    }),
  );
}

const note = (id: number, at: string, author: string, body: string) => ({ id, body, system: false, created_at: `2026-10-17T${at}:00Z`, author: { username: author } });
const push = (at: string, by: string, from: string | null, to: string, ref = 'fix') => ({
  created_at: `2026-10-17T${at}:00Z`,
  author: { username: by },
  push_data: { ref, ref_type: 'branch', action: from ? 'pushed' : 'created', commit_from: from, commit_to: to },
});

interface Case {
  commits?: number;
  email?: string;
  file?: string;
  tier?: string;
  mrAuthor?: string;
  issueAuthor?: string;
  notes?: (r: { base: string; shas: string[] }) => unknown[];
  events: (r: { base: string; shas: string[] }) => unknown[];
  issueNotes?: unknown[];
  closes?: unknown[];
  api?: string;
}

async function run(c: Case) {
  return runIn(repo(c.commits ?? 1, c.email, c.file), c);
}

async function runIn(r: { dir: string; base: string; shas: string[] }, c: Case) {
  const api = await gitlab({
    '/api/v4/projects/1/merge_requests/7': { author: { username: c.mrAuthor ?? 'Mazen-Ghanaym' }, created_at: '2026-10-17T09:00:00Z', description: 'Closes #22', source_branch: 'fix' },
    '/api/v4/projects/1/merge_requests/7/notes': c.notes?.(r) ?? [],
    '/api/v4/projects/1/events': c.events(r),
    '/api/v4/projects/1/merge_requests/7/closes_issues': c.closes ?? [{ iid: 22, author: { username: c.issueAuthor ?? 'Issue-Author' } }],
    '/api/v4/projects/1/issues/22/notes': c.issueNotes ?? [],
  });
  // async, so the stand-in server in this process can answer while the CLI runs
  const child = spawn('node', [CLI], {
    cwd: r.dir,
    env: {
      ...process.env,
      CI_API_V4_URL: c.api ?? api.url,
      CI_PROJECT_ID: '1',
      CI_MERGE_REQUEST_IID: '7',
      CI_MERGE_REQUEST_DIFF_BASE_SHA: r.base,
      AUTONOMY_TIER: c.tier ?? 'low',
      AUTONOMY_CONFIG: CONFIG,
      CI_JOB_TOKEN: 'job',
    },
  });
  let text = '';
  child.stdout.on('data', (d) => (text += d));
  child.stderr.on('data', (d) => (text += d));
  const code = await new Promise<number | null>((ok) => child.on('close', ok));
  api.close();
  return { code, text };
}

const proposal = note(1, '10:00', AGENT, 'Review of x: proposed fixes');
const goAhead = (who = 'Ahmad-Faraj', at = '10:05') => note(2, at, who, `@${AGENT} go-ahead`);

describe('autonomy:goahead against a git repo and a stand-in for GitLab', () => {
  it("passes an agent push that had a teammate's go-ahead after the proposal", async () => {
    const { code, text } = await run({ notes: () => [proposal, goAhead()], events: (r) => [push('10:10', AGENT, r.base, r.shas[0])] });
    expect(text).toContain('go-ahead in note 2 by @Ahmad-Faraj');
    expect(code).toBe(0);
  });

  it('fails a planted agent push with no go-ahead', async () => {
    const { code, text } = await run({ notes: () => [proposal], events: (r) => [push('10:10', AGENT, r.base, r.shas[0])] });
    expect(text).toMatch(/no go-ahead mentioning @ai-mr-reviewer/);
    expect(code).toBe(1);
  });

  it("knows the agent from who pushed, not from the commit's email (which the agent writes)", async () => {
    const { code, text } = await run({ email: 'dev@example.com', notes: () => [proposal], events: (r) => [push('10:10', AGENT, r.base, r.shas[0])] });
    expect(text).toMatch(/push at .* by @ai-mr-reviewer.*no go-ahead/);
    expect(code).toBe(1);
  });

  it('fails a high-risk push whose go-ahead came from a teammate who is not the maintainer', async () => {
    const { code, text } = await run({ tier: 'high', notes: () => [proposal, goAhead()], events: (r) => [push('10:10', AGENT, r.base, r.shas[0])] });
    expect(text).toMatch(/not a maintainer; high risk needs @HamzaHassanain/);
    expect(code).toBe(1);
  });

  it('needs a new go-ahead for a second push', async () => {
    const { code, text } = await run({
      commits: 2,
      notes: () => [proposal, goAhead()],
      events: (r) => [push('10:10', AGENT, r.base, r.shas[0]), push('10:20', AGENT, r.shas[0], r.shas[1])],
    });
    expect(text).toMatch(/push at 2026-10-17T10:10:00Z .* go-ahead in note 2/);
    expect(text).toMatch(/push at 2026-10-17T10:20:00Z .* between its previous push at 2026-10-17T10:10:00Z/);
    expect(code).toBe(1);
  });

  it('a go-ahead is used up by the same agent pushing anywhere else in between', async () => {
    const { code, text } = await run({
      notes: () => [proposal, goAhead()],
      events: (r) => [push('10:07', AGENT, 'aaaa', 'bbbb', 'other-branch'), push('10:10', AGENT, r.base, r.shas[0])],
    });
    expect(text).toMatch(/between its previous push at 2026-10-17T10:07:00Z/);
    expect(code).toBe(1);
  });

  it('fails a commit that no recorded push brought', async () => {
    const { code, text } = await run({ commits: 2, notes: () => [proposal, goAhead()], events: (r) => [push('10:10', AGENT, r.base, r.shas[0])] });
    expect(text).toMatch(/is in no push GitLab recorded for fix/);
    expect(code).toBe(1);
  });

  it('checks a branch an agent pushed before the MR existed against the issue it closes', async () => {
    const { code, text } = await run({
      issueNotes: [note(1, '08:00', BUILDER, 'Proposal for #22: ...'), note(2, '08:30', 'HamzaHassanain', `@${BUILDER} go-ahead`)],
      events: (r) => [push('08:45', BUILDER, null, r.shas[0])],
    });
    expect(text).toMatch(/go-ahead in note 2 on #22 by @HamzaHassanain/);
    expect(code).toBe(0);
  });

  it("doesn't accept a go-ahead on the issue given to a different agent", async () => {
    const { code, text } = await run({
      issueNotes: [note(1, '08:00', BUILDER, 'Proposal for #22'), note(2, '08:30', 'HamzaHassanain', `@${BUILDER} go-ahead`)],
      events: (r) => [push('08:45', 'ai-pipeline-fixer-group_b1d814', null, r.shas[0])],
    });
    expect(text).toMatch(/@ai-pipeline-fixer-group_b1d814 wrote no proposal/);
    expect(code).toBe(1);
  });

  it('on an MR an agent opened, the issue author still asked for it, so their go-ahead does not count', async () => {
    const { code, text } = await run({
      mrAuthor: BUILDER,
      issueAuthor: 'Ahmad-Faraj',
      issueNotes: [note(1, '08:00', BUILDER, 'Proposal for #22'), note(2, '08:30', 'Ahmad-Faraj', `@${BUILDER} go-ahead`)],
      events: (r) => [push('08:45', BUILDER, null, r.shas[0])],
    });
    expect(text).toMatch(/Ahmad-Faraj asked for this work/);
    expect(code).toBe(1);
  });

  it('fails an agent push that changes a governance file, whatever email the commit carries', async () => {
    const { code, text } = await run({
      email: 'dev@example.com',
      file: '.autonomy.yml',
      notes: () => [proposal, goAhead()],
      events: (r) => [push('10:10', AGENT, r.base, r.shas[0])],
    });
    expect(text).toMatch(/pushed by @ai-mr-reviewer.* changes files only people may change: \.autonomy\.yml/);
    expect(code).toBe(1);
  });

  it("leaves people's own pushes alone", async () => {
    const { code, text } = await run({ email: 'mazen@example.com', events: (r) => [push('10:10', 'Mazen-Ghanaym', r.base, r.shas[0])] });
    expect(text).toMatch(/1 push\(es\), 0 by agents/);
    expect(code).toBe(0);
  });

  it('skips a push a later force-push threw away, and still accounts for every commit', async () => {
    const gone = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const { code, text } = await run({
      notes: () => [proposal, goAhead()],
      events: (r) => [push('09:50', AGENT, r.base, gone), push('10:10', AGENT, gone, r.shas[0])],
    });
    // the second push names a head that's gone, so its commit is accounted for by no push
    expect(text).toMatch(/is in no push GitLab recorded/);
    expect(code).toBe(1);
  });

  it('needs a go-ahead for a push by an account outside go_ahead.people, whatever its name', async () => {
    const { code, text } = await run({ email: 'helper@example.com', events: (r) => [push('10:10', 'helper-robot', r.base, r.shas[0])] });
    expect(text).toMatch(/@helper-robot wrote no proposal/);
    expect(code).toBe(1);
  });

  it("doesn't count a go-ahead from someone outside the project's people", async () => {
    const { code, text } = await run({ notes: () => [proposal, goAhead('random-stranger')], events: (r) => [push('10:10', AGENT, r.base, r.shas[0])] });
    expect(text).toMatch(/random-stranger is not one of the people/);
    expect(code).toBe(1);
  });

  it('refuses a merge commit from an agent (its diff would hide a governance change)', async () => {
    const r = repo(0);
    const git = (...a: string[]) => execFileSync('git', a, { cwd: r.dir, encoding: 'utf8' }).trim();
    git('checkout', '-qb', 'side');
    execFileSync('mkdir', ['-p', join(r.dir, 'engine')]);
    writeFileSync(join(r.dir, 'engine', 'evil.ts'), 'x');
    git('add', '.');
    git('-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '-qm', 'side');
    git('checkout', '-q', '-');
    writeFileSync(join(r.dir, 'b.txt'), 'b');
    git('add', '.');
    git('-c', 'user.name=s', '-c', 'user.email=s@x', 'commit', '-qm', 'main side');
    git('-c', 'user.name=s', '-c', 'user.email=s@x', 'merge', '-q', '--no-ff', '-m', 'merge', 'side');
    const head = git('rev-parse', 'HEAD');
    const { code, text } = await runIn(r, {
      notes: () => [proposal, goAhead()],
      events: () => [push('10:10', AGENT, r.base, head)],
    });
    expect(text).toMatch(/is a merge commit; agents may not push merges/);
    expect(code).toBe(1);
  });

  it('catches a governance file with a non-ASCII name', async () => {
    const { code, text } = await run({ file: 'engine/é.ts', notes: () => [proposal, goAhead()], events: (r) => [push('10:10', AGENT, r.base, r.shas[0])] });
    expect(text).toMatch(/changes files only people may change: engine\/é\.ts/);
    expect(code).toBe(1);
  });

  it('fails with a plain message when GitLab does not answer', async () => {
    const { code, text } = await run({ api: 'http://127.0.0.1:9/api/v4', events: () => [] });
    expect(text).toMatch(/autonomy:goahead could not finish, so it fails/);
    expect(code).toBe(1);
  });

  it('passes an MR with no commits', async () => {
    const { code, text } = await run({ commits: 0, events: () => [] });
    expect(text).toContain('no commits on this MR');
    expect(code).toBe(0);
  });
});
