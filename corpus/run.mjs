#!/usr/bin/env node
/**
 * Golden + mutant corpus check for polyman.
 *
 * Runs `polyman verify --json` on every problem in corpus/problems and
 * compares each solution's per-test verdicts with corpus/expected/<problem>.json.
 * Exits 1 on any difference, so a change that makes polyman judge differently
 * fails the pipeline even when the unit tests stay green.
 *
 * Timing is not judged exactly: an expected OK that comes back TLE is reported
 * as a warning (slow runner), never the other way round. A solution that spins
 * forever must keep getting TLE.
 *
 * Usage:
 *   node corpus/run.mjs [--polyman dist/cli.js] [--record] [--only a,b]
 *                       [--junit corpus/out/junit.xml] [--keep]
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORPUS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(CORPUS);
const PROBLEMS = path.join(CORPUS, 'problems');
const EXPECTED = path.join(CORPUS, 'expected');
const TESTLIB = path.join(CORPUS, 'vendor', 'testlib.h');
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

function parseArgs(argv) {
  const args = {
    polyman: path.join(ROOT, 'dist', 'cli.js'),
    record: false,
    only: null,
    junit: path.join(CORPUS, 'out', 'junit.xml'),
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--record') args.record = true;
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--polyman') args.polyman = path.resolve(argv[++i]);
    else if (arg === '--junit') args.junit = path.resolve(argv[++i]);
    else if (arg === '--only') args.only = new Set(argv[++i].split(','));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

/** First line of `<tool> --version`, or null when the tool is missing. */
function toolVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const text = `${result.stdout}${result.stderr}`.trim();
  return text.split('\n')[0];
}

function toolchain() {
  return {
    node: process.version,
    'g++': toolVersion('g++'),
    java: toolVersion('java', ['-version']),
    python: toolVersion('python'),
    python3: toolVersion('python3'),
  };
}

