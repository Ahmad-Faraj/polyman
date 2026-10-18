import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compare } from './lib.mjs';
import {
  REQUIREMENTS,
  actualVerdicts,
  corpusRequirements,
  polygonRequirements,
} from './requirements.mjs';

const { pe, unjudged, wa, platform } = Object.fromEntries(
  Object.entries(REQUIREMENTS).map(([rule, r]) => [rule, r.iid])
);

// sum-parity as pinned, and polyman's answer with some verdicts changed
const expected = JSON.parse(
  fs.readFileSync(new URL('./expected/sum-parity.json', import.meta.url))
);
const answer = changes => {
  const actual = structuredClone(expected);
  for (const [name, verdicts] of Object.entries(changes))
    actual.solutions[name].verdicts = verdicts;
  return actual;
};
// the summary run.mjs writes, from the same compare() it uses
const summaryOf = actual => {
  const diffs = compare(expected, actual);
  const of = kind => diffs.filter(d => d.kind === kind).map(d => d.message);
  return {
    problems: [
      { name: 'sum-parity', failures: of('failure'), warnings: of('warning') },
    ],
  };
};
const judge = actual =>
  corpusRequirements(summaryOf(actual), { 'sum-parity': expected });

describe('corpusRequirements: the judge rules from a corpus run', () => {
  it('satisfies every rule when polyman matches the true verdicts', () => {
    expect(judge(expected)).toEqual({
      [pe]: 'passed',
      [unjudged]: 'passed',
      [wa]: 'passed',
    });
  });

  it('fails all three on polyman 3.0.0 (#21, #28, as in #45)', () => {
    const v300 = answer({
      pe_prints_sum: ['tests#1:WA', 'tests#2:OK', 'tests#3:OK', 'tests#4:OK'],
      wa_always_yes: ['tests#1:WA', 'tests#2:OK', 'tests#3:OK', 'tests#4:OK'],
      wa_python: ['tests#1:WA', 'tests#2:OK', 'tests#3:OK', 'tests#4:OK'],
    });
    expect(judge(v300)).toEqual({
      [pe]: 'failed',
      [unjudged]: 'failed',
      [wa]: 'failed',
    });
  });

  it('keeps the rules apart: PE reported as WA fails only the PE rule', () => {
    const peAsWa = answer({
      pe_prints_sum: ['tests#1:WA', 'tests#2:WA', 'tests#3:WA', 'tests#4:WA'],
    });
    expect(judge(peAsWa)).toEqual({
      [pe]: 'failed',
      [unjudged]: 'passed',
      [wa]: 'passed',
    });
  });

  it('a wrong answer judged OK on the first test fails the WA rule only', () => {
    const waFirst = answer({
      wa_python: ['tests#1:OK', 'tests#2:WA', 'tests#3:WA', 'tests#4:WA'],
    });
    expect(judge(waFirst)).toEqual({
      [pe]: 'passed',
      [unjudged]: 'passed',
      [wa]: 'failed',
    });
  });

  it('a slow runner (OK came back TLE) breaks no rule', () => {
    const slow = answer({
      correct2: ['tests#1:OK', 'tests#2:TLE', 'tests#3:OK', 'tests#4:OK'],
    });
    expect(summaryOf(slow).problems[0].warnings).toHaveLength(1);
    expect(judge(slow)).toEqual({
      [pe]: 'passed',
      [unjudged]: 'passed',
      [wa]: 'passed',
    });
  });

  it('fails the rules a problem tests when polyman produced no report', () => {
    const summary = {
      problems: [
        {
          name: 'sum-parity',
          failures: ['polyman produced no JSON report:\nboom'],
        },
      ],
    };
    expect(actualVerdicts(expected, summary.problems[0])).toBeNull();
    expect(corpusRequirements(summary, { 'sum-parity': expected })).toEqual({
      [pe]: 'failed',
      [unjudged]: 'failed',
      [wa]: 'failed',
    });
  });

  it('leaves out a rule no pinned test applies to', () => {
    const okOnly = {
      steps: {},
      solutions: { main: { verdicts: ['tests#1:OK', 'tests#2:OK'] } },
    };
    const summary = { problems: [{ name: 'easy', failures: [] }] };
    expect(corpusRequirements(summary, { easy: okOnly })).toEqual({});
  });
});

describe('polygonRequirements: generated tests against Polygon', () => {
  const junit = cases =>
    `<?xml version="1.0"?>\n<testsuite>\n${cases.join('\n')}\n</testsuite>`;
  const ok = name =>
    `  <testcase classname="polygon-roundtrip" name="${name}"></testcase>`;
  const bad = name =>
    `  <testcase classname="polygon-roundtrip" name="${name}"><failure message="polyman 3 bytes, Polygon 4 bytes"/></testcase>`;

  it('passes when every generated input matches', () => {
    const xml = junit([
      ok('solution main'),
      ok('input tests #1'),
      ok('input tests #2'),
    ]);
    expect(polygonRequirements(xml)).toEqual({ [platform]: 'passed' });
  });

  it('fails on one input that differs, whatever else failed', () => {
    const xml = junit([
      bad('solution java'),
      ok('input tests #1'),
      bad('input tests #2'),
    ]);
    expect(polygonRequirements(xml)).toEqual({ [platform]: 'failed' });
  });

  it('fails when polyman generate wrote nothing to compare', () => {
    expect(polygonRequirements(junit([bad('inputs tests')]))).toEqual({
      [platform]: 'failed',
    });
  });

  it('leaves the rule out when the round trip never compared inputs', () => {
    expect(polygonRequirements(junit([bad('push succeeded')]))).toEqual({});
    expect(polygonRequirements(undefined)).toEqual({});
  });
});
