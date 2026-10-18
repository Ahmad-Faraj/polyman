#!/usr/bin/env node
/**
 * The judge rules as GitLab Requirements (#50): writes the requirements report
 * (artifacts:reports:requirements_v2) that marks each Requirement satisfied or
 * failed from the corpus results. Keys are the Requirements' work item IIDs.
 *
 * A rule with no evidence in this run (no pinned test it applies to, or a round
 * trip that stopped before comparing inputs) is left out, so the Requirement
 * keeps its last state instead of passing unseen.
 *
 * Usage:
 *   node corpus/requirements.mjs corpus  [corpus/out/summary.json] [out.json]
 *   node corpus/requirements.mjs polygon [corpus/out/junit-polygon.xml] [out.json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORPUS = path.dirname(fileURLToPath(import.meta.url));

/** The Requirements in this project (Plan > Requirements), by rule. */
export const REQUIREMENTS = {
  pe: { iid: 53, title: 'A presentation error is reported as PE' },
  unjudged: { iid: 54, title: 'A test the checker never judged is never OK' },
  wa: { iid: 55, title: 'A wrong answer is never reported OK' },
  platform: { iid: 56, title: 'Generated tests match the platform of record' },
};

const verdictOf = test => test.split(':').pop();
const MISMATCH = /^solution (.+?): expected (\S+), got (\S+)$/;
const TIMING = /^solution (.+?): (\S+) came back (\S+) \(timing, not judged\)$/;

/**
 * What polyman reported per solution, rebuilt from the pinned verdicts and the
 * differences the corpus listed (corpus/lib.mjs compare()), or null when the
 * corpus couldn't compare test by test (no report, a missing solution, a
 * different number of tests).
 */
export function actualVerdicts(expected, problem) {
  if (!expected) return null;
  const messages = [...(problem.failures ?? []), ...(problem.warnings ?? [])];
  const got = new Map();
  for (const message of messages) {
    const m = MISMATCH.exec(message) ?? TIMING.exec(message);
    if (m) got.set(`${m[1]}\n${m[2]}`, m[3]);
    else if (
      /produced no JSON report|no expected file|missing from report|tests, got \d+$/.test(
        message
      )
    )
      return null;
  }
  const solutions = {};
  for (const [name, want] of Object.entries(expected.solutions)) {
    solutions[name] = want.verdicts.map(v => got.get(`${name}\n${v}`) ?? v);
  }
  return solutions;
}

/**
 * The three verdict rules from one corpus run: { iid: 'passed' | 'failed' }.
 * `expected` maps each problem name to its corpus/expected/<name>.json.
 */
export function corpusRequirements(summary, expected) {
  const state = { pe: null, unjudged: null, wa: null };
  const judge = (rule, ok) => {
    state[rule] = ok && state[rule] !== 'failed' ? 'passed' : 'failed';
  };
  for (const problem of summary?.problems ?? []) {
    const want = expected[problem.name];
    const got = actualVerdicts(want, problem);
    const all = Object.values(want?.solutions ?? {}).flatMap(s => s.verdicts);
    const has = verdict => all.some(v => verdictOf(v) === verdict);
    if (!got) {
      // polyman judged nothing here: every rule this problem tests fails
      if (has('PE')) judge('pe', false);
      if (has('WA')) judge('wa', false);
      judge('unjudged', false);
      continue;
    }
    for (const [name, { verdicts }] of Object.entries(want.solutions)) {
      let rejected = false;
      verdicts.forEach((test, i) => {
        const truth = verdictOf(test);
        const reported = verdictOf(got[name][i]);
        if (truth === 'PE') judge('pe', reported === 'PE');
        if (truth === 'WA') judge('wa', reported !== 'OK');
        if (rejected && truth !== 'OK') judge('unjudged', reported !== 'OK');
        if (reported !== 'OK') rejected = true;
      });
    }
  }
  return Object.fromEntries(
    Object.entries(state)
      .filter(([, s]) => s)
      .map(([rule, s]) => [REQUIREMENTS[rule].iid, s])
  );
}

const unescape = s =>
  s.replace(
    /&(lt|gt|quot|amp);/g,
    (_, e) => ({ lt: '<', gt: '>', quot: '"', amp: '&' })[e]
  );

/**
 * The platform rule from the Polygon round trip's JUnit report: every
 * generated input matches Polygon's, and at least one was compared.
 */
export function polygonRequirements(junitXml) {
  const cases = [
    ...String(junitXml ?? '').matchAll(
      /<testcase [^>]*name="([^"]*)"[^>]*?(\/>|>([\s\S]*?)<\/testcase>)/g
    ),
  ].map(m => ({
    name: unescape(m[1]),
    ok: !/<failure/.test(m[3] ?? ''),
  }));
  const inputs = cases.filter(c => /^inputs? /.test(c.name));
  if (!inputs.length) return {};
  const ok =
    inputs.every(c => c.ok) && inputs.some(c => /^input /.test(c.name));
  return { [REQUIREMENTS.platform.iid]: ok ? 'passed' : 'failed' };
}

function main() {
  const [mode, input, output] = process.argv.slice(2);
  const out = path.resolve(
    output ?? path.join(CORPUS, 'out', 'requirements.json')
  );
  let report;
  if (mode === 'corpus') {
    const file = input ?? path.join(CORPUS, 'out', 'summary.json');
    if (!fs.existsSync(file)) {
      console.log(
        `no ${file}: the corpus didn't finish, requirements unchanged`
      );
      return;
    }
    const summary = JSON.parse(fs.readFileSync(file, 'utf8'));
    const expected = {};
    for (const p of summary.problems ?? []) {
      const f = path.join(CORPUS, 'expected', `${p.name}.json`);
      if (fs.existsSync(f))
        expected[p.name] = JSON.parse(fs.readFileSync(f, 'utf8'));
    }
    report = corpusRequirements(summary, expected);
  } else if (mode === 'polygon') {
    const file = input ?? path.join(CORPUS, 'out', 'junit-polygon.xml');
    report = fs.existsSync(file)
      ? polygonRequirements(fs.readFileSync(file, 'utf8'))
      : {};
  } else {
    throw new Error('usage: requirements.mjs corpus|polygon [input] [output]');
  }
  const byIid = Object.fromEntries(
    Object.values(REQUIREMENTS).map(r => [r.iid, r.title])
  );
  for (const [iid, state] of Object.entries(report))
    console.log(`${state.padEnd(6)} #${iid} ${byIid[iid]}`);
  if (!Object.keys(report).length)
    console.log('no rule had evidence in this run: requirements unchanged');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
