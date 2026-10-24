import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Pins the corpus:pch job (corpus/corpus.gitlab-ci.yml, #113): it runs
// corpus/pch-check.mjs with clang installed, on the same pipelines as the
// other corpus jobs. Read as text, like corpus-gate.test.ts.
const file = readFileSync(
  resolve(__dirname, '../../corpus/corpus.gitlab-ci.yml'),
  'utf8'
).replace(/\r\n/g, '\n');
const lines = file.split('\n');

/** One top-level job: from its name line to the next top-level key. */
function job(name: string): string {
  const start = lines.findIndex(l => l === `${name}:`);
  expect(start, `job ${name} exists`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(l => /^\S/.test(l) && !l.startsWith('#'));
  return rest
    .slice(0, end < 0 ? undefined : end)
    .filter(l => !l.trim().startsWith('#'))
    .join('\n');
}

describe('corpus:pch', () => {
  const pch = job('corpus:pch');

  it('runs the PCH check after a build, with clang installed', () => {
    const script = pch.split('\n').filter(l => /^ {4}- /.test(l));
    expect(script).toEqual([
      '    - apt-get update -qq && apt-get install -y -qq clang >/dev/null',
      '    - npm run build',
      '    - node corpus/pch-check.mjs',
    ]);
  });

  it('takes the .corpus rules: default branch, and src/ or corpus/ changes', () => {
    expect(pch).toMatch(/^ {2}extends: \.corpus$/m);
    expect(pch).not.toMatch(/^ {2}rules:/m);
    const base = job('.corpus');
    expect(base).toContain('- if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
    // corpus/**/* covers this CI file and the script
    expect(base).toMatch(/changes: \[src\/\*\*\/\*, corpus\/\*\*\/\*/);
  });

  it('is blocking', () => {
    expect(pch).not.toMatch(/allow_failure/);
  });
});
