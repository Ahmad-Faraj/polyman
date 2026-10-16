import { describe, expect, it } from 'vitest';
import { compare } from '../scripts/golden.ts';

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
