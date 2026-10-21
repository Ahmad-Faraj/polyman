import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The #65 public-host upload step and the nightly incident rehearsal, read as
// text: deleting the step, letting the rehearsal fail quietly or starting it
// on merge requests must break a test. .gitattributes has `*.yml text`, so a
// Windows checkout has CRLF line ends.
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const service = read('../ci/service.gitlab-ci.yml');
const rehearsals = read('../ci/rehearsals/rehearsals.gitlab-ci.yml');
const root = read('../../.gitlab-ci.yml');
const uploadScript = fileURLToPath(new URL('../ci/public-upload.sh', import.meta.url));

/** One top-level job: from its name line to the next top-level key. */
function job(name: string, text: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l === `${name}:`);
  expect(start, `job ${name} exists`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l) && !l.startsWith('#'));
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

/** The lines of a job's `script:` list, without comments. */
function script(block: string): string[] {
  const body = block.split('\n  script:\n')[1]?.split(/\n  \S/)[0] ?? '';
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2));
}

describe('service:golden makes the #65 upload as the public host', () => {
  const golden = job('service:golden', service);

  it('runs the shared script against the service, with the public host', () => {
    expect(script(golden)).toContain('sh service/ci/public-upload.sh http://verify:8080 "$PUBLIC_HOST"');
    expect(golden).toMatch(/\n {4}PUBLIC_HOST: \S+\.run\.app\n/);
  });

  it('has no inline curl -F that could drift from the script', () => {
    expect(golden).not.toMatch(/curl\b[^\n]*\s-F\b/);
  });
});

describe('rehearsal:incidents', () => {
  const rehearsal = job('rehearsal:incidents', rehearsals);

  it('turns the night red when a check lets a past bug through', () => {
    expect(rehearsal).toMatch(/\n {2}allow_failure: false\n/);
  });

  it('runs only in a pipeline schedule, never in a merge request or on a push', () => {
    const body = rehearsal.split('\n  rules:\n')[1]?.split(/\n {2}\S/)[0] ?? '';
    const rules = body.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(rules.map((l) => l.trim())).toEqual(['- if: $CI_PIPELINE_SOURCE == "schedule"']);
    expect(rehearsal).not.toContain('merge_request_event');
  });

  it('reports to the pipeline as a junit report', () => {
    expect(rehearsal).toMatch(/reports:\n\s+junit: rehearsal\/junit\.xml\n/);
  });

  it('runs rehearse.sh', () => {
    expect(script(rehearsal)).toContain('bash service/ci/rehearsals/rehearse.sh');
  });
});

describe('the root pipeline', () => {
  it('includes the rehearsal and the service jobs', () => {
    const includes = root.split('\ninclude:\n')[1]?.split(/\n\S/)[0] ?? '';
    const lines = includes
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => !l.startsWith('#'));
    expect(lines).toContain('- local: service/ci/rehearsals/rehearsals.gitlab-ci.yml');
    expect(lines).toContain('- local: service/ci/service.gitlab-ci.yml');
  });
});

describe('service/ci/public-upload.sh', () => {
  let server: Server;
  let base: string;
  let dir: string;
  let reply: { status: number; body: string };
  let seen: { host?: string; origin?: string; type?: string; path?: string };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'public-upload-'));
    server = createServer((req, res) => {
      seen = {
        host: req.headers.host,
        origin: req.headers.origin,
        type: req.headers['content-type'],
        path: req.url,
      };
      req.resume();
      req.on('end', () => {
        res.writeHead(reply.status, { 'content-type': 'application/x-ndjson' });
        res.end(reply.body);
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((ok) => server.close(ok));
    rmSync(dir, { recursive: true, force: true });
  });

  function run(): Promise<{ code: number | null; out: string }> {
    return new Promise((ok) => {
      execFile('sh', [uploadScript, base, 'polyman-verify-1.us-east1.run.app'], { cwd: dir, timeout: 60_000 }, (err, stdout, stderr) => {
        const code: unknown = err ? err.code : 0;
        ok({ code: typeof code === 'number' ? code : null, out: stdout + stderr });
      });
    });
  }

  it('passes on a 200 that ends with a done line, sending no Origin and the public Host', async () => {
    reply = { status: 200, body: '{"type":"log","line":"x"}\n{"type":"done","ok":true}\n' };
    const r = await run();
    expect(r.out).toContain('ok   upload as polyman-verify-1.us-east1.run.app with no Origin (#65)');
    expect(r.code).toBe(0);
    expect(seen.path).toBe('/api/verify');
    expect(seen.host).toBe('polyman-verify-1.us-east1.run.app');
    expect(seen.origin).toBeUndefined();
    expect(seen.type).toMatch(/^multipart\/form-data/);
  });

  it('fails with HTTP 403 (#65) when the upload is refused', async () => {
    reply = { status: 403, body: '{"error":"forbidden"}\n' };
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('HTTP 403 (#65)');
    expect(r.out).toContain('forbidden');
  });

  it('fails on a 200 that never says done', async () => {
    reply = { status: 200, body: '{"type":"log","line":"x"}\n' };
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.out).toContain('HTTP 200 (#65)');
  });
});
