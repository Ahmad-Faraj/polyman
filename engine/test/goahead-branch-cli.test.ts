import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('src/cli/goahead-branch.ts');
const CONFIG = resolve('../.autonomy.yml');
const REVIEWER = 'ai-mr-reviewer-group_e50080';
const BUILDER = 'ai-issue-builder-group_e1c791';
const BRANCH = '24-java-source-types-approved';

/** A repo whose first commit is the default branch (with the policy), and one agent commit on top. */
function repo(policy = true) {
  const dir = mkdtempSync(join(tmpdir(), 'goahead-branch-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'a');
  if (policy) copyFileSync(CONFIG, join(dir, '.autonomy.yml'));
  git('add', '.');
  git('-c', 'user.name=Mazen', '-c', 'user.email=mazen@example.com', 'commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'b');
  git('-c', 'user.name=agent', '-c', 'user.email=service_account_group_1@noreply.gitlab.com', 'commit', '-qam', 'test: tie schema Java sourceTypes');
  return { dir, base, head: git('rev-parse', 'HEAD') };
}

/** Answers like GitLab's API for the given paths (arrays are paged). */
function gitlab(routes: Record<string, unknown>) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    const body = routes[url.pathname];
    if (body === undefined) {
      res.writeHead(404).end('{"message":"404 Not found"}');
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

const at = (time: string) => `2026-10-18T${time}:00Z`;
const note = (id: number, time: string, author: string, body: string) => ({ id, body, system: false, created_at: at(time), author: { username: author } });
const push = (time: string, by: string, from: string | null, to: string) => ({
  created_at: at(time),
  author: { username: by },
  push_data: { ref: BRANCH, ref_type: 'branch', action: from ? 'pushed' : 'created', commit_from: from, commit_to: to },
});
const merged86 = { iid: 86, state: 'merged', source_project_id: 1, created_at: at('14:10'), merged_at: at('14:20') };

interface Case {
  branch?: string;
  policy?: boolean;
  mrs?: unknown[];
  events: (r: { base: string; head: string }) => unknown[];
  /** what GET /issues/24 answers; undefined: 404 */
  issue?: unknown;
  issueNotes?: unknown[];
}

async function run(c: Case) {
  const r = repo(c.policy ?? true);
  const api = await gitlab({
    '/api/v4/projects/1/merge_requests': c.mrs ?? [merged86],
    '/api/v4/projects/1/events': c.events(r),
    ...(c.issue === undefined ? {} : { '/api/v4/projects/1/issues/24': c.issue }),
    '/api/v4/projects/1/issues/24/notes': c.issueNotes ?? [],
  });
  const child = spawn('node', [CLI], {
    cwd: r.dir,
    env: {
      ...process.env,
      CI_API_V4_URL: api.url,
      CI_API_GRAPHQL_URL: '',
      CI_PROJECT_ID: '1',
      CI_PROJECT_PATH: 'group/showcase',
      CI_JOB_TOKEN: 'job',
      CI_COMMIT_BRANCH: c.branch ?? BRANCH,
      CI_DEFAULT_BRANCH: 'main',
      AUTONOMY_POLICY_REF: r.base,
      AUTONOMY_CONFIG: '.autonomy.yml',
      AUTONOMY_TIER: '',
    },
  });
  let text = '';
  child.stdout.on('data', (d) => (text += d));
  child.stderr.on('data', (d) => (text += d));
  const code = await new Promise<number | null>((ok) => child.on('close', ok));
  api.close();
  return { code, text };
}

const issue24 = { iid: 24, author: { username: 'Ahmad-Faraj' } };

describe('autonomy:goahead:branch against a git repo and a stand-in for GitLab', () => {
  it("fails the #64 push: a review agent re-created a merged MR's branch with a commit nobody approved", async () => {
    const { code, text } = await run({ issue: issue24, events: (r) => [push('14:05', 'Ahmad-Faraj', null, r.base), push('14:22', REVIEWER, null, r.head)] });
    expect(text).toMatch(/by @ai-mr-reviewer-group_e50080 \(\w{8}\) on #24: .*wrote no proposal before the push/);
    expect(text).toMatch(/has no MR, so the go-ahead has to be on the issue the branch is named after, and with no risk score it is judged as high risk/);
    expect(text).toMatch(/Next: a go-ahead can't be given after the push\./);
    expect(code).toBe(1);
  });

  it("passes the issue-builder's push with a maintainer's go-ahead on the issue", async () => {
    const { code, text } = await run({
      mrs: [],
      issue: issue24,
      issueNotes: [note(1, '14:00', BUILDER, 'Proposal for #24: the change'), note(2, '14:05', 'Mazen-Ghanaym', `@${BUILDER} go-ahead`)],
      events: (r) => [push('14:22', BUILDER, null, r.head)],
    });
    expect(text).toContain('go-ahead in note 2 on #24 by @Mazen-Ghanaym');
    expect(text).toContain(`1 commit(s) on ${BRANCH} not on main, 1 agent push(es) no MR covers, risk high: each had its own go-ahead`);
    expect(code).toBe(0);
  });

  it("leaves a branch with an open MR to that MR's pipeline", async () => {
    const { code, text } = await run({
      mrs: [{ iid: 90, state: 'opened', source_project_id: 1, created_at: at('14:23') }],
      events: (r) => [push('14:22', BUILDER, null, r.head)],
    });
    expect(text).toContain(`${BRANCH} has an open MR, !90: autonomy:goahead in its pipeline judges every push to it`);
    expect(code).toBe(0);
  });

  it("doesn't take a fork's MR with the same branch name as covering the push", async () => {
    const { code, text } = await run({
      mrs: [{ iid: 91, state: 'opened', source_project_id: 2, created_at: at('14:23') }],
      issue: issue24,
      events: (r) => [push('14:22', REVIEWER, null, r.head)],
    });
    expect(text).toMatch(/wrote no proposal/);
    expect(code).toBe(1);
  });

  it('fails an agent push to a branch whose issue GitLab does not have', async () => {
    const { code, text } = await run({ events: (r) => [push('14:22', REVIEWER, null, r.head)] });
    expect(text).toMatch(/which has no MR, and the branch names no issue written by a person to hold its go-ahead/);
    expect(code).toBe(1);
  });

  it('passes a branch only people pushed to', async () => {
    const { code, text } = await run({ branch: 'docs/notes', events: (r) => [{ ...push('14:22', 'HamzaHassanain', null, r.head), push_data: { ref: 'docs/notes', ref_type: 'branch', action: 'created', commit_from: null, commit_to: r.head } }] });
    expect(text).toContain('1 commit(s) on docs/notes not on main, 0 agent push(es) no MR covers');
    expect(code).toBe(0);
  });

  it('does nothing on the default branch', async () => {
    const { code, text } = await run({ branch: 'main', events: () => [] });
    expect(text).toContain('main is the default branch, which autonomy:guard:main checks');
    expect(code).toBe(0);
  });

  it('fails when the default branch has no policy file', async () => {
    const { code, text } = await run({ policy: false, events: () => [] });
    expect(text).toMatch(/autonomy:goahead:branch could not finish, so it fails: the default branch has no \.autonomy\.yml/);
    expect(code).toBe(1);
  });
});

describe('the autonomy:goahead:branch job', () => {
  const ci = readFileSync(new URL('../ci/autonomy.gitlab-ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const lines = ci.split('\n');
  const start = lines.indexOf('autonomy:goahead:branch:');
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l) && !l.startsWith('#'));
  const job = rest.slice(0, end < 0 ? undefined : end).join('\n');

  it('runs on every push to a branch other than the default one', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(job).toContain('- if: $CI_COMMIT_BRANCH && $CI_COMMIT_BRANCH != $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "push"');
    expect(job).not.toContain('allow_failure');
  });

  it("runs the default branch's guard, not the pushed branch's", () => {
    expect(job).toContain('git fetch -q origin "+refs/heads/$CI_DEFAULT_BRANCH:refs/goahead/default"');
    expect(job).toContain('git archive "$AUTONOMY_POLICY_REF" engine | tar -x -C "$GUARD"');
    expect(job).toContain('node "$GUARD/engine/src/cli/goahead-branch.ts"');
    // its own before_script, so the pushed branch's engine is never installed or run
    expect(job).toContain('  before_script:\n');
  });
});
