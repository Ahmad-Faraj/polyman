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
      'mutation_score 50\nmutants_helpers_solution_ts 2\n' +
        'mutants_survived_helpers_solution_ts 1\n' +
        'mutants_untested_helpers_solution_ts 0\n'
    );
  });

  it('refuses a sibling folder whose name starts like the working directory', () => {
    const r = run('../work-evil/m.json', 'metrics.txt');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      'path outside the working directory: ../work-evil/m.json'
    );
  });

  it('refuses an output outside the working directory', () => {
    const r = run('m.json', path.join(outside, 'metrics.txt'));
    expect(r.status).toBe(1);
    expect(fs.existsSync(path.join(outside, 'metrics.txt'))).toBe(false);
  });

  it('refuses a symlink inside the working directory that points outside it', () => {
    fs.symlinkSync(outside, path.join(work, 'link'));
    expect(run('link/m.json', 'metrics.txt').status).toBe(1);
    const r = run('m.json', 'link/metrics.txt');
    expect(r.status).toBe(1);
    expect(fs.existsSync(path.join(outside, 'metrics.txt'))).toBe(false);
  });

  it('refuses a dangling symlink as the output', () => {
    fs.symlinkSync(path.join(outside, 'new.txt'), path.join(work, 'dangling'));
    const r = run('m.json', 'dangling');
    expect(r.status).toBe(1);
    expect(fs.existsSync(path.join(outside, 'new.txt'))).toBe(false);
  });
});
