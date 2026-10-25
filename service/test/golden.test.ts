import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, expectedSamples, readStream, runGolden, trafficFrom, zipFolder, type RouteCall } from '../scripts/golden.ts';
import { unzip } from '../src/unzip.ts';

const expected = { ok: false, solutions: { main: true, first_only: false }, readinessFailures: [] };
const event = (ok: boolean, solutions: [string, boolean][], failed: string[] = []) => ({
  type: 'problem' as const,
  ok,
  seconds: 1,
  report: { solutions: solutions.map(([name, matchesTag]) => ({ name, matchesTag })) },
  readiness: [...failed.map((id) => ({ id, ok: false })), { id: 'tags_presence', ok: true }],
});

describe('golden compare', () => {
  it('agrees when everything matches', () => {
    expect(compare(expected, event(false, [['main', true], ['first_only', false]]))).toEqual([]);
  });

  it('names each difference', () => {
    const diffs = compare(expected, event(true, [['main', false]], ['test_coverage']));
    expect(diffs).toEqual([
      'expected ok=false, got ok=true',
      'solution main: expected matchesTag=true, got false',
      'solution first_only is missing from the report',
      'guideline failures: expected [], got [test_coverage]',
    ]);
  });

  it('fails when no result came back', () => {
    expect(compare(expected, undefined)).toEqual(['no result came back']);
  });
});

describe('golden stream reading', () => {
  it('needs a done event, and reports error events and unreadable lines', () => {
    const r = readStream('{"type":"start"}\nnot json\n{"type":"error","message":"boom"}\n');
    expect(r.problems).toEqual(['unreadable line: not json', 'the service reported an error: boom', 'the answer ended without a "done" event']);
  });
});

describe('the expected results', () => {
  it('come from the repository, one per sample folder', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const dir = new URL('../samples/', import.meta.url).pathname;
    const folders = readdirSync(dir).filter((n) => statSync(dir + n).isDirectory()).sort();
    expect([...expectedSamples().keys()]).toEqual(folders);
  });
});

