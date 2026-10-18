import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addedLines, addedLinesOf, changedFiles, loadIncidents, securityFindings } from '../src/inputs.ts';

describe('addedLines', () => {
  it('reads the new side of every hunk header in a -U0 diff', () => {
    const diff = [
      'diff --git a/src/helpers/utils.ts b/src/helpers/utils.ts',
      '--- a/src/helpers/utils.ts',
      '+++ b/src/helpers/utils.ts',
      '@@ -5,0 +6 @@ import fs',
      '+import { spawnSync } from "child_process";',
      '@@ -505,0 +507,47 @@ export function readFirstLine',
      '@@ -531 +579 @@ export function getCompiledCommandToRun',
      'diff --git a/tests/a.test.ts b/tests/a.test.ts',
      '--- a/tests/a.test.ts',
      '+++ b/tests/a.test.ts',
      '@@ -10,3 +9,0 @@ describe',
    ].join('\n');
    const lines = addedLines(diff);
    expect(lines.get('src/helpers/utils.ts')).toEqual([[6, 6], [507, 553], [579, 579]]);
    // only deletions: no added lines
    expect(lines.get('tests/a.test.ts')).toEqual([]);
  });

  it('leaves out deleted files and paths git quotes, so those count as unknown', () => {
    const diff = [
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      'diff --git "a/odd\\tname.ts" "b/odd\\tname.ts"',
      '--- "a/odd\\tname.ts"',
      '+++ "b/odd\\tname.ts"',
      '@@ -0,0 +1 @@',
    ].join('\n');
    expect([...addedLines(diff).keys()]).toEqual([]);
  });

  it('reads "+++" as a file name only in a header: an added line "++ x" in a hunk is content (a gate bypass otherwise)', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1,0 +2 @@ a',
      '+++ b/evil.ts',
      '@@ -7 +8 @@ f',
      '+G',
    ].join('\n');
    const lines = addedLines(diff);
    expect(lines.get('a.ts')).toEqual([
      [2, 2],
      [8, 8],
    ]);
    expect(lines.has('evil.ts')).toBe(false);
  });

  it('drops the tab git puts after a name with a space', () => {
    const diff = ['diff --git a/sp ace.ts b/sp ace.ts', '--- a/sp ace.ts\t', '+++ b/sp ace.ts\t', '@@ -1 +1,2 @@'].join('\n');
    expect(addedLines(diff).get('sp ace.ts')).toEqual([[1, 2]]);
  });
});

describe('changedFiles on a real repository', () => {
  it("gives each path as the scanners do (spaces, non-ASCII) with its added lines, whatever the user's git config", () => {
    const dir = mkdtempSync(join(tmpdir(), 'changed-'));
    const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q');
    // configs that would change the diff's prefixes or quoting
    git('config', 'diff.noprefix', 'true');
    git('config', 'diff.mnemonicPrefix', 'true');
    for (const name of ['a b.ts', 'é.ts', 'gone ü.ts']) writeFileSync(join(dir, name), 'one\ntwo\nthree\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'base');
    const base = git('rev-parse', 'HEAD');
    for (const name of ['a b.ts', 'é.ts']) writeFileSync(join(dir, name), 'one\ntwo\nnew\nthree\n');
    writeFileSync(join(dir, 'c.ts'), '++ looks like a header\n');
    git('rm', '-q', 'gone ü.ts');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@x', 'commit', '-qm', 'change');
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const files = changedFiles(base);
      expect(files.map((f) => [f.path, f.status, f.addedLines])).toEqual([
        ['a b.ts', 'M', [[3, 3]]],
        ['c.ts', 'A', [[1, 1]]],
        ['gone ü.ts', 'D', undefined],
        ['é.ts', 'M', [[3, 3]]],
      ]);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('addedLinesOf', () => {
  it("falls back to no line ranges (count by file) when git fails or its output overflows, and says so", () => {
    const overflow = Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' });
    const failed = Object.assign(new Error('git exited 128'), { status: 128 });
    for (const err of [overflow, failed]) {
      expect(addedLinesOf(() => { throw err; }, 'a...b').size).toBe(0);
    }
  });

  it('still throws a bug of its own rather than hiding it', () => {
    expect(() => addedLinesOf(() => { throw new TypeError('oops'); }, 'a...b')).toThrow('oops');
  });
});

describe('securityFindings', () => {
  it('keeps the first and last line of a finding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'report-'));
    writeFileSync(
      join(dir, 'gl-sast-report.json'),
      JSON.stringify({ scan: { type: 'sast' }, vulnerabilities: [{ name: 'Path Traversal', severity: 'Medium', location: { file: 'src/a.ts', start_line: 500, end_line: 506 } }] }),
    );
    expect(securityFindings(dir).findings).toEqual([{ scanner: 'sast', severity: 'Medium', name: 'Path Traversal', file: 'src/a.ts', line: 500, endLine: 506 }]);
  });
});

describe('loadIncidents', () => {
  it('keeps well-formed lessons and skips one with the wrong shape instead of failing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
    const good = { paths: ['service/src/app.ts'], weight: 25, reason: 'production check failed', ref: '#70' };
    writeFileSync(join(dir, 'incidents.json'), JSON.stringify([good, { files: ['x.ts'], weight: 25 }, { paths: ['y.ts'], weight: '25' }]));
    expect(loadIncidents(join(dir, 'incidents.json'))).toEqual([good]);
  });

  it('reads null or a non-list as no lessons, and still filters a wrapped list', () => {
    const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
    const good = { paths: ['a.ts'], weight: 25, reason: 'r' };
    const read = (value: unknown) => {
      writeFileSync(join(dir, 'incidents.json'), JSON.stringify(value));
      return loadIncidents(join(dir, 'incidents.json'));
    };
    expect(read(null)).toEqual([]);
    expect(read({ incidents: {} })).toEqual([]);
    expect(read({ incidents: [good, { files: ['b.ts'] }] })).toEqual([good]);
  });

  it('reads an empty list and a missing file as no lessons', () => {
    const dir = mkdtempSync(join(tmpdir(), 'incidents-'));
    writeFileSync(join(dir, 'incidents.json'), '[]');
    expect(loadIncidents(join(dir, 'incidents.json'))).toEqual([]);
    expect(loadIncidents(join(dir, 'none.json'))).toEqual([]);
  });
});
