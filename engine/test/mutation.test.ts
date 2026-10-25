import { describe, expect, it } from 'vitest';
import { scoreOf } from '../src/mutation.ts';

const report = (...statuses: string[]) => ({ files: { 'src/goahead.ts': { mutants: statuses.map((status) => ({ status })) } } });

describe('the mutation score', () => {
  it('counts killed and timed-out mutants as caught, among those Stryker judged', () => {
    expect(scoreOf(report('Killed', 'Killed', 'Timeout', 'Survived', 'NoCoverage', 'Ignored', 'CompileError', 'RuntimeError'))).toEqual({
      caught: 3,
      judged: 5,
      timeouts: 1,
      score: 60,
    });
  });

  it('rounds to one decimal, across files', () => {
    const r = { files: { a: { mutants: [{ status: 'Killed' }, { status: 'Survived' }] }, b: { mutants: [{ status: 'Killed' }] } } };
    expect(scoreOf(r).score).toBe(66.7);
  });

  it("refuses a run that judged nothing, so a crash or a moved file can't pass as a score", () => {
    expect(() => scoreOf({ files: {} })).toThrow(/no mutant was judged/);
    expect(() => scoreOf(report('CompileError', 'Ignored'))).toThrow(/no mutant was judged/);
    expect(() => scoreOf({ files: { a: {} } })).toThrow(/no mutant was judged/);
    expect(() => scoreOf({})).toThrow(/not a Stryker report/);
    expect(() => scoreOf(null)).toThrow(/not a Stryker report/);
  });
});
