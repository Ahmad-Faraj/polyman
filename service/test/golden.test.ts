import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, expectedSamples, readStream, runGolden, zipFolder } from '../scripts/golden.ts';
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
    await expect(runGolden(s.base, want, 0, null)).rejects.toThrow('HTTP 500');
    s.close();
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
    expect(job).toContain('golden.json "$@"');
  });
});

describe('the fire drill, end to end', () => {
  it('golden.ts --drill says so first, fails only the turned-around sample, and still writes the json', async () => {
    const { execFile } = await import('node:child_process');
    const { existsSync } = await import('node:fs');
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
      const plain = await run();
      expect(plain.code).toBe(0);
      expect(plain.out).not.toContain('DRILL');

      const drill = await run('--drill');
      const sample = [...want.keys()][0];
      expect(drill.code).toBe(1);
      expect(drill.out.split('\n')[0]).toMatch(new RegExp(`^DRILL: .*${sample}`));
      expect(drill.out.indexOf('DRILL')).toBeLessThan(drill.out.indexOf('FAIL'));
      const failed = drill.out.split('\n').filter((l) => l.startsWith('FAIL'));
      expect(failed.every((l) => l.includes(sample))).toBe(true);
      expect(drill.out).toContain(`expected ok=${!want.get(sample)!.ok}, got ok=${want.get(sample)!.ok}`);
      expect(existsSync(join(dir, 'g.json'))).toBe(true);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the production-check job script, run in sh', () => {
  async function args(env: Record<string, string>) {
    const { execFileSync } = await import('node:child_process');
    const { chmodSync, writeFileSync } = await import('node:fs');
    const ci = readFileSync(new URL('../ci/service.gitlab-ci.yml', import.meta.url), 'utf8');
    const job = ci.slice(ci.indexOf('service:check:production:'), ci.indexOf('service:rollback:production:'));
    const lines = job.split('\n');
    const start = lines.findIndex((l) => l.trim() === '- |') + 1;
    const end = lines.findIndex((l) => l.trim() === 'artifacts:');
    const script = lines.slice(start, end).map((l) => l.replace(/^ {6}/, '')).join('\n');
    const dir = mkdtempSync(join(tmpdir(), 'drill-sh-'));
    try {
      // a stand-in node that prints the arguments it got, one per line
      writeFileSync(join(dir, 'node'), '#!/bin/sh\nfor a in "$@"; do echo "$a"; done\n');
      chmodSync(join(dir, 'node'), 0o755);
      const out = execFileSync('sh', ['-ec', script], { env: { PATH: `${dir}:/usr/bin:/bin`, SERVICE_URL: 'https://prod.example', ...env }, encoding: 'utf8' });
      return out.trim().split('\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('adds --drill only for DRILL=production-check in a pipeline started from the UI', async () => {
    const base = ['--disable-warning=ExperimentalWarning', 'service/scripts/golden.ts', 'https://prod.example', '--json', 'golden.json'];
    expect(await args({ DRILL: 'production-check', CI_PIPELINE_SOURCE: 'web' })).toEqual([...base, '--drill']);
    for (const source of ['push', 'api', 'trigger', 'schedule', 'pipeline']) {
      expect(await args({ DRILL: 'production-check', CI_PIPELINE_SOURCE: source })).toEqual(base);
    }
    expect(await args({ CI_PIPELINE_SOURCE: 'web' })).toEqual(base);
    expect(await args({ DRILL: 'other', CI_PIPELINE_SOURCE: 'web' })).toEqual(base);
    expect(await args({ DRILL: '', CI_PIPELINE_SOURCE: 'web' })).toEqual(base);
  });
});
