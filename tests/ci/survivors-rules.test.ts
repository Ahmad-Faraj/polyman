import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Pins the rules of the survivors jobs in corpus/corpus.gitlab-ci.yml: a merge to the
// default branch runs them only when an input changed; non-push pipelines always run
// them. Neither js-yaml nor yaml is a direct dependency, so the file is read as text.
const file = readFileSync(
  resolve(__dirname, '../../corpus/corpus.gitlab-ci.yml'),
  'utf8'
);
const lines = file.split('\n');

interface Rule {
  if?: string;
  changes?: string[];
  when?: string;
  allow_failure?: string;
}

const anchors = new Map<string, string[]>();
for (const m of file.matchAll(/&([\w-]+) \[([^\]]*)\]/g)) {
  anchors.set(m[1], splitList(m[2]));
}

function splitList(s: string): string[] {
  return s
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);
}

function parseChanges(value: string): string[] {
  const v = value.replace(/^&[\w-]+\s+/, '').trim();
  if (v.startsWith('*')) {
    const list = anchors.get(v.slice(1));
    if (!list) throw new Error(`unknown alias ${v}`);
    return list;
  }
  const m = /^\[(.*)\]$/.exec(v);
  if (!m) throw new Error(`unsupported changes value: ${value}`);
  return splitList(m[1]);
}

function rulesOf(job: string): Rule[] {
  const start = lines.findIndex(l => l === `${job}:`);
  expect(start, `job ${job} exists`).toBeGreaterThanOrEqual(0);
  let i = start + 1;
  while (i < lines.length && lines[i] !== '  rules:') {
    if (/^\S/.test(lines[i])) throw new Error(`${job} has no rules`);
    i++;
  }
  const rules: Rule[] = [];
  for (i++; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (!line.startsWith('    ')) break;
    let body = line;
    if (line.startsWith('    - ')) {
      rules.push({});
      body = '      ' + line.slice(6);
    }
    const m = /^ {6}([a-z_]+):\s*(.*)$/.exec(body);
    if (!m) throw new Error(`cannot parse rules line: ${line}`);
    const rule = rules[rules.length - 1];
    if (m[1] === 'changes') rule.changes = parseChanges(m[2]);
    else if (m[1] === 'if' || m[1] === 'when' || m[1] === 'allow_failure')
      rule[m[1]] = m[2].trim();
    else throw new Error(`unexpected rule key ${m[1]}`);
  }
  return rules;
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const PUSH =
  '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "push"';
const NOT_PUSH =
  '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE != "push"';
const BARE = '$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH';

const ORIGINAL_PATTERNS = [
  'src/**/*',
  'tests/**/*',
  'corpus/**/*',
  'template/**/*',
  'assets/**/*',
  'package.json',
  'package-lock.json',
  'tsconfig*.json',
  'vitest.config.ts',
  '.gitlab-ci.yml',
];
const CI_PATTERNS = [
  'engine/ci/**/*',
  'service/ci/**/*',
  'infra/infra.gitlab-ci.yml',
  '.gitlab/ci/**/*',
];

const JOBS = ['.corpus-survivors', 'corpus:survivors:mutants'];

const quoted = (v?: string) => (v ? v.replace(/^'|'$/g, '') : v);

describe('survivors job rules', () => {
  for (const job of JOBS) {
    describe(job, () => {
      const rules = rulesOf(job);

      // GitLab takes the first matching rule, so the order is part of the behaviour:
      // a changes-only rule above the non-push rule would make nightly runs manual.
      it('keeps the rules in order: push with changes, non-push, merge request', () => {
        const manual = job === 'corpus:survivors:mutants';
        expect(
          rules.map(r => ({
            if: quoted(r.if),
            changes: r.changes !== undefined,
            when: r.when,
            allow_failure: r.allow_failure,
          }))
        ).toEqual([
          {
            if: PUSH,
            changes: true,
            when: undefined,
            allow_failure: undefined,
          },
          {
            if: NOT_PUSH,
            changes: false,
            when: undefined,
            allow_failure: undefined,
          },
          {
            if: undefined,
            changes: true,
            when: manual ? 'manual' : undefined,
            allow_failure: manual ? 'true' : undefined,
          },
        ]);
      });

      it('runs a push to the default branch only when inputs changed', () => {
        const rule = rules.find(r => quoted(r.if) === PUSH);
        expect(rule).toBeDefined();
        expect(rule!.changes?.length).toBeGreaterThan(0);
        expect(rule!.when).toBeUndefined();
      });

      it('always runs a non-push pipeline on the default branch', () => {
        const rule = rules.find(r => quoted(r.if) === NOT_PUSH);
        expect(rule).toBeDefined();
        expect(rule!.changes).toBeUndefined();
        expect(rule!.when).toBeUndefined();
      });

      it('has no bare default-branch rule', () => {
        expect(rules.filter(r => quoted(r.if) === BARE)).toEqual([]);
      });

      it('watches the original inputs and the CI files', () => {
        const rule = rules.find(r => quoted(r.if) === PUSH)!;
        expect(rule.changes).toEqual(
          expect.arrayContaining([...ORIGINAL_PATTERNS, ...CI_PATTERNS])
        );
      });

      it('has a merge request rule for the survivors inputs', () => {
        const mr = rules.filter(r => r.if === undefined);
        expect(mr).toHaveLength(1);
        const paths = mr[0].changes ?? [];
        expect(paths).toContain('src/helpers/solution.ts');
        const push = rules.find(r => quoted(r.if) === PUSH)!.changes!;
        const globs = push.map(globToRegExp);
        for (const p of paths) {
          expect(
            globs.some(g => g.test(p)),
            `${p} is matched by a push pattern`
          ).toBe(true);
        }
        if (job === 'corpus:survivors:mutants') {
          expect(mr[0].when).toBe('manual');
          expect(mr[0].allow_failure).toBe('true');
        }
      });
    });
  }

  it('uses the same push changes list on both jobs', () => {
    const [a, b] = JOBS.map(
      j => rulesOf(j).find(r => quoted(r.if) === PUSH)?.changes
    );
    expect(a).toBeDefined();
    expect(b).toEqual(a);
  });
});
