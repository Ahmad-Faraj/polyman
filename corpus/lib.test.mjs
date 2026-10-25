import { describe, expect, it } from 'vitest';
import {
  ciRun,
  compare,
  failedStepReason,
  freshnessCheck,
  freshnessMarker,
  inputCountCheck,
  isInside,
  nonEmpty,
  outcomeOf,
  polygonTargets,
  pushChecks,
  pushFailureSummary,
  pushOutputTail,
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

  it('does not count a different reason for the same failed step', () => {
    const base = summary([
      {
        name: 'p',
        failures: [
          'failed step: expected none, got compile-solutions | polyman said: Process killed after 10000ms timeout',
        ],
      },
    ]);
    const next = summary([
      {
        name: 'p',
        failures: [
          'failed step: expected none, got compile-solutions | polyman said: main.cpp:3: error',
        ],
      },
    ]);
    expect(regressions(base, next)).toEqual({ added: [], fixed: [] });
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

  // polyman stops a solution at its first TLE, so a slow test cuts the report
  // short: the tests after it never ran (!4 review, corpus/lib.mjs:55)
  it.each([2, 3])(
    'excuses a slow test %i that cut the report short',
    slowTest => {
      const want = expected({ main });
      const got = structuredClone(want);
      got.solutions.main.verdicts = [
        ...okTests(slowTest - 1),
        `tests#${slowTest}:TLE`,
      ];
      got.solutions.main.matchesTag = false;
      const diffs = compare(want, got);
      expect(failures(diffs)).toEqual([]);
      expect(warnings(diffs).map(d => d.message)).toEqual([
        `solution main: tests#${slowTest}:OK came back tests#${slowTest}:TLE (timing, not judged)`,
        `solution main: ${4 - slowTest} ${slowTest === 3 ? 'test' : 'tests'} after tests#${slowTest} did not run (timing, not judged)`,
      ]);
    }
  );

  // a broken time limit times out every correct solution on its first test:
  // nothing in the report shows the limit works, so it fails
  it('fails a report cut short on its first test', () => {
    const want = expected({ main });
    const got = structuredClone(want);
    got.solutions.main.verdicts = ['tests#1:TLE'];
    got.solutions.main.matchesTag = false;
    expect(failures(compare(want, got))).toContain(
      'solution main: cut short at tests#1:TLE with no expected OK test still OK (a broken limit, not a slow runner)'
    );
  });

  // the WA this solution is in the corpus for never ran (review of !80)
  it('fails a short report whose skipped tests expect a non-OK verdict', () => {
    const wa = {
      tag: 'WA',
      matchesTag: true,
      verdicts: ['tests#1:OK', 'tests#2:OK', 'tests#3:WA'],
    };
    const want = expected({ wa });
    const got = structuredClone(want);
    got.solutions.wa.verdicts = ['tests#1:OK', 'tests#2:TLE'];
    got.solutions.wa.matchesTag = false;
    expect(failures(compare(want, got))).toContain(
      'solution wa: cut short at tests#2:TLE before tests#3:WA ran, so the expected verdict was never seen'
    );
  });

  it('fails a short report that does not end on a slow test', () => {
    const want = expected({ main });
    const got = structuredClone(want);
    got.solutions.main.verdicts = okTests(2);
    expect(failures(compare(want, got))).toEqual([
      'solution main: expected 4 tests, got 2',
    ]);
  });

  it('fails a short report that ends on a TLE where OK was not expected', () => {
    const wa = {
      tag: 'WA',
      matchesTag: true,
      verdicts: ['tests#1:OK', 'tests#2:WA', 'tests#3:OK'],
    };
    const want = expected({ wa });
    const got = structuredClone(want);
    got.solutions.wa.verdicts = ['tests#1:OK', 'tests#2:TLE'];
    expect(failures(compare(want, got))).toEqual([
      'solution wa: expected 3 tests, got 2',
    ]);
  });

  it('fails a short report whose earlier tests changed verdict', () => {
    const want = expected({ main });
    const got = structuredClone(want);
    got.solutions.main.verdicts = ['tests#1:WA', 'tests#2:TLE'];
    got.solutions.main.matchesTag = false;
    const messages = failures(compare(want, got));
    expect(messages).toContain(
      'solution main: expected tests#1:OK, got tests#1:WA'
    );
    expect(messages).toContain(
      'solution main: expected matchesTag=true, got false'
    );
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

describe('polygonTargets', () => {
  it('pushes the problems with a Polygon ID and names the others as skipped', () => {
    expect(
      polygonTargets(['sum-parity', 'pair-target', 'mean-deviation'], {
        'sum-parity': 605330,
      })
    ).toEqual({
      targets: [{ problem: 'sum-parity', problemId: '605330' }],
      skipped: ['mean-deviation', 'pair-target'],
    });
  });

  it('skips an ID that is not a positive integer', () => {
    expect(polygonTargets(['a', 'b'], { a: '605330', b: 0 })).toEqual({
      targets: [],
      skipped: ['a', 'b'],
    });
  });
});

describe('round-trip checks', () => {
  it('fails a push that exited non-zero even when nothing differs', () => {
    expect(pushChecks(1, 0)).toEqual([
      expect.objectContaining({ name: 'push succeeded', ok: false }),
    ]);
  });

  it('puts what polyman said in the failure message', () => {
    expect(pushChecks(1, 0, 'solution x: 502')[0].detail).toBe(
      'polyman remote push exited 1: solution x: 502'
    );
  });

  it('keeps a redacted tail of the push output', () => {
    const output = [
      'Uploading solutions',
      '',
      'GET /api/problem.info?apiKey=abc123&time=1&apiSig=deadbeef',
      'secret s3cr3t leaked',
      ...Array.from({ length: 50 }, (_, i) => `line ${i}`),
    ].join('\n');
    const tail = pushOutputTail(output, ['s3cr3t'], 60);
    expect(tail).not.toMatch(/abc123|deadbeef|s3cr3t/);
    expect(tail).toContain('apiKey=[REDACTED]');
    expect(tail).toContain('secret [REDACTED] leaked');
    expect(tail).not.toContain('\n\n');
    expect(pushOutputTail(output, [], 3)).toBe('line 47\nline 48\nline 49');
  });

  it('summarises the failed items, or the last lines', () => {
    const tail = [
      'Uploading tests',
      '╔══════════════════════════════╗',
      '║  PUSH COMPLETED WITH ERRORS  ║',
      '╚══════════════════════════════╝',
      '  1 item(s) failed to upload:',
      '   ✗ Solution acc.cpp: Polygon answered 502',
      '  ℹ Problem ID: 605330',
    ].join('\n');
    expect(pushFailureSummary(tail)).toBe(
      '1 item(s) failed to upload: | ✗ Solution acc.cpp: Polygon answered 502 | ℹ Problem ID: 605330'
    );
    expect(pushFailureSummary('a\nb\nc\nd\ne\nf')).toBe('b | c | d | e | f');
    expect(pushFailureSummary('x'.repeat(700))).toHaveLength(600);
  });

  it('keeps the last lines when nothing follows the push error marker', () => {
    expect(
      pushFailureSummary(pushOutputTail('a\n║  PUSH COMPLETED WITH ERRORS  ║'))
    ).toBe('a | PUSH COMPLETED WITH ERRORS');
    expect(
      pushFailureSummary(
        'x\n╔════╗\n║  PUSH COMPLETED WITH ERRORS  ║\n╚════╝\n'
      )
    ).toBe('x | PUSH COMPLETED WITH ERRORS');
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

  it('needs as many generated tests as Polygon has', () => {
    expect(inputCountCheck('tests', 5, 5)).toEqual(
      expect.objectContaining({ name: 'inputs tests count', ok: true })
    );
    expect(inputCountCheck('tests', 3, 5)).toEqual({
      name: 'inputs tests count',
      ok: false,
      detail: 'polyman generated 3 tests, Polygon has 5',
    });
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

describe('isInside: the path guard', () => {
  it('accepts files under the folder', () => {
    expect(isInside('/repo', '/repo/corpus/out/m.json')).toBe(true);
    expect(isInside('/repo', '/repo/..notes')).toBe(true);
  });
  it('refuses the folder itself, parents and siblings', () => {
    expect(isInside('/repo', '/repo')).toBe(false);
    expect(isInside('/repo', '/')).toBe(false);
    expect(isInside('/repo', '/repo-evil/m.json')).toBe(false);
    expect(isInside('/repo', '/tmp/m.json')).toBe(false);
  });
});

describe('failedStepReason: why a step failed', () => {
  const report = errors => ({
    ok: false,
    failedStep: 'compile-solutions',
    steps: [
      { name: 'validate-tests', ok: true, errors: [] },
      { name: 'compile-solutions', ok: false, errors },
    ],
  });

  it("gives the failed step's errors on one line", () => {
    expect(
      failedStepReason(
        report([
          'Failed to compile wa.cpp:\n  Process killed after 10000ms timeout',
          'Failed to compile tle.cpp',
        ])
      )
    ).toBe(
      'Failed to compile wa.cpp: Process killed after 10000ms timeout; Failed to compile tle.cpp'
    );
  });

  it('redacts secrets and apiKey/apiSig values', () => {
    const reason = failedStepReason(
      report(['GET /api?apiKey=abc123&apiSig=deadbeef failed, key s3cr3t']),
      ['s3cr3t']
    );
    expect(reason).not.toMatch(/abc123|deadbeef|s3cr3t/);
    expect(reason).toContain('apiKey=[REDACTED]');
  });

  it('cuts a long reason', () => {
    expect(failedStepReason(report(['x'.repeat(700)]))).toHaveLength(600);
  });

  it('is empty when no step failed or the step listed nothing', () => {
    expect(failedStepReason({ ok: true, failedStep: null, steps: [] })).toBe(
      ''
    );
    expect(failedStepReason(report([]))).toBe('');
  });

  it('goes into the failed-step message, and only there', () => {
    const want = expected({});
    const got = {
      ...structuredClone(want),
      ok: false,
      failedStep: 'compile-solutions',
    };
    expect(
      failures(compare(want, got, 'Process killed after 10000ms timeout'))
    ).toEqual([
      'report ok: expected true, got false',
      'failed step: expected none, got compile-solutions | polyman said: Process killed after 10000ms timeout',
    ]);
    expect(failures(compare(want, got))).toContain(
      'failed step: expected none, got compile-solutions'
    );
  });
});

describe('ciRun: the GitHub Actions run', () => {
  const env = {
    GITHUB_ACTIONS: 'true',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'HamzaHassanain/polyman',
    GITHUB_RUN_ID: '123456',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_JOB: 'polygon',
    GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
  };

  it('links the run and names the commit', () => {
    expect(ciRun(env)).toEqual({
      id: '123456',
      url: 'https://github.com/HamzaHassanain/polyman/actions/runs/123456',
      commit: '01234567',
      marker: '123456.2.polygon',
    });
  });

  it('gives each attempt and each job its own marker', () => {
    const marker = e => ciRun({ ...env, ...e }).marker;
    expect(marker({ GITHUB_RUN_ATTEMPT: '3' })).toBe('123456.3.polygon');
    expect(marker({ GITHUB_JOB: 'production' })).toBe('123456.2.production');
    expect(marker({ GITHUB_RUN_ATTEMPT: undefined })).toBe('123456.1.polygon');
  });

  it('uses the server of a GitHub Enterprise instance', () => {
    expect(
      ciRun({ ...env, GITHUB_SERVER_URL: 'https://git.example.com' }).url
    ).toBe(
      'https://git.example.com/HamzaHassanain/polyman/actions/runs/123456'
    );
  });

  it('is null outside GitHub Actions', () => {
    expect(ciRun({})).toBeNull();
    expect(ciRun({ ...env, GITHUB_ACTIONS: undefined })).toBeNull();
    expect(ciRun({ ...env, GITHUB_RUN_ID: '' })).toBeNull();
    // GitLab's variables are not read any more
    expect(
      ciRun({ CI_PIPELINE_URL: 'https://gitlab.com/x/-/pipelines/1' })
    ).toBeNull();
  });
});
