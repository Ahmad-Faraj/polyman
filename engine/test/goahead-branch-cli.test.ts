import { describe, expect, it } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const CLI = resolve('src/cli/goahead-branch.ts');
const CONFIG = resolve('../.autonomy.yml');
const REVIEWER = 'ai-mr-reviewer-group_e50080';
const BUILDER = 'ai-issue-builder-group_e1c791';
const BRANCH = '24-java-source-types-approved';

/** A repo whose first commit is the default branch (with the policy, or this one), and one agent commit on top. */
function repo(policy: boolean | string = true) {
  const dir = mkdtempSync(join(tmpdir(), 'goahead-branch-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'a');
  if (typeof policy === 'string') writeFileSync(join(dir, '.autonomy.yml'), policy);
  else if (policy) copyFileSync(CONFIG, join(dir, '.autonomy.yml'));
  git('add', '.');
  git('-c', 'user.name=Mazen', '-c', 'user.email=mazen@example.com', 'commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(join(dir, 'a.txt'), 'b');
  git('-c', 'user.name=agent', '-c', 'user.email=service_account_group_1@noreply.gitlab.com', 'commit', '-qam', 'test: tie schema Java sourceTypes');
  return { dir, base, head: git('rev-parse', 'HEAD') };
}

/**
 * Answers like GitLab's API for the given paths (arrays are paged), or with the
 * given error status. With `after`, it leaves out records from that day and
 * before, as GitLab's events API does.
 */
function gitlab(routes: Record<string, unknown>, errors: Record<string, number> = {}, after = false) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '', 'http://x');
    if (errors[url.pathname]) {
      res.writeHead(errors[url.pathname]).end('{"message":"server error"}');
      return;
    }
    const body = routes[url.pathname];
    if (body === undefined) {
      res.writeHead(404).end('{"message":"404 Not found"}');
      return;
    }
    const page = url.searchParams.get('page') ?? '1';
    const from = url.searchParams.get('after');
    const records = after && from && Array.isArray(body) ? body.filter((r: { created_at: string }) => r.created_at.slice(0, 10) > from) : body;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(Array.isArray(records) && page !== '1' ? [] : records));
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
  policy?: boolean | string;
  mrs?: unknown[];
  events: (r: { base: string; head: string }) => unknown[];
  /** what GET /issues/24 answers; undefined: 404 */
  issue?: unknown;
  issueNotes?: unknown[];
  /** API paths that answer with this error status */
  errors?: Record<string, number>;
  env?: Record<string, string>;
  /** the events API leaves out what is before its `after` day, as GitLab's does */
  windowed?: boolean;
}

async function run(c: Case) {
  const r = repo(c.policy ?? true);
  const api = await gitlab({
    '/api/v4/projects/1/merge_requests': c.mrs ?? [merged86],
    '/api/v4/projects/1/events': c.events(r),
    ...(c.issue === undefined ? {} : { '/api/v4/projects/1/issues/24': c.issue }),
    '/api/v4/projects/1/issues/24/notes': c.issueNotes ?? [],
  }, c.errors, c.windowed);
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
      GITLAB_RETRY_MS: '0',
      ...c.env,
    },
  });
  let text = '';
  child.stdout.on('data', (d) => (text += d));
  child.stderr.on('data', (d) => (text += d));
  const code = await new Promise<number | null>((ok) => child.on('close', ok));
  api.close();
  return { code, text };
}

const issue24 = { iid: 24, author: { username: 'Ahmad-Faraj' }, created_at: '2026-10-17T09:00:00Z' };

