import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { countedRuns } from '../src/manifest.ts';
import { sessionGrams } from '../src/sci.ts';

const CLI = resolve('src/cli/sci-report.ts');
const dir = mkdtempSync(join(tmpdir(), 'sci-report-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
// the node running the tests, which strips TypeScript types; without --ci it reads no API
const NO_CI = { CI_API_V4_URL: '', CI_PROJECT_ID: '', CI_MERGE_REQUEST_IID: '', CI_COMMIT_BRANCH: '', CI_PIPELINE_ID: '' };
const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...NO_CI, AUTONOMY_CONFIG: 'test/fixtures/autonomy.yml' } });
const write = (name: string, data: unknown) => {
  const file = join(dir, name);
  writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
};

const total = (calls: number) => ({ calls, uncached: 0, cacheWrite: 1000, cacheRead: 9000, output: 500 });
const sessions = [
  { pipeline: 1, at: '2026-10-18T10:01:00Z', flow: 'mr-reviewer', tier: 'high', skipped: false, seconds: 600, mr: 1, total: total(38) },
  { pipeline: 2, at: '2026-10-18T10:02:00Z', flow: 'mr-reviewer', tier: 'low', skipped: false, seconds: 60, mr: 2, total: total(7) },
];
const sessionsFile = write('sessions.json', { sessions });

/** if-run's output for these sessions at the fixture's coefficients, with `factor` applied to each review */
const ifOutput = (factor = 1) => {
  const c = loadConfig('test/fixtures/autonomy.yml').sustainability;
  const children: Record<string, unknown> = {};
  for (const [tier, runs] of countedRuns(sessions)) {
    const outputs = runs.map((r) => {
      const g = sessionGrams(r.seconds, r.calls, c);
      return { 'carbon-low': g.low * factor, 'carbon-high': g.high * factor };
    });
    children[`${tier}-risk-reviews`] = { outputs, aggregated: { 'carbon-low': outputs.reduce((n, o) => n + o['carbon-low'], 0), 'carbon-high': outputs.reduce((n, o) => n + o['carbon-high'], 0) } };
  }
  // JSON is YAML
  return { execution: { status: 'success', environment: { 'if-version': '1.1.1' } }, tree: { children } };
};

describe('sci-report', () => {
  it('writes the page, the metrics and the JSON, and exits 0 when if-run agrees', () => {
    const out = join(dir, 'ok');
    const r = run('--sessions', sessionsFile, '--if', write('agree.yaml', ifOutput()), '--out', out);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Impact Framework 1\.1\.1 agrees with sci\.ts on every review/);
    for (const f of ['index.html', 'metrics.txt', 'sci-report.json']) expect(existsSync(join(out, f)), f).toBe(true);
    expect(readFileSync(join(out, 'metrics.txt'), 'utf8')).toContain('sci_review_high_reviews 1\n');
  });

  it('exits 1 when if-run disagrees, and still writes the report that says where', () => {
    const out = join(dir, 'disagree');
    const r = run('--sessions', sessionsFile, '--if', write('disagree.yaml', ifOutput(1.01)), '--out', out);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('DISAGREES');
    for (const f of ['index.html', 'metrics.txt', 'sci-report.json']) expect(existsSync(join(out, f)), f).toBe(true);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toContain('class="bad"');
  });

  it('exits 2 with a message, not a stack trace, on bad arguments or input', () => {
    const cases = [
      [['--sessions', sessionsFile, '--out'], /--out needs a value/],
      [['--sessions', sessionsFile, '--if', '--out', join(dir, 'x')], /--if needs a value/],
      [['--sessions', join(dir, 'missing.json')], /can't read the sessions in .*missing\.json/],
      [['--sessions', write('nolist.json', { sessions: {} })], /no "sessions" list/],
      [['--sessions', write('null.json', 'null')], /no "sessions" list/],
      [['--sessions', write('nan.json', { sessions: [{ ...sessions[0], seconds: 'a' }] })], /session 1 \(pipeline 1\) has seconds "a"/],
      [['--sessions', write('grid.json', { sessions, coefficients: { gridGramsPerKwh: '<b>' } })], /gridGramsPerKwh is "<b>"/],
      [['--sessions', sessionsFile, '--if', write('bad.yaml', 'a: [1, 2\n')], /can't read if-run's output in .*bad\.yaml/],
    ] as const;
    for (const [args, message] of cases) {
      const r = run(...args);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.stderr).toMatch(message);
      expect(r.stderr).not.toMatch(/\n\s+at /);
    }
  });

  it('reports an empty if-run output as a disagreement (exit 1), not a crash', () => {
    const r = run('--sessions', sessionsFile, '--if', write('empty.yaml', ''), '--out', join(dir, 'empty'));
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("if-run's output isn't a manifest");
  });
});

