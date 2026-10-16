import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configProblems, findProblems } from '../src/problems.ts';

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'problems-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const problemAt = (dir: string, config: object = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Config.json'), JSON.stringify(config));
};

describe('findProblems', () => {
  it('finds one problem at the root', () => {
    const root = fresh();
    problemAt(root);
    expect(findProblems(root)).toEqual([{ name: '.', dir: root }]);
  });

  it('finds a contest, zipped directly or inside one folder, in name order', () => {
    const a = fresh();
    problemAt(join(a, 'B'));
    problemAt(join(a, 'A'));
    expect(findProblems(a).map((p) => p.name)).toEqual(['A', 'B']);

    const b = fresh();
    problemAt(join(b, 'contest', 'A'));
    problemAt(join(b, 'contest', 'B'));
    expect(findProblems(b).map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('ignores hidden folders and finds nothing in an unrelated zip', () => {
    const root = fresh();
    problemAt(join(root, '.git'));
    mkdirSync(join(root, 'docs'));
    expect(findProblems(root)).toEqual([]);
  });
});

describe('configProblems', () => {
  const template = {
    solutions: [{ name: 'main', source: './solutions/acc.cpp', tag: 'MA' }],
    checker: { source: './checker/chk.cpp', testsFilePath: './checker/checker_tests.json' },
    statements: { english: { legend: './statements/english/legend.tex' } },
    testsets: [{ name: 'tests', generatorScript: { scriptFile: './generators/gen-script.txt' }, manualTests: [{ input: './manual/a.in' }] }],
  };

  it('accepts the paths of a normal problem', () => {
    const dir = fresh();
    problemAt(dir, template);
    expect(configProblems(dir)).toEqual([]);
  });

  it.each([
    ['a solution', { solutions: [{ name: 'x', source: '../../etc/passwd' }] }, 'Config.json.solutions[0].source'],
    ['an absolute statement', { statements: { english: { legend: '/proc/self/environ' } } }, 'Config.json.statements.english.legend'],
    ['a manual test', { testsets: [{ manualTests: [{ input: '../x.in' }] }] }, 'Config.json.testsets[0].manualTests[0].input'],
    ['a generator script', { testsets: [{ generatorScript: { scriptFile: '/etc/hosts' } }] }, 'scriptFile'],
    ['checker tests', { checker: { source: './c.cpp', testsFilePath: '../t.json' } }, 'testsFilePath'],
  ])('refuses %s outside the folder, naming where', (_what, config, where) => {
    const dir = fresh();
    problemAt(dir, config);
    const problems = configProblems(dir);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(where);
    expect(problems[0]).toContain('outside the problem folder');
  });

  it('refuses a path that leaves through a symlink already on disk', () => {
    const dir = fresh();
    problemAt(dir, { solutions: [{ source: './link/passwd' }] });
    symlinkSync('/etc', join(dir, 'link'));
    expect(configProblems(dir)[0]).toContain('outside the problem folder');
  });

  it('a standard checker must be a plain name, so it cannot point at any program', () => {
    const ok = fresh();
    problemAt(ok, { checker: { isStandard: true, source: 'wcmp.cpp' } });
    expect(configProblems(ok)).toEqual([]);

    for (const source of ['../../../bin/sh', '/bin/sh', '..', 'a/b']) {
      const bad = fresh();
      problemAt(bad, { checker: { isStandard: true, source } });
      expect(configProblems(bad)[0]).toContain('must be a plain name');
    }
  });

  it('reports a broken Config.json instead of throwing', () => {
    const dir = fresh();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Config.json'), '{ nope');
    expect(configProblems(dir)[0]).toContain('not valid JSON');
  });
});
