import { describe, expect, it } from 'vitest';
import {
  compare,
  freshnessCheck,
  freshnessMarker,
  nonEmpty,
  outcomeOf,
  pushChecks,
  regressions,
  scriptLines,
  selectProblems,
} from './lib.mjs';

describe('regressions: the release gate', () => {
  const summary = problems => ({ polyman: 'x', problems });
  const latest = summary([
    {
      name: 'sum-parity',
      failures: [
        'solution pe: expected tests#1:PE, got tests#1:WA',
        'solution wa: expected tests#3:WA, got tests#3:OK',
      ],
    },
    { name: 'mistagged', failures: [] },
  ]);

  it('passes a candidate that only fixes things, and lists the fixes', () => {
    const next = summary([
      {
        name: 'sum-parity',
        failures: ['solution wa: expected tests#3:WA, got tests#3:OK'],
      },
      { name: 'mistagged', failures: [] },
    ]);
    const { added, fixed } = regressions(latest, next);
    expect(added).toEqual([]);
    expect(fixed).toEqual([
      {
        problem: 'sum-parity',
        message: 'solution pe: expected tests#1:PE, got tests#1:WA',
      },
    ]);
  });

  it('fails on a failure the baseline did not have, even next to old ones', () => {
    const next = summary([
      { name: 'sum-parity', failures: latest.problems[0].failures },
      { name: 'mistagged', failures: ['solution x: expected OK, got WA'] },
    ]);
    expect(regressions(latest, next).added).toEqual([
      { problem: 'mistagged', message: 'solution x: expected OK, got WA' },
    ]);
  });

  it('counts a problem the candidate did not judge at all as a regression', () => {
    const next = summary([{ name: 'sum-parity', failures: [] }]);
    expect(regressions(latest, next).added).toEqual([
      { problem: 'mistagged', message: 'not judged by the candidate' },
    ]);
  });

  it("counts a new problem's failures, since the baseline never had it", () => {
    const next = summary([
      ...latest.problems,
      { name: 'new-one', failures: ['solution y: wrong'] },
    ]);
    expect(regressions(latest, next).added).toEqual([
      { problem: 'new-one', message: 'solution y: wrong' },
    ]);
  });
});

const okTests = n => Array.from({ length: n }, (_, i) => `tests#${i + 1}:OK`);

function expected(solutions) {
  return {
    ok: true,
    failedStep: null,
    steps: { 'run-solutions': true, 'verify-solutions': true },
    solutions,
  };
}

const failures = diffs =>
  diffs.filter(d => d.kind === 'failure').map(d => d.message);
const warnings = diffs => diffs.filter(d => d.kind === 'warning');

describe('compare', () => {
  const main = { tag: 'MA', matchesTag: true, verdicts: okTests(4) };

  it('passes when everything matches', () => {
    const want = expected({ main });
    expect(compare(want, structuredClone(want))).toEqual([]);
  });

  it('excuses one slow test and the matchesTag flip it causes', () => {
    const want = expected({ main });
    const got = structuredClone(want);
    got.solutions.main.verdicts[2] = 'tests#3:TLE';
    got.solutions.main.matchesTag = false;
    const diffs = compare(want, got);
    expect(failures(diffs)).toEqual([]);
    expect(warnings(diffs)).toHaveLength(1);
  });

  it('fails a reference solution that times out on every test', () => {
    const want = expected({ main });
    const got = structuredClone(want);
    got.solutions.main.verdicts = got.solutions.main.verdicts.map(v =>
      v.replace(':OK', ':TLE')
    );
    got.solutions.main.matchesTag = false;
    const messages = failures(compare(want, got));
    expect(messages.some(m => m.includes('all 4 expected OK tests'))).toBe(
      true
    );
    expect(messages.some(m => m.includes('matchesTag'))).toBe(true);
  });

  it('fails a matchesTag flip when no verdict changed', () => {
    const want = expected({ main });
    const got = structuredClone(want);
    got.solutions.main.matchesTag = false;
    expect(failures(compare(want, got))).toEqual([
      'solution main: expected matchesTag=true, got false',
    ]);
  });

  it('fails any non-timing verdict change, and does not excuse matchesTag', () => {
    const want = expected({ main });
    const got = structuredClone(want);
    got.solutions.main.verdicts[0] = 'tests#1:TLE';
    got.solutions.main.verdicts[1] = 'tests#2:WA';
    got.solutions.main.matchesTag = false;
    const messages = failures(compare(want, got));
    expect(messages).toContain(
      'solution main: expected tests#2:OK, got tests#2:WA'
    );
    expect(messages).toContain(
      'solution main: expected matchesTag=true, got false'
    );
  });

  it('keeps one slow test a warning when only one test is expected OK (#38)', () => {
    const wa = {
      tag: 'WA',
      matchesTag: true,
      verdicts: ['tests#1:WA', 'tests#2:OK'],
    };
    const want = expected({ wa });
    const got = structuredClone(want);
    got.solutions.wa.verdicts[1] = 'tests#2:TLE';
    const diffs = compare(want, got);
    expect(failures(diffs)).toEqual([]);
    expect(warnings(diffs)).toHaveLength(1);
  });

  it('never excuses OK where TLE is expected', () => {
    const tle = { tag: 'TL', matchesTag: true, verdicts: ['tests#1:TLE'] };
    const want = expected({ tle });
    const got = structuredClone(want);
    got.solutions.tle.verdicts = ['tests#1:OK'];
    expect(failures(compare(want, got))).toHaveLength(1);
  });

  it('checks the report verdict and the failed step', () => {
    const want = expected({ main });
    const got = structuredClone(want);
    got.ok = false;
    got.failedStep = 'verify-solutions';
    expect(failures(compare(want, got))).toEqual([
      'report ok: expected true, got false',
      'failed step: expected none, got verify-solutions',
    ]);
  });

  it('fails on missing, extra and resized solutions', () => {
    const want = expected({ main });
    const got = structuredClone(want);
    got.solutions.main.verdicts.pop();
    got.solutions.extra = structuredClone(main);
    const messages = failures(compare(want, got));
    expect(messages).toContain('solution main: expected 4 tests, got 3');
    expect(messages).toContain('solution extra: not pinned in expected file');
    expect(failures(compare(want, { ...got, solutions: {} }))).toContain(
      'solution main: missing from report'
    );
  });
});

