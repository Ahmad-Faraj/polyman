#!/usr/bin/env node
/**
 * An independent judgment of a corpus problem, without polyman: compiles the
 * generators, validator, checker and solutions with g++/javac directly,
 * generates the tests from the script, runs every solution with the time
 * limit, and asks the checker about every test it ran. Prints what
 * corpus/expected/<problem>.json should say, so a pinned verdict never comes
 * from the program it judges (`run.mjs --record` trusts polyman).
 *
 * Conventions shared with the expected files: a solution's run stops at its
 * first TLE or runtime error (polyman stops there too, and the later tests are
 * not in the report); every test that ran is judged by the checker, not only
 * the ones before the first wrong answer. The checker's exit code is the
 * verdict: 0 OK, 1 WA, 2 PE (3, FAIL, means the jury is wrong and stops the run).
 *
 * It also runs the validator and checker self-tests from Config.json against
 * their expected verdicts, and warns about any OK test that used more than
 * half the time limit (a verdict that a slower machine could flip).
 *
 * Usage:
 *   node corpus/truth.mjs <problem> [--write]   (--write: corpus/expected/<problem>.json)
 *   node corpus/truth.mjs [problem...] --check  (every problem by default; exits 1
 *                                                when a pinned file disagrees)
 *
 * Needs g++, javac/java and Python 3 (python3, or python on Windows). On
 * Windows, testlib validators expect CR LF line ends, so the validator steps
 * come out false there; CI on Linux is the reference.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORPUS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(CORPUS);
const WIN = process.platform === 'win32';
const EXE = WIN ? '.exe' : '';
const PYTHON = WIN ? 'python' : 'python3';

const STEPS = [
  'read-config',
  'compile-generators',
  'generate-tests',
  'compile-validator',
  'test-validator',
  'validate-tests',
  'compile-checker',
  'test-checker',
  'compile-solutions',
  'run-solutions',
  'verify-solutions',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  if (result.error && result.error.code !== 'ETIMEDOUT') throw result.error;
  return result;
}

function must(result, what) {
  if (result.status !== 0)
    throw new Error(`${what} failed:\n${result.stderr || result.stdout}`);
  return result;
}

/** Compiles a C++ source next to itself, as polyman does, and returns the binary. */
function compileCpp(source, root) {
  const binary = source.replace(/\.(cpp|cc|cxx)$/, '') + EXE;
  must(
    run('g++', ['-O2', '-std=c++17', '-iquote', root, '-o', binary, source]),
    `g++ ${path.relative(root, source)}`
  );
  return binary;
}

/** The command (program and arguments) that runs a solution. */
function compileSolution(source, root) {
  if (/\.(cpp|cc|cxx)$/.test(source)) return [compileCpp(source, root)];
  if (source.endsWith('.java')) {
    must(run('javac', [source]), `javac ${path.relative(root, source)}`);
    return [
      'java',
      `-Xmx256m`,
      '-cp',
      path.dirname(source),
      path.basename(source, '.java'),
    ];
  }
  if (source.endsWith('.py')) return [PYTHON, source];
  throw new Error(`unsupported solution ${source}`);
}

