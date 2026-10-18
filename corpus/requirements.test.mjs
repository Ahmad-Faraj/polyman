import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('leaves out the unjudged rule when polyman gave no report on a problem it does not apply to', () => {
    const okOnly = {
      steps: {},
      solutions: { main: { verdicts: ['tests#1:OK', 'tests#2:OK'] } },
    };
    const oneWa = {
      steps: {},
      solutions: { wa: { verdicts: ['tests#1:OK', 'tests#2:WA'] } },
    };
    const summary = {
      problems: [
        { name: 'easy', failures: ['polyman produced no JSON report:\nboom'] },
        {
          name: 'one-wa',
          failures: ['polyman produced no JSON report:\nboom'],
        },
      ],
    };
    expect(
      corpusRequirements(summary, { easy: okOnly, 'one-wa': oneWa })
    ).toEqual({ [wa]: 'failed' });
  });

  it('judges nothing for a problem with no expected file', () => {
    expect(actualVerdicts(undefined, { failures: [] })).toBeNull();
    const summary = { problems: [{ name: 'new', failures: [] }] };
    expect(corpusRequirements(summary, {})).toEqual({});
    expect(corpusRequirements(undefined, {})).toEqual({});
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
      ok('inputs tests count'),
    ]);
    expect(polygonRequirements(xml)).toEqual({ [platform]: 'passed' });
  });

  it('fails when the push failed or left an earlier upload, even if inputs match', () => {
    const inputs = [
      ok('input tests #1'),
      ok('input tests #2'),
      ok('inputs tests count'),
    ];
    for (const push of ['push succeeded', 'push is fresh']) {
      expect(polygonRequirements(junit([bad(push), ...inputs]))).toEqual({
        [platform]: 'failed',
      });
    }
    expect(
      polygonRequirements(
        junit([
          bad('push is fresh'),
          bad('push succeeded'),
          ok('input tests #1'),
        ])
      )
    ).toEqual({ [platform]: 'failed' });
  });

  it('fails when polyman generated fewer tests than Polygon has', () => {
    const xml = junit([ok('input tests #1'), bad('inputs tests count')]);
    expect(polygonRequirements(xml)).toEqual({ [platform]: 'failed' });
  });

  it('fails when a testset was compared without its test count', () => {
    expect(polygonRequirements(junit([ok('input tests #1')]))).toEqual({
      [platform]: 'failed',
    });
    const xml = junit([
      ok('input tests #1'),
      ok('inputs tests count'),
      ok('input extra #1'),
    ]);
    expect(polygonRequirements(xml)).toEqual({ [platform]: 'failed' });
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

describe('requirements.mjs as a command', () => {
  const script = fileURLToPath(new URL('./requirements.mjs', import.meta.url));
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'requirements-'));
  const run = (...args) =>
    execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

  it('writes the corpus rules from a summary', () => {
    const dir = tmp();
    const summary = path.join(dir, 'summary.json');
    const out = path.join(dir, 'out', 'requirements.json');
    fs.writeFileSync(summary, JSON.stringify(summaryOf(expected)));
    expect(run('corpus', summary, out)).toContain(`passed #${pe}`);
    expect(read(out)).toEqual({
      [pe]: 'passed',
      [unjudged]: 'passed',
      [wa]: 'passed',
    });
  });

  it('writes nothing when the corpus did not finish', () => {
    const dir = tmp();
    const out = path.join(dir, 'requirements.json');
    expect(run('corpus', path.join(dir, 'missing.json'), out)).toContain(
      'requirements unchanged'
    );
    expect(fs.existsSync(out)).toBe(false);
  });

  it('writes the platform rule from a JUnit report, or {} without one', () => {
    const dir = tmp();
    const xml = path.join(dir, 'junit.xml');
    const out = path.join(dir, 'requirements.json');
    fs.writeFileSync(
      xml,
      '<testsuite><testcase classname="polygon-roundtrip" name="input tests #1"></testcase></testsuite>'
    );
    run('polygon', xml, out);
    expect(read(out)).toEqual({ [platform]: 'failed' });
    expect(run('polygon', path.join(dir, 'missing.xml'), out)).toContain(
      'no rule had evidence'
    );
    expect(read(out)).toEqual({});
  });

  it('exits non-zero on an unknown mode or a broken summary', () => {
    const dir = tmp();
    const broken = path.join(dir, 'summary.json');
    fs.writeFileSync(broken, '{');
    for (const args of [['nope'], ['corpus', broken, path.join(dir, 'o.json')]])
      expect(
        spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
          .status
      ).not.toBe(0);
  });
});
