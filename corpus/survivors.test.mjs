import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMutant,
  cacheArgs,
  combineShards,
  isInsideRoot,
  judge,
  judgeBaseline,
  judgedEntry,
  judgeMutant,
  junitXml,
  mergeBaseline,
  metricsText,
  offsetOf,
  parseArgs,
  parseShard,
  restoreAll,
  run,
  sameDifferences,
  selectMutants,
  shardJudges,
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

  it('a stopped job (restoreAll) puts the source back while the run is still going', async () => {
    let planted;
    const inside = new Promise(resolve => (planted = resolve));
    let finish;
    const stillRunning = new Promise(resolve => (finish = resolve));
    const done = withMutant(file, m, () => {
      planted();
      return stillRunning;
    });
    await inside;
    try {
      expect(fs.readFileSync(file, 'utf8')).not.toBe(original);
      restoreAll();
      expect(fs.readFileSync(file, 'utf8')).toBe(original);
    } finally {
      // let withMutant finish, so no restorer of this deleted file is left
      finish();
      await done;
    }
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
      now: () => t0,
    });
    expect(result.status).toBe('Survived');
  });

  it('is not Killed by a difference only one run shows (a flake)', async () => {
    const { judge } = scripted([entry('p', 'compile timed out'), entry('p')]);
    const result = await judgeMutant({
      ...base,
      judge,
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
      now: () => t0,
    });
    expect(result).toMatchObject({ status: 'Killed', killedBy: 'q' });
    expect(calls.map(c => c.problem)).toEqual(['p', 'q', 'q']);
  });

  it('gives every run the full timeout, so a slow runner is not a kill', async () => {
    // the review's reproduction: 5 problems, 150 ms per call, identical verdicts
    let clock = t0;
    const five = ['a', 'b', 'c', 'd', 'e'];
    const calls = [];
    const judge = async (problem, ms) => {
      calls.push(ms);
      clock += 150;
      return entry(problem);
    };
    const result = await judgeMutant({
      ...base,
      problems: five,
      baseline: {
        problems: five.map(name => ({ name, failures: [], flaky: false })),
      },
      judge,
      timeoutSeconds: 0.6,
      now: () => clock,
    });
    expect(result.status).toBe('Survived');
    expect(new Set(calls)).toEqual(new Set([600]));
  });

  it('is not a Timeout when only one run gives no verdict', async () => {
    const { judge, calls } = scripted([{ timedOut: true }, entry('p')]);
    const result = await judgeMutant({ ...base, judge, now: () => t0 });
    expect(result.status).toBe('Survived');
    expect(calls).toHaveLength(2);
  });

  it('is a Timeout when two runs on the same problem give no verdict', async () => {
    const { judge } = scripted([{ timedOut: true }, { timedOut: true }]);
    expect(await judgeMutant({ ...base, judge, now: () => t0 })).toMatchObject({
      status: 'Timeout',
      killedBy: 'p',
      detail: 'no verdict within 600s, twice (on p)',
    });
  });

  it('a timeout between two runs with the same difference still kills', async () => {
    const { judge, calls } = scripted([
      entry('p', 'x'),
      { timedOut: true },
      entry('p', 'x'),
    ]);
    const result = await judgeMutant({ ...base, judge, now: () => t0 });
    expect(result).toMatchObject({ status: 'Killed', killedBy: 'p' });
    expect(calls).toHaveLength(3);
  });

  it('is an Error, never a kill, once it runs past its budget', async () => {
    let clock = t0;
    const { judge, calls } = scripted([entry('p', 'x'), entry('p', 'x')]);
    const slow = async (problem, ms) => {
      clock += 2_000_000;
      return judge(problem, ms);
    };
    const result = await judgeMutant({
      ...base,
      judge: slow,
      now: () => clock,
    });
    expect(result.status).toBe('Error');
    expect(result.detail).toMatch(/not judged within 1800s in all/);
    expect(calls).toHaveLength(1);
  });

  it('still judges a mutant with type errors, and says so', async () => {
    const { judge } = scripted([entry('p')]);
    const result = await judgeMutant({
      ...base,
      build: async () => ({ ok: false }),
      judge,
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

describe('what reaches the reports is well-formed', () => {
  const result = extra => ({
    id: '7',
    file: 'src/a.ts',
    location: { start: { line: 1, column: 1 } },
    mutatorName: 'X',
    original: 'a',
    replacement: 'b',
    unitStatus: 'Survived',
    ...extra,
  });

  it('drops control characters XML 1.0 forbids, keeping tab and newline', () => {
    const junit = junitXml([
      result({ status: 'Error', detail: 'tsc \u001b[31mred\u0000\tend\nnext' }),
    ]);
    const forbidden = [...junit].filter(c => {
      const code = c.codePointAt(0);
      return (
        (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127
      );
    });
    expect(forbidden).toEqual([]);
    expect(junit).toContain('tsc [31mred\tend\nnext');
  });

  it('strips a temp-dir suffix in linear time, even on a hostile message', () => {
    const hostile = 'polyman-corpus-'.repeat(20000) + '!';
    const started = Date.now();
    withoutTempDir(hostile);
    expect(Date.now() - started).toBeLessThan(500);
    expect(withoutTempDir('/tmp/polyman-corpus-sum-parity-AbC123.log')).toBe(
      '/tmp/polyman-corpus-sum-parity-XXXXXX.log'
    );
  });

  it('reads a problem from the run.mjs summary, without its temp dir', () => {
    const summary = JSON.stringify({
      problems: [
        { name: 'p', failures: ['crash in /tmp/polyman-corpus-p-AbC123/x'] },
      ],
    });
    expect(judgedEntry('p', summary, { code: 1, output: '' })).toEqual({
      name: 'p',
      failures: ['crash in /tmp/polyman-corpus-p-XXXXXX/x'],
    });
  });

  it('turns a missing, broken or foreign summary into one failure', () => {
    for (const text of [
      null,
      '{',
      JSON.stringify({ problems: [{ name: 'q' }] }),
    ]) {
      const entry = judgedEntry('p', text, { code: 2, output: 'boom' });
      expect(entry.name).toBe('p');
      expect(entry.failures).toEqual([
        'run.mjs exited 2 without a summary: boom',
      ]);
    }
  });

  it('refuses shards from a run with a different number of shards', () => {
    const shard = (index, total) => ({
      shard: { index, total },
      fingerprint: 'f',
      results: [],
    });
    expect(() => combineShards([shard(1, 2)], 1)).toThrow(
      /run of 2 shards, expected 1/
    );
  });
});

describe('parseArgs: the command line', () => {
  it('has defaults for a single local shard', () => {
    const args = parseArgs([]);
    expect(args.mode).toBe('judge');
    expect(args.shard).toEqual({ index: 1, total: 1 });
    expect(args.timeout).toBe(600);
  });

  it('reads report mode and the shard count', () => {
    const args = parseArgs(['report', '--shards', '8']);
    expect(args.mode).toBe('report');
    expect(args.shards).toBe(8);
  });

  it('refuses a shard count, timeout or flag it cannot use', () => {
    expect(() => parseArgs(['report', '--shards', 'abc'])).toThrow(/--shards/);
    expect(() => parseArgs(['report', '--shards', '0'])).toThrow(/--shards/);
    expect(() => parseArgs(['--timeout', '0'])).toThrow(/--timeout/);
    expect(() => parseArgs(['--timeout'])).toThrow(/needs a value/);
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
  });
});

// The kill paths use process groups and sh; Windows has neither the same way.
const posix = process.platform !== 'win32';

describe.runIf(posix)('stopping: no process outlives its run', () => {
  // the children whose command line names `marker`, from /proc (Linux) or ps
  const alive = marker => {
    try {
      return fs
        .readdirSync('/proc')
        .filter(d => /^\d+$/.test(d))
        .map(d => {
          try {
            return fs.readFileSync(`/proc/${d}/cmdline`, 'utf8');
          } catch {
            return '';
          }
        })
        .filter(c => c.includes(marker)).length;
    } catch {
      return 0;
    }
  };

  it('a timeout kills the whole process group, children included', async () => {
    const marker = `sleep 37.${process.pid}`;
    const started = Date.now();
    const r = await run('sh', ['-c', `${marker} & ${marker} & wait`], {
      timeoutMs: 300,
    });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(alive(marker)).toBe(0);
  });

  it('restoreAll (what a stopped job runs) kills what is still running', async () => {
    const marker = `sleep 41.${process.pid}`;
    const pending = run('sh', ['-c', `${marker} & wait`]);
    await new Promise(resolve => setTimeout(resolve, 300));
    restoreAll();
    const r = await pending;
    expect(r.code).not.toBe(0);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(alive(marker)).toBe(0);
  });
});

describe('judge: one run of run.mjs on one problem', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'survivors-judge-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // a stand-in run.mjs: writes a summary on its first run only
  const stub = () => {
    const script = path.join(dir, 'run.mjs');
    fs.writeFileSync(
      script,
      `import fs from 'node:fs';
import path from 'node:path';
const junit = process.argv[process.argv.indexOf('--junit') + 1];
const flag = path.join(${JSON.stringify(dir)}, 'ran-once');
fs.mkdirSync(path.dirname(junit), { recursive: true });
if (!fs.existsSync(flag)) {
  fs.writeFileSync(flag, '');
  fs.writeFileSync(path.join(path.dirname(junit), 'summary.json'),
    JSON.stringify({ problems: [{ name: 'p', failures: ['crash in /tmp/polyman-corpus-p-AbC123/x'] }] }));
  process.exit(1);
}
process.exit(3);
`
    );
    return script;
  };

  it("reads the problem's failures, without the temp dir", async () => {
    const r = await judge('p', path.join(dir, 'work'), 20_000, stub());
    expect(r.entry).toEqual({
      name: 'p',
      failures: ['crash in /tmp/polyman-corpus-p-XXXXXX/x'],
    });
  });

  it('a run past its time limit is a timeout, not a failure of the problem', async () => {
    const script = path.join(dir, 'slow.mjs');
    fs.writeFileSync(script, 'setTimeout(() => {}, 60_000);\n');
    const started = Date.now();
    const r = await judge('p', path.join(dir, 'work'), 300, script);
    expect(r).toEqual({ timedOut: true });
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("never reads the previous attempt's summary", async () => {
    const script = stub();
    const work = path.join(dir, 'work');
    await judge('p', work, 20_000, script);
    // the second run writes no summary: the first one's must not be read
    const second = await judge('p', work, 20_000, script);
    expect(second.entry.failures).toHaveLength(1);
    expect(second.entry.failures[0]).toMatch(
      /^run\.mjs exited 3 without a summary/
    );
  });

  // a stand-in run.mjs that records the arguments it was given
  const argvOf = async cache => {
    const script = path.join(dir, 'argv.mjs');
    const log = path.join(dir, 'argv.json');
    fs.writeFileSync(
      script,
      `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));
`
    );
    const work = path.join(dir, 'work');
    await (cache
      ? judge('p', work, 20_000, script, cache)
      : judge('p', work, 20_000, script));
    return JSON.parse(fs.readFileSync(log, 'utf8'));
  };

  it("hands the cache flags to run.mjs's command line", async () => {
    const junit = path.join(dir, 'work', 'p', 'junit.xml');
    expect(await argvOf(['--cache', '/c', '--save-cache'])).toEqual([
      '--only',
      'p',
      '--junit',
      junit,
      '--cache',
      '/c',
      '--save-cache',
    ]);
    expect(await argvOf()).toEqual(['--only', 'p', '--junit', junit]);
  });
});

describe('judgeBaseline: the unmutated build, judged twice', () => {
  const clean = problem => ({ entry: { name: problem, failures: [] } });

  it('judges every problem twice, each run in its own folder', async () => {
    const calls = [];
    const work = path.join('tmp', 'work');
    const baseline = await judgeBaseline(
      ['a', 'b'],
      work,
      500,
      async (problem, folder, ms) => {
        calls.push([problem, folder, ms]);
        return clean(problem);
      }
    );
    expect(calls).toEqual([
      ['a', path.join(work, 'baseline-0'), 500],
      ['a', path.join(work, 'baseline-1'), 500],
      ['b', path.join(work, 'baseline-0'), 500],
      ['b', path.join(work, 'baseline-1'), 500],
    ]);
    expect(baseline.problems).toEqual([
      { name: 'a', failures: [], flaky: false },
      { name: 'b', failures: [], flaky: false },
    ]);
  });

  it('a difference only one run shows is flaky, so no mutant is blamed for it', async () => {
    const baseline = await judgeBaseline(
      ['a'],
      'work',
      500,
      async (problem, folder) => ({
        entry: {
          name: problem,
          failures: folder.endsWith('baseline-1') ? ['tests#3: got OK'] : [],
        },
      })
    );
    expect(baseline.problems).toEqual([
      { name: 'a', failures: ['tests#3: got OK'], flaky: true },
    ]);
  });

  // [problem, attempt] of the one call that times out; every case must stop
  // the job, name that problem, and judge nothing after it
  it.each([
    ['a', 0, 1],
    ['a', 1, 2],
    ['b', 0, 3],
    ['b', 1, 4],
  ])(
    'stops the job when the unmutated build times out (%s, attempt %i)',
    async (slow, attempt, callsBefore) => {
      let calls = 0;
      await expect(
        judgeBaseline(['a', 'b'], 'work', 500, async (problem, folder) => {
          calls++;
          return problem === slow && folder.endsWith(`baseline-${attempt}`)
            ? { timedOut: true }
            : clean(problem);
        })
      ).rejects.toThrow(`the unmutated build timed out on ${slow}`);
      expect(calls).toBe(callsBefore);
    }
  );
});

describe('the compile cache: only the cold baseline run writes it', () => {
  const clean = problem => ({ entry: { name: problem, failures: [] } });
  const recordCacheFlags = async cache => {
    const flags = [];
    await judgeBaseline(
      ['a', 'b'],
      'work',
      500,
      async (problem, folder, ms, script, cache) => {
        flags.push([problem, path.basename(folder), cache]);
        return clean(problem);
      },
      cache
    );
    return flags;
  };

  it('passes --save-cache on attempt 0 only, --cache on both', async () => {
    expect(await recordCacheFlags('/c')).toEqual([
      ['a', 'baseline-0', ['--cache', '/c', '--save-cache']],
      ['a', 'baseline-1', ['--cache', '/c']],
      ['b', 'baseline-0', ['--cache', '/c', '--save-cache']],
      ['b', 'baseline-1', ['--cache', '/c']],
    ]);
  });

  it('passes no cache flags without a cache folder', async () => {
    expect(await recordCacheFlags(undefined)).toEqual([
      ['a', 'baseline-0', []],
      ['a', 'baseline-1', []],
      ['b', 'baseline-0', []],
      ['b', 'baseline-1', []],
    ]);
  });

  it('gives a mutant --cache and never --save-cache', () => {
    expect(cacheArgs('/c')).toEqual(['--cache', '/c']);
    expect(cacheArgs(null)).toEqual([]);
  });
});

describe("shardJudges: a shard's judges share one cache, mutants only read it", () => {
  const work = path.join('tmp', 'work');
  const cache = path.join(work, 'compile-cache');
  const recorder = () => {
    const calls = [];
    const judgeOne = async (problem, folder, ms, script, flags) => {
      calls.push([problem, folder, ms, script, flags]);
      return { entry: { name: problem, failures: [] } };
    };
    return { calls, judgeOne };
  };

  it('the baseline fills the cache on its cold run and reads it on the second', async () => {
    const { calls, judgeOne } = recorder();
    await shardJudges(work, judgeOne).baseline(['a'], 500);
    expect(calls).toEqual([
      [
        'a',
        path.join(work, 'baseline-0'),
        500,
        undefined,
        ['--cache', cache, '--save-cache'],
      ],
      ['a', path.join(work, 'baseline-1'), 500, undefined, ['--cache', cache]],
    ]);
  });

  it('a mutant reads the same cache and never saves to it', async () => {
    const { calls, judgeOne } = recorder();
    const judgeMutantRun = shardJudges(work, judgeOne).mutant({ id: '42' });
    await judgeMutantRun('a', 500);
    await judgeMutantRun('b', 700);
    expect(calls).toEqual([
      ['a', path.join(work, '42'), 500, undefined, ['--cache', cache]],
      ['b', path.join(work, '42'), 700, undefined, ['--cache', cache]],
    ]);
  });
});

describe('run.mjs --cache: every run starts from its own copy', () => {
  const RUN = path.join(import.meta.dirname, 'run.mjs');
  const PROBLEM = 'sum-parity';
  let dir, log, cache, fake;

  // a stand-in for polyman: logs which cache files it found, then adds one
  const FAKE = `
import fs from 'node:fs';
const dir = '.polyman/cache';
const seen = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : null;
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(seen) + '\\n');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dir + '/' + process.env.FAKE_WRITES, 'x');
process.stdout.write('not a report');
`;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'survivors-cache-'));
    log = path.join(dir, 'seen.log');
    cache = path.join(dir, 'cache');
    fake = path.join(dir, 'fake-polyman.mjs');
    fs.writeFileSync(fake, FAKE);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const runOnce = (writes, extra) => {
    const result = spawnSync(
      process.execPath,
      [
        RUN,
        '--polyman',
        fake,
        '--only',
        PROBLEM,
        '--junit',
        path.join(dir, writes, 'junit.xml'),
        ...extra,
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, FAKE_LOG: log, FAKE_WRITES: writes },
      }
    );
    // the fake prints no report, so run.mjs reports a difference (exit 1)
    expect(result.status, result.stderr).toBe(1);
  };
  const seen = () =>
    fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
  const saved = () => fs.readdirSync(path.join(cache, PROBLEM)).sort();

  it('--save-cache keeps the cold run cache; mutants read a copy and never write back', () => {
    runOnce('baseline-0', cacheArgs(cache, { save: true }));
    runOnce('baseline-1', cacheArgs(cache));
    runOnce('mutant-1', cacheArgs(cache));
    runOnce('mutant-2', cacheArgs(cache));
    expect(seen()).toEqual([
      null,
      ['baseline-0'],
      ['baseline-0'],
      ['baseline-0'],
    ]);
    expect(saved()).toEqual(['baseline-0']);
  }, 30_000);

  it('without --cache every run is cold and nothing is kept', () => {
    runOnce('first', []);
    runOnce('second', []);
    expect(seen()).toEqual([null, null]);
    expect(fs.existsSync(cache)).toBe(false);
  });

  it('refuses --save-cache without --cache', () => {
    const result = spawnSync(
      process.execPath,
      [RUN, '--only', PROBLEM, '--save-cache'],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch('--save-cache needs --cache <dir>');
  });
});