describe('autonomy:goahead:branch against a git repo and a stand-in for GitLab', () => {
  it("fails the #64 push: a review agent re-created a merged MR's branch with a commit nobody approved", async () => {
    const { code, text } = await run({ issue: issue24, events: (r) => [push('14:05', 'Ahmad-Faraj', null, r.base), push('14:22', REVIEWER, null, r.head)] });
    expect(text).toMatch(/by @ai-mr-reviewer-group_e50080 \(\w{8}\) on #24: .*wrote no proposal before the push/);
    expect(text).toMatch(/has no MR, so the go-ahead has to be on the issue the branch is named after, and with no risk score it is judged as high risk/);
    expect(text).toMatch(/Next: a go-ahead can't be given after the push\./);
    expect(code).toBe(1);
  });

  it('ends a failure with who can give the go-ahead and what to do next', async () => {
    const { code, text } = await run({ issue: issue24, events: (r) => [push('14:05', 'Ahmad-Faraj', null, r.base), push('14:22', REVIEWER, null, r.head)] });
    expect(text.trim().split('\n').slice(-2)).toEqual([
      `Assisted: an agent acts only on a person's go-ahead, one per push, from someone who didn't ask for the work. ${BRANCH} has no MR, so the go-ahead has to be on the issue the branch is named after, and with no risk score it is judged as high risk: only @HamzaHassanain, @Mazen-Ghanaym, @Ahmad-Faraj. If an MR for this branch opened after this job started, retry the job: that MR's pipeline judges these pushes.`,
      "Next: a go-ahead can't be given after the push. One of @HamzaHassanain, @Mazen-Ghanaym, @Ahmad-Faraj deletes the branch or moves the commits that had one to a new branch; for anything still wanted, the agent proposes again on the issue and waits for a new go-ahead.",
    ]);
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

  describe('reads pushes back to when the issue was created, so a go-ahead used on an old branch stays used', () => {
    const DAY = 86_400_000;
    const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
    const onBranch = (event: ReturnType<typeof push>, ref: string, created_at: string) => ({ ...event, created_at, push_data: { ...event.push_data, ref } });
    const goAhead = (days: number) => [
      { ...note(1, '00:00', BUILDER, 'Proposal for #24: the change'), created_at: ago(days + 1) },
      { ...note(2, '00:00', 'Mazen-Ghanaym', `@${BUILDER} go-ahead`), created_at: ago(days) },
    ];

    it('fails 24-b when 24-a used the go-ahead five days ago, before the base commit', async () => {
      const { code, text } = await run({
        branch: '24-b',
        windowed: true,
        mrs: [],
        issue: { ...issue24, created_at: ago(10) },
        issueNotes: goAhead(8),
        events: (r) => [onBranch(push('00:00', BUILDER, null, r.base), '24-a', ago(5)), onBranch(push('00:00', BUILDER, null, r.head), '24-b', ago(0))],
      });
      expect(text).toMatch(new RegExp(`no go-ahead mentioning @${BUILDER} between its previous push at ${ago(5).slice(0, 10)}T[\\d:.]+Z and the push`));
      expect(code).toBe(1);
    });

    it('passes 24-b on its own go-ahead after the 24-a push', async () => {
      const { code, text } = await run({
        branch: '24-b',
        windowed: true,
        mrs: [],
        issue: { ...issue24, created_at: ago(10) },
        issueNotes: [...goAhead(8), { ...note(3, '00:00', 'Mazen-Ghanaym', `@${BUILDER} go-ahead`), created_at: ago(1) }],
        events: (r) => [onBranch(push('00:00', BUILDER, null, r.base), '24-a', ago(5)), onBranch(push('00:00', BUILDER, null, r.head), '24-b', ago(0))],
      });
      expect(text).toContain('go-ahead in note 3 on #24 by @Mazen-Ghanaym');
      expect(code).toBe(0);
    });

    it("fails a go-ahead older than the 120 days it reads, as a push it can't see may have used it", async () => {
      const { code, text } = await run({
        branch: '24-b',
        windowed: true,
        mrs: [],
        issue: { ...issue24, created_at: ago(200) },
        issueNotes: goAhead(150),
        events: (r) => [onBranch(push('00:00', BUILDER, null, r.head), '24-b', ago(0))],
      });
      expect(text).toMatch(/go-ahead in note 2 is from .*, before the pushes read from \d{4}-\d\d-\d\d on, so whether an earlier push already used it can't be told; it needs a new go-ahead/);
      expect(code).toBe(1);
    });
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

  it('judges as high risk even when AUTONOMY_TIER says low: the push can set that variable', async () => {
    const onlyHamza = readFileSync(CONFIG, 'utf8').replace(/^  maintainers:\n(    - .*\n)+/m, '  maintainers:\n    - HamzaHassanain\n');
    expect(onlyHamza).not.toBe(readFileSync(CONFIG, 'utf8'));
    const { code, text } = await run({
      policy: onlyHamza,
      mrs: [],
      issue: issue24,
      issueNotes: [note(1, '14:00', BUILDER, 'Proposal for #24: the change'), note(2, '14:05', 'Mazen-Ghanaym', `@${BUILDER} go-ahead`)],
      events: (r) => [push('14:22', BUILDER, null, r.head)],
      env: { AUTONOMY_TIER: 'low' },
    });
    expect(text).toContain("go-ahead in note 2 doesn't count: @Mazen-Ghanaym is not a maintainer; high risk needs @HamzaHassanain");
    expect(text).toMatch(/judged as high risk: only @HamzaHassanain/);
    expect(code).toBe(1);
  });

  it("fails when GitLab answers the issue with an error other than 404, rather than taking the issue as missing", async () => {
    const { code, text } = await run({ mrs: [], issue: issue24, errors: { '/api/v4/projects/1/issues/24': 500 }, events: (r) => [push('14:22', BUILDER, null, r.head)] });
    expect(text).toMatch(/autonomy:goahead:branch could not finish, so it fails: GET .*issues\/24 -> 500/);
    expect(text).not.toMatch(/names no issue/);
    expect(code).toBe(1);
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

  describe('its shell, run up to where the guard would start', () => {
    const steps = (parse(ci) as Record<string, { before_script: string[]; script: string[] }>)['autonomy:goahead:branch'];
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

    /** A default branch in "origin" (with the guard or not), a clone of it, and the job run in the clone as GitLab runs it (set -eo pipefail). */
    function job(o: { guard: boolean; gitFailsOn?: string[] }) {
      const dir = mkdtempSync(join(tmpdir(), 'goahead-branch-job-'));
      const origin = join(dir, 'origin');
      const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
      mkdirSync(join(origin, 'engine/src/cli'), { recursive: true });
      git(origin, 'init', '-q', '-b', 'main');
      writeFileSync(join(origin, o.guard ? 'engine/src/cli/goahead-branch.ts' : 'engine/src/cli/other.ts'), '');
      git(origin, 'add', '.');
      git(origin, '-c', 'user.name=Mazen', '-c', 'user.email=mazen@example.com', 'commit', '-qm', 'base');
      git(dir, 'clone', '-q', 'origin', 'work');
      // a git that fails on the given subcommands, as a broken checkout would
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const fails = (o.gitFailsOn ?? []).map((c) => `${c}) echo "fatal: broken" >&2; exit 128;;`).join(' ');
      writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$1" in ${fails} esac\nexec "${realGit}" "$@"\n`);
      chmodSync(join(bin, 'git'), 0o755);
      const shell = ['set -eo pipefail', ...steps.before_script, steps.script[0], 'echo "the guard runs on $AUTONOMY_POLICY_REF"'].join('\n');
      return spawnSync('bash', ['-c', shell], {
        cwd: join(dir, 'work'),
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CI_DEFAULT_BRANCH: 'main' },
      });
    }

    it('goes on to the guard when the default branch has it', () => {
      const r = job({ guard: true });
      expect(r.stdout).toMatch(/the guard runs on [0-9a-f]{40}/);
      expect(r.status).toBe(0);
    });

    it('passes with nothing to judge when the default branch has no guard yet', () => {
      const r = job({ guard: false });
      expect(r.stdout).toContain('the default branch has no engine/src/cli/goahead-branch.ts yet, so nothing judges this push here');
      expect(r.stdout).not.toContain('the guard runs');
      expect(r.status).toBe(0);
    });

    it("stops when the default branch's head can't be read, not passes", () => {
      const r = job({ guard: true, gitFailsOn: ['rev-parse'] });
      expect(r.stdout).not.toContain('nothing judges');
      expect(r.stdout).not.toContain('the guard runs');
      expect(r.status).not.toBe(0);
    });

    it("fails when git can't read the default branch's tree, rather than taking the guard as missing", () => {
      const r = job({ guard: true, gitFailsOn: ['cat-file', 'ls-tree'] });
      expect(r.stderr).toContain("can't read the default branch's head");
      expect(r.stdout).not.toContain('nothing judges');
      expect(r.status).toBe(1);
    });
  });
});
