import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.ts';
import { countedRuns } from '../src/manifest.ts';
import { sessionGrams } from '../src/sci.ts';

const CLI = resolve('src/cli/sci-report.ts');
const dir = mkdtempSync(join(tmpdir(), 'sci-report-'));
// the node running the tests, which strips TypeScript types; no --ci, so no API
const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { encoding: 'utf8', env: { ...process.env, AUTONOMY_CONFIG: 'test/fixtures/autonomy.yml' } });
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
