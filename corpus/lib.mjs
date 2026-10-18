/**
 * The corpus's judging logic, kept free of I/O so tests can pin it
 * (corpus/lib.test.mjs). run.mjs and polygon-roundtrip.mjs import from here.
 */

/** Reduces a `polyman verify --json` report to the parts the corpus pins. */
export function outcomeOf(report) {
  const steps = {};
  for (const step of report.steps) steps[step.name] = step.ok;
  const solutions = {};
  for (const solution of report.solutions) {
    const tests = [...solution.tests].sort(
      (a, b) => a.testset.localeCompare(b.testset) || a.index - b.index
    );
    solutions[solution.name] = {
      tag: solution.tag,
      matchesTag: solution.matchesTag,
      verdicts: tests.map(
        test => `${test.testset}#${test.index}:${test.verdict}`
      ),
    };
  }
  return { ok: report.ok, failedStep: report.failedStep, steps, solutions };
}

/**
 * Lists differences as { kind: 'failure' | 'warning', message }.
 *
 * Timing is not judged exactly: an expected OK that comes back TLE is a
 * warning (slow runner), and may excuse the matchesTag change it causes. That
 * excuse needs at least one expected OK to still be OK: a runner slow enough to
 * time out every test of a solution is not a slow runner, it's a broken limit.
 * That rule needs two or more expected OK tests; with one, a single slow test
 * stays a warning.
 */
export function compare(expected, actual) {
  const diffs = [];
  const fail = message => diffs.push({ kind: 'failure', message });
  const warn = message => diffs.push({ kind: 'warning', message });

  if (actual.ok !== expected.ok)
    fail(`report ok: expected ${expected.ok}, got ${actual.ok}`);
  if ((actual.failedStep ?? null) !== (expected.failedStep ?? null))
    fail(
      `failed step: expected ${expected.failedStep ?? 'none'}, got ${actual.failedStep ?? 'none'}`
    );
  for (const [step, ok] of Object.entries(expected.steps)) {
    if (actual.steps[step] !== ok)
      fail(`step ${step}: expected ok=${ok}, got ${actual.steps[step]}`);
  }
  for (const [name, want] of Object.entries(expected.solutions)) {
    const got = actual.solutions[name];
    if (!got) {
      fail(`solution ${name}: missing from report`);
      continue;
    }
    if (got.verdicts.length !== want.verdicts.length) {
      fail(
        `solution ${name}: expected ${want.verdicts.length} tests, got ${got.verdicts.length}`
      );
      continue;
    }
    const expectedOk = want.verdicts.filter(v => v.endsWith(':OK')).length;
    let slower = 0;
    let other = false;
    want.verdicts.forEach((wantTest, i) => {
      const gotTest = got.verdicts[i];
      if (gotTest === wantTest) return;
      if (wantTest.endsWith(':OK') && gotTest.endsWith(':TLE')) {
        slower++;
        warn(
          `solution ${name}: ${wantTest} came back ${gotTest} (timing, not judged)`
        );
      } else {
        other = true;
        fail(`solution ${name}: expected ${wantTest}, got ${gotTest}`);
      }
    });
    const allTimedOut = expectedOk > 1 && slower === expectedOk;
    if (allTimedOut)
      fail(
        `solution ${name}: all ${expectedOk} expected OK tests came back TLE; a slow runner doesn't time out every test`
      );
    const timingOnly = slower > 0 && !other && !allTimedOut;
    if (got.matchesTag !== want.matchesTag && !timingOnly) {
      fail(
        `solution ${name}: expected matchesTag=${want.matchesTag}, got ${got.matchesTag}`
      );
    }
  }
  for (const name of Object.keys(actual.solutions)) {
    if (!expected.solutions[name])
      fail(`solution ${name}: not pinned in expected file`);
  }
  return diffs;
}

/**
 * Which problems to judge. `only` names that match no problem are returned in
 * `unknown`; a run that judges nothing or names unknown problems must fail.
 */
