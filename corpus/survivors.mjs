#!/usr/bin/env node
/**
 * Who judges the judge: do the corpus judges catch the bugs the unit tests
 * miss? Takes the mutants Stryker reports as Survived (the unit tests ran the
 * code and still passed) and NoCoverage (no unit test runs that code), plants
 * each one in the source, builds polyman and runs the corpus (run.mjs) on all
 * problems. A mutant is killed when the corpus judges anything worse than it
 * does on the unmutated build of the same run (the release gate's rule,
 * `regressions` in lib.mjs), so a red baseline doesn't count as kills.
 *
 *   node corpus/survivors.mjs [--report corpus/out/mutation/mutation.json]
 *       [--shard 1/8] [--out corpus/out/survivors] [--timeout 600] [--only 12,57]
 *   node corpus/survivors.mjs report [--out corpus/out/survivors] [--shards 8]
 *
 * The first form judges one shard and writes shard-<i>-of-<n>.json, a JUnit
 * file (a mutant the judges miss is a failed test case) and that shard's
 * metrics. `report` sums the shards into one metrics file and summary.md, and
 * fails if a shard is missing. The source file is always put back, also when a
 * build or a run fails or the job is stopped.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { regressions } from './lib.mjs';

const CORPUS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(CORPUS);
const TSC = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const BUILD_TIMEOUT_MS = 5 * 60 * 1000;

/** The statuses judged, and what each set is called in the metrics. */
export const GROUPS = {
  Survived: 'corpus_kills_unit_survivors',
  NoCoverage: 'corpus_kills_untested_mutants',
};

/** `i/n` (1-based, as GitLab's CI_NODE_INDEX/CI_NODE_TOTAL) → { index, total }. */
export function parseShard(text) {
  const match = /^(\d+)\/(\d+)$/.exec(String(text ?? ''));
  const index = match ? Number(match[1]) : NaN;
  const total = match ? Number(match[2]) : NaN;
  if (!(total >= 1 && index >= 1 && index <= total))
    throw new Error(`--shard must be i/n with 1 <= i <= n, got "${text}"`);
  return { index, total };
}

/**
 * The mutants to judge, from a Stryker JSON report: every Survived and
 * NoCoverage mutant, ordered by file and numeric id so every shard sees the
 * same list.
 */
export function selectMutants(report, statuses = Object.keys(GROUPS)) {
  const picked = [];
  for (const [file, { mutants = [] }] of Object.entries(report.files ?? {}))
    for (const m of mutants)
      if (statuses.includes(m.status))
        picked.push({
          file,
          id: String(m.id),
          mutatorName: m.mutatorName,
          replacement: m.replacement,
          location: m.location,
          unitStatus: m.status,
        });
  const num = id => (/^\d+$/.test(id) ? Number(id) : Infinity);
  return picked.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      num(a.id) - num(b.id) ||
      a.id.localeCompare(b.id)
  );
}

/** The differences two runs of the same mutant agree on. */
export function sameDifferences(first, second) {
  const key = a => JSON.stringify([a.problem, a.message]);
  const again = new Set(second.map(key));
  return first.filter(a => again.has(key(a)));
}

/**
 * One problem's baseline from two runs of the unmutated build: every failure
 * either run showed, and whether they disagreed.
 */
export function mergeBaseline([first, second]) {
  const failures = [...new Set([...first.failures, ...second.failures])];
  const flaky =
    failures.length !== first.failures.length ||
    failures.length !== second.failures.length;
  return { name: first.name, failures, flaky };
}

/** Round robin, so slow and fast parts of the file spread over all shards. */
export function shardOf(list, { index, total }) {
  return list.filter((_, i) => i % total === index - 1);
}

/**
 * Offset in `source` of a Stryker position: lines and columns are 1-based,
 * and an end column points just past the last replaced character.
 */
export function offsetOf(source, { line, column }) {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const next = source.indexOf('\n', offset);
    if (next < 0) throw new Error(`line ${line} is past the end of the file`);
    offset = next + 1;
  }
  const lineEnd = source.indexOf('\n', offset);
  const length = (lineEnd < 0 ? source.length : lineEnd + 1) - offset;
  if (column < 1 || column - 1 > length)
    throw new Error(`column ${column} is outside line ${line}`);
  return offset + column - 1;
}

/** The source with the mutant's replacement, and the text it replaced. */
export function applyMutant(source, mutant) {
  const start = offsetOf(source, mutant.location.start);
  const end = offsetOf(source, mutant.location.end);
  if (end < start)
    throw new Error(`mutant ${mutant.id}: its location ends before it starts`);
  return {
    mutated: source.slice(0, start) + mutant.replacement + source.slice(end),
    original: source.slice(start, end),
  };
}

