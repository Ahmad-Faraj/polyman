import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// monitor.ts is a top-level script: fake traffic.json, the GitLab notes API and
// process.exit, then import it fresh.

const files = vi.hoisted(() => ({ traffic: '', written: {} as Record<string, string> }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) =>
      path === 'traffic.json' ? files.traffic : (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof actual.readFileSync,
    writeFileSync: ((path: string, data: string) => {
      files.written[path] = String(data);
    }) as typeof actual.writeFileSync,
  };
});

const BASE = 'https://gitlab.test/api/v4';
const NOTES = '/projects/42/merge_requests/9/notes?per_page=100&sort=desc';
const saved = { ...process.env };
let calls: { method: string; path: string; headers: Record<string, string> }[];

class Exit extends Error {
  code: number | undefined;
  constructor(code: number | undefined) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const watch = (max: number, route = 'POST /api/payments/:id/refund') =>
  '```watch\n' + JSON.stringify([{ route, signal: 'error_rate', max }]) + '\n```';
const agentNote = (max: number) => ({ body: `Review of 3e14b10: ready to approve.\n\n${watch(max)}`, author: { username: 'ai-mr-reviewer-gitlab-ai-hackathon_dc1918' } });
const lookAlike = (max: number) => ({ body: `Review of 9999999: ready to approve.\n\n${watch(max)}`, author: { username: 'mallory' } });
const traffic = (errorRate: number) =>
  JSON.stringify({ routes: { 'POST /api/payments/:id/refund': { count: 100, errorRate, p95Ms: 20 } } });

type NotesReply = unknown[] | { status: number; anonymous?: unknown[] };

function fakeGitLab(notes: NotesReply) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
      const path = url.slice(BASE.length);
      calls.push({ method: init.method ?? 'GET', path, headers: init.headers ?? {} });
      if (path !== NOTES) return new Response('{}', { status: 404 });
      if (Array.isArray(notes)) return new Response(JSON.stringify(notes));
      const anonymous = !(init.headers ?? {})['JOB-TOKEN'];
      if (anonymous && notes.anonymous) return new Response(JSON.stringify(notes.anonymous));
      return new Response(JSON.stringify({ message: 'error' }), { status: notes.status });
    }),
  );
}

async function runMonitor() {
  vi.resetModules();
  process.argv[2] = 'traffic.json';
  await import('../src/cli/monitor.ts');
}

const health = () => JSON.parse(files.written['health-report.json']);

beforeEach(() => {
  files.written = {};
  files.traffic = traffic(0);
  delete process.env.AUTONOMY_REVIEWER_ACCOUNT;
  process.env.CI_API_V4_URL = BASE;
  process.env.CI_PROJECT_ID = '42';
  process.env.CI_JOB_TOKEN = 'job-secret';
  delete process.env.AUTONOMY_BOT_TOKEN;
  process.env.RELEASE_MR_IID = '9';
  // a 5xx on a read is tried again (#98); no test waits for that
  process.env.GITLAB_RETRY_MS = '0';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exit(code);
  }) as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('monitor: no longer writes to the MR', () => {
  it('only makes GET requests and sends the job token', async () => {
    fakeGitLab([agentNote(0.5)]);
    await runMonitor();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${NOTES}`]);
    expect(calls[0].headers['JOB-TOKEN']).toBe('job-secret');
  });

  it('writes health-report.json for the release notes even when the check fails', async () => {
    files.traffic = traffic(0.9);
    fakeGitLab([]);
    await expect(runMonitor()).rejects.toMatchObject({ code: 1 });
    expect(Object.keys(files.written)).toEqual(['health-report.json']);
  });
});

describe('monitor: the notes read fails', () => {
  it('falls back to the default checks on a server error instead of failing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeGitLab({ status: 500 });
    await runMonitor();
    expect(health()).toMatchObject({ planSource: 'unreadable', plan: [] });
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('retries a 403 anonymously and carries on with what that returns', async () => {
    files.traffic = traffic(0.03);
    fakeGitLab({ status: 403, anonymous: [agentNote(0.02)] });
    await expect(runMonitor()).rejects.toMatchObject({ code: 1 });
    expect(calls.map((c) => !!c.headers['JOB-TOKEN'])).toEqual([true, false]);
  });

  it('does not roll back a healthy release when the review cannot be read at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeGitLab({ status: 403 });
    await runMonitor();
    expect(health().planSource).toBe('unreadable');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('still fails a release that is actually unhealthy when the review cannot be read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    files.traffic = traffic(0.5);
    fakeGitLab({ status: 403 });
    await expect(runMonitor()).rejects.toMatchObject({ code: 1 });
  });

  it('warns which MR could not be read, and runs the default checks on the traffic', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeGitLab({ status: 500 });
    await runMonitor();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("couldn't read the review on !9"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('default checks only'));
    expect(health().results).toMatchObject([{ ok: true, source: 'default' }]);
  });

  it('falls back when the notes reply is not JSON', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad gateway</html>', { status: 200 })));
    await runMonitor();
    expect(health().planSource).toBe('unreadable');
    expect(process.exit).not.toHaveBeenCalled();
  });

  it('fails the job when the traffic file is missing, even if notes are unreadable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    files.traffic = 'not json';
    fakeGitLab({ status: 500 });
    await expect(runMonitor()).rejects.toThrow();
  });

  it("records planSource 'review' when an agent review supplies the watch list", async () => {
    fakeGitLab([agentNote(0.5)]);
    await runMonitor();
    expect(health()).toMatchObject({ planSource: 'review' });
    expect(health().plan).toHaveLength(1);
  });

  it("records planSource 'none' when notes were read but hold no agent review", async () => {
    fakeGitLab([lookAlike(0.5)]);
    await runMonitor();
    expect(health()).toMatchObject({ planSource: 'none', plan: [] });
  });

  it("records planSource 'none' when there are no notes at all", async () => {
    fakeGitLab([]);
    await runMonitor();
    expect(health().planSource).toBe('none');
  });

  it('fails when RELEASE_MR_IID is missing', async () => {
    delete process.env.RELEASE_MR_IID;
    fakeGitLab([]);
    await expect(runMonitor()).rejects.toThrow('RELEASE_MR_IID');
    expect(calls).toEqual([]);
  });
});

describe('monitor: traffic with no routes', () => {
  // A run that measured nothing must not pass the release.
  it('fails the job when the traffic file has no routes at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    files.traffic = JSON.stringify({ routes: {} });
    fakeGitLab([]);
    await expect(runMonitor()).rejects.toMatchObject({ code: 1 });
  });
});
