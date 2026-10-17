import { describe, expect, it } from 'vitest';
import { addedLines } from '../src/inputs.ts';

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
    const diff = ['--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '--- "a/odd\\tname.ts"', '+++ "b/odd\\tname.ts"', '@@ -0,0 +1 @@'].join('\n');
    expect([...addedLines(diff).keys()]).toEqual([]);
  });
});
