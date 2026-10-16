import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readiness } from '../src/readiness.ts';
import type { VerifyReport } from '../src/verify.ts';

const dirs: string[] = [];
const problem = (config: unknown, files: Record<string, string> = {}) => {
  const d = mkdtempSync(join(tmpdir(), 'ready-test-'));
  dirs.push(d);
  writeFileSync(join(d, 'Config.json'), JSON.stringify(config));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(d, name, '..'), { recursive: true });
    writeFileSync(join(d, name), text);
  }
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const report = (tests: number, extra: Partial<VerifyReport> = {}): VerifyReport => ({
  schemaVersion: 1,
  polymanVersion: '3.0.0',
  ok: true,
  failedStep: null,
  steps: [
    { name: 'compile-checker', ok: true, errors: [] },
    { name: 'test-checker', ok: true, errors: [] },
  ],
  solutions: [{ name: 'main', tag: 'MA', matchesTag: true, reason: '', tests: Array.from({ length: tests }, (_, i) => ({ testset: 'tests', index: i + 1, verdict: 'OK', timeMs: 1, message: '' })) }],
  ...extra,
});

const byId = (checks: ReturnType<typeof readiness>) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe('readiness', () => {
  it('passes a complete problem', () => {
    const dir = problem(
      {
        tags: ['math'],
        statements: { english: { legend: './l.tex', input: './i.tex', output: './o.tex', tutorial: './t.tex' } },
        checker: { source: 'wcmp.cpp', isStandard: true },
        validator: { source: './v.cpp' },
        solutions: [
          { name: 'main', source: './a.cpp', tag: 'MA' },
          { name: 'j', source: './b.java', tag: 'OK' },
          { name: 'wa', source: './c.cpp', tag: 'WA' },
        ],
      },
      { 'l.tex': 'x', 'i.tex': 'x', 'o.tex': 'x', 't.tex': 'x' },
    );
    const checks = readiness(dir, report(12));
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks).toHaveLength(9);
  });

  it('counts an empty statement file as missing, and says which', () => {
    const dir = problem({ statements: { english: { legend: './l.tex', input: './i.tex', output: './o.tex' } } }, { 'l.tex': '  \n', 'i.tex': 'x', 'o.tex': 'x' });
    expect(byId(readiness(dir, report(12))).statement_completeness).toMatchObject({ ok: false, detail: 'english: missing or empty legend' });
  });

  it('wants ten tests and says how many ran', () => {
    expect(byId(readiness(problem({}), report(4))).test_coverage).toMatchObject({ ok: false, detail: '4 test(s) ran' });
    expect(byId(readiness(problem({}), null)).test_coverage.detail).toContain('did not finish');
  });

  it('does not throw on a config of the wrong shape; those parts count as missing', () => {
    const dir = problem({ tags: 'dp', statements: { english: null, fr: 'x' }, solutions: 'all of them', checker: 5 });
    const checks = byId(readiness(dir, report(12)));
    expect(checks.tags_presence.ok).toBe(false);
    expect(checks.statement_completeness.ok).toBe(false);
    expect(checks.solution_presence.ok).toBe(false);
    expect(checks.checker_presence.ok).toBe(false);
  });

  it('does not read a statement path that leaves the folder', () => {
    const dir = problem({ statements: { english: { legend: '../../../etc/hostname', input: './i.tex', output: './o.tex' } } }, { 'i.tex': 'x', 'o.tex': 'x' });
    expect(byId(readiness(dir, report(12))).statement_completeness.ok).toBe(false);
  });
});
