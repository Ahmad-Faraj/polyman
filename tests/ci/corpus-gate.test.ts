import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Pins which corpus lanes block a merge request (corpus/corpus.gitlab-ci.yml):
// `corpus` and the node-20.19 toolchain lane block, the no-python-alias lane is
// reported, not yet blocking. Read as text, like survivors-rules.test.ts.
// corpus/corpus.gitlab-ci.yml was removed with the GitLab CI; read it only if
// it is there so the skipped suite below still loads.
const ciFile = resolve(__dirname, '../../corpus/corpus.gitlab-ci.yml');
const file = (existsSync(ciFile) ? readFileSync(ciFile, 'utf8') : '').replace(
  /\r\n/g,
  '\n'
);
const lines = file.split('\n');

/** One top-level job: from its name line to the next top-level key. */
function job(name: string): string {
  if (file === '') return ''; // file removed, suite skipped
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

/** Every `changes:` list in a block, inline `[a, b]` or block style `- a`. */
function changesOf(block: string): string[][] {
  const src = code(block).split('\n');
  const lists: string[][] = [];
  src.forEach((line, i) => {
    const m = /^(\s*(?:- )?)changes:\s*(.*)$/.exec(line);
    if (!m) return;
    const inline = /^\[(.*)\]$/.exec(m[2].trim());
    if (inline) {
      lists.push(
        inline[1]
          .split(',')
          .map(x => x.trim())
          .filter(Boolean)
      );
      return;
    }
    // Block list: the dashes sit at the key's column or deeper.
    const keyCol = m[1].length;
    const items: string[] = [];
    for (const next of src.slice(i + 1)) {
      const item = /^(\s*)- (.*)$/.exec(next);
      if (!item || item[1].length < keyCol) break;
      items.push(item[2].trim());
    }
    lists.push(items);
  });
  return lists;
}

// re-pointed to .github/workflows in the CI commit
describe.skip('corpus lanes on merge requests', () => {
  it('corpus is blocking', () => {
    expect(code(job('corpus'))).not.toMatch(/allow_failure/);
    expect(code(job('.corpus'))).not.toMatch(/allow_failure/);
  });

  const toolchain = code(job('corpus:toolchain'));
  // The job's own `rules:` list (two-space key, four-space entries).
  const toolchainRules = (toolchain.match(/^ {2}rules:\n((?: {4}.*\n?)+)/m) ??
    [])[1]?.replace(/\n$/, '');

  it('has no job-level allow_failure on the toolchain lanes', () => {
    expect(toolchain).not.toMatch(/^ {2}allow_failure:/m);
  });

  it('lets only no-python-alias fail, on the same pipelines as .corpus', () => {
    expect(toolchainRules, 'toolchain has rules').toBeTruthy();
    const rules = toolchainRules.split(/\n(?= {4}- )/);
    const allowed = rules.filter(r => /allow_failure: true/.test(r));
    expect(allowed).toHaveLength(2);
    for (const rule of allowed) {
      expect(rule).toContain('$LANE == "no-python-alias"');
    }
    expect(toolchain).not.toMatch(/node-20\.19"/);
    expect(allowed[0]).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
    const lane = changesOf(allowed[1]);
    const base = changesOf(job('.corpus'));
    expect(lane).toHaveLength(1);
    expect(base).toHaveLength(1);
    expect(lane[0], 'toolchain changes list is not empty').not.toHaveLength(0);
    expect(base[0], '.corpus changes list is not empty').not.toHaveLength(0);
    expect(lane).toEqual(base);
    expect(rules).toHaveLength(3);
    // Order matters: the first matching rule wins, so the allow_failure rules
    // must come before the .corpus rules, which would make the lane blocking.
    expect(rules[0]).toContain('$LANE == "no-python-alias"');
    expect(rules[0]).toContain('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH');
    expect(rules[0]).toContain('allow_failure: true');
    expect(rules[1]).toContain('$LANE == "no-python-alias"');
    expect(rules[1]).toMatch(/changes:/);
    expect(rules[1]).toContain('allow_failure: true');
    expect(rules[2]).toBe('    - !reference [.corpus, rules]');
  });

  it('keeps both lanes in the matrix', () => {
    expect(toolchain).toMatch(/- LANE: node-20\.19$/m);
    expect(toolchain).toMatch(/- LANE: no-python-alias$/m);
  });
});
