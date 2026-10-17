import { describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('src/cli/goahead.ts');
const CONFIG = resolve('../.autonomy.yml');
const AGENT = 'ai-mr-reviewer-group_e50080';

/** A git repo with one person's commit (the base) and the given agent commits on top. */
function repo(agentCommits: number, author = 'mr-reviewer') {
  const dir = mkdtempSync(join(tmpdir(), 'goahead-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(dir, 'a.txt'), 'a');
  git('add', '.');
  git('-c', 'user.name=Mazen', '-c', 'user.email=mazen@example.com', 'commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  const shas: string[] = [];
  for (let i = 0; i < agentCommits; i++) {
    writeFileSync(join(dir, 'a.txt'), `fix ${i}`);
    git('-c', `user.name=${author}`, '-c', 'user.email=service_account_group_1@noreply.gitlab.com', 'commit', '-qam', `fix ${i}`);
    shas.push(git('rev-parse', 'HEAD'));
  }
  return { dir, base, shas };
}

/** Serves the MR, its notes, and an issue with its notes, like GitLab's API. */
function gitlab(routes: Record<string, unknown>) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const page = new URL(req.url ?? '', 'http://x').searchParams.get('page') ?? '1';
    const body = routes[path];
    if (body === undefined) {
      res.writeHead(404).end('{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(Array.isArray(body) && page !== '1' ? [] : body));
  });
  return new Promise<{ url: string; close: () => void }>((ok) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      ok({ url: `http://127.0.0.1:${port}/api/v4`, close: () => server.close() });
    }),
  );
}

const note = (id: number, at: string, author: string, body: string, system = false) => ({ id, body, system, created_at: `2026-10-17T${at}:00Z`, author: { username: author } });

async function run(
  agentCommits: number,
  notes: (shas: string[]) => unknown[],
  tier = 'low',
  extra: Record<string, unknown> = {},
  opts: { author?: string; mrAuthor?: string } = {},
) {
  const r = repo(agentCommits, opts.author);
  const api = await gitlab({
    '/api/v4/projects/1/merge_requests/7': { author: { username: opts.mrAuthor ?? 'Mazen-Ghanaym' }, created_at: '2026-10-17T09:00:00Z', description: 'Closes #22' },
    '/api/v4/projects/1/issues/22': { author: { username: 'Issue-Author' } },
    '/api/v4/projects/1/merge_requests/7/notes': notes(r.shas),
    ...extra,
  });
  // async, so the stand-in server in this process can answer while the CLI runs
  const child = spawn('node', [CLI], {
    cwd: r.dir,
    env: { ...process.env, CI_API_V4_URL: api.url, CI_PROJECT_ID: '1', CI_MERGE_REQUEST_IID: '7', CI_MERGE_REQUEST_DIFF_BASE_SHA: r.base, AUTONOMY_TIER: tier, AUTONOMY_CONFIG: CONFIG, CI_JOB_TOKEN: 'job' },
  });
  let text = '';
  child.stdout.on('data', (d) => (text += d));
  child.stderr.on('data', (d) => (text += d));
  const code = await new Promise<number | null>((ok) => child.on('close', ok));
  api.close();
  return { code, text };
}

const pushed = (id: number, at: string, shas: string[]) => note(id, at, AGENT, `added ${shas.length} commit\n\n<ul>${shas.map((s) => `<li>${s.slice(0, 8)} - fix</li>`).join('')}</ul>`, true);

describe('autonomy:goahead against a git repo and a stand-in for GitLab', () => {
  it('passes an agent push that had a teammate\'s go-ahead after the proposal', async () => {
    const { code, text } = await run(1, (s) => [note(1, '10:00', AGENT, 'Review of x: proposed fixes'), note(2, '10:05', 'Ahmad-Faraj', `@${AGENT} go-ahead`), pushed(3, '10:10', s)]);
    expect(text).toContain('go-ahead in note 2 by @Ahmad-Faraj');
    expect(code).toBe(0);
  });

  it('fails a planted agent push with no go-ahead', async () => {
    const { code, text } = await run(1, (s) => [note(1, '10:00', AGENT, 'Review of x: proposed fixes'), pushed(3, '10:10', s)]);
    expect(text).toMatch(/no go-ahead mentioning @ai-mr-reviewer/);
    expect(code).toBe(1);
  });

  it('fails a high-risk push whose go-ahead came from a teammate who is not the maintainer', async () => {
    const { code, text } = await run(1, (s) => [note(1, '10:00', AGENT, 'Review'), note(2, '10:05', 'Ahmad-Faraj', `@${AGENT} go-ahead`), pushed(3, '10:10', s)], 'high');
    expect(text).toMatch(/not a maintainer; high risk needs @HamzaHassanain/);
    expect(code).toBe(1);
  });

  it('checks agent commits that were there when the MR opened against the issue it closes', async () => {
    const BUILDER = 'ai-issue-builder-group_e1c791';
    const issue = {
      '/api/v4/projects/1/issues/22': { author: { username: 'Ahmad-Faraj' } },
      '/api/v4/projects/1/issues/22/notes': [note(1, '08:00', BUILDER, 'Proposal for #22: ...'), note(2, '08:30', 'HamzaHassanain', `@${BUILDER} go-ahead`)],
    };
    const { code, text } = await run(1, () => [], 'low', issue, { author: 'issue-builder' });
    expect(text).toMatch(/go-ahead in note 2 on #22 by @HamzaHassanain/);
    expect(code).toBe(0);
  });

  it("doesn't accept one agent's go-ahead on the issue for another agent's commits", async () => {
    const BUILDER = 'ai-issue-builder-group_e1c791';
    const issue = {
      '/api/v4/projects/1/issues/22/notes': [note(1, '08:00', BUILDER, 'Proposal for #22: ...'), note(2, '08:30', 'Mazen-Ghanaym', `@${BUILDER} go-ahead`)],
    };
    const { code, text } = await run(1, () => [], 'low', issue, { author: 'pipeline-fixer' });
    expect(text).toMatch(/by "pipeline-fixer": no agent account on #22 matches/);
    expect(code).toBe(1);
  });

  it('on an MR an agent opened, the issue author still asked for it, so their go-ahead does not count', async () => {
    const BUILDER = 'ai-issue-builder-group_e1c791';
    const issue = {
      '/api/v4/projects/1/issues/22': { author: { username: 'Ahmad-Faraj' } },
      '/api/v4/projects/1/issues/22/notes': [note(1, '08:00', BUILDER, 'Proposal for #22: ...'), note(2, '08:30', 'Ahmad-Faraj', `@${BUILDER} go-ahead`)],
    };
    const { code, text } = await run(1, () => [], 'low', issue, { author: 'issue-builder', mrAuthor: BUILDER });
    expect(text).toMatch(/Ahmad-Faraj asked for this work/);
    expect(code).toBe(1);
  });

  it('reads a long push listed as a range, and needs a go-ahead for each push', async () => {
    const rangeNote = (id: number, at: string, first: string, last: string, n: number) =>
      note(id, at, AGENT, `added ${n} commits\n\n<ul><li>${first.slice(0, 8)}...${last.slice(0, 8)} - ${n} commits from branch \`fix\`</li></ul>`, true);
    const { code, text } = await run(4, (s) => [
      note(1, '10:00', AGENT, 'Review: proposed fixes'),
      note(2, '10:05', 'Ahmad-Faraj', `@${AGENT} go-ahead`),
      rangeNote(3, '10:10', s[0], s[2], 3),
      pushed(4, '10:20', [s[3]]),
    ]);
    expect(text).toMatch(/push at 2026-10-17T10:10:00Z by @ai-mr-reviewer.*: go-ahead in note 2/);
    expect(text).toMatch(/push at 2026-10-17T10:20:00Z .* between its previous push at 2026-10-17T10:10:00Z/);
    expect(code).toBe(1);
  });

  it('fails an agent commit that came after a recorded push but is in no push note', async () => {
    const { code, text } = await run(2, (s) => [note(1, '10:00', AGENT, 'Review'), note(2, '10:05', 'Ahmad-Faraj', `@${AGENT} go-ahead`), pushed(3, '10:10', [s[0]])]);
    expect(text).toMatch(/came after a recorded push, but no push note lists it/);
    expect(code).toBe(1);
  });

  it('fails with a plain message when GitLab does not answer', async () => {
    const r = repo(1);
    const child = spawn('node', [CLI], {
      cwd: r.dir,
      env: { ...process.env, CI_API_V4_URL: 'http://127.0.0.1:9/api/v4', CI_PROJECT_ID: '1', CI_MERGE_REQUEST_IID: '7', CI_MERGE_REQUEST_DIFF_BASE_SHA: r.base, AUTONOMY_CONFIG: CONFIG, CI_JOB_TOKEN: 'job' },
    });
    let text = '';
    child.stderr.on('data', (d) => (text += d));
    const code = await new Promise<number | null>((ok) => child.on('close', ok));
    expect(text).toMatch(/autonomy:goahead could not finish, so it fails/);
    expect(code).toBe(1);
  });

  it('passes an MR with no agent pushes or commits', async () => {
    const { code, text } = await run(0, () => []);
    expect(text).toContain('no agent pushes or agent commits');
    expect(code).toBe(0);
  });
});
