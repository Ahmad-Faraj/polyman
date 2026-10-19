import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli/session-audit.ts';
import { type SessionNode, sessionReport } from '../src/session-audit.ts';

// sessionReport as it is, unless a test makes it throw
vi.mock('../src/session-audit.ts', async (actual) => {
  const real = await actual<typeof import('../src/session-audit.ts')>();
  return { ...real, sessionReport: vi.fn(real.sessionReport) };
});

// the issue-builder session from the pure tests (it pushed 4-formatter-light-theme
// at 06:31:36), read through a GitLab stood in for by a fetch that answers from fixtures
const dir = 'test/fixtures/session-audit';
const read = (name: string) => readFileSync(`${dir}/${name}`, 'utf8');
const nodes = (JSON.parse(read('sessions.json')) as { data: { project: { duoWorkflowWorkflows: { nodes: SessionNode[] } } } }).data.project.duoWorkflowWorkflows.nodes;
const builder = nodes.find((n) => n.id.endsWith('/9647635'))!;
const failed = nodes.find((n) => n.id.endsWith('/9663778'))!;
const ACCEPTED = 'push at 2026-10-18T06:31:36.500Z by @ai-issue-builder-x (46fb4e00): go-ahead in note 1 by @a-person';
const GOAHEAD = { id: 77, name: 'autonomy:goahead', status: 'success', started_at: '2026-10-18T06:32:00Z' };

interface Fake {
  /** what the session list says of who is asking (null: nobody, as GitLab says to a token it doesn't take) */
  user?: string | null;
  /** the session list's HTTP status (401: refused) */
  listStatus?: number;
  checkpointFails?: boolean;
  /** the pipeline's jobs, a page each */
  jobs?: { id: number; name: string; status: string; started_at: string | null }[][];
  /** the guard job's log (null: a 404, as for an expired log) */
  log?: string | null;
  /** the sessions listed */
  sessions?: SessionNode[];
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function gitlab({ user = 'auditor', listStatus = 200, checkpointFails = false, jobs = [[GOAHEAD]], log = ACCEPTED, sessions = [builder] }: Fake = {}) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const u = new URL(url);
    if (u.pathname === '/api/graphql') {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      if (query.includes('duoWorkflowWorkflows')) {
        if (listStatus !== 200) return new Response('', { status: listStatus });
        const list = { pageInfo: { hasNextPage: false, endCursor: '' }, nodes: sessions };
        return json({ data: { currentUser: user === null ? null : { username: user }, project: user === null ? null : { duoWorkflowWorkflows: list } } });
      }
      return checkpointFails ? json({ errors: [{ message: 'Internal server error' }] }) : json({ data: { duoWorkflowEvents: { nodes: [] } } });
    }
    const path = u.pathname;
    if (path.endsWith('/workflows/9647635/trace.jsonl')) return new Response(read('trace-builder.jsonl'));
    if (path.endsWith('/trace.jsonl')) return new Response('{"channel":"status","value":"Failed"}\n');
    if (path.endsWith('/merge_requests')) return json([{ iid: 54, state: 'opened', created_at: '2026-10-18T06:31:40Z', merged_at: null, closed_at: null }]);
    if (path.endsWith('/merge_requests/54/pipelines')) return json([{ id: 900, sha: 'c'.repeat(40), created_at: '2026-10-18T06:31:45Z' }]);
    if (path.endsWith('/pipelines/900/jobs')) return json(jobs[Number(u.searchParams.get('page') ?? 1) - 1] ?? []);
    if (path.endsWith('/jobs/77/trace')) return log === null ? new Response('', { status: 404 }) : new Response(log);
    return new Response('', { status: 404 });
  });
}

const ENV = { GITLAB_URL: 'https://gitlab.test', AUDIT_TOKEN: 'audit-token' };
const audit = (env: NodeJS.ProcessEnv = ENV) => main(['group/showcase', '--since', '2026-10-18'], env);
let errors: string[] = [];
let printed: string[] = [];

beforeEach(() => {
  errors = [];
  printed = [];
  vi.spyOn(console, 'error').mockImplementation((line: string) => void errors.push(line));
  vi.spyOn(console, 'log').mockImplementation((line: string) => void printed.push(line));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the session audit against GitLab', () => {
  it("accepts a push the guard's log accepts", async () => {
    gitlab();
    expect(await audit()).toBe(0);
    expect(printed.join('\n')).toContain('| guard | autonomy:goahead on pipeline 900: push at 2026-10-18T06:31:36.500Z');
  });

  it('finds autonomy:goahead past the first page of a pipeline\'s jobs', async () => {
    const others = Array.from({ length: 100 }, (_, i) => ({ id: i + 1000, name: `test:${i}`, status: 'success', started_at: null }));
    gitlab({ jobs: [others, [GOAHEAD]] });
    expect(await audit()).toBe(0);
    expect(printed.join('\n')).toContain('| guard |');
  });

  it("leaves a push unjudged when the guard's log can't be read, and says why", async () => {
    gitlab({ log: null });
    expect(await audit()).toBe(1);
    expect(printed.join('\n')).toContain('**unjudged** | autonomy:goahead passed on pipeline 900, but its log was not readable');
    expect(errors).toContain('warning: pipeline 900: the log of autonomy:goahead (job 77) is not readable: GET /:project/jobs/77/trace -> 404');
  });

  it("says it couldn't finish when a session's checkpoint can't be read", async () => {
    gitlab({ checkpointFails: true });
    expect(await audit()).toBe(2);
    expect(errors).toContain('warning: session 9647635: checkpoint: GraphQL: Internal server error');
    expect(printed.join('\n')).toContain("**Not finished: 1 session(s) weren't read in full.");
  });

  it("reports a session it can't make sense of as unread, and still the others", async () => {
    const real = (await vi.importActual<typeof import('../src/session-audit.ts')>('../src/session-audit.ts')).sessionReport;
    vi.mocked(sessionReport).mockImplementation((node, web, trace, checkpoint) => {
      if (node.id === failed.id && trace) throw new TypeError("Cannot read properties of null (reading 'tool_info')");
      return real(node, web, trace, checkpoint);
    });
    try {
      gitlab({ sessions: [builder, failed] });
      expect(await audit()).toBe(2);
      expect(errors).toContain("warning: session 9663778: trace and checkpoint: Cannot read properties of null (reading 'tool_info')");
      const text = printed.join('\n');
      expect(text).toContain("**Not finished: 1 session(s) weren't read in full.");
      expect(text).toContain('| guard | autonomy:goahead on pipeline 900');
      expect(text).toContain('| [9663778](');
    } finally {
      vi.mocked(sessionReport).mockImplementation(real);
    }
  });

  it("says it couldn't finish when GitLab doesn't take the token, and passes without one", async () => {
    gitlab({ user: null });
    expect(await audit()).toBe(2);
    expect(printed.join('\n')).toContain('Skipped: GitLab answered as if nobody asked to the token');
    gitlab({ listStatus: 401 });
    expect(await audit({ GITLAB_URL: 'https://gitlab.test' })).toBe(0);
    expect(printed.join('\n')).toContain('Skipped: no AUDIT_TOKEN, and GitLab answered 401');
  });
});
