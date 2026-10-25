import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(
  new URL('./mutation-metrics.mjs', import.meta.url)
);
const REPORT = JSON.stringify({
  files: {
    'src/helpers/solution.ts': {
      mutants: [{ status: 'Killed' }, { status: 'Survived' }],
    },
  },
});

let root;
let work;
let outside;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-metrics-'));
  work = path.join(root, 'work');
  outside = path.join(root, 'work-evil');
  fs.mkdirSync(work);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(work, 'm.json'), REPORT);
  fs.writeFileSync(path.join(outside, 'm.json'), REPORT);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const SUMMARY = [
  '## Mutation score: 50%',
  '',
  '1 of 2 mutants caught by the unit tests (Killed or Timeout).',
  '',
  '| File | Mutants | Caught | Survived | No coverage |',
  '| --- | ---: | ---: | ---: | ---: |',
  '| `src/helpers/solution.ts` | 2 | 1 | 1 | 0 |',
  '',
  '### Not caught (1)',
  '',
  '- Survived #? `src/helpers/solution.ts` mutant: (no replacement)',
  '',
].join('\n');
const OUTSIDE = 'path outside the working directory';

const run = (...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: work,
    encoding: 'utf8',
  });

describe('mutation-metrics.mjs summary', () => {
  const mutant = (id, status, extra = {}) => ({
    id: String(id),
    status,
    mutatorName: 'ConditionalExpression',
    replacement: 'true',
    location: { start: { line: id, column: 3 }, end: { line: id, column: 9 } },
    ...extra,
  });
  const write = files =>
    fs.writeFileSync(path.join(work, 'r.json'), JSON.stringify({ files }));
  const summary = () => fs.readFileSync(path.join(work, 's.md'), 'utf8');

  it('scores timeouts as caught and lists every survivor with its place', () => {
    write({
      'src/helpers/solution.ts': {
        mutants: [
          mutant(1, 'Killed'),
          mutant(2, 'Timeout'),
          mutant(3, 'Survived', { replacement: 'a `b`\n c' }),
          mutant(4, 'NoCoverage'),
          mutant(5, 'CompileError'),
        ],
      },
    });
    expect(run('r.json', 's.md').status).toBe(0);
    const text = summary();
    expect(text).toContain('## Mutation score: 50%');
    expect(text).toContain('2 of 4 mutants caught');
    expect(text).toContain('| `src/helpers/solution.ts` | 4 | 2 | 1 | 1 |');
    expect(text).toContain(
      "- Survived #3 `src/helpers/solution.ts:3:3` ConditionalExpression: `a 'b' c`"
    );
    expect(text).toContain(
      '- NoCoverage #4 `src/helpers/solution.ts:4:3` ConditionalExpression: `true`'
    );
    expect(text).not.toContain('#5');
  });

  it('caps the list so the run summary stays small', () => {
    write({
      'src/a.ts': {
        mutants: Array.from({ length: 205 }, (_, i) =>
          mutant(i + 1, 'Survived')
        ),
      },
    });
    expect(run('r.json', 's.md').status).toBe(0);
    const text = summary();
    expect(text).toContain('### Not caught (205)');
    expect(text.match(/^- Survived/gm)).toHaveLength(200);
    expect(text).toContain('- and 5 more: see the mutation report artifact');
  });

  it('scores an empty report 0', () => {
    write({});
    expect(run('r.json', 's.md').status).toBe(0);
    expect(summary()).toContain('## Mutation score: 0%');
    expect(summary()).not.toContain('Not caught');
  });
});

describe('mutation-metrics.mjs path guard', () => {
  it('writes the summary for paths inside the working directory', () => {
    const r = run('m.json', 'summary.md');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(work, 'summary.md'), 'utf8')).toBe(
      SUMMARY
    );
  });

  it('runs with the arguments the mutation workflow passes', () => {
    fs.mkdirSync(path.join(work, 'corpus/out/mutation'), { recursive: true });
    fs.writeFileSync(
      path.join(work, 'corpus/out/mutation/mutation.json'),
      REPORT
    );
    const r = run(
      'corpus/out/mutation/mutation.json',
      'corpus/out/mutation-summary.md'
    );
    expect(r.status).toBe(0);
    expect(
      fs.readFileSync(path.join(work, 'corpus/out/mutation-summary.md'), 'utf8')
    ).toBe(SUMMARY);
  });

  it('accepts absolute paths inside the working directory', () => {
    const real = fs.realpathSync(work);
    const r = run(path.join(real, 'm.json'), path.join(real, 'abs.txt'));
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(work, 'abs.txt'), 'utf8')).toBe(SUMMARY);
  });

  it('accepts symlinks that stay inside the working directory', () => {
    fs.mkdirSync(path.join(work, 'sub'));
    fs.symlinkSync(path.join(work, 'sub'), path.join(work, 'sub-link'));
    fs.symlinkSync('m.json', path.join(work, 'in.json'));
    const r = run('in.json', 'sub-link/summary.md');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(work, 'sub/summary.md'), 'utf8')).toBe(
      SUMMARY
    );
  });

  it('follows a dangling symlink that points inside the working directory', () => {
    fs.symlinkSync('target.txt', path.join(work, 'outlink.txt'));
    const r = run('m.json', 'outlink.txt');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(work, 'target.txt'), 'utf8')).toBe(
      SUMMARY
    );
  });

  it('refuses a symlink loop with its own message', () => {
    fs.symlinkSync('b', path.join(work, 'a'));
    fs.symlinkSync('a', path.join(work, 'b'));
    const r = run('m.json', 'a');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot resolve a: ELOOP');
  });

  it('refuses a sibling folder whose name starts like the working directory', () => {
    const r = run('../work-evil/m.json', 'summary.md');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${OUTSIDE}: ../work-evil/m.json`);
  });

  it('refuses an output outside the working directory', () => {
    const r = run('m.json', path.join(outside, 'summary.md'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(OUTSIDE);
    expect(fs.existsSync(path.join(outside, 'summary.md'))).toBe(false);
  });

  it('refuses a symlink inside the working directory that points outside it', () => {
    fs.symlinkSync(outside, path.join(work, 'link'));
    const input = run('link/m.json', 'summary.md');
    expect(input.status).toBe(1);
    expect(input.stderr).toContain(`${OUTSIDE}: link/m.json`);
    const r = run('m.json', 'link/summary.md');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${OUTSIDE}: link/summary.md`);
    expect(fs.existsSync(path.join(outside, 'summary.md'))).toBe(false);
  });

  it('refuses a dangling symlink that points outside the working directory', () => {
    fs.symlinkSync(path.join(outside, 'new.txt'), path.join(work, 'dangling'));
    const r = run('m.json', 'dangling');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${OUTSIDE}: dangling`);
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });
});