/** Runs polyman verify on a fresh copy of the problem and returns its JSON report. */
function verifyProblem(name, args) {
  const work = fs.mkdtempSync(
    path.join(os.tmpdir(), `polyman-corpus-${name}-`)
  );
  fs.cpSync(path.join(PROBLEMS, name), work, { recursive: true });
  fs.copyFileSync(TESTLIB, path.join(work, 'testlib.h'));

  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [args.polyman, 'verify', '--json'],
    {
      cwd: work,
      encoding: 'utf8',
      timeout: VERIFY_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  const seconds = (Date.now() - started) / 1000;
  if (!args.keep) fs.rmSync(work, { recursive: true, force: true });

  let report = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {
    // Reported below with the captured stderr.
  }
  return { report, seconds, stderr: result.stderr ?? '', work };
}

/** Reduces a verify report to the parts the corpus pins. */
function outcomeOf(report) {
  const steps = {};
  for (const step of report.steps) steps[step.name] = step.ok;
  const solutions = {};
  for (const solution of report.solutions) {
    const tests = [...solution.tests].sort(
      (a, b) => a.testset.localeCompare(b.testset) || a.index - b.index
    );
    solutions[solution.name] = {
      tag: solution.tag,
      matchesTag: solution.matchesTag,
      verdicts: tests.map(
        test => `${test.testset}#${test.index}:${test.verdict}`
      ),
    };
  }
  return { ok: report.ok, failedStep: report.failedStep, steps, solutions };
}

/** Lists differences as { kind: 'failure' | 'warning', message }. */
function compare(expected, actual) {
  const diffs = [];
  const fail = message => diffs.push({ kind: 'failure', message });
  const warn = message => diffs.push({ kind: 'warning', message });

  for (const [step, ok] of Object.entries(expected.steps)) {
    if (actual.steps[step] !== ok)
      fail(`step ${step}: expected ok=${ok}, got ${actual.steps[step]}`);
  }
  for (const [name, want] of Object.entries(expected.solutions)) {
    const got = actual.solutions[name];
    if (!got) {
      fail(`solution ${name}: missing from report`);
      continue;
    }
    if (got.verdicts.length !== want.verdicts.length) {
      fail(
        `solution ${name}: expected ${want.verdicts.length} tests, got ${got.verdicts.length}`
      );
      continue;
    }
    let timingOnly = true;
    want.verdicts.forEach((wantTest, i) => {
      const gotTest = got.verdicts[i];
      if (gotTest === wantTest) return;
      const slower = wantTest.endsWith(':OK') && gotTest.endsWith(':TLE');
      if (slower)
        warn(
          `solution ${name}: ${wantTest} came back ${gotTest} (timing, not judged)`
        );
      else {
        timingOnly = false;
        fail(`solution ${name}: expected ${wantTest}, got ${gotTest}`);
      }
    });
    if (got.matchesTag !== want.matchesTag && !timingOnly) {
      fail(
        `solution ${name}: expected matchesTag=${want.matchesTag}, got ${got.matchesTag}`
      );
    }
  }
  for (const name of Object.keys(actual.solutions)) {
    if (!expected.solutions[name])
      fail(`solution ${name}: not pinned in expected file`);
  }
  return diffs;
}

const xml = text =>
  String(text).replace(
    /[<>&"]/g,
    c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]
  );

function writeJUnit(file, results) {
  const cases = [];
  for (const r of results) {
    const failures = r.diffs.filter(d => d.kind === 'failure');
    const warnings = r.diffs.filter(d => d.kind === 'warning');
    const body = failures.length
      ? `<failure message="${xml(failures.length)} difference(s)">${xml(failures.map(d => d.message).join('\n'))}</failure>`
      : '';
    const out = warnings.length
      ? `<system-out>${xml(warnings.map(d => d.message).join('\n'))}</system-out>`
      : '';
    cases.push(
      `  <testcase classname="corpus" name="${xml(r.name)}" time="${r.seconds}">${body}${out}</testcase>`
    );
  }
  const failed = results.filter(r =>
    r.diffs.some(d => d.kind === 'failure')
  ).length;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="polyman-corpus" tests="${results.length}" failures="${failed}">\n${cases.join('\n')}\n</testsuite>\n`
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tools = toolchain();
  console.log('toolchain:', JSON.stringify(tools));

  const names = fs
    .readdirSync(PROBLEMS)
    .filter(name => fs.statSync(path.join(PROBLEMS, name)).isDirectory())
    .filter(name => !args.only || args.only.has(name))
    .sort();

  const results = [];
  for (const name of names) {
    const run = verifyProblem(name, args);
    const expectedFile = path.join(EXPECTED, `${name}.json`);
    if (!run.report) {
      results.push({
        name,
        seconds: run.seconds,
        diffs: [
          {
            kind: 'failure',
            message: `polyman produced no JSON report:\n${run.stderr.slice(-2000)}`,
          },
        ],
      });
      continue;
    }
    const actual = outcomeOf(run.report);

    if (args.record) {
      fs.mkdirSync(EXPECTED, { recursive: true });
      fs.writeFileSync(expectedFile, `${JSON.stringify(actual, null, 2)}\n`);
      console.log(`recorded ${name} (${run.seconds}s)`);
      results.push({ name, seconds: run.seconds, diffs: [] });
      continue;
    }
    if (!fs.existsSync(expectedFile)) {
      results.push({
        name,
        seconds: run.seconds,
        diffs: [
          {
            kind: 'failure',
            message: 'no expected file; run with --record and review it',
          },
        ],
      });
      continue;
    }
    const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
    results.push({
      name,
      seconds: run.seconds,
      diffs: compare(expected, actual),
    });
  }

  writeJUnit(args.junit, results);
  const summary = {
    polyman: path.relative(ROOT, args.polyman),
    toolchain: tools,
    problems: results.map(r => ({
      name: r.name,
      seconds: r.seconds,
      failures: r.diffs.filter(d => d.kind === 'failure').map(d => d.message),
      warnings: r.diffs.filter(d => d.kind === 'warning').map(d => d.message),
    })),
  };
  fs.writeFileSync(
    path.join(path.dirname(args.junit), 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`
  );

  let failed = 0;
  for (const p of summary.problems) {
    const status = p.failures.length ? 'FAIL' : 'ok';
    if (p.failures.length) failed++;
    console.log(`${status.padEnd(4)} ${p.name} (${p.seconds}s)`);
    for (const message of p.failures) console.log(`     ✗ ${message}`);
    for (const message of p.warnings) console.log(`     ! ${message}`);
  }
  console.log(
    `${summary.problems.length - failed}/${summary.problems.length} problems match the corpus`
  );
  process.exit(failed ? 1 : 0);
}

main();
