import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMutant,
  combineShards,
  isInsideRoot,
  judgeMutant,
  junitXml,
  mergeBaseline,
  metricsText,
  offsetOf,
  parseShard,
  sameDifferences,
  selectMutants,
  shardOf,
  summaryMarkdown,
  withMutant,
  withoutTempDir,
} from './survivors.mjs';

const at = (line, column) => ({ line, column });
const mutant = (id, start, end, replacement, extra = {}) => ({
  id,
  mutatorName: 'EqualityOperator',
  replacement,
  location: { start, end },
  ...extra,
});

describe('applyMutant: Stryker locations', () => {
  const source = 'const a = 1;\nif (a === 0) {\n  run();\n}\n';

  it('replaces exactly the located range (1-based, end exclusive)', () => {
    // "a === 0" is line 2, columns 5..11
    const { mutated, original } = applyMutant(
      source,
      mutant('1', at(2, 5), at(2, 12), 'a !== 0')
    );
    expect(original).toBe('a === 0');
    expect(mutated).toBe('const a = 1;\nif (a !== 0) {\n  run();\n}\n');
  });

  it('replaces a block spanning several lines', () => {
    const { mutated, original } = applyMutant(
      source,
      mutant('2', at(2, 14), at(4, 2), '{}')
    );
    expect(original).toBe('{\n  run();\n}');
    expect(mutated).toBe('const a = 1;\nif (a === 0) {}\n');
  });

  it('keeps CRLF files intact', () => {
    const crlf = 'x = 1;\r\ny = 2;\r\n';
    expect(
      applyMutant(crlf, mutant('3', at(2, 5), at(2, 6), '3')).mutated
    ).toBe('x = 1;\r\ny = 3;\r\n');
  });

  it('refuses locations outside the file instead of guessing', () => {
    expect(() => offsetOf(source, at(9, 1))).toThrow(/past the end/);
    expect(() => offsetOf(source, at(1, 40))).toThrow(/outside line 1/);
    expect(() =>
      applyMutant(source, mutant('4', at(2, 6), at(2, 5), 'x'))
    ).toThrow(/ends before it starts/);
  });
});