describe('sci-report --ci', () => {
  /** runs the CLI without blocking, so a server in this process can answer it */
  const runCi = (env: Record<string, string>, out: string) =>
    new Promise<{ status: number | null; stderr: string; metrics: string | null; json: { ci: unknown } | null }>((done) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, '--sessions', sessionsFile, '--out', out, '--ci'], {
        env: { ...process.env, ...NO_CI, AUTONOMY_CONFIG: 'test/fixtures/autonomy.yml', CI_JOB_TOKEN: 'job-token', ...env },
      });
      let stderr = '';
      child.stderr.on('data', (d) => (stderr += d));
      // a failed run writes no report
      const read = (f: string) => (existsSync(join(out, f)) ? readFileSync(join(out, f), 'utf8') : null);
      child.on('close', (status) => {
        const json = read('sci-report.json');
        done({ status, stderr, metrics: read('metrics.txt'), json: json === null ? null : JSON.parse(json) });
      });
    });
  const serve = async (answer: (url: string) => [number, unknown]) => {
    const server = createServer((req, res) => {
      const [status, body] = answer(req.url ?? '');
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v4`, close: () => server.close() };
  };
  const mr = (url: string) => ({ CI_API_V4_URL: url, CI_PROJECT_ID: '1', CI_MERGE_REQUEST_IID: '3', CI_PIPELINE_ID: '30' });

  it('measures the MR\'s finished pipelines and writes one per-pipeline metric', async () => {
    const api = await serve((url) =>
      url.includes('/merge_requests/3/pipelines')
        ? [200, [{ id: 30, status: 'running' }, { id: 20, status: 'success' }, { id: 10, status: 'failed' }]]
        : url.includes('/jobs')
          ? [200, [{ name: 'test', status: 'success', duration: url.includes('/pipelines/20/') ? 120 : 60 }]]
          : [404, {}],
    );
    try {
      const r = await runCi(mr(api.url), join(dir, 'ci-ok'));
      expect(r.status, r.stderr).toBe(0);
      expect(r.metrics).toContain('sci_ci_runner_minutes_per_pipeline_median 1.5\n');
      expect(r.metrics).toMatch(/^sci_ci_runner_gco2e_per_pipeline_median \d/m);
      expect(r.json?.ci).toMatchObject({ pipelines: 2, scope: "!3's 2 finished pipelines before this one" });
    } finally {
      api.close();
    }
  });

  it('warns and writes the report without CI figures when the API refuses or cannot be reached', async () => {
    const api = await serve(() => [500, { message: 'boom' }]);
    try {
      for (const [name, url, says] of [
        ['refused', api.url, /-> 500/],
        ['unreachable', 'http://127.0.0.1:9/api/v4', /fetch failed/],
      ] as const) {
        const r = await runCi(mr(url), join(dir, `ci-${name}`));
        expect(r.status, `${name}: ${r.stderr}`).toBe(0);
        expect(r.stderr).toMatch(/warning: no CI footprint this time, the GitLab API answered: /);
        expect(r.stderr).toMatch(says);
        expect(r.metrics).not.toMatch(/sci_ci_/);
        expect(r.json?.ci).toBeNull();
      }
    } finally {
      api.close();
    }
  });

  it('says it is not a CI job, instead of a stack trace, when either API variable is missing', async () => {
    for (const [name, env] of [
      ['none', {}],
      ['no project', { CI_API_V4_URL: 'http://127.0.0.1:9/api/v4' }],
      ['no API URL', { CI_PROJECT_ID: '1' }],
    ] as const) {
      const r = await runCi({ ...env, CI_MERGE_REQUEST_IID: '3' }, join(dir, `ci-${name.replace(/ /g, '-')}`));
      expect(r.status, name).toBe(0);
      expect(r.stderr, name).toContain('warning: no CI footprint: CI_API_V4_URL and CI_PROJECT_ID are not set');
      expect(r.stderr, name).not.toMatch(/\n\s+at /);
      expect(r.metrics, name).not.toMatch(/sci_ci_/);
      expect(r.json?.ci, name).toBeNull();
    }
  });

  it('fails the job, not just warns, when the API answers in a shape the code does not expect', async () => {
    const pipelines = [{ id: 20, status: 'success' }];
    // a list of pipelines that isn't one; jobs that aren't a list; a list holding no job (a TypeError in our code, not an outage)
    for (const [name, jobs, says] of [
      ['pipelines', null, /merge_requests\/3\/pipelines\?per_page=100 did not return a list/],
      ['jobs', {}, /pipelines\/20\/jobs\?per_page=100&include_retried=true&page=1 did not return a list/],
      ['job', [null], /Cannot read properties of null/],
    ] as const) {
      const api = await serve((url) => (url.includes('/merge_requests/3/pipelines') ? [200, name === 'pipelines' ? {} : pipelines] : [200, jobs]));
      try {
        const r = await runCi(mr(api.url), join(dir, `ci-shape-${name}`));
        expect(r.status, name).toBe(1);
        expect(r.stderr, name).toMatch(/the CI footprint failed: /);
        expect(r.stderr, name).toMatch(says);
        expect(r.stderr, name).not.toContain('no CI footprint this time');
      } finally {
        api.close();
      }
    }
  });
});
