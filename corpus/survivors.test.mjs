import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMutant,
  combineShards,
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
});
