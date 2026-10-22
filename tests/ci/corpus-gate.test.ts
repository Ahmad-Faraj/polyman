import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Pins which corpus lanes block a merge request (corpus/corpus.gitlab-ci.yml):
// `corpus` and the node-20.19 toolchain lane block, the no-python-alias lane is
// reported, not yet blocking. Read as text, like survivors-rules.test.ts.
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
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

const code = (block: string) =>
  block
    .split('\n')
    .filter(l => !l.trim().startsWith('#'))
    .join('\n');

const changesOf = (block: string) =>
  [...code(block).matchAll(/changes: (\[.*\])/g)].map(m => m[1]);

describe('corpus lanes on merge requests', () => {
  it('corpus is blocking', () => {
    expect(code(job('corpus'))).not.toMatch(/allow_failure/);
    expect(code(job('.corpus'))).not.toMatch(/allow_failure/);
  });

  const toolchain = code(job('corpus:toolchain'));

  it('has no job-level allow_failure on the toolchain lanes', () => {
    expect(toolchain).not.toMatch(/^ {2}allow_failure:/m);
  });

  it('lets only no-python-alias fail, on the same pipelines as .corpus', () => {
    const allowed = toolchain
      .split(/\n(?= {4}- )/)
      .filter(r => /allow_failure: true/.test(r));
    expect(allowed).toHaveLength(2);
    for (const rule of allowed) {
      expect(rule).toContain('$LANE == "no-python-alias"');
    }
    expect(toolchain).not.toMatch(/node-20\.19"/);
    expect(allowed[0]).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
    expect(changesOf(allowed[1])).toEqual(changesOf(job('.corpus')));
    expect(toolchain).toMatch(/^ {4}- !reference \[\.corpus, rules\]$/m);
  });

  it('keeps both lanes in the matrix', () => {
    expect(toolchain).toMatch(/- LANE: node-20\.19$/m);
    expect(toolchain).toMatch(/- LANE: no-python-alias$/m);
  });
});