describe('outcomeOf', () => {
  it('sorts tests by testset and index', () => {
    const outcome = outcomeOf({
      ok: true,
      failedStep: null,
      steps: [{ name: 'run-solutions', ok: true }],
      solutions: [
        {
          name: 'main',
          tag: 'MA',
          matchesTag: true,
          tests: [
            { testset: 'tests', index: 2, verdict: 'OK' },
            { testset: 'tests', index: 1, verdict: 'WA' },
          ],
        },
      ],
    });
    expect(outcome.solutions.main.verdicts).toEqual([
      'tests#1:WA',
      'tests#2:OK',
    ]);
  });
});

describe('selectProblems', () => {
  it('reports names that match no problem', () => {
    expect(selectProblems(['b', 'a'], new Set(['nonexistent']))).toEqual({
      names: [],
      unknown: ['nonexistent'],
    });
  });

  it('selects everything by default, sorted', () => {
    expect(selectProblems(['b', 'a'], null)).toEqual({
      names: ['a', 'b'],
      unknown: [],
    });
  });
});

describe('round-trip checks', () => {
  it('fails a push that exited non-zero even when nothing differs', () => {
    expect(pushChecks(1, 0)).toEqual([
      expect.objectContaining({ name: 'push succeeded', ok: false }),
    ]);
  });

  it('fails a push that exited 0 while Polygon differs (#25)', () => {
    expect(pushChecks(0, 2)).toEqual([
      expect.objectContaining({ name: 'push reports failures', ok: false }),
    ]);
    expect(pushChecks(0, 0)).toEqual([]);
  });

  it('needs this run’s marker on Polygon', () => {
    const marker = freshnessMarker('123');
    expect(freshnessCheck(`legend\r\n${marker}\r\n`, marker).ok).toBe(true);
    expect(freshnessCheck(`legend\n${freshnessMarker('122')}`, marker).ok).toBe(
      false
    );
    expect(freshnessCheck(undefined, marker).ok).toBe(false);
  });

  it('turns a check group that produced nothing into a failure', () => {
    expect(nonEmpty('scripts', [], 'no scripts')).toEqual([
      { name: 'scripts', ok: false, detail: 'no checks ran: no scripts' },
    ]);
    const some = [{ name: 'x', ok: true, detail: '' }];
    expect(nonEmpty('scripts', some, 'no scripts')).toBe(some);
  });

  it('reads generator lines the way Polygon shows them', () => {
    const files = { gen: 'gen' };
    expect(
      scriptLines('<#-- note -->\ngen 1 2 > 1\n\ngen 3 > $\n', files)
    ).toEqual(['gen 1 2', 'gen 3']);
    expect(scriptLines('<#list 1..3 as i>gen ${i} > $</#list>', files)).toBe(
      null
    );
  });
});
