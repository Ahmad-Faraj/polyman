import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// release.ts check mode (approvals with the job token). Top-level script: fake fs, GitLab and process.exit.

const files = vi.hoisted(() => ({ written: {} as Record<string, string> }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (path === 'health-report.json') throw new Error('ENOENT');
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.readFileSync,
    writeFileSync: ((path: string, data: string) => {
      files.written[path] = String(data);
    }) as typeof actual.writeFileSync,
  };
});

const BASE = 'https://gitlab.test/api/v4';
const SHA = 'abcdef1234567890';
const saved = { ...process.env };

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: { description?: string };
}
let calls: Call[];

class Exit extends Error {
  code: number | undefined;
  constructor(code: number | undefined) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const mr = (over: Record<string, unknown> = {}) => ({
  iid: 7,
  title: 'Add refunds',
  state: 'merged',
  labels: ['risk::high'],
  web_url: 'x',
  author: { username: 'dev' },
  ...over,
});

interface World {
  mrs?: unknown[];
  approvals?: unknown;
  approvalsStatus?: number;
  /** answer to the anonymous retry of the approvals read */
  approvalsAnonymous?: unknown;
  notes?: unknown[];
}

function fakeGitLab(world: World = {}) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      const path = url.slice(BASE.length);
      const headers = init.headers ?? {};
      calls.push({ method: init.method ?? 'GET', path, headers, body: init.body ? JSON.parse(init.body) : undefined });
      const ok = (data: unknown) => new Response(JSON.stringify(data));
      if (init.method === 'POST') return ok({});
      if (path.includes('/repository/commits/')) return ok(world.mrs ?? [mr()]);
      if (path.endsWith('/approvals')) {
        if (world.approvalsStatus) {
          if (!headers['JOB-TOKEN'] && world.approvalsAnonymous) return ok(world.approvalsAnonymous);
          return new Response('{"message":"denied"}', { status: world.approvalsStatus });
        }
        return ok(world.approvals ?? { approved_by: [{ user: { username: 'alice' } }] });
      }
      if (path.includes('/notes')) return ok(world.notes ?? []);
      return ok([]);
    }),
  );
}

async function run(mode: 'check' | 'report') {
  vi.resetModules();
  process.argv[2] = mode;
  await import('../src/cli/release.ts');
}

const releaseBody = () => calls.find((c) => c.method === 'POST' && c.path === '/projects/42/releases')?.body?.description ?? '';
const note = (username: string | undefined, body: string) => ({ body, ...(username ? { author: { username } } : {}) });
const REVIEWER = 'ai-mr-reviewer-gitlab-ai-hackathon_dc1918';
const FIXER = 'ai-pipeline-fixer-gitlab-ai-hackathon';

beforeEach(() => {
  files.written = {};
  delete process.env.AUTONOMY_REVIEWER_ACCOUNT;
  delete process.env.AUTONOMY_FIXER_ACCOUNT;
  delete process.env.AUTONOMY_BOT_TOKEN;
  process.env.CI_API_V4_URL = BASE;
  process.env.CI_PROJECT_ID = '42';
  process.env.CI_JOB_TOKEN = 'job-secret';
  process.env.CI_COMMIT_SHA = SHA;
  process.env.CI_PIPELINE_ID = '99';
  process.env.CI_PIPELINE_URL = 'https://gitlab.test/p/99';
  process.env.AUTONOMY_CONFIG = 'does-not-exist.yml';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exit(code);
  }) as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('release check with the job token', () => {
  it('reads the merged MR and its approvals with JOB-TOKEN and writes release.env', async () => {
    fakeGitLab({ approvals: { approved_by: [{ user: { username: 'alice' } }, { user: { username: 'bob' } }] } });
    await run('check');
    expect(calls.map((c) => c.path)).toEqual([`/projects/42/repository/commits/${SHA}/merge_requests`, '/projects/42/merge_requests/7/approvals']);
    expect(calls.every((c) => c.method === 'GET' && c.headers['JOB-TOKEN'] === 'job-secret' && !('PRIVATE-TOKEN' in c.headers))).toBe(true);
    expect(files.written['release.env']).toBe('RELEASE_MR_IID=7\nRELEASE_APPROVED_BY=alice,bob\nRELEASE_TIER=high\n');
  });

  it('reports the tier as unknown when the MR has no risk label', async () => {
    fakeGitLab({ mrs: [mr({ labels: ['bug'] })] });
    await run('check');
    expect(files.written['release.env']).toContain('RELEASE_TIER=unknown');
  });

  it('exits 1 and writes nothing when nobody approved', async () => {
    fakeGitLab({ approvals: { approved_by: [] } });
    await expect(run('check')).rejects.toMatchObject({ code: 1 });
    expect(files.written['release.env']).toBeUndefined();
  });

  it('exits 1 when the commit has no merged MR, without reading approvals', async () => {
    fakeGitLab({ mrs: [mr({ state: 'opened' })] });
    await expect(run('check')).rejects.toMatchObject({ code: 1 });
    expect(calls.some((c) => c.path.endsWith('/approvals'))).toBe(false);
    expect(files.written['release.env']).toBeUndefined();
  });

  it('exits 1 when the commit belongs to no MR at all', async () => {
    fakeGitLab({ mrs: [] });
    await expect(run('check')).rejects.toMatchObject({ code: 1 });
  });

  it('retries a refused approvals read without credentials and carries on if that works', async () => {
    fakeGitLab({ approvalsStatus: 403, approvalsAnonymous: { approved_by: [{ user: { username: 'alice' } }] } });
    await run('check');
    expect(files.written['release.env']).toContain('RELEASE_APPROVED_BY=alice');
  });

  it('fails the job (not "no approval") when the approvals read is refused both ways', async () => {
    fakeGitLab({ approvalsStatus: 403 });
    await expect(run('check')).rejects.toMatchObject({ status: 403 });
    expect(process.exit).not.toHaveBeenCalled();
    expect(files.written['release.env']).toBeUndefined();
  });

  it('rejects an unknown mode', async () => {
    fakeGitLab();
    await expect(run('nope' as never)).rejects.toThrow('usage: release.ts check|report');
  });
});
