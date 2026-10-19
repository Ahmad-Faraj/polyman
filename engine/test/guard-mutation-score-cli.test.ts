import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('src/cli/guard-mutation-score.ts');
const dir = mkdtempSync(join(tmpdir(), 'guard-score-'));
const report = (name: string, ...statuses: string[]) => {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ files: { 'src/goahead.ts': { mutants: statuses.map((status) => ({ status })) } } }));
  return file;
};
// the node running the tests, which strips TypeScript types
const run = (...args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], { encoding: 'utf8' });
const half = report('half.json', 'Killed', 'Survived');

describe('guard-mutation-score', () => {
  it('prints the metrics and fails under the floor', () => {
    const r = run(half, '--floor', '85');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('guard_mutation_score 50');
    expect(r.stderr).toMatch(/under the floor of 85%/);
  });

  it('passes at or over the floor, given as --floor N or --floor=N', () => {
    expect(run(half, '--floor', '50').status).toBe(0);
    expect(run(half, '--floor=85').status).toBe(1);
    expect(run(half, '--floor=40').status).toBe(0);
  });

  it('compares the exact share, so a score that rounds up to the floor is still under it', () => {
    const almost = report('almost.json', ...Array(1699).fill('Killed'), ...Array(301).fill('Survived')); // 84.95%
    const r = run(almost, '--floor', '85');
    expect(r.stdout).toContain('guard_mutation_score 85');
    expect(r.status).toBe(1);
  });

  it("refuses a floor that would switch the gate off, and says why without a stack trace", () => {
    for (const bad of [[], ['--floor'], ['--floor', ''], ['--floor', ' '], ['--floor', '-5'], ['--floor', 'abc'], ['--floor', '0x10'], ['--floor', '1e3'], ['--floor', '101']]) {
      const r = run(half, ...bad);
      expect(r.status, JSON.stringify(bad)).toBe(2);
      expect(r.stderr).toMatch(/--floor takes a percentage/);
      expect(r.stderr).not.toMatch(/\n\s+at /);
    }
  });

  it('fails on an empty run, a missing report or an unknown option', () => {
    expect(run(report('empty.json'), '--floor', '85').stderr).toMatch(/no mutant was judged/);
    expect(run(report('empty2.json'), '--floor', '85').status).toBe(2);
    expect(run(join(dir, 'missing.json'), '--floor', '85').stderr).toMatch(/can't read the Stryker report/);
    expect(run(half, '--floor', '85', '--strict').stderr).toMatch(/unknown option --strict/);
  });
});
