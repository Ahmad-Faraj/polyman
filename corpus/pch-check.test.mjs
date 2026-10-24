import { describe, expect, it } from 'vitest';
import {
  compareOutcomes,
  describePath,
  mainSolution,
  outcomeOf,
  parseArgs,
  pathProblems,
  pchPathOf,
  RUNS,
  startsWithBitsStdcpp,
} from './pch-check.mjs';

const debug = lines => lines.map(l => `[polyman debug] ${l}`).join('\n');
const run = name => RUNS.find(r => r.name === name);

const OFF = debug(['pch: off, normal compile: acc.cpp']);
const BUILT = debug([
  'pch: built key aaaaaaaaaaaa in 7400ms at /c/pch/aaaa/bits/stdc++.h.gch',
  'pch: using key aaaaaaaaaaaa for acc.cpp',
]);
const USED = debug(['pch: using key aaaaaaaaaaaa for acc.cpp']);
const OTHER = debug([
  'pch: built key bbbbbbbbbbbb in 7000ms at /c/pch/bbbb/bits/stdc++.h.gch',
  'pch: using key bbbbbbbbbbbb for acc.cpp',
]);
const CLANG = debug([
  'pch: skipped, clang++ is not g++ (Debian clang version 14.0.6), normal compile: acc.cpp',
]);

describe('pchPathOf', () => {
  it('reads each path polyman logs', () => {
    expect(pchPathOf(OFF, 'acc.cpp').off).toBe(true);
    expect(pchPathOf(BUILT, 'acc.cpp')).toMatchObject({
      builtKey: 'aaaaaaaaaaaa',
      buildMs: 7400,
      usedKey: 'aaaaaaaaaaaa',
    });
    expect(pchPathOf(USED, 'acc.cpp')).toMatchObject({
      builtKey: null,
      usedKey: 'aaaaaaaaaaaa',
    });
    expect(pchPathOf(CLANG, 'acc.cpp').notGxx).toBe(true);
    expect(
      pchPathOf(debug(['cache: hit, no compile: acc.cpp']), 'acc.cpp').cacheHit
    ).toBe(true);
  });

  it('ignores lines about other sources and plain output', () => {
    const text = `compiling...\n${debug([
      'pch: using key cccccccccccc for gen.cpp',
      'pch: off, normal compile: gen.cpp',
    ])}\r\n`;
    const p = pchPathOf(text, 'acc.cpp');
    expect(p.usedKey).toBeNull();
    expect(p.off).toBe(false);
    expect(p.lines).toHaveLength(2);
    expect(describePath(p)).toBe('no PCH line for the solution');
  });
});

