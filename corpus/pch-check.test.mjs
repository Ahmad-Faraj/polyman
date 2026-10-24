import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  compareOutcomes,
  describePath,
  exitCodeOf,
  hashTree,
  judgeResult,
  mainSolution,
  outcomeOf,
  parseArgs,
  pathProblems,
  pchPathOf,
  pickProblem,
  prepareRunDir,
  rewriteConfig,
  RUNS,
  runMain,
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
// the lines of src/helpers/utils.ts and pch.ts when a compile fails with the PCH
const RETRIED = debug([
  'pch: compile failed with the PCH, retrying without it',
]);
const MARKED = debug(['pch: key aaaaaaaaaaaa marked unsupported']);
const MARKED_SKIP = debug([
  'pch: key aaaaaaaaaaaa marked unsupported, not used',
]);

const temps = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pch-check-test-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

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

  it('reads a compile that failed with the PCH', () => {
    const p = pchPathOf(`${BUILT}\n${RETRIED}\n${MARKED}`, 'acc.cpp');
    expect(p).toMatchObject({
      usedKey: 'aaaaaaaaaaaa',
      retried: true,
      markedUnsupported: 'aaaaaaaaaaaa',
    });
    expect(describePath(p)).toBe(
      'compile failed with the PCH, retried without it'
    );
    expect(pchPathOf(MARKED_SKIP, 'acc.cpp')).toMatchObject({
      retried: false,
      markedUnsupported: 'aaaaaaaaaaaa',
    });
    expect(pchPathOf(BUILT, 'acc.cpp')).toMatchObject({
      retried: false,
      markedUnsupported: null,
    });
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

  it('fails every run when a compile was retried without the PCH', () => {
    const logs = [OFF, BUILT, USED, OTHER, CLANG].map(l => `${l}\n${RETRIED}`);
    for (const problems of judge(logs))
      expect(problems).toContain(
        'a compile failed with the PCH and was retried without it'
      );
  });

  it('fails every run when a PCH key was marked unsupported', () => {
    for (const marked of [MARKED, MARKED_SKIP]) {
      const logs = [OFF, BUILT, USED, OTHER, CLANG].map(l => `${l}\n${marked}`);
      for (const problems of judge(logs))
        expect(problems).toContain(
          'the PCH key aaaaaaaaaaaa was marked unsupported'
        );
    }
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

describe('judgeResult', () => {
  const stdout = JSON.stringify({
    ok: true,
    tests: [{ testset: 'tests', index: 1, verdict: 'OK', timeMs: 3 }],
  });

  it('passes a run that exited 0 with tests', () => {
    const judged = judgeResult({ status: 0, stdout }, { 'a.txt': '1' });
    expect(judged.problems).toEqual([]);
    expect(judged.outcome).toEqual({
      ok: true,
      tests: ['tests#1:OK'],
      outputs: { 'a.txt': '1' },
    });
  });

  it('fails a run that exited non-zero, even with a report', () => {
    expect(judgeResult({ status: 1, stdout }, {}).problems).toEqual([
      'polyman run exited 1',
    ]);
    expect(judgeResult({ status: null, stdout: '' }, {}).problems).toContain(
      'polyman run exited null'
    );
  });

  it('fails a run where no test ran', () => {
    const empty = JSON.stringify({ ok: true, tests: [] });
    expect(judgeResult({ status: 0, stdout: empty }, {}).problems).toEqual([
      'no test ran',
    ]);
  });

  it('fails a run whose stdout is not JSON', () => {
    const judged = judgeResult({ status: 0, stdout: 'Compiling...\n' }, {});
    expect(judged.outcome.ok).toBe(false);
    expect(judged.problems).toEqual(['polyman run exited 0', 'no test ran']);
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

describe('the run folders', () => {
  const config = {
    name: 'p',
    cppStandard: 'c++23',
    compiler: { cxx: 'g++', flags: ['-O2'] },
  };

  it('rewrites only what the run sets', () => {
    expect(rewriteConfig(config, { flags: ['-O1'] })).toEqual({
      ...config,
      compiler: { cxx: 'g++', flags: ['-O1'] },
    });
    expect(rewriteConfig(config, { cppStandard: 'c++20' })).toEqual({
      ...config,
      cppStandard: 'c++20',
    });
    expect(rewriteConfig({ name: 'p' }, { flags: ['-O1'] })).toEqual({
      name: 'p',
      compiler: { flags: ['-O1'] },
    });
    expect(rewriteConfig(config, { name: 'no-pch' })).toBeNull();
    // the problem's own config is left alone
    expect(config.compiler.flags).toEqual(['-O2']);
  });

  it('copies the problem and writes the config of each run', () => {
    const base = path.join(tempDir(), 'base');
    fs.mkdirSync(path.join(base, 'tests'), { recursive: true });
    const text = `${JSON.stringify(config)}\n`;
    fs.writeFileSync(path.join(base, 'Config.json'), text);
    fs.writeFileSync(path.join(base, 'tests', 'test1.txt'), '1 2\n');
    const read = dir =>
      JSON.parse(fs.readFileSync(path.join(dir, 'Config.json'), 'utf8'));

    for (const r of RUNS) prepareRunDir(base, path.join(base, '..', r.name), r);
    const at = name => path.join(base, '..', name);
    expect(
      fs.readFileSync(path.join(at('no-pch'), 'Config.json'), 'utf8')
    ).toBe(text);
    expect(read(at('other-flags')).compiler.flags).toEqual(['-O1']);
    expect(read(at('other-flags')).cppStandard).toBe('c++23');
    expect(read(at('clang')).cppStandard).toBe('c++20');
    expect(read(at('clang')).compiler.flags).toEqual(['-O2']);
    expect(hashTree(at('clang'))).toHaveProperty(['tests/test1.txt']);
  });

  it('hashes every file under a folder', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b');
    const first = hashTree(dir);
    expect(Object.keys(first).sort()).toEqual(['a.txt', 'sub/b.txt']);
    expect(hashTree(dir)).toEqual(first);

    fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'c');
    const changed = hashTree(dir);
    expect(changed['a.txt']).toBe(first['a.txt']);
    expect(changed['sub/b.txt']).not.toBe(first['sub/b.txt']);
    expect(hashTree(path.join(dir, 'missing'))).toEqual({});
  });
});

describe('exit codes', () => {
  it('gives 0 when every run passed and 1 when one did not', () => {
    expect(exitCodeOf([])).toBe(0);
    expect(exitCodeOf(['pch-build: no test ran'])).toBe(1);
  });

  it('gives 2 on a setup error', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(exitCodeOf([], true)).toBe(2);
      expect(runMain(['--nope'])).toBe(2);
      expect(error).toHaveBeenCalledWith('Unknown argument: --nope');
    } finally {
      error.mockRestore();
    }
  });
});

describe('pickProblem', () => {
  const problem = (root, name, main) => {
    const dir = path.join(root, name);
    fs.mkdirSync(path.join(dir, 'solutions'), { recursive: true });
    const solutions = main
      ? [{ name: 'main', source: `solutions/${main.file}`, tag: 'MA' }]
      : [];
    fs.writeFileSync(
      path.join(dir, 'Config.json'),
      JSON.stringify({ solutions })
    );
    if (main)
      fs.writeFileSync(path.join(dir, 'solutions', main.file), main.text);
  };
  const BITS = '#include <bits/stdc++.h>\nint main() {}\n';

  it('takes the first problem by name that starts with bits/stdc++.h', () => {
    const root = tempDir();
    problem(root, 'a-iostream', {
      file: 'acc.cpp',
      text: '#include <iostream>',
    });
    problem(root, 'b-python', { file: 'acc.py', text: 'print(1)' });
    problem(root, 'c-none', null);
    problem(root, 'e-bits', { file: 'acc.cpp', text: BITS });
    problem(root, 'd-bits', { file: 'acc.cpp', text: `// x\n${BITS}` });
    fs.writeFileSync(path.join(root, 'README.md'), 'not a problem');
    expect(pickProblem(null, root)).toMatchObject({
      name: 'd-bits',
      dir: path.join(root, 'd-bits'),
      main: { name: 'main', source: 'solutions/acc.cpp' },
    });
  });

  it('honors --problem', () => {
    const root = tempDir();
    problem(root, 'a-bits', { file: 'acc.cpp', text: BITS });
    problem(root, 'b-bits', { file: 'acc.cpp', text: BITS });
    expect(pickProblem('b-bits', root).name).toBe('b-bits');
  });

  it('errors clearly when no problem fits or the name is unknown', () => {
    const root = tempDir();
    problem(root, 'a-iostream', {
      file: 'acc.cpp',
      text: '#include <iostream>',
    });
    expect(() => pickProblem(null, root)).toThrow(
      'no corpus problem has a main solution that starts with #include <bits/stdc++.h>'
    );
    expect(() => pickProblem('a-iostream', root)).toThrow(
      'a-iostream: its main solution does not start with #include <bits/stdc++.h>'
    );
    expect(() => pickProblem('nope', root)).toThrow('no corpus problem nope');
  });
});
