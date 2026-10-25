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

const METRICS =
  'mutation_score 50\nmutants_helpers_solution_ts 2\n' +
  'mutants_survived_helpers_solution_ts 1\n' +
  'mutants_untested_helpers_solution_ts 0\n';
const OUTSIDE = 'path outside the working directory';

const run = (...args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: work,
    encoding: 'utf8',
  });

describe('mutation-metrics.mjs path guard', () => {
  it('writes the metrics for paths inside the working directory', () => {
    const r = run('m.json', 'metrics.txt');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(work, 'metrics.txt'), 'utf8')).toBe(
      METRICS
    );
  });

  it('runs with the arguments the corpus:mutation job passes', () => {
    fs.mkdirSync(path.join(work, 'corpus/out/mutation'), { recursive: true });
    fs.writeFileSync(
      path.join(work, 'corpus/out/mutation/mutation.json'),
      REPORT
    );
    const r = run(
      'corpus/out/mutation/mutation.json',
      'corpus/out/mutation-metrics.txt'
    );
    expect(r.status).toBe(0);
    expect(
      fs.readFileSync(
        path.join(work, 'corpus/out/mutation-metrics.txt'),
        'utf8'
      )
    ).toBe(METRICS);
  });

  it('accepts absolute paths inside the working directory', () => {
    const real = fs.realpathSync(work);
    const r = run(path.join(real, 'm.json'), path.join(real, 'abs.txt'));
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(work, 'abs.txt'), 'utf8')).toBe(METRICS);
  });

  it('accepts symlinks that stay inside the working directory', () => {
    fs.mkdirSync(path.join(work, 'sub'));
    fs.symlinkSync(path.join(work, 'sub'), path.join(work, 'sub-link'));
    fs.symlinkSync('m.json', path.join(work, 'in.json'));
    const r = run('in.json', 'sub-link/metrics.txt');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(work, 'sub/metrics.txt'), 'utf8')).toBe(
      METRICS
    );
  });

  it('follows a dangling symlink that points inside the working directory', () => {
    fs.symlinkSync('target.txt', path.join(work, 'outlink.txt'));
    const r = run('m.json', 'outlink.txt');
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(work, 'target.txt'), 'utf8')).toBe(
      METRICS
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
    const r = run('../work-evil/m.json', 'metrics.txt');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${OUTSIDE}: ../work-evil/m.json`);
  });

  it('refuses an output outside the working directory', () => {
    const r = run('m.json', path.join(outside, 'metrics.txt'));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(OUTSIDE);
    expect(fs.existsSync(path.join(outside, 'metrics.txt'))).toBe(false);
  });

  it('refuses a symlink inside the working directory that points outside it', () => {
    fs.symlinkSync(outside, path.join(work, 'link'));
    const input = run('link/m.json', 'metrics.txt');
    expect(input.status).toBe(1);
    expect(input.stderr).toContain(`${OUTSIDE}: link/m.json`);
    const r = run('m.json', 'link/metrics.txt');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${OUTSIDE}: link/metrics.txt`);
    expect(fs.existsSync(path.join(outside, 'metrics.txt'))).toBe(false);
  });

  it('refuses a dangling symlink that points outside the working directory', () => {
    fs.symlinkSync(path.join(outside, 'new.txt'), path.join(work, 'dangling'));
    const r = run('m.json', 'dangling');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${OUTSIDE}: dangling`);
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });
});