describe('the expected path of each run', () => {
  const judge = (logs, keys = {}) =>
    RUNS.map((r, i) => pathProblems(r, pchPathOf(logs[i], 'acc.cpp'), keys));

  it('passes the paths a working PCH takes', () => {
    expect(judge([OFF, BUILT, USED, OTHER, CLANG])).toEqual([
      [],
      [],
      [],
      [],
      [],
    ]);
  });

  it('fails no-pch when the PCH was used', () => {
    expect(judge([USED])[0]).not.toEqual([]);
  });

  it('fails pch-reuse when it builds again or uses another key', () => {
    const keys = {};
    pathProblems(run('pch-build'), pchPathOf(BUILT, 'acc.cpp'), keys);
    expect(
      pathProblems(run('pch-reuse'), pchPathOf(BUILT, 'acc.cpp'), keys)
    ).toContain('expected no build, built aaaaaaaaaaaa');
    expect(
      pathProblems(run('pch-reuse'), pchPathOf(OTHER, 'acc.cpp'), keys)
    ).not.toEqual([]);
  });

  it('fails other-flags when it gets the same key', () => {
    const keys = { first: 'aaaaaaaaaaaa' };
    expect(
      pathProblems(run('other-flags'), pchPathOf(BUILT, 'acc.cpp'), keys)
    ).toEqual(['expected a key other than aaaaaaaaaaaa']);
    expect(
      pathProblems(run('other-flags'), pchPathOf(USED, 'acc.cpp'), keys)
    ).not.toEqual([]);
  });

  it('fails clang when it does not skip', () => {
    expect(pathProblems(run('clang'), pchPathOf(USED, 'acc.cpp'), {})).toEqual([
      'expected "skipped, ... is not g++"',
      'clang must not use a PCH',
    ]);
  });

  it('fails any run the compile cache answered', () => {
    const hit = `${CLANG}\n${debug(['cache: hit, no compile: acc.cpp'])}`;
    expect(pathProblems(run('clang'), pchPathOf(hit, 'acc.cpp'), {})).toEqual([
      'the compile cache restored the binary, nothing was compiled',
    ]);
  });

  it('runs other-flags with flags and clang with clang', () => {
    expect(RUNS.map(r => r.name)).toEqual([
      'no-pch',
      'pch-build',
      'pch-reuse',
      'other-flags',
      'clang',
    ]);
    expect(run('no-pch').args).toEqual(['--no-cache']);
    expect(run('other-flags').flags).toEqual(['-O1']);
    expect(run('clang').clang).toBe(true);
    // the runner's clang 14 does not know the c++23 default
    expect(run('clang').cppStandard).toBe('c++20');
    expect(RUNS.filter(r => r.cppStandard).map(r => r.name)).toEqual(['clang']);
  });
});

describe('compareOutcomes', () => {
  const report = verdicts => ({
    ok: true,
    tests: verdicts.map((verdict, i) => ({
      testset: 'tests',
      index: i + 1,
      verdict,
      timeMs: 10 * i,
    })),
  });
  const reference = outcomeOf(report(['OK', 'OK']), {
    'a.txt': '1',
    'b.txt': '2',
  });

  it('accepts the same verdicts and outputs, whatever the timing', () => {
    const same = outcomeOf(
      { ...report(['OK', 'OK']), tests: report(['OK', 'OK']).tests.reverse() },
      { 'b.txt': '2', 'a.txt': '1' }
    );
    expect(compareOutcomes(reference, same)).toEqual([]);
  });

  it('reports a different verdict, output, missing or extra file', () => {
    expect(
      compareOutcomes(
        reference,
        outcomeOf(report(['OK', 'RE']), reference.outputs)
      )
    ).toHaveLength(1);
    expect(
      compareOutcomes(
        reference,
        outcomeOf(report(['OK', 'OK']), { 'a.txt': '9', 'c.txt': '3' })
      )
    ).toEqual([
      'output a.txt differs',
      'output b.txt missing',
      'extra output c.txt',
    ]);
  });

  it('reports a run that failed', () => {
    expect(compareOutcomes(reference, outcomeOf(null, {}))).toContain(
      'polyman run did not succeed'
    );
  });
});

describe('helpers', () => {
  it('finds the main solution', () => {
    expect(
      mainSolution({
        solutions: [
          { name: 'wa', tag: 'WA' },
          { name: 'main', tag: 'MA' },
        ],
      })
    ).toEqual({ name: 'main', tag: 'MA' });
    expect(mainSolution({})).toBeNull();
  });

  it('matches only a leading <bits/stdc++.h>, like src/helpers/pch.ts', () => {
    expect(
      startsWithBitsStdcpp('// main\n/* x */\n#include <bits/stdc++.h>\n')
    ).toBe(true);
    expect(
      startsWithBitsStdcpp('#include <vector>\n#include <bits/stdc++.h>')
    ).toBe(false);
  });

  it('parses its arguments', () => {
    expect(
      parseArgs(['--problem', 'sum-parity', '--clang', 'clang++-17', '--keep'])
    ).toMatchObject({ problem: 'sum-parity', clang: 'clang++-17', keep: true });
    expect(() => parseArgs(['--problem'])).toThrow('--problem needs a value');
    expect(() => parseArgs(['--nope'])).toThrow('Unknown argument: --nope');
  });
});
