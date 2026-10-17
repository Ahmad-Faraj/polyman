import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addedLines, securityFindings } from '../src/inputs.ts';

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

  it("doesn't read an added line that starts with '++ ' as a file header", () => {
    // a.ts gains "++ evil" after line 1 and changes line 7: the content line prints as "+++ evil"
    const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1,0 +2 @@ a', '+++ evil', '@@ -7 +8 @@ f', '-g', '+G'].join('\n');
    const lines = addedLines(diff);
    expect(lines.get('a.ts')).toEqual([[2, 2], [8, 8]]);
    expect([...lines.keys()]).toEqual(['a.ts']);
  });

  it('drops the tab git puts after a path with a space', () => {
    const diff = ['diff --git a/sp ace.ts b/sp ace.ts', '--- a/sp ace.ts\t', '+++ b/sp ace.ts\t', '@@ -0,0 +1,2 @@'].join('\n');
    expect(addedLines(diff).get('sp ace.ts')).toEqual([[1, 2]]);
  });

  it('leaves out deleted files and paths git still quotes, so those count as unknown', () => {
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
});

describe('securityFindings', () => {
  it('keeps the first and last line of each finding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'findings-'));
    const vulnerabilities = [
      { name: 'span', severity: 'Medium', location: { file: 'src/a.ts', start_line: 500, end_line: 510 } },
      { name: 'one line', severity: 'High', location: { file: 'src/a.ts', start_line: 7 } },
      { name: 'no line', severity: 'Low', location: { file: 'package.json' } },
    ];
    writeFileSync(join(dir, 'gl-sast-report.json'), JSON.stringify({ scan: { type: 'sast' }, vulnerabilities }));
    const { findings } = securityFindings(dir);
    expect(findings.map((f) => [f.name, f.line, f.endLine])).toEqual([
      ['span', 500, 510],
      ['one line', 7, undefined],
      ['no line', undefined, undefined],
    ]);
  });
});
