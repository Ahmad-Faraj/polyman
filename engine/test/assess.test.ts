import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUMMARY_END, SUMMARY_START } from '../src/report.ts';

// assess.ts is a top-level script. Git and the file system are faked, the risk
// scoring is real, and fetch plays GitLab.

const state = vi.hoisted(() => ({ files: [] as unknown[], findings: [] as unknown[], written: {} as Record<string, string> }));

vi.mock('../src/inputs.ts', () => ({
  changedFiles: () => state.files,
  securityFindings: () => ({ findings: state.findings, reports: [] }),
  loadIncidents: () => [],
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: ((path: string, data: string) => {
      state.written[path] = String(data);
    }) as typeof actual.writeFileSync,
  };
});

const BASE = 'https://gitlab.test/api/v4';
const saved = { ...process.env };
const file = (path: string, added = 1) => ({ path, status: 'M', added, deleted: 0 });

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: { name: string };
}
let calls: Call[];
let logs: string[];
let warns: string[];

function fakeGitLab(status = 200) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      calls.push({ url, method: init?.method, headers: init?.headers, body: JSON.parse(init?.body ?? '{}') });
      return new Response(status === 200 ? '{}' : '{"message":"denied"}', { status });
    }),
  );
}

async function runAssess() {
  vi.resetModules();
  process.argv[2] = 'origin/main';
  await import('../src/cli/assess.ts');
}

beforeEach(() => {
  state.files = [];
  state.findings = [];
  state.written = {};
  logs = [];
  warns = [];
  process.env.CI_API_V4_URL = BASE;
  process.env.CI_PROJECT_ID = '42';
  process.env.CI_JOB_TOKEN = 'job-secret';
  process.env.CI_PIPELINE_ID = '99';
  process.env.AUTONOMY_CONFIG = 'does-not-exist.yml';
  delete process.env.AUTONOMY_BOT_TOKEN;
  vi.spyOn(console, 'log').mockImplementation((...a) => void logs.push(a.join(' ')));
  vi.spyOn(console, 'warn').mockImplementation((...a) => void warns.push(a.join(' ')));
  fakeGitLab();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...saved };
});

describe('assess: naming the pipeline', () => {
  it('PUTs "risk TIER SCORE/100 - top factor" to the pipeline metadata with the job token', async () => {
    state.files = [file('.gitlab-ci.yml'), file('src/other.ts')];
    await runAssess();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe(`${BASE}/projects/42/pipelines/99/metadata`);
    expect(calls[0].headers['JOB-TOKEN']).toBe('job-secret');
    expect(calls[0].body.name).toBe('risk high 60/100 - it changes the pipeline or its policy (.gitlab-ci.yml)');
    expect(logs).toContain(`pipeline name: ${calls[0].body.name}`);
  });

  it('names the rule that forced the tier, even when another factor scored more', async () => {
    state.files = [file('.gitlab-ci.yml'), file('src/a.ts', 500)]; // policy +40, size +20, missing tests +10
    state.findings = [{ scanner: 'sast', severity: 'Critical', name: 'x', file: 'src/a.ts' }]; // +45
    await runAssess();
    expect(calls[0].body.name).toMatch(/ - it changes the pipeline or its policy \(\.gitlab-ci\.yml\)$/);
  });

  it('uses the highest-scoring factor, whatever its position', async () => {
    state.files = [file('docs/a.md', 60), file('package.json')]; // size +5, dependencies +20
    await runAssess();
    expect(calls[0].body.name).toBe('risk medium 25/100 - dependency manifest changed');
  });

  it('leaves the factor off when there are none', async () => {
    state.files = [file('docs/a.md')];
    await runAssess();
    expect(calls[0].body.name).toBe('risk low 0/100');
  });

  it('cuts the name to 250 characters', async () => {
    state.files = [file(`.gitlab/${'a'.repeat(400)}.yaml`)];
    await runAssess();
    const { name } = calls[0].body;
    expect(name).toHaveLength(250);
    expect(name.startsWith('risk high ')).toBe(true);
  });

  it('stays non-fatal when GitLab refuses the update', async () => {
    fakeGitLab(403);
    state.files = [file('src/other.ts')];
    await expect(runAssess()).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(warns.join('\n')).toMatch(/could not name the pipeline: PUT .*metadata -> 403/);
    expect(logs.join('\n')).not.toContain('pipeline name:');
    expect(state.written['risk-report.json']).toBeDefined();
  });

  it('stays non-fatal when the network call itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('socket hang up'); }));
    state.files = [file('src/other.ts')];
    await expect(runAssess()).resolves.toBeUndefined();
    expect(warns.join('\n')).toContain('could not name the pipeline: socket hang up');
  });

  it.each(['CI_JOB_TOKEN', 'CI_PIPELINE_ID'])('does not call GitLab without %s', async (name) => {
    delete process.env[name];
    state.files = [file('src/other.ts')];
    await runAssess();
    expect(calls).toHaveLength(0);
    expect(state.written['risk-report.json']).toBeDefined();
  });

  it('does not call GitLab when CI_JOB_TOKEN is empty', async () => {
    process.env.CI_JOB_TOKEN = '';
    await runAssess();
    expect(calls).toHaveLength(0);
  });
});

describe('assess: outputs', () => {
  it('writes the report files and the dotenv for later jobs', async () => {
    state.files = [file('.gitlab-ci.yml')];
    await runAssess();
    expect(state.written['autonomy.env']).toBe('AUTONOMY_TIER=high\nAUTONOMY_SCORE=40\n');
    expect(JSON.parse(state.written['risk-report.json'])).toMatchObject({ tier: 'high', score: 40, baseRef: 'origin/main' });
    expect(state.written['metrics.txt']).toContain('autonomy_risk_score 40');
  });

  it('prints the summary between the markers', async () => {
    state.files = [file('.gitlab-ci.yml')];
    await runAssess();
    const out = logs.join('\n');
    expect(out).toContain('risk 40/100 -> high (forced: it changes the pipeline');
    const start = out.indexOf(SUMMARY_START);
    expect(start).toBeGreaterThan(-1);
    expect(out.indexOf(SUMMARY_END)).toBeGreaterThan(start);
    expect(out.slice(start, out.indexOf(SUMMARY_END))).toContain('Risk: high (40/100)');
  });
});