describe('withMutant: the source always comes back', () => {
  let dir;
  let file;
  const original = 'export const ok = (v: string) => v === "OK";\n';
  const m = mutant('7', at(1, 34), at(1, 44), 'true');
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'survivors-'));
    file = path.join(dir, 'solution.ts');
    fs.writeFileSync(file, original);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('plants the mutant while the callback runs, then restores', async () => {
    const seen = await withMutant(file, m, async ({ original: replaced }) => {
      expect(replaced).toBe('v === "OK"');
      return fs.readFileSync(file, 'utf8');
    });
    expect(seen).toBe('export const ok = (v: string) => true;\n');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('restores when the build or the corpus run throws', async () => {
    await expect(
      withMutant(file, m, async () => {
        throw new Error('tsc crashed');
      })
    ).rejects.toThrow('tsc crashed');
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('never writes when the location is invalid', async () => {
    const bad = mutant('8', at(5, 1), at(5, 2), 'x');
    await expect(withMutant(file, bad, async () => 1)).rejects.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });
});

describe('selecting and sharding', () => {
  const report = {
    files: {
      'src/b.ts': {
        mutants: [
          { id: '10', status: 'Survived', location: {} },
          { id: '2', status: 'Killed', location: {} },
        ],
      },
      'src/a.ts': {
        mutants: [
          { id: '11', status: 'NoCoverage', location: {} },
          { id: '9', status: 'Survived', location: {} },
          { id: '3', status: 'Timeout', location: {} },
          { id: '4', status: 'CompileError', location: {} },
        ],
      },
    },
  };

  it('takes Survived and NoCoverage only, by file then numeric id', () => {
    const picked = selectMutants(report);
    expect(picked.map(m => `${m.file}#${m.id}:${m.unitStatus}`)).toEqual([
      'src/a.ts#9:Survived',
      'src/a.ts#11:NoCoverage',
      'src/b.ts#10:Survived',
    ]);
  });

  it('splits the list so every mutant is in exactly one shard', () => {
    const list = Array.from({ length: 103 }, (_, i) => ({ id: String(i) }));
    const shards = Array.from({ length: 8 }, (_, i) =>
      shardOf(list, { index: i + 1, total: 8 })
    );
    expect(shards.map(s => s.length)).toEqual([13, 13, 13, 13, 13, 13, 13, 12]);
    const ids = shards.flat().map(m => m.id);
    expect(new Set(ids).size).toBe(103);
    expect(shardOf(list, { index: 1, total: 1 })).toHaveLength(103);
  });

  it('parses i/n as GitLab numbers parallel jobs (1-based)', () => {
    expect(parseShard('3/8')).toEqual({ index: 3, total: 8 });
    for (const bad of ['0/8', '9/8', '1/0', '1', 'a/b', undefined])
      expect(() => parseShard(bad)).toThrow(/--shard/);
  });
});

const result = (id, unitStatus, status, extra = {}) => ({
  file: 'src/helpers/solution.ts',
  id,
  mutatorName: 'ConditionalExpression',
  replacement: 'true',
  original: 'tag === "WA"',
  location: { start: at(12, 3), end: at(12, 15) },
  unitStatus,
  status,
  ...extra,
});

describe('metrics and reports', () => {
  const results = [
    result('1', 'Survived', 'Killed', { killedBy: 'sum-parity' }),
    result('2', 'Survived', 'Survived'),
    result('3', 'Survived', 'Timeout', { killedBy: 'pair-target' }),
    result('4', 'Survived', 'Error', { detail: 'tsc timed out' }),
    result('5', 'NoCoverage', 'Killed', { killedBy: 'sum-parity' }),
    result('6', 'NoCoverage', 'Survived', { typeErrors: true }),
  ];

  it('counts timeouts as kills and errors in the total only', () => {
    expect(metricsText(results)).toBe(
      'corpus_kills_unit_survivors 2\n' +
        'corpus_kills_unit_survivors_total 4\n' +
        'corpus_kills_untested_mutants 1\n' +
        'corpus_kills_untested_mutants_total 2\n'
    );
  });

  it('is all zeros, not missing, when nothing was judged', () => {
    expect(metricsText([])).toBe(
      'corpus_kills_unit_survivors 0\ncorpus_kills_unit_survivors_total 0\n' +
        'corpus_kills_untested_mutants 0\ncorpus_kills_untested_mutants_total 0\n'
    );
  });

  it('makes a mutant the judges miss a failed test case', () => {
    const junit = junitXml(results);
    expect(junit).toContain('tests="6" failures="2" errors="1"');
    expect(junit).toContain(
      'name="#2 src/helpers/solution.ts:12:3 ConditionalExpression: tag === &quot;WA&quot; → true"'
    );
  });

  it('lists the mutants the judges miss, with the counts first', () => {
    const page = summaryMarkdown(results);
    expect(page).toContain(
      'the corpus kills **2 of 4**, 1 could not be judged'
    );
    expect(page).toContain('the corpus kills **1 of 2**.');
    expect(page).toContain('## Missed by the unit tests and by the judges (2)');
    expect(page).toContain(
      '| 2 | survived | src/helpers/solution.ts:12 | ConditionalExpression | `tag === "WA"` | `true` | yes |'
    );
    expect(page).toContain('| 6 | never run |');
    expect(page).toMatch(/\| 6 .*\| no \|/);
    expect(page).toContain('- `sum-parity`: 2');
  });

  it('escapes table characters in code', () => {
    const page = summaryMarkdown([
      result('9', 'Survived', 'Survived', { original: 'a || b' }),
    ]);
    expect(page).toContain('`a \\|\\| b`');
  });

  it('sums shards only when all are there and judged the same source', () => {
    const shard = (index, ids, fingerprint = 'f') => ({
      shard: { index, total: 2 },
      fingerprint,
      results: ids.map(id => result(id, 'Survived', 'Killed')),
    });
    expect(
      combineShards([shard(2, ['3']), shard(1, ['10', '1'])], 2).map(r => r.id)
    ).toEqual(['1', '3', '10']);
    expect(() => combineShards([shard(1, ['1'])], 2)).toThrow(
      /missing shard\(s\) 2 of 2/
    );
    expect(() => combineShards([shard(1, ['1']), shard(1, ['2'])], 2)).toThrow(
      /twice/
    );
    expect(() =>
      combineShards([shard(1, ['1']), shard(2, ['2'], 'g')], 2)
    ).toThrow(/different reports/);
  });
});

describe('flakes are not kills', () => {
  const d = (problem, message) => ({ problem, message });

  it('keeps only the differences both runs of a mutant show', () => {
    const first = [d('a', 'step x failed'), d('a', 'solution w: WA')];
    const second = [d('a', 'solution w: WA'), d('b', 'other')];
    expect(sameDifferences(first, second)).toEqual([d('a', 'solution w: WA')]);
    expect(sameDifferences(first, [])).toEqual([]);
  });

  it('excuses a failure either baseline run showed, and flags the flake', () => {
    expect(
      mergeBaseline([
        { name: 'p', failures: ['compile-generators failed'] },
        { name: 'p', failures: [] },
      ])
    ).toEqual({
      name: 'p',
      failures: ['compile-generators failed'],
      flaky: true,
    });
    expect(
      mergeBaseline([
        { name: 'p', failures: [] },
        { name: 'p', failures: [] },
      ])
    ).toEqual({ name: 'p', failures: [], flaky: false });
  });

  it('says in the summary when the baseline was not clean', () => {
    const clean = summaryMarkdown([], {
      baseline: { problems: 5, red: [], flaky: [] },
    });
    expect(clean).toContain('matches the pinned verdicts on all 5 problems');
    const dirty = summaryMarkdown([], {
      baseline: { problems: 5, red: ['sum-parity'], flaky: ['sum-parity'] },
    });
    expect(dirty).toContain('**Baseline not clean**');
    expect(dirty).toContain('judged sum-parity differently between runs');
  });

  it('matches the same crash in two runs despite their random temp dirs', () => {
    // run.mjs copies each problem to a fresh polyman-corpus-<name>-XXXXXX
    const crash = dir =>
      d('sum-parity', `polyman crashed: ENOENT /tmp/${dir}/out/report.json`);
    expect(
      sameDifferences(
        [crash('polyman-corpus-sum-parity-AbC123')],
        [crash('polyman-corpus-sum-parity-XyZ789')]
      )
    ).toEqual([crash('polyman-corpus-sum-parity-AbC123')]);
    // a different file is still a different difference
    expect(
      sameDifferences(
        [crash('polyman-corpus-sum-parity-AbC123')],
        [d('sum-parity', 'polyman crashed: ENOENT /tmp/elsewhere/x.json')]
      )
    ).toEqual([]);
  });

  it('strips only the 6-character suffix, not a hyphenated problem name', () => {
    expect(withoutTempDir('/tmp/polyman-corpus-sum-parity-AbC123/x')).toBe(
      '/tmp/polyman-corpus-sum-parity-XXXXXX/x'
    );
    expect(
      withoutTempDir('C:\\Temp\\polyman-corpus-pair-target-q1W2e3\\out')
    ).toBe('C:\\Temp\\polyman-corpus-pair-target-XXXXXX\\out');
    expect(withoutTempDir('at polyman-corpus-distinct-count-0aB9zZ')).toBe(
      'at polyman-corpus-distinct-count-XXXXXX'
    );
    expect(withoutTempDir('solution w: expected WA, got OK')).toBe(
      'solution w: expected WA, got OK'
    );
  });

  it('does not call a failure listed twice in one run a flake', () => {
    expect(
      mergeBaseline([
        { name: 'p', failures: ['step x failed', 'step x failed'] },
        { name: 'p', failures: ['step x failed'] },
      ])
    ).toEqual({ name: 'p', failures: ['step x failed'], flaky: false });
  });
});

describe('malformed reports are refused, not guessed', () => {
  const report = mutants => ({ files: { 'src/a.ts': { mutants } } });

  it('refuses a mutant without replacement text, but accepts a removal', () => {
    const source = 'const a = 1;\nrun();\n';
    expect(() =>
      applyMutant(source, mutant('1', at(2, 1), at(2, 7), undefined))
    ).toThrow(/no replacement/);
    expect(
      applyMutant(source, mutant('1', at(2, 1), at(2, 7), '')).mutated
    ).toBe('const a = 1;\n\n');
  });

  it('refuses an id that is not a Stryker number', () => {
    expect(() =>
      selectMutants(report([{ id: '../keep', status: 'Survived' }]))
    ).toThrow(/not a Stryker number/);
  });

  it('refuses a file outside the repo', () => {
    expect(() =>
      selectMutants({
        files: {
          '../victim/f.txt': { mutants: [{ id: '1', status: 'Survived' }] },
        },
      })
    ).toThrow(/outside the repo/);
    expect(isInsideRoot('src/helpers/solution.ts', '/repo')).toBe(true);
    expect(isInsideRoot('../x', '/repo')).toBe(false);
    expect(isInsideRoot('/etc/passwd', '/repo')).toBe(false);
    expect(isInsideRoot('.', '/repo')).toBe(false);
  });
});

describe('judgeMutant: when a mutant counts as killed', () => {
  const entry = (name, ...failures) => ({ entry: { name, failures } });
  const clean = { problems: [{ name: 'p', failures: [], flaky: false }] };
  const ok = async () => ({ ok: true });
  // judge() answers from a script, one answer per call, and records the calls
  const scripted = answers => {
    const calls = [];
    const judge = async (problem, left) => {
      calls.push({ problem, left });
      return answers.shift();
    };
    return { judge, calls };
  };
  const base = {
    problems: ['p'],
    baseline: clean,
    build: ok,
    timeoutSeconds: 600,
  };
  const t0 = 1_000_000;

  it('is Survived when no run differs from the baseline, after one run', async () => {
    const { judge, calls } = scripted([entry('p')]);
    const result = await judgeMutant({
      ...base,
      judge,
      deadline: t0 + 600_000,
      now: () => t0,
    });
    expect(result).toEqual({ typeErrors: false, status: 'Survived' });
    expect(calls).toHaveLength(1);
  });

  it('is Killed only when the second run shows the same difference', async () => {
    const { judge, calls } = scripted([
      entry('p', 'w: WA'),
      entry('p', 'w: WA'),
    ]);
    const result = await judgeMutant({
      ...base,
      judge,
      deadline: t0 + 600_000,
      now: () => t0,
    });
    expect(result).toMatchObject({
      status: 'Killed',
      killedBy: 'p',
      detail: 'p: w: WA',
    });
    expect(calls).toHaveLength(2);
  });

  it('is not Killed when the two runs show different differences', async () => {
    const { judge } = scripted([
      entry('p', 'compile timed out'),
      entry('p', 'w: WA'),
    ]);
    const result = await judgeMutant({
      ...base,
      judge,
      deadline: t0 + 600_000,
      now: () => t0,
    });
    expect(result.status).toBe('Survived');
  });

  it('is not Killed by a difference only one run shows (a flake)', async () => {
    const { judge } = scripted([entry('p', 'compile timed out'), entry('p')]);
    const result = await judgeMutant({
      ...base,
      judge,
      deadline: t0 + 600_000,
      now: () => t0,
    });
    expect(result.status).toBe('Survived');
  });

  it('does not count a failure the baseline already had', async () => {
    const red = {
      problems: [{ name: 'p', failures: ['old bug'], flaky: false }],
    };
    const { judge } = scripted([entry('p', 'old bug'), entry('p', 'old bug')]);
    const result = await judgeMutant({
      ...base,
      baseline: red,
      judge,
      deadline: t0 + 600_000,
      now: () => t0,
    });
    expect(result.status).toBe('Survived');
  });

  it('kills on the first problem that shows it, and stops there', async () => {
    const two = {
      problems: [
        { name: 'p', failures: [], flaky: false },
        { name: 'q', failures: [], flaky: false },
      ],
    };
    const { judge, calls } = scripted([
      entry('p'),
      entry('q', 'x'),
      entry('q', 'x'),
    ]);
    const result = await judgeMutant({
      ...base,
      problems: ['p', 'q'],
      baseline: two,
      judge,
      deadline: t0 + 600_000,
      now: () => t0,
    });
    expect(result).toMatchObject({ status: 'Killed', killedBy: 'q' });
    expect(calls.map(c => c.problem)).toEqual(['p', 'q', 'q']);
  });

  it('is a Timeout when a run gives no verdict, or the deadline has passed', async () => {
    const late = scripted([{ timedOut: true }]);
    expect(
      await judgeMutant({
        ...base,
        judge: late.judge,
        deadline: t0 + 600_000,
        now: () => t0,
      })
    ).toMatchObject({
      status: 'Timeout',
      killedBy: 'p',
      detail: 'no verdict within 600s (on p)',
    });

    const never = scripted([entry('p')]);
    const result = await judgeMutant({
      ...base,
      judge: never.judge,
      deadline: t0,
      now: () => t0,
    });
    expect(result.status).toBe('Timeout');
    expect(never.calls).toHaveLength(0);
  });

  it('passes the time left to each run', async () => {
    let clock = t0;
    const { judge, calls } = scripted([entry('p', 'x'), entry('p', 'x')]);
    const timed = async (problem, left) => {
      clock += 100_000;
      return judge(problem, left);
    };
    await judgeMutant({
      ...base,
      judge: timed,
      deadline: t0 + 600_000,
      now: () => clock,
    });
    expect(calls.map(c => c.left)).toEqual([600_000, 500_000]);
  });

  it('still judges a mutant with type errors, and says so', async () => {
    const { judge } = scripted([entry('p')]);
    const result = await judgeMutant({
      ...base,
      build: async () => ({ ok: false }),
      judge,
      deadline: t0 + 600_000,
      now: () => t0,
    });
    expect(result).toEqual({ typeErrors: true, status: 'Survived' });
  });

  it('is an Error, judged by nobody, when tsc times out', async () => {
    const { judge, calls } = scripted([]);
    const result = await judgeMutant({
      ...base,
      build: async () => ({ ok: false, timedOut: true }),
      judge,
      deadline: t0 + 600_000,
      now: () => t0,
    });
    expect(result).toEqual({
      typeErrors: true,
      status: 'Error',
      detail: 'tsc timed out',
    });
    expect(calls).toHaveLength(0);
  });
});
