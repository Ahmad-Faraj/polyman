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

  it('runs in CI only when a person starts the pipeline from the UI with DRILL=production-check', async () => {
    const { readFileSync } = await import('node:fs');
    const ci = readFileSync(new URL('../ci/service.gitlab-ci.yml', import.meta.url), 'utf8');
    const job = ci.slice(ci.indexOf('service:check:production:'), ci.indexOf('service:rollback:production:'));
    expect(job).toContain('[ "${DRILL:-}" = production-check ] && [ "$CI_PIPELINE_SOURCE" = web ]');
    expect(job).toContain('golden.json "$@"');
  });
});