/** Expands the script's generator lines: `gen args > $` or `> N`. */
function scriptCommands(script) {
  const commands = [];
  for (const raw of script.replace(/<#--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.includes('<#') || line.includes('${'))
      throw new Error(`FreeMarker is not supported here: ${line}`);
    const [left, target] = line.split('>').map(s => s.trim());
    const [generator, ...args] = left.split(/\s+/);
    commands.push({ generator, args, target });
  }
  return commands;
}

function buildTests(config, dir, generators) {
  const testset = config.testsets[0];
  const tests = new Map();
  for (const manual of testset.manualTests ?? [])
    tests.set(
      manual.index,
      fs.readFileSync(path.join(dir, manual.input), 'utf8')
    );
  const gs = testset.generatorScript;
  const script =
    gs.script ?? fs.readFileSync(path.join(dir, gs.scriptFile), 'utf8');
  for (const { generator, args, target } of scriptCommands(script)) {
    let index = Number(target);
    if (target === '$') {
      index = 1;
      while (tests.has(index)) index++;
    }
    if (!Number.isInteger(index) || tests.has(index))
      throw new Error(`bad or duplicate target ${target}`);
    const result = must(
      run(generators[generator], args),
      `${generator} ${args.join(' ')}`
    );
    tests.set(index, result.stdout);
  }
  const folder = path.join(dir, 'truth-tests');
  fs.mkdirSync(folder, { recursive: true });
  return [...tests.keys()]
    .sort((a, b) => a - b)
    .map(index => {
      const file = path.join(folder, `test${index}.txt`);
      fs.writeFileSync(file, tests.get(index));
      return { index, file, testset: testset.name };
    });
}

/** Runs a command with a file as stdin and another as stdout. */
function runOnFile(command, input, output, timeoutMs) {
  const stdin = fs.openSync(input, 'r');
  const stdout = fs.openSync(output, 'w');
  const started = process.hrtime.bigint();
  const result = spawnSync(command[0], command.slice(1), {
    stdio: [stdin, stdout, 'pipe'],
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    encoding: 'utf8',
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  fs.closeSync(stdin);
  fs.closeSync(stdout);
  const timedOut = result.error?.code === 'ETIMEDOUT' || ms >= timeoutMs;
  return { status: result.status, timedOut, ms, stderr: result.stderr };
}

const CHECKER_VERDICTS = { 0: 'OK', 1: 'WA', 2: 'PE' };
const SELF_TEST_VERDICTS = {
  OK: 'OK',
  WRONG_ANSWER: 'WA',
  WA: 'WA',
  PRESENTATION_ERROR: 'PE',
  PE: 'PE',
};

function checkerVerdict(checker, input, output, answer) {
  const result = run(checker, [input, output, answer]);
  const verdict = CHECKER_VERDICTS[result.status];
  if (!verdict)
    throw new Error(
      `checker exit ${result.status} (FAIL?): ${result.stderr.trim()}`
    );
  return { verdict, message: result.stderr.trim() };
}

/** Does a solution's set of verdicts satisfy its tag (Polygon's meaning)? */
export function matchesTag(tag, verdicts) {
  const kinds = new Set(verdicts.map(v => v.split(':').pop()));
  const only = (...allowed) => [...kinds].every(k => allowed.includes(k));
  switch (tag) {
    case 'MA':
    case 'OK':
      return only('OK');
    case 'WA':
      return kinds.has('WA') && only('OK', 'WA');
    case 'PE':
      return kinds.has('PE') && only('OK', 'PE');
    case 'TL':
      return kinds.has('TLE') && only('OK', 'TLE');
    case 'TO':
      return only('OK', 'TLE');
    case 'RE':
      return kinds.has('RTE') && only('OK', 'RTE');
    case 'ML':
      return kinds.has('MLE') && only('OK', 'MLE');
    case 'RJ':
      return !only('OK');
    default:
      throw new Error(`unknown tag ${tag}`);
  }
}

function judge(name) {
  const source = path.join(CORPUS, 'problems', name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `truth-${name}-`));
  fs.cpSync(source, dir, { recursive: true });
  fs.copyFileSync(
    path.join(CORPUS, 'vendor', 'testlib.h'),
    path.join(dir, 'testlib.h')
  );
  const config = JSON.parse(
    fs.readFileSync(path.join(dir, 'Config.json'), 'utf8')
  );
  const warnings = [];
  const steps = Object.fromEntries(STEPS.map(s => [s, true]));

  const generators = {};
  for (const g of config.generators)
    generators[g.name] = compileCpp(path.join(dir, g.source), dir);
  const tests = buildTests(config, dir, generators);

  const validator = compileCpp(path.join(dir, config.validator.source), dir);
  const validatorTests = config.validator.testsFilePath
    ? JSON.parse(
        fs.readFileSync(path.join(dir, config.validator.testsFilePath), 'utf8')
      ).tests
    : [];
  validatorTests.forEach((t, i) => {
    const result = run(validator, [], { input: t.input });
    const got = result.status === 0 ? 'VALID' : 'INVALID';
    if (got !== t.expectedVerdict) {
      steps['test-validator'] = false;
      warnings.push(
        `validator test ${i + 1}: expected ${t.expectedVerdict}, got ${got}`
      );
    }
  });
  for (const t of tests) {
    const result = run(validator, [], { input: fs.readFileSync(t.file) });
    if (result.status !== 0) {
      steps['validate-tests'] = false;
      warnings.push(`test ${t.index} is invalid: ${result.stderr.trim()}`);
    }
  }

  const checkerSource = config.checker.isStandard
    ? path.join(dir, `std-${config.checker.source}`)
    : path.join(dir, config.checker.source);
  if (config.checker.isStandard)
    fs.copyFileSync(
      path.join(ROOT, 'assets', 'checkers', config.checker.source),
      checkerSource
    );
  const checker = compileCpp(checkerSource, dir);
  const checkerTests =
    !config.checker.isStandard && config.checker.testsFilePath
      ? JSON.parse(
          fs.readFileSync(path.join(dir, config.checker.testsFilePath), 'utf8')
        ).tests
      : [];
  checkerTests.forEach((t, i) => {
    const files = ['input', 'output', 'answer'].map(part => {
      const file = path.join(dir, `checker-test-${i + 1}-${part}.txt`);
      fs.writeFileSync(file, t[part]);
      return file;
    });
    const result = run(checker, files);
    const got = CHECKER_VERDICTS[result.status] ?? `exit ${result.status}`;
    const want = SELF_TEST_VERDICTS[t.expectedVerdict];
    if (got !== want) {
      steps['test-checker'] = false;
      warnings.push(
        `checker test ${i + 1}: expected ${t.expectedVerdict}, got ${got}`
      );
    }
  });

  const timeLimit = config.timeLimit;
  const outputs = path.join(dir, 'truth-outputs');
  fs.mkdirSync(outputs, { recursive: true });
  const main = config.solutions.find(s => s.tag === 'MA');
  const ordered = [main, ...config.solutions.filter(s => s !== main)];
  const commands = Object.fromEntries(
    ordered.map(s => [s.name, compileSolution(path.join(dir, s.source), dir)])
  );

  const solutions = {};
  for (const solution of ordered) {
    const verdicts = [];
    for (const test of tests) {
      const output = path.join(outputs, `${solution.name}-${test.index}.txt`);
      const answer = path.join(outputs, `${main.name}-${test.index}.txt`);
      const ran = runOnFile(
        commands[solution.name],
        test.file,
        output,
        timeLimit
      );
      const id = `${test.testset}#${test.index}`;
      if (ran.timedOut) {
        verdicts.push(`${id}:TLE`);
        break;
      }
      if (ran.status !== 0) {
        verdicts.push(`${id}:RTE`);
        break;
      }
      if (ran.ms > timeLimit / 2)
        warnings.push(
          `${solution.name} on ${id}: ${Math.round(ran.ms)} ms of ${timeLimit}, close to the limit`
        );
      const { verdict } = checkerVerdict(checker, test.file, output, answer);
      verdicts.push(`${id}:${verdict}`);
    }
    solutions[solution.name] = {
      tag: solution.tag,
      matchesTag: matchesTag(solution.tag, verdicts),
      verdicts,
    };
  }
  fs.rmSync(dir, { recursive: true, force: true });

  // Keep Config.json's order of solutions, as polyman's report does.
  const inConfigOrder = Object.fromEntries(
    config.solutions.map(s => [s.name, solutions[s.name]])
  );
  const allSteps = Object.values(steps).every(Boolean);
  const allMatch = Object.values(solutions).every(s => s.matchesTag);
  const firstFailed = STEPS.find(s => !steps[s]) ?? null;
  return {
    expected: {
      ok: allSteps && allMatch,
      failedStep: firstFailed ?? (allMatch ? null : 'verify-solutions'),
      steps,
      solutions: inConfigOrder,
    },
    warnings,
  };
}

/** Where an independent judgment and a pinned expected file disagree. */
export function differences(truth, pinned) {
  const diffs = [];
  for (const key of ['ok', 'failedStep'])
    if (truth[key] !== pinned[key])
      diffs.push(`${key}: judged ${truth[key]}, pinned ${pinned[key]}`);
  for (const step of new Set([
    ...Object.keys(truth.steps),
    ...Object.keys(pinned.steps),
  ]))
    if (truth.steps[step] !== pinned.steps[step])
      diffs.push(
        `step ${step}: judged ${truth.steps[step]}, pinned ${pinned.steps[step]}`
      );
  for (const name of new Set([
    ...Object.keys(truth.solutions),
    ...Object.keys(pinned.solutions),
  ])) {
    const a = truth.solutions[name];
    const b = pinned.solutions[name];
    if (!a || !b) {
      diffs.push(`solution ${name}: ${a ? 'not pinned' : 'not judged'}`);
      continue;
    }
    if (a.tag !== b.tag || a.matchesTag !== b.matchesTag)
      diffs.push(
        `solution ${name}: judged ${a.tag}/matchesTag=${a.matchesTag}, pinned ${b.tag}/matchesTag=${b.matchesTag}`
      );
    if (a.verdicts.join() !== b.verdicts.join())
      diffs.push(
        `solution ${name}: judged ${a.verdicts.join(' ')}, pinned ${b.verdicts.join(' ')}`
      );
  }
  return diffs;
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const check = args.includes('--check');
  let names = args.filter(a => !a.startsWith('--'));
  if (!names.length && check)
    names = fs.readdirSync(path.join(CORPUS, 'problems')).sort();
  if (!names.length || (write && check)) {
    console.error(
      'usage: node corpus/truth.mjs <problem> [--write]\n       node corpus/truth.mjs [problem...] --check'
    );
    process.exit(2);
  }
  let failed = 0;
  for (const name of names) {
    const { expected, warnings } = judge(name);
    const json = `${JSON.stringify(expected, null, 2)}\n`;
    for (const w of warnings) console.error(`! ${name}: ${w}`);
    if (write) {
      fs.writeFileSync(path.join(CORPUS, 'expected', `${name}.json`), json);
      console.error(`wrote corpus/expected/${name}.json`);
    } else if (check) {
      const pinned = JSON.parse(
        fs.readFileSync(path.join(CORPUS, 'expected', `${name}.json`), 'utf8')
      );
      const diffs = differences(expected, pinned);
      console.log(
        `${diffs.length ? 'FAIL' : 'ok  '} ${name}: ${diffs.length ? `${diffs.length} difference(s) from the pinned verdicts` : 'the independent judgment matches the pinned verdicts'}`
      );
      for (const d of diffs) console.log(`     ✗ ${d}`);
      if (diffs.length) failed++;
      const out = path.join(CORPUS, 'out', 'truth');
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, `${name}.json`), json);
    } else {
      process.stdout.write(json);
    }
  }
  if (failed) process.exit(1);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
