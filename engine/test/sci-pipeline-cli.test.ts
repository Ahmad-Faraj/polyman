import { afterAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('src/cli/sci-pipeline.ts');
const dir = mkdtempSync(join(tmpdir(), 'sci-pipeline-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const NO_CI = { CI_API_V4_URL: '', CI_PROJECT_ID: '', CI_PIPELINE_ID: '', CI_JOB_ID: '', CI_MERGE_REQUEST_IID: '', CI_MERGE_REQUEST_TARGET_BRANCH_NAME: '', AUTONOMY_BOT_TOKEN: '' };

/** runs the CLI without blocking, so a server in this process can answer it */
const run = (env: Record<string, string>, out: string) =>
  new Promise<{ status: number | null; stdout: string; stderr: string; metrics: string | null }>((done) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, '--out', out], {
      env: { ...process.env, ...NO_CI, AUTONOMY_CONFIG: 'test/fixtures/autonomy.yml', CI_JOB_TOKEN: 'job-token', GITLAB_RETRY_MS: '0', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => {
      const file = join(out, 'metrics.txt');
      done({ status, stdout, stderr, metrics: existsSync(file) ? readFileSync(file, 'utf8') : null });
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
const ci = (url: string, more: Record<string, string> = {}) => ({ CI_API_V4_URL: url, CI_PROJECT_ID: '1', CI_PIPELINE_ID: '50', CI_JOB_ID: '9', ...more });
const job = (id: number, name: string, status: string, duration: number | null) => ({ id, name, status, duration });

describe('sci-pipeline', () => {
  it("writes this pipeline's three metrics and logs what it left out", async () => {
    const api = await serve((url) =>
      url.includes('/pipelines/50/jobs')
        ? [200, [job(1, 'test', 'success', 1800), job(2, 'test', 'failed', 1800), job(3, 'release', 'manual', null), job(9, 'autonomy:sci:pipeline', 'running', null)]]
        : [404, {}],
    );
    try {
      const r = await run(ci(api.url), join(dir, 'ok'));
      expect(r.status, r.stderr).toBe(0);
      // the fixture's coefficients, the same footprint() as everywhere else
      expect(r.metrics).toMatch(/^sci_ci_runner_minutes_this_pipeline 60\nsci_ci_runner_gco2e_this_pipeline \d+\.\d+\nsci_ci_jobs_counted_this_pipeline 2\n$/);
      expect(r.stdout).toContain('left out: release (manual, not run), autonomy:sci:pipeline (this job)');
      expect(existsSync(join(dir, 'ok', 'pipeline.json'))).toBe(true);
    } finally {
      api.close();
    }
  });

  it('exits 0 with a warning and an empty metrics report on 403, 500 or a closed port', async () => {
    for (const status of [403, 500]) {
      const api = await serve(() => [status, { message: 'no' }]);
      try {
        const r = await run(ci(api.url), join(dir, `e${status}`));
        expect(r.status, `${status}: ${r.stderr}`).toBe(0);
        expect(r.stderr).toMatch(new RegExp(`warning: no pipeline footprint this time: .*-> ${status}`));
        expect(r.metrics).toBe('');
      } finally {
        api.close();
      }
    }
    const r = await run(ci('http://127.0.0.1:9/api/v4'), join(dir, 'closed'));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toMatch(/warning: no pipeline footprint this time: fetch failed/);
    expect(r.metrics).toBe('');
  });

  it('exits 0 with a warning, not a stack trace, on an answer of the wrong shape', async () => {
    const api = await serve(() => [200, { not: 'a list' }]);
    try {
      const r = await run(ci(api.url), join(dir, 'shape'));
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/warning: no pipeline footprint this time: GET .* did not return a list/);
      expect(r.stderr).not.toMatch(/\n\s+at /);
      expect(r.metrics).toBe('');
    } finally {
      api.close();
    }
  });

  it('says it is not a CI job when the API variables are missing', async () => {
    const r = await run({}, join(dir, 'none'));
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('this is not a CI job');
    expect(r.metrics).toBe('');
  });

  it("in an MR, lists the costliest jobs against the target branch, and only warns when that list fails", async () => {
    const mr = { CI_MERGE_REQUEST_IID: '3', CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'main' };
    const jobs = [job(1, 'test', 'success', 120), job(2, 'new', 'success', 60)];
    const ok = await serve((url) =>
      url.includes('/pipelines/50/jobs')
        ? [200, jobs]
        : url.includes('/pipelines?ref=main')
          ? [200, [{ id: 40 }]]
          : url.includes('/pipelines/40/jobs')
            ? [200, [job(5, 'test', 'success', 60), job(6, 'windows', 'success', 600)]]
            : [404, {}],
    );
    try {
      const r = await run(ci(ok.url, mr), join(dir, 'mr'));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('test: 2.0 min, main 1.0 min (+1.0 min, +100%)');
      expect(r.stdout).toContain('new: 1.0 min, not on main');
      expect(r.stdout).toContain("main's usual jobs not run here: 1, 10.0 runner-min");
    } finally {
      ok.close();
    }
    const failing = await serve((url) => (url.includes('/pipelines/50/jobs') ? [200, jobs] : [500, { message: 'boom' }]));
    try {
      const r = await run(ci(failing.url, mr), join(dir, 'mr-fail'));
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toMatch(/warning: no comparison with main this time: .*-> 500/);
      expect(r.metrics).toMatch(/^sci_ci_jobs_counted_this_pipeline 2$/m);
    } finally {
      failing.close();
    }
  });
});
