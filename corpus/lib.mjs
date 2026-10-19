/**
 * The corpus's judging logic, kept free of I/O so tests can pin it
 * (corpus/lib.test.mjs). run.mjs and polygon-roundtrip.mjs import from here.
 */

import path from 'node:path';

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
 * stays a warning. polyman stops a solution at its first TLE, so a report cut
 * short right after an expected OK that came back TLE is judged on the tests
 * that ran, and the rest are a warning, if an earlier expected OK still came
 * back OK and every test that didn't run expects OK.
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
    // polyman stops a solution at its first TLE, so a slow test cuts the
    // report short; only the tests that ran are judged
    let wantVerdicts = want.verdicts;
    if (got.verdicts.length !== want.verdicts.length) {
      const ran = got.verdicts.length;
      const last = got.verdicts[ran - 1];
      if (
        !(ran < want.verdicts.length) ||
        !last?.endsWith(':TLE') ||
        want.verdicts[ran - 1] !== last.replace(/:TLE$/, ':OK')
      ) {
        fail(
          `solution ${name}: expected ${want.verdicts.length} tests, got ${ran}`
        );
        continue;
      }
      wantVerdicts = want.verdicts.slice(0, ran);
    }
    const expectedOk = wantVerdicts.filter(v => v.endsWith(':OK')).length;
    let slower = 0;
    let other = false;
    wantVerdicts.forEach((wantTest, i) => {
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
    const notRun = want.verdicts.length - wantVerdicts.length;
    // the excuse needs an expected OK that still came back OK: a solution cut
    // short with none may be a broken limit, not a slow runner
    if (
      notRun &&
      !wantVerdicts.some((v, i) => v.endsWith(':OK') && got.verdicts[i] === v)
    )
      fail(
        `solution ${name}: cut short at ${got.verdicts.at(-1)} with no expected OK test still OK (a broken limit, not a slow runner)`
      );
    else if (notRun) {
      // a skipped test that expects WA, RE, ML, ... is the verdict this
      // solution is in the corpus for: without it nothing was judged
      const missed = want.verdicts
        .slice(wantVerdicts.length)
        .filter(v => !v.endsWith(':OK'));
      if (missed.length)
        fail(
          `solution ${name}: cut short at ${got.verdicts.at(-1)} before ${missed.join(', ')} ran, so the expected verdict was never seen`
        );
      else
        warn(
          `solution ${name}: ${notRun} ${notRun === 1 ? 'test' : 'tests'} after ${wantVerdicts.at(-1).replace(/:OK$/, '')} did not run (timing, not judged)`
        );
    }
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
export function pushChecks(status, differences, summary = '') {
  if (status !== 0)
    return [
      {
        name: 'push succeeded',
        ok: false,
        detail: `polyman remote push exited ${status}${summary ? `: ${summary}` : ''}`,
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

/**
 * polyman's push output, made safe and short enough for a job log: the given
 * secrets and any apiKey/apiSig query values are redacted, blank lines are
 * dropped, and only the last `lines` lines are kept.
 */
export function pushOutputTail(output, secrets = [], lines = 40) {
  let out = String(output ?? '');
  for (const secret of secrets)
    if (secret) out = out.split(secret).join('[REDACTED]');
  out = out.replace(/\b(apiKey|apiSig)=[^&\s"')]+/g, '$1=[REDACTED]');
  return out
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim())
    .slice(-lines)
    .join('\n');
}

/**
 * One line for the JUnit failure message: the items polyman lists under
 * "PUSH COMPLETED WITH ERRORS", or else (no marker, or nothing but the box
 * after it) the last few lines of the output.
 */
export function pushFailureSummary(tail, max = 600) {
  const lines = tail
    .split('\n')
    .map(l => l.replace(/[\u2500-\u257f]/g, '').trim())
    .filter(Boolean);
  const start = lines.findIndex(l => l.includes('PUSH COMPLETED WITH ERRORS'));
  const after = start >= 0 ? lines.slice(start + 1) : [];
  const picked = (after.length ? after : lines.slice(-5)).join(' | ');
  return picked.length > max ? `${picked.slice(0, max - 3)}...` : picked;
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

/**
 * True when `target` is a file strictly inside the folder `base` (both
 * absolute). `path.relative` catches `..` and sibling folders such as
 * `/repo-other`, which `startsWith` lets through.
 */
export function isInside(base, target) {
  const rel = path.relative(base, target);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
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

/**
 * Which problems the Polygon round trip pushes (`--all`): those with a Polygon
 * problem ID in corpus/polygon.json. The others are skipped, by name, so a
 * report says what the round trip did not cover.
 */
export function polygonTargets(problems, ids) {
  const targets = [];
  const skipped = [];
  for (const problem of [...problems].sort()) {
    const id = ids?.[problem];
    if (Number.isInteger(id) && id > 0)
      targets.push({ problem, problemId: String(id) });
    else skipped.push(problem);
  }
  return { targets, skipped };
}