export function selectProblems(available, only) {
  const names = [...available].filter(name => !only || only.has(name)).sort();
  const unknown = only ? [...only].filter(n => !available.includes(n)) : [];
  return { names, unknown };
}

/** Line endings differ by platform; Polygon stores CRLF. Compare content only. */
export const text = s => String(s ?? '').replace(/\r\n/g, '\n');

/**
 * The generator lines of a script as Polygon shows them per test: the
 * generator's file name (without extension) and its arguments, no target.
 * Returns null for scripts that use FreeMarker beyond comments.
 */
export function scriptLines(script, generatorFiles) {
  const lines = [];
  for (const raw of script.replace(/<#--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.includes('<#') || line.includes('${')) return null;
    const command = line.split('>')[0].trim().split(/\s+/);
    command[0] = generatorFiles[command[0]] ?? command[0];
    lines.push(command.join(' '));
  }
  return lines;
}

/**
 * Checks about the push itself. A push that exits non-zero failed, whatever
 * Polygon now holds: it may still hold the previous run's upload. A push that
 * exits 0 while Polygon differs from the folder hid its failures (#25).
 */
export function pushChecks(status, differences) {
  if (status !== 0)
    return [
      {
        name: 'push succeeded',
        ok: false,
        detail: `polyman remote push exited ${status}`,
      },
    ];
  if (differences > 0)
    return [
      {
        name: 'push reports failures',
        ok: false,
        detail:
          'polyman remote push exited 0, but Polygon differs from the folder',
      },
    ];
  return [];
}

/** A marker unique to this run, written into a statement before the push. */
export const freshnessMarker = runId => `% polyman corpus run ${runId}`;

/**
 * The problem is reused across runs, so a push that silently uploads nothing
 * would leave the last run's content to compare against. Polygon must show this
 * run's marker.
 */
export function freshnessCheck(statement, marker) {
  const found = text(statement).includes(marker);
  return {
    name: 'push is fresh',
    ok: found,
    detail: found
      ? ''
      : `Polygon's statement doesn't contain "${marker}"; it holds an earlier upload`,
  };
}

/**
 * polyman must generate as many tests as Polygon holds for the testset, or a
 * run that stopped early would pass on the inputs it did write.
 */
export function inputCountCheck(testset, local, remote) {
  return {
    name: `inputs ${testset} count`,
    ok: local === remote,
    detail: `polyman generated ${local} tests, Polygon has ${remote}`,
  };
}

/** A check group that produced nothing must fail, or it passes unseen. */
export function nonEmpty(name, checks, reason) {
  return checks.length
    ? checks
    : [{ name, ok: false, detail: `no checks ran: ${reason}` }];
}

/**
 * What a release candidate judges worse or better than the version users have,
 * from two corpus summaries (summary.json). While judge bugs are open the
 * corpus can't be all green, so the release gate is "no regression": nothing
 * the baseline got right may go wrong. A problem the candidate didn't run at
 * all counts as a regression, so a broken install can't pass as "nothing new".
 */
export function regressions(baseline, candidate) {
  const failuresOf = summary =>
    new Map(
      (summary?.problems ?? []).map(p => [p.name, new Set(p.failures ?? [])])
    );
  const before = failuresOf(baseline);
  const after = failuresOf(candidate);
  const added = [];
  const fixed = [];
  for (const [name, was] of before) {
    const now = after.get(name);
    if (!now) {
      added.push({ problem: name, message: 'not judged by the candidate' });
      continue;
    }
    for (const m of now)
      if (!was.has(m)) added.push({ problem: name, message: m });
    for (const m of was)
      if (!now.has(m)) fixed.push({ problem: name, message: m });
  }
  for (const [name, now] of after) {
    if (before.has(name)) continue;
    for (const m of now) added.push({ problem: name, message: m });
  }
  return { added, fixed };
}