const restorers = new Set();
const restoreAll = () => {
  for (const restore of restorers) restore();
};

/**
 * Plants the mutant in `file` while `fn` runs and puts the original back
 * afterwards, whatever `fn` does. A stopped job (SIGINT/SIGTERM) restores too.
 */
export async function withMutant(file, mutant, fn) {
  const source = fs.readFileSync(file, 'utf8');
  const { mutated, original } = applyMutant(source, mutant);
  const restore = () => {
    if (fs.readFileSync(file, 'utf8') !== source)
      fs.writeFileSync(file, source);
  };
  restorers.add(restore);
  try {
    fs.writeFileSync(file, mutated);
    return await fn({ original });
  } finally {
    restore();
    restorers.delete(restore);
  }
}

/** One line of a code fragment, short enough for a table cell. */
export function snippet(text, max = 60) {
  const one = String(text).replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** Counts per group: judged, killed, missed by the judges, errors. */
export function tally(results) {
  const counts = {};
  for (const status of Object.keys(GROUPS))
    counts[status] = { total: 0, killed: 0, missed: 0, errors: 0 };
  for (const r of results) {
    const c = counts[r.unitStatus];
    if (!c) continue;
    c.total++;
    if (r.status === 'Killed' || r.status === 'Timeout') c.killed++;
    else if (r.status === 'Survived') c.missed++;
    else c.errors++;
  }
  return counts;
}

/**
 * The GitLab metrics report (one `name value` per line). A Timeout counts as
 * a kill, as in Stryker: a judge that never finishes is noticed. An error (the
 * mutant couldn't be judged) is in the total but not a kill.
 */
export function metricsText(results) {
  const counts = tally(results);
  const lines = [];
  for (const [status, name] of Object.entries(GROUPS)) {
    lines.push(`${name} ${counts[status].killed}`);
    lines.push(`${name}_total ${counts[status].total}`);
  }
  return `${lines.join('\n')}\n`;
}

const xml = text =>
  String(text).replace(
    /[<>&"]/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]
  );

/** Where a mutant is and what it does, e.g. `src/a.ts:12:5 EqualityOperator: a < b → a <= b`. */
export function describeMutant(r) {
  const at = `${r.file}:${r.location.start.line}:${r.location.start.column}`;
  return `${at} ${r.mutatorName}: ${snippet(r.original ?? '?')} → ${snippet(r.replacement)}`;
}

/** One test case per mutant; a mutant the judges miss is a failure. */
export function junitXml(results, name = 'corpus-survivors') {
  const cases = results.map(r => {
    const head = `  <testcase classname="survivors.${xml(r.unitStatus)}" name="${xml(`#${r.id} ${describeMutant(r)}`)}" time="${r.seconds ?? 0}">`;
    let body = '';
    if (r.status === 'Survived')
      body = `<failure message="the corpus judged it like the unmutated build">${xml(describeMutant(r))}</failure>`;
    else if (r.status === 'Error')
      body = `<error message="${xml(snippet(r.detail ?? 'error', 200))}">${xml(r.detail ?? '')}</error>`;
    else if (r.detail) body = `<system-out>${xml(r.detail)}</system-out>`;
    return `${head}${body}</testcase>`;
  });
  const failures = results.filter(r => r.status === 'Survived').length;
  const errors = results.filter(r => r.status === 'Error').length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${xml(name)}" tests="${results.length}" failures="${failures}" errors="${errors}">\n${cases.join('\n')}\n</testsuite>\n`;
}

/**
 * The shards of one run, checked: all `total` present, once each, judged from
 * the same report and source. Returns every mutant's result, by id.
 */
export function combineShards(shards, total) {
  const seen = new Map();
  for (const s of shards) {
    if (s.shard.total !== total)
      throw new Error(
        `shard ${s.shard.index}/${s.shard.total} is from a run of ${s.shard.total} shards, expected ${total}`
      );
    if (seen.has(s.shard.index))
      throw new Error(`shard ${s.shard.index} appears twice`);
    seen.set(s.shard.index, s);
  }
  const missing = [];
  for (let i = 1; i <= total; i++) if (!seen.has(i)) missing.push(i);
  if (missing.length)
    throw new Error(
      `missing shard(s) ${missing.join(', ')} of ${total}: a partial sum would undercount`
    );
  const fingerprints = new Set(shards.map(s => s.fingerprint));
  if (fingerprints.size > 1)
    throw new Error('the shards judged different reports or sources');
  return shards
    .flatMap(s => s.results)
    .sort((a, b) => Number(a.id) - Number(b.id) || a.id.localeCompare(b.id));
}

const md = text => String(text).replace(/[|`\\]/g, c => `\\${c}`);

/** A short page for the merge request: the numbers, then every mutant the judges miss. */
export function summaryMarkdown(results, meta = {}) {
  const counts = tally(results);
  const s = counts.Survived;
  const u = counts.NoCoverage;
  const missed = results.filter(r => r.status === 'Survived');
  const errors = results.filter(r => r.status === 'Error');
  const byProblem = {};
  for (const r of results)
    if (r.killedBy) byProblem[r.killedBy] = (byProblem[r.killedBy] ?? 0) + 1;
  const lines = [
    '# Judges vs the mutants the unit tests miss',
    '',
    meta.where ? `${meta.where}\n` : '',
    `- **Survivors** (unit tests ran the code and passed): the corpus kills **${s.killed} of ${s.total}**${s.errors ? `, ${s.errors} could not be judged` : ''}.`,
    `- **Untested** (no unit test runs the code, NoCoverage): the corpus kills **${u.killed} of ${u.total}**${u.errors ? `, ${u.errors} could not be judged` : ''}.`,
    `- Killed means: \`node corpus/run.mjs\` judged some solution or step differently than on the unmutated build, the same way in two runs. Timeouts count as kills (${results.filter(r => r.status === 'Timeout').length} here).`,
  ];
  const b = meta.baseline;
  if (b)
    lines.push(
      b.red.length || b.flaky.length
        ? `- **Baseline not clean**: the unmutated build (judged twice per shard) differs from the pinned verdicts on ${b.red.join(', ') || 'none'}${b.flaky.length ? `, and judged ${b.flaky.join(', ')} differently between runs` : ''}. Only differences beyond those count, so kills on those problems are undercounted.`
        : `- Baseline: the unmutated build matches the pinned verdicts on all ${b.problems} problems, twice in every shard.`
    );
  lines.push('');
  if (Object.keys(byProblem).length) {
    lines.push('First problem to catch each killed mutant:', '');
    for (const [p, n] of Object.entries(byProblem).sort((a, b) => b[1] - a[1]))
      lines.push(`- \`${p}\`: ${n}`);
    lines.push('');
  }
  lines.push(
    `## Missed by the unit tests and by the judges (${missed.length})`,
    ''
  );
  if (missed.length) {
    lines.push(
      '| id | unit tests | where | mutator | original | replacement | type-checks |',
      '|---|---|---|---|---|---|---|'
    );
    for (const r of missed)
      lines.push(
        `| ${md(r.id)} | ${r.unitStatus === 'NoCoverage' ? 'never run' : 'survived'} | ${md(`${r.file}:${r.location.start.line}`)} | ${md(r.mutatorName)} | \`${md(snippet(r.original ?? ''))}\` | \`${md(snippet(r.replacement))}\` | ${r.typeErrors ? 'no' : 'yes'} |`
      );
  } else lines.push('None.');
  if (errors.length) {
    lines.push('', `## Could not be judged (${errors.length})`, '');
    for (const r of errors)
      lines.push(`- #${md(r.id)} ${md(describeMutant(r))}: ${md(r.detail)}`);
  }
  lines.push(
    '',
    '"type-checks: no" means `tsc` rejects the mutant, so `npm run build` would fail on it although the emitted JavaScript ran.'
  );
  return `${lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Running things

/**
 * Runs a command; on timeout kills it with all its children (polyman spawns
 * compilers and solutions). Resolves { code, timedOut, output }.
 */
export function run(command, args, { cwd = ROOT, timeoutMs, env } = {}) {
  return new Promise(resolve => {
    const windows = process.platform === 'win32';
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      detached: !windows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const keep = chunk => {
      output = (output + chunk).slice(-20000);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            if (windows)
              spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
            else process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }, timeoutMs)
      : null;
    child.on('error', error => {
      if (timer) clearTimeout(timer);
      resolve({ code: null, timedOut, output: `${output}\n${error.message}` });
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({ code, timedOut, output });
    });
  });
}

async function build() {
  const result = await run(process.execPath, [TSC], {
    timeoutMs: BUILD_TIMEOUT_MS,
  });
  return {
    ok: result.code === 0,
    timedOut: result.timedOut,
    output: result.output,
  };
}

function corpusProblems() {
  const dir = path.join(CORPUS, 'problems');
  return fs
    .readdirSync(dir)
    .filter(name => fs.statSync(path.join(dir, name)).isDirectory())
    .sort();
}

/**
 * Runs run.mjs on one problem and returns its summary entry, or a failure
 * when it produced none. Exit 1 only means the problem differs from the
 * pinned verdicts; the comparison with the baseline decides what that means.
 */
async function judge(problem, work, timeoutMs) {
  const junit = path.join(work, problem, 'junit.xml');
  const result = await run(
    process.execPath,
    [path.join(CORPUS, 'run.mjs'), '--only', problem, '--junit', junit],
    { timeoutMs }
  );
  if (result.timedOut) return { timedOut: true };
  try {
    const summary = JSON.parse(
      fs.readFileSync(path.join(path.dirname(junit), 'summary.json'), 'utf8')
    );
    const entry = summary.problems.find(p => p.name === problem);
    if (entry) return { entry };
  } catch {
    // no summary: reported as a failure below
  }
  return {
    entry: {
      name: problem,
      failures: [
        `run.mjs exited ${result.code} without a summary: ${snippet(result.output.slice(-500), 300)}`,
      ],
    },
  };
}

function parseArgs(argv) {
  const args = {
    mode: 'judge',
    report: path.join(CORPUS, 'out', 'mutation', 'mutation.json'),
    shard: { index: 1, total: 1 },
    shards: null,
    out: path.join(CORPUS, 'out', 'survivors'),
    timeout: 600,
    only: null,
  };
  const value = (i, flag) => {
    const v = argv[i];
    if (v === undefined || v.startsWith('--'))
      throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (i === 0 && arg === 'report') args.mode = 'report';
    else if (arg === '--report') args.report = path.resolve(value(++i, arg));
    else if (arg === '--shard') args.shard = parseShard(value(++i, arg));
    else if (arg === '--shards') args.shards = Number(value(++i, arg));
    else if (arg === '--out') args.out = path.resolve(value(++i, arg));
    else if (arg === '--timeout') args.timeout = Number(value(++i, arg));
    else if (arg === '--only') args.only = new Set(value(++i, arg).split(','));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!(args.timeout > 0)) throw new Error('--timeout must be seconds > 0');
  return args;
}

const where = () =>
  process.env.CI_PIPELINE_URL
    ? `Pipeline [${process.env.CI_PIPELINE_ID}](${process.env.CI_PIPELINE_URL}), commit ${process.env.CI_COMMIT_SHORT_SHA}.`
    : 'Local run.';

async function judgeShard(args) {
  const report = JSON.parse(fs.readFileSync(args.report, 'utf8'));
  const all = selectMutants(report);
  let mine = shardOf(all, args.shard);
  if (args.only) mine = mine.filter(m => args.only.has(m.id));

  // Stryker's locations are only valid for the source it mutated
  const hash = crypto.createHash('sha256');
  for (const file of [...new Set(all.map(m => m.file))].sort()) {
    const onDisk = fs.readFileSync(path.join(ROOT, file), 'utf8');
    if (onDisk !== report.files[file].source)
      throw new Error(
        `${file} differs from the source in ${path.relative(ROOT, args.report)}; run Stryker on this commit first`
      );
    hash.update(file).update(onDisk);
  }
  const fingerprint = hash.digest('hex').slice(0, 16);
  const tag = `shard ${args.shard.index}/${args.shard.total}`;
  console.log(
    `${tag}: ${mine.length} of ${all.length} mutants (Survived + NoCoverage)`
  );

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'polyman-survivors-'));
  const problems = corpusProblems();
  const timeoutMs = args.timeout * 1000;

  // The unmutated build, judged in this same job: kills are differences from it
  const base = await build();
  if (!base.ok) throw new Error(`the unmutated build fails:\n${base.output}`);
  // Judged twice: a difference either run shows is not held against a mutant
  const baseline = { problems: [] };
  for (const problem of problems) {
    const runs = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const judged = await judge(
        problem,
        path.join(work, `baseline-${attempt}`),
        timeoutMs
      );
      if (judged.timedOut)
        throw new Error(`the unmutated build timed out on ${problem}`);
      runs.push(judged.entry);
    }
    baseline.problems.push(mergeBaseline(runs));
  }
  const red = baseline.problems.filter(p => p.failures.length);
  const flaky = baseline.problems.filter(p => p.flaky);
  console.log(
    `baseline: ${problems.length - red.length}/${problems.length} problems match${red.length ? ` (red: ${red.map(p => p.name).join(', ')}; only new differences count)` : ''}${flaky.length ? `; flaky: ${flaky.map(p => p.name).join(', ')}` : ''}`
  );

  const results = [];
  for (const [n, mutant] of mine.entries()) {
    const started = Date.now();
    const deadline = started + timeoutMs;
    const result = { ...mutant, status: 'Error' };
    try {
      await withMutant(
        path.join(ROOT, mutant.file),
        mutant,
        async ({ original }) => {
          result.original = original;
          const built = await build();
          // tsc emits JavaScript despite type errors (noEmitOnError is off),
          // so the judges still run; the summary says it wouldn't build
          result.typeErrors = !built.ok;
          if (built.timedOut) throw new Error('tsc timed out');
          for (const problem of problems) {
            const only = {
              problems: baseline.problems.filter(p => p.name === problem),
            };
            // judged twice before it counts: a compile or timing flake in one
            // run is not a kill (the second run must show the same difference)
            let added = null;
            for (let attempt = 0; attempt < 2; attempt++) {
              const left = deadline - Date.now();
              const judged =
                left > 0
                  ? await judge(problem, path.join(work, mutant.id), left)
                  : { timedOut: true };
              if (judged.timedOut) {
                result.status = 'Timeout';
                result.killedBy = problem;
                result.detail = `no verdict within ${args.timeout}s (on ${problem})`;
                return;
              }
              const now = regressions(only, { problems: [judged.entry] }).added;
              added = added === null ? now : sameDifferences(added, now);
              if (!added.length) break;
            }
            if (added.length) {
              result.status = 'Killed';
              result.killedBy = problem;
              result.detail = added
                .map(a => `${a.problem}: ${a.message}`)
                .join('\n');
              return;
            }
          }
          result.status = 'Survived';
        }
      );
    } catch (error) {
      result.status = 'Error';
      result.detail = error instanceof Error ? error.message : String(error);
    }
    result.seconds = Math.round((Date.now() - started) / 100) / 10;
    fs.rmSync(path.join(work, mutant.id), { recursive: true, force: true });
    results.push(result);
    console.log(
      `[${n + 1}/${mine.length}] ${result.status.padEnd(8)} #${result.id} (${result.unitStatus}) ${describeMutant(result)}${result.killedBy ? ` — ${result.killedBy}` : ''} ${result.seconds}s${result.typeErrors ? ' [type error]' : ''}`
    );
  }

  // leave dist/ built from the real source
  const rebuilt = await build();
  if (!rebuilt.ok) console.error('warning: the final rebuild failed');
  fs.rmSync(work, { recursive: true, force: true });

  fs.mkdirSync(args.out, { recursive: true });
  const name = `${args.shard.index}-of-${args.shard.total}`;
  fs.writeFileSync(
    path.join(args.out, `shard-${name}.json`),
    `${JSON.stringify(
      {
        shard: args.shard,
        fingerprint,
        report: path.relative(ROOT, args.report),
        baseline,
        results,
      },
      null,
      2
    )}\n`
  );
  fs.writeFileSync(
    path.join(args.out, `junit-${name}.xml`),
    junitXml(results, `corpus-survivors-${name}`)
  );
  fs.writeFileSync(
    path.join(args.out, `metrics-${name}.txt`),
    metricsText(results)
  );
  process.stdout.write(metricsText(results));
}

function reportShards(args) {
  const files = fs
    .readdirSync(args.out)
    .filter(f => /^shard-\d+-of-\d+\.json$/.test(f));
  const shards = files.map(f =>
    JSON.parse(fs.readFileSync(path.join(args.out, f), 'utf8'))
  );
  const total = args.shards ?? shards[0]?.shard.total;
  if (!total) throw new Error(`no shard results in ${args.out}`);
  const results = combineShards(shards, total);
  fs.writeFileSync(path.join(args.out, 'metrics.txt'), metricsText(results));
  const names = new Set();
  const red = new Set();
  const flaky = new Set();
  for (const s of shards)
    for (const p of s.baseline?.problems ?? []) {
      names.add(p.name);
      if (p.failures.length) red.add(p.name);
      if (p.flaky) flaky.add(p.name);
    }
  const page = summaryMarkdown(results, {
    where: where(),
    baseline: { problems: names.size, red: [...red], flaky: [...flaky] },
  });
  fs.writeFileSync(path.join(args.out, 'summary.md'), page);
  console.log(page);
  process.stdout.write(metricsText(results));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'report') return reportShards(args);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      restoreAll();
      process.exit(130);
    });
  await judgeShard(args);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(error => {
    restoreAll();
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  });