describe('runGolden against a stand-in service', () => {
  const want = new Map([['a', { ok: true, solutions: { main: true }, readinessFailures: [] }]]);
  const answer = '{"type":"start"}\n{"type":"problem","ok":true,"seconds":1,"report":{"solutions":[{"name":"main","matchesTag":true}]},"readiness":[]}\n{"type":"done","ok":true}\n';

  async function serve(handler: (url: string, n: number) => [number, string]) {
    let n = 0;
    const server = createServer((req, res) => {
      const [status, body] = handler(req.url ?? '', ++n);
      res.writeHead(status).end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
  }

  it('waits out 429s and then checks the sample', async () => {
    let posts = 0;
    const s = await serve((url) => (url === '/api/samples' ? [200, '[{"name":"a"}]'] : ++posts < 3 ? [429, 'busy'] : [200, answer]));
    const results = await runGolden(s.base, want, 0, null);
    s.close();
    expect(posts).toBe(3);
    expect(results).toMatchObject([{ sample: 'a', ok: true }]);
  });

  it('fails a sample the service does not offer', async () => {
    const s = await serve(() => [200, '[]']);
    const results = await runGolden(s.base, want, 0, null);
    s.close();
    expect(results[0].differences).toEqual(['the service does not offer this sample']);
  });

  it('fails when the sample list itself fails', async () => {
    const s = await serve(() => [500, 'oops']);
    const calls: RouteCall[] = [];
    await expect(runGolden(s.base, want, 0, null, calls)).rejects.toThrow('HTTP 500');
    s.close();
    expect(calls).toMatchObject([{ route: 'GET /api/samples', ok: false }]);
  });

  it('records each answered request by route, a wrong answer as failed, and not the 429s', async () => {
    const two = new Map([...want, ['b', { ok: false, solutions: { main: true }, readinessFailures: [] }]]);
    let posts = 0;
    const s = await serve((url) => (url === '/api/samples' ? [200, '[{"name":"a"},{"name":"b"}]'] : ++posts === 1 ? [429, 'busy'] : [200, answer]));
    const calls: RouteCall[] = [];
    await runGolden(s.base, two, 0, null, calls);
    s.close();
    expect(calls.map((c) => [c.route, c.ok])).toEqual([
      ['GET /api/samples', true],
      ['POST /api/samples/:name/verify', true],
      ['POST /api/samples/:name/verify', false],
    ]);
  });

  it('counts a sample list without one of the samples as a wrong answer', async () => {
    const s = await serve(() => [200, '[]']);
    const calls: RouteCall[] = [];
    await runGolden(s.base, want, 0, null, calls);
    s.close();
    expect(calls).toMatchObject([{ route: 'GET /api/samples', ok: false }]);
  });
});

describe('the traffic file', () => {
  it('gives each route its request count, share of failed answers and p95 time', () => {
    const calls = [
      { route: 'GET /api/samples', ok: true, seconds: 0.05 },
      ...[1, 2, 3, 4].map((s) => ({ route: 'POST /api/samples/:name/verify', ok: s !== 3, seconds: s })),
    ];
    expect(trafficFrom(calls)).toEqual({
      'GET /api/samples': { count: 1, errorRate: 0, p95Ms: 50 },
      'POST /api/samples/:name/verify': { count: 4, errorRate: 0.25, p95Ms: 4000 },
    });
    expect(trafficFrom([])).toEqual({});
  });

  it('names exactly the routes .autonomy.yml says are measured, as the service declares them', async () => {
    const config = readFileSync(new URL('../../.autonomy.yml', import.meta.url), 'utf8');
    const measured = JSON.parse(config.match(/^ {2}measured_routes: (\[.*\])$/m)![1]) as string[];
    const answer = '{"type":"problem","ok":true,"seconds":1,"report":{"solutions":[]},"readiness":[]}\n{"type":"done","ok":true}\n';
    // the upload route zips a real sample folder, so use one that exists
    const sample = [...expectedSamples().keys()][0];
    const offered = new Map([[sample, { ok: true, solutions: {}, readinessFailures: [] }]]);
    const server = createServer((req, res) => res.writeHead(200).end(req.url === '/api/samples' ? JSON.stringify([{ name: sample }]) : answer));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const calls: RouteCall[] = [];
    await runGolden(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, offered, 0, sample, calls);
    server.close();
    expect(Object.keys(trafficFrom(calls)).sort()).toEqual([...measured].sort());
    const app = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8');
    for (const route of measured) {
      const [method, path] = route.split(' ');
      expect(app).toMatch(new RegExp(`app\\.${method.toLowerCase()}(<[^>]*>)?\\('${path}'`));
    }
  });
});

describe('zipFolder', () => {
  it('makes a zip the service unpacks to the same files', async () => {
    const samples = new URL('../samples/even-sum', import.meta.url).pathname;
    const dest = mkdtempSync(join(tmpdir(), 'zipfolder-test-'));
    try {
      const files = await unzip(zipFolder(samples, 'even-sum'), dest);
      expect(files).toContain('even-sum/Config.json');
      expect(readFileSync(join(dest, 'even-sum/solutions/acc.cpp'), 'utf8')).toBe(readFileSync(join(samples, 'solutions/acc.cpp'), 'utf8'));
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });
});

describe('the production-check fire drill', () => {
  it('turns around exactly one sample, so a correct service fails the check', async () => {
    const { drillExpected, expectedSamples } = await import('../scripts/golden.ts');
    const expected = expectedSamples();
    const { expected: drilled, sample } = drillExpected(expected);
    expect(drilled.get(sample)!.ok).toBe(!expected.get(sample)!.ok);
    for (const [name, want] of expected) if (name !== sample) expect(drilled.get(name)).toEqual(want);
    // the repository's own expectations are untouched
    expect(expectedSamples().get(sample)!.ok).toBe(expected.get(sample)!.ok);
  });

  it('turns the first sample around in either direction, without touching its input', async () => {
    const { drillExpected } = await import('../scripts/golden.ts');
    const fail = { ok: false, solutions: { main: true }, readinessFailures: ['test_coverage'] };
    const pass = { ok: true, solutions: { main: true }, readinessFailures: [] };
    const input = new Map([
      ['a', fail],
      ['b', pass],
    ]);
    const drilled = drillExpected(input);
    expect(drilled.sample).toBe('a');
    expect(drilled.expected.get('a')).toEqual({ ...fail, ok: true });
    expect(drilled.expected.get('b')).toBe(pass);
    expect(input.get('a')).toBe(fail);
    expect(fail.ok).toBe(false);
    expect(drillExpected(new Map([['x', pass]])).expected.get('x')!.ok).toBe(false);
  });

  it('refuses to run a drill when there is no sample to turn around', async () => {
    const { drillExpected } = await import('../scripts/golden.ts');
    expect(() => drillExpected(new Map())).toThrow('no sample to turn around');
  });

  it('runs in CI only when a person starts the pipeline from the UI with DRILL=production-check', async () => {
    const { readFileSync } = await import('node:fs');
    const ci = readFileSync(new URL('../ci/service.gitlab-ci.yml', import.meta.url), 'utf8');
    const job = ci.slice(ci.indexOf('service:check:production:'), ci.indexOf('service:rollback:production:'));
    expect(job).toContain('[ "${DRILL:-}" = production-check ] && [ "$CI_PIPELINE_SOURCE" = web ]');
    expect(job).toContain('traffic.json "$@"');
  });
});

describe('the fire drill, end to end', () => {
  it('golden.ts --drill says so first, fails only the turned-around sample, and still writes the json', async () => {
    const { execFile } = await import('node:child_process');
    const want = expectedSamples();
    // a service that judges every sample exactly as the repository expects
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if (url === '/api/samples') return void res.writeHead(200).end(JSON.stringify([...want.keys()].map((name) => ({ name }))));
      const name = want.has(decodeURIComponent(url.split('/')[3] ?? '')) ? decodeURIComponent(url.split('/')[3]) : [...want.keys()][0];
      const w = want.get(name)!;
      const problem = {
        type: 'problem',
        ok: w.ok,
        seconds: 1,
        report: { solutions: Object.entries(w.solutions).map(([n, matchesTag]) => ({ name: n, matchesTag })) },
        readiness: w.readinessFailures.map((id) => ({ id, ok: false })),
      };
      res.writeHead(200).end(`${JSON.stringify(problem)}\n{"type":"done","ok":true}\n`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), 'drill-test-'));
    const run = (...extra: string[]) =>
      new Promise<{ code: number; out: string }>((resolve) => {
        const script = new URL('../scripts/golden.ts', import.meta.url).pathname;
        execFile(process.execPath, ['--disable-warning=ExperimentalWarning', script, base, '--json', join(dir, 'g.json'), ...extra], (err, stdout, stderr) =>
          resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr }),
        );
      });
    try {
      const { readFileSync } = await import('node:fs');
      const plain = await run();
      expect(plain.code).toBe(0);
      expect(plain.out).not.toContain('DRILL');
      // no drill marker, so the incident responder treats a failure as real
      expect(JSON.parse(readFileSync(join(dir, 'g.json'), 'utf8')).drill).toBeUndefined();

      const drill = await run('--drill');
      const sample = [...want.keys()][0];
      expect(drill.code).toBe(1);
      expect(drill.out.split('\n')[0]).toMatch(new RegExp(`^DRILL: .*${sample}`));
      expect(drill.out.indexOf('DRILL')).toBeLessThan(drill.out.indexOf('FAIL'));
      const failed = drill.out.split('\n').filter((l) => l.startsWith('FAIL'));
      expect(failed.every((l) => l.includes(sample))).toBe(true);
      expect(drill.out).toContain(`expected ok=${!want.get(sample)!.ok}, got ok=${want.get(sample)!.ok}`);
      expect(existsSync(join(dir, 'g.json'))).toBe(true);
      // the marker the incident responder reads to open a "Drill:" incident instead of proposing a rollback MR
      expect(JSON.parse(readFileSync(join(dir, 'g.json'), 'utf8')).drill).toBe(sample);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('golden.ts --traffic, end to end', () => {
  /**
   * Runs the real script against a stand-in service. `answer` gives the
   * sample list's status and body; `wrong` names a sample the service judges
   * the other way round.
   */
  async function trafficRun(opts: { list?: (names: string[]) => [number, string]; wrong?: string } = {}) {
    const { execFile } = await import('node:child_process');
    const want = expectedSamples();
    const server = createServer((req, res) => {
      const url = req.url ?? '';
      if (url === '/api/samples') {
        const [status, body] = opts.list?.([...want.keys()]) ?? [200, JSON.stringify([...want.keys()].map((name) => ({ name })))];
        return void res.writeHead(status).end(body);
      }
      // POST /api/samples/NAME/verify, or POST /api/verify with the first sample zipped
      const name = url === '/api/verify' ? [...want.keys()][0] : decodeURIComponent(url.split('/')[3] ?? '');
      const w = want.get(name)!;
      const problem = {
        type: 'problem',
        ok: name === opts.wrong ? !w.ok : w.ok,
        seconds: 1,
        report: { solutions: Object.entries(w.solutions).map(([n, matchesTag]) => ({ name: n, matchesTag })) },
        readiness: w.readinessFailures.map((id) => ({ id, ok: false })),
      };
      res.writeHead(200).end(`${JSON.stringify(problem)}\n{"type":"done","ok":true}\n`);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), 'traffic-test-'));
    try {
      const script = new URL('../scripts/golden.ts', import.meta.url).pathname;
      const code = await new Promise<number>((resolve) =>
        execFile(process.execPath, ['--disable-warning=ExperimentalWarning', script, base, '--traffic', join(dir, 't.json')], (err) =>
          resolve(err ? ((err as { code?: number }).code ?? 1) : 0),
        ),
      );
      const routes = JSON.parse(readFileSync(join(dir, 't.json'), 'utf8')).routes as Record<string, { count: number; errorRate: number }>;
      return { code, routes, samples: [...want.keys()] };
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('passes a service that answers every sample correctly, with all three routes measured', async () => {
    const r = await trafficRun();
    expect(r.code).toBe(0);
    expect(Object.keys(r.routes).sort()).toEqual(['GET /api/samples', 'POST /api/samples/:name/verify', 'POST /api/verify']);
    for (const stats of Object.values(r.routes)) expect(stats.errorRate).toBe(0);
  });

  it('fails one wrongly judged sample and counts it against the verify route', async () => {
    const samples = [...expectedSamples().keys()];
    // not the first sample, which also goes through the upload route
    const r = await trafficRun({ wrong: samples.at(-1) });
    expect(samples.length).toBeGreaterThan(1);
    expect(r.code).toBe(1);
    expect(r.routes['POST /api/samples/:name/verify'].errorRate).toBeGreaterThan(0);
    expect(r.routes['GET /api/samples'].errorRate).toBe(0);
  });

  it('fails when the sample list answers 500', async () => {
    const r = await trafficRun({ list: () => [500, 'oops'] });
    expect(r.code).toBe(1);
    expect(r.routes['GET /api/samples']).toMatchObject({ count: 1, errorRate: 1 });
  });

  it('fails when the sample list answers 200 with something that is not JSON', async () => {
    const r = await trafficRun({ list: () => [200, '<html>maintenance</html>'] });
    expect(r.code).toBe(1);
    expect(r.routes['GET /api/samples']).toMatchObject({ count: 1, errorRate: 1 });
  });
});

describe('the production-check job script, run in sh', () => {
  /**
   * Runs the job's script with stand-ins for node, curl and npm that log how
   * they were called. The real node still reads the MR list and the reports.
   * VERSION is what production's /api/version answers, MRS and MR_CODE the
   * merged-MR lookup, HEALTH what the monitor writes to health-report.json.
   */
  async function run(env: Record<string, string>) {
    const { spawnSync } = await import('node:child_process');
    const { chmodSync, writeFileSync } = await import('node:fs');
    const ci = readFileSync(new URL('../ci/service.gitlab-ci.yml', import.meta.url), 'utf8');
    const job = ci.slice(ci.indexOf('service:check:production:'), ci.indexOf('service:rollback:production:'));
    const lines = job.split('\n');
    const start = lines.findIndex((l) => l.trim() === '- |') + 1;
    const end = lines.findIndex((l) => l.trim() === 'artifacts:');
    const script = lines.slice(start, end).map((l) => l.replace(/^ {6}/, '')).join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'drill-sh-'));
    const log = join(dir, 'log');
    const stub = (name: string, body: string) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    try {
      stub(
        'node',
        `case "$*" in
  *golden.ts*) echo "golden $*" >> "${log}"; exit \${GOLDEN_EXIT:-0} ;;
  *monitor.ts*) echo "monitor $* RELEASE_MR_IID=$RELEASE_MR_IID" >> "${log}"; [ -z "$HEALTH" ] || printf '%s' "$HEALTH" > health-report.json; exit \${MONITOR_EXIT:-0} ;;
esac
exec "${process.execPath}" "$@"`,
      );
      stub(
        'curl',
        `echo "curl $*" >> "${log}"
case "$*" in
  */api/version*) [ "\${VERSION_CODE:-200}" = 200 ] || exit 22; printf '%s' "$VERSION"; exit 0 ;;
esac
out=; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done
[ "\${MR_CODE:-200}" != 000 ] || { printf 000; echo "curl: (7) could not connect" >&2; exit 7; }
printf '%s' "$MRS" > "$out"; printf '%s' "\${MR_CODE:-200}"`,
      );
      stub('npm', `echo "npm $*" >> "${log}"; exit \${NPM_EXIT:-0}`);
      stub('sleep', ':');
      const r = spawnSync('sh', ['-ec', script], {
        cwd: dir,
        env: {
          PATH: `${dir}:/usr/bin:/bin`,
          SERVICE_URL: 'https://prod.example',
          CI_API_V4_URL: 'https://gitlab.example/api/v4',
          CI_PROJECT_ID: '7',
          CI_COMMIT_SHA: 'abc1234def',
          CI_COMMIT_SHORT_SHA: 'abc1234',
          CI_JOB_TOKEN: 'tok',
          VERSION: '{"polyman":"3.0.1","service":"0.1.0","commit":"abc1234"}',
          MRS: '[{"iid":12,"state":"opened"},{"iid":14,"state":"merged"}]',
          HEALTH: '{"results":[{"ok":true}]}',
          ...env,
        },
        encoding: 'utf8',
      });
      const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
      const noted = existsSync(join(dir, 'monitor.txt')) ? readFileSync(join(dir, 'monitor.txt'), 'utf8') : '';
      return { code: r.status, out: r.stdout + r.stderr, calls, noted, golden: calls.find((c) => c.startsWith('golden '))?.slice('golden '.length).split(' ') };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('adds --drill only for DRILL=production-check in a pipeline started from the UI', async () => {
    const base = ['--disable-warning=ExperimentalWarning', 'service/scripts/golden.ts', 'https://prod.example', '--json', 'golden.json', '--traffic', 'traffic.json'];
    expect((await run({ DRILL: 'production-check', CI_PIPELINE_SOURCE: 'web' })).golden).toEqual([...base, '--drill']);
    for (const source of ['push', 'api', 'trigger', 'schedule', 'pipeline']) {
      expect((await run({ DRILL: 'production-check', CI_PIPELINE_SOURCE: source })).golden).toEqual(base);
    }
    expect((await run({ CI_PIPELINE_SOURCE: 'web' })).golden).toEqual(base);
    expect((await run({ DRILL: 'other', CI_PIPELINE_SOURCE: 'web' })).golden).toEqual(base);
    expect((await run({ DRILL: '', CI_PIPELINE_SOURCE: 'web' })).golden).toEqual(base);
  });

  it('runs the monitor on the traffic file for the merged MR of this commit, with the job token', async () => {
    const r = await run({});
    expect(r.code).toBe(0);
    expect(r.calls).toContain("curl -sS -o mrs.json -w %{http_code} -H JOB-TOKEN: tok https://gitlab.example/api/v4/projects/7/repository/commits/abc1234def/merge_requests");
    expect(r.calls).toContain('npm ci --prefix engine --no-audit --no-fund --loglevel=error');
    expect(r.calls.at(-1)).toBe('monitor engine/src/cli/monitor.ts traffic.json RELEASE_MR_IID=14');
    expect(r.noted).toContain('every signal within its limit');
  });

  it('fails when the samples fail or the monitor finds a watched route over its limit, and runs the monitor even when the samples failed', async () => {
    const golden = await run({ GOLDEN_EXIT: '1' });
    expect(golden.code).toBe(1);
    expect(golden.calls.at(-1)).toMatch(/^monitor /);
    const over = { MONITOR_EXIT: '1', HEALTH: '{"results":[{"ok":true},{"ok":false}]}' };
    expect((await run(over)).code).toBe(1);
    expect((await run(over)).noted).toContain('over its limit');
    expect((await run({ ...over, GOLDEN_EXIT: '1' })).code).toBe(1);
  });

  it('without a merged MR it says so, skips the monitor and keeps the samples result', async () => {
    const none = await run({ MRS: '[]' });
    expect(none.code).toBe(0);
    expect(none.out).toContain('no merged MR for abc1234def');
    expect(none.calls.some((c) => c.startsWith('monitor '))).toBe(false);
    expect((await run({ MRS: '[]', GOLDEN_EXIT: '1' })).code).toBe(1);
  });

  it('shows a failed MR lookup as a warning (exit 3), tries the public API too, and records it', async () => {
    for (const MR_CODE of ['500', '000']) {
      const r = await run({ MR_CODE });
      expect(r.code).toBe(3);
      expect(r.calls.filter((c) => c.includes('/merge_requests'))).toHaveLength(2);
      expect(r.calls.some((c) => c.startsWith('monitor '))).toBe(false);
      expect(r.noted).toContain(`WARNING: the release monitor did not run: looking up the merged MR for abc1234def failed (HTTP ${MR_CODE}`);
    }
    const garbled = await run({ MRS: '<html>' });
    expect(garbled.code).toBe(3);
    expect(garbled.noted).toContain('not an MR list');
    // the samples failing still fails the job (and rolls back)
    expect((await run({ MR_CODE: '500', GOLDEN_EXIT: '1' })).code).toBe(1);
  });

  it('does not roll back a release whose samples passed when the monitor itself could not run', async () => {
    const npm = await run({ NPM_EXIT: '1' });
    expect(npm.code).toBe(3);
    expect(npm.noted).toContain('npm ci) failed');
    // a crash: exit 1 with no failed result written
    const crash = await run({ MONITOR_EXIT: '1', HEALTH: '' });
    expect(crash.code).toBe(3);
    expect(crash.noted).toContain('could not finish (exit 1');
    expect((await run({ MONITOR_EXIT: '7' })).code).toBe(3);
    expect((await run({ NPM_EXIT: '1', GOLDEN_EXIT: '1' })).code).toBe(1);
  });

  it('fails before the samples when production serves another commit than the one promoted', async () => {
    for (const env of [{ VERSION: '{"commit":"b8511ddf"}' }, { VERSION: '{"commit":"dev"}' }, { VERSION: '<html>' }, { VERSION_CODE: '503' }] as Record<string, string>[]) {
      const r = await run(env);
      expect(r.code).toBe(1);
      expect(r.out).toContain('not abc1234, which this pipeline promoted');
      expect(r.golden).toBeUndefined();
      expect(r.calls.filter((c) => c.includes('/api/version'))).toHaveLength(3);
    }
    expect((await run({ VERSION: '{"commit":"b8511ddf"}' })).out).toContain('serves commit b8511ddf');
  });

  it('ends every way out with a NEXT STEP line that says who does what', async () => {
    expect((await run({})).out).toContain('NEXT STEP: nothing to click: production serves abc1234 and passed its check.');
    // a rollback MR: the person who merged it goes back to the incident
    const rollback = await run({ MRS: '[{"iid":15,"state":"merged","labels":["incident"],"merge_user":{"username":"HamzaHassanain"}}]' });
    expect(rollback.code).toBe(0);
    expect(rollback.out).toContain('NEXT STEP: production serves abc1234 and passed its check. @HamzaHassanain (who merged !15) mentions the incident responder on the incident this rollback is for, so it records Verified.');
    const unnamed = await run({ MRS: '[{"iid":15,"state":"merged","labels":["incident"]}]' });
    expect(unnamed.out).toContain('the person who merged this change mentions the incident responder');
    for (const env of [{ GOLDEN_EXIT: '1' }, { VERSION: '{"commit":"b8511ddf"}' }] as Record<string, string>[]) {
      const r = await run(env);
      expect(r.code).toBe(1);
      expect(r.out).toContain('NEXT STEP: nobody promotes again: service:rollback:production moves traffic back by itself');
    }
    const broken = await run({ NPM_EXIT: '1', CI_JOB_URL: 'https://gitlab.example/p/-/jobs/5' });
    expect(broken.code).toBe(3);
    expect(broken.out).toContain('NEXT STEP: a maintainer reads monitor.txt in this job\'s artifacts (https://gitlab.example/p/-/jobs/5/artifacts/browse)');
    expect((await run({ PROMOTED: 'false' })).out).toContain("NEXT STEP: nothing to do in this pipeline: the newer main pipeline's candidate is the one to promote");
  });

  it('checks nothing, as a warning, when the promote switched nothing', async () => {
    const r = await run({ PROMOTED: 'false', DRILL: 'production-check', CI_PIPELINE_SOURCE: 'web' });
    expect(r.code).toBe(3);
    expect(r.calls).toEqual([]);
    expect(r.noted).toContain('not checked');
  });
});

describe('pipeline schedules', () => {
  it('never build, check or release the service (a schedule counts every file as changed)', async () => {
    const { readFileSync } = await import('node:fs');
    const ci = readFileSync(new URL('../ci/service.gitlab-ci.yml', import.meta.url), 'utf8');
    const blocks = ci.split('  rules:\n').slice(1);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(block.startsWith('    # a pipeline schedule on main') && block.includes('- if: $CI_PIPELINE_SOURCE == "schedule"\n      when: never')).toBe(true);
  });
});
