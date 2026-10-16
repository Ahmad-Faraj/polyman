#!/usr/bin/env node
/**
 * Polygon round trip: does `polyman remote push` put on Polygon what the
 * problem folder says?
 *
 * Pushes a corpus problem to a Polygon problem with polyman, reads it back
 * through the Polygon API and compares it with the local folder: solutions
 * (tag and source type), checker and validator tests, generator script lines,
 * manual tests and statements. Exits 1 on any difference, and also reports
 * when polyman said the push succeeded although something is missing.
 *
 * Needs a Polygon account that can write to the problem:
 *   POLYGON_API_KEY, POLYGON_API_SECRET   (or ~/.polyman/api_key, secret_key)
 *   POLYGON_PROBLEM_ID                     (or --problem-id; without one a new
 *                                           problem is created and its ID printed)
 *
 * Usage:
 *   node corpus/polygon-roundtrip.mjs [--polyman dist/cli.js] [--problem sum-parity]
 *                                     [--problem-id N] [--junit corpus/out/junit-polygon.xml]
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CORPUS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(CORPUS);
const API = 'https://polygon.codeforces.com/api';

function parseArgs(argv) {
  const args = {
    polyman: path.join(ROOT, 'dist', 'cli.js'),
    problem: 'sum-parity',
    problemId: process.env.POLYGON_PROBLEM_ID || null,
    junit: path.join(CORPUS, 'out', 'junit-polygon.xml'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--polyman') args.polyman = path.resolve(argv[++i]);
    else if (arg === '--problem') args.problem = argv[++i];
    else if (arg === '--problem-id') args.problemId = argv[++i];
    else if (arg === '--junit') args.junit = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function credentials() {
  const fromEnv = [process.env.POLYGON_API_KEY, process.env.POLYGON_API_SECRET];
  if (fromEnv[0] && fromEnv[1]) return { key: fromEnv[0], secret: fromEnv[1] };
  const dir = path.join(os.homedir(), '.polyman');
  const read = f => fs.readFileSync(path.join(dir, f), 'utf8').trim();
  try {
    return { key: read('api_key'), secret: read('secret_key') };
  } catch {
    throw new Error(
      'No Polygon credentials: set POLYGON_API_KEY and POLYGON_API_SECRET'
    );
  }
}

/** One signed Polygon API call (https://codeforces.github.io/polygon-misc/API). */
async function polygon(creds, method, params) {
  const all = {
    ...params,
    apiKey: creds.key,
    time: Math.floor(Date.now() / 1000),
  };
  const pairs = Object.entries(all)
    .map(([k, v]) => [k, String(v)])
    .sort((a, b) =>
      a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0] < b[0] ? -1 : 1
    );
  const rand = crypto.randomBytes(3).toString('hex');
  const query = pairs.map(([k, v]) => `${k}=${v}`).join('&');
  const hash = crypto
    .createHash('sha512')
    .update(`${rand}/${method}?${query}#${creds.secret}`)
    .digest('hex');
  const response = await fetch(`${API}/${method}`, {
    method: 'POST',
    body: new URLSearchParams([...pairs, ['apiSig', rand + hash]]),
  });
  const data = await response.json();
  if (data.status !== 'OK') throw new Error(`${method}: ${data.comment}`);
  return data.result;
}

/** Line endings differ by platform; Polygon stores CRLF. Compare content only. */
const text = s => String(s ?? '').replace(/\r\n/g, '\n');
const base = p => path.basename(p);
const stem = p => path.basename(p, path.extname(p));
const readLocal = (dir, rel) =>
  rel && fs.existsSync(path.join(dir, rel))
    ? fs.readFileSync(path.join(dir, rel), 'utf8')
    : '';
const readJson = (dir, rel) =>
  rel && fs.existsSync(path.join(dir, rel))
    ? JSON.parse(readLocal(dir, rel))
    : null;

/**
 * The generator lines of a script as Polygon shows them per test: the
 * generator's file name (without extension) and its arguments, no target.
 * Returns null for scripts that use FreeMarker beyond comments.
 */
function scriptLines(script, generatorFiles) {
  const lines = [];
  for (const raw of script.replace(/<#--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.includes('<#') || line.includes('${')) return null;
    const command = line.split('>')[0].trim().split(/\s+/);
    command[0] = generatorFiles[command[0]] ?? command[0];
    lines.push(command.join(' '));
  }
  return lines;
}

/** Push with polyman, as a user would, with credentials in a throwaway home. */
function push(args, creds, problemDir) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'polyman-home-'));
  fs.mkdirSync(path.join(home, '.polyman'));
  fs.writeFileSync(path.join(home, '.polyman', 'api_key'), creds.key);
  fs.writeFileSync(path.join(home, '.polyman', 'secret_key'), creds.secret);
  const extra = args.problemId
    ? []
    : ['--yes', '--name', `polyman-corpus-${args.problem}-${Date.now()}`];
  const result = spawnSync(
    process.execPath,
    [args.polyman, 'remote', 'push', '.', ...extra],
    {
      cwd: problemDir,
      encoding: 'utf8',
      env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' },
      timeout: 15 * 60 * 1000,
    }
  );
  fs.rmSync(home, { recursive: true, force: true });
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

async function compare(creds, problemId, dir, config) {
  const checks = [];
  const check = (name, ok, detail = '') => checks.push({ name, ok, detail });
  const id = { problemId };

  // Solutions: every local one is on Polygon with the same tag and source type.
  const remoteSolutions = new Map(
    (await polygon(creds, 'problem.solutions', id)).map(s => [s.name, s])
  );
  for (const s of config.solutions ?? []) {
    const remote = remoteSolutions.get(base(s.source));
    if (!remote)
      check(`solution ${s.name}`, false, `${base(s.source)} is not on Polygon`);
    else if (remote.tag !== s.tag)
      check(
        `solution ${s.name}`,
        false,
        `tag ${remote.tag}, expected ${s.tag}`
      );
    else if (s.sourceType && remote.sourceType !== s.sourceType)
      check(
        `solution ${s.name}`,
        false,
        `source type ${remote.sourceType}, expected ${s.sourceType}`
      );
    else check(`solution ${s.name}`, true);
  }

  // Checker and its tests.
  if (config.checker && !config.checker.isStandard) {
    const checker = await polygon(creds, 'problem.checker', id);
    check(
      'checker',
      checker === base(config.checker.source),
      `Polygon uses ${checker}`
    );
  }
  const localChecker =
    readJson(dir, config.checker?.testsFilePath)?.tests ?? [];
  const remoteChecker = await polygon(creds, 'problem.checkerTests', id);
  const sameChecker = t => r =>
    text(r.input) === text(t.input) && text(r.answer) === text(t.answer);
  const missingChecker = localChecker.filter(
    t => !remoteChecker.some(sameChecker(t))
  ).length;
  check(
    'checker tests',
    missingChecker === 0,
    `${missingChecker} of ${localChecker.length} local tests are not on Polygon (it has ${remoteChecker.length})`
  );

  // Validator tests: same inputs, byte for byte apart from line endings.
  const localValidator =
    readJson(dir, config.validator?.testsFilePath)?.tests ?? [];
  const remoteValidator = await polygon(creds, 'problem.validatorTests', id);
  const missingValidator = localValidator.filter(
    t =>
      !remoteValidator.some(
        r =>
          text(r.input) === text(t.input) &&
          r.expectedVerdict === t.expectedVerdict
      )
  ).length;
  check(
    'validator tests',
    missingValidator === 0,
    `${missingValidator} of ${localValidator.length} local tests are not on Polygon (it has ${remoteValidator.length})`
  );

  // Tests: manual count and the generator script, line by line.
  const generatorFiles = Object.fromEntries(
    (config.generators ?? []).map(g => [g.name, stem(g.source)])
  );
  for (const testset of config.testsets ?? []) {
    const remote = (
      await polygon(creds, 'problem.tests', {
        ...id,
        testset: testset.name,
        noInputs: true,
      })
    ).sort((a, b) => a.index - b.index);
    const manual = remote.filter(t => t.manual).length;
    const localManual = (testset.manualTests ?? []).length;
    check(
      `testset ${testset.name} manual tests`,
      manual === localManual,
      `${manual} on Polygon, ${localManual} local`
    );

    const gs = testset.generatorScript ?? {};
    const script = gs.script ?? readLocal(dir, gs.scriptFile);
    const local = scriptLines(script, generatorFiles);
    const lines = remote
      .filter(t => !t.manual)
      .map(t => t.scriptLine.trim().split(/\s+/).join(' '));
    if (local === null)
      check(
        `testset ${testset.name} script`,
        true,
        'skipped: FreeMarker script'
      );
    else
      check(
        `testset ${testset.name} script`,
        JSON.stringify(lines) === JSON.stringify(local),
        `Polygon ${JSON.stringify(lines)}, local ${JSON.stringify(local)}`
      );
  }

  // Statements: every section that exists locally.
  const statements = await polygon(creds, 'problem.statements', id);
  for (const [lang, st] of Object.entries(config.statements ?? {})) {
    for (const part of ['legend', 'input', 'output', 'notes', 'tutorial']) {
      if (!st[part]) continue;
      const ok =
        text(statements[lang]?.[part]).trim() ===
        text(readLocal(dir, st[part])).trim();
      check(
        `statement ${lang} ${part}`,
        ok,
        ok ? '' : 'differs from the local file'
      );
    }
  }
  return checks;
}

function junit(file, checks, pushStatus) {
  const esc = s =>
    String(s).replace(
      /[<>&"]/g,
      c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]
    );
  const cases = checks
    .map(
      c =>
        `  <testcase classname="polygon-roundtrip" name="${esc(c.name)}">${c.ok ? '' : `<failure message="${esc(c.detail)}"/>`}</testcase>`
    )
    .join('\n');
  const failures = checks.filter(c => !c.ok).length;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="polygon-roundtrip" tests="${checks.length}" failures="${failures}">\n${cases}\n  <system-out>${esc(`polyman remote push exit code: ${pushStatus}`)}</system-out>\n</testsuite>\n`
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const creds = credentials();
  const source = path.join(CORPUS, 'problems', args.problem);
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), `roundtrip-${args.problem}-`)
  );
  fs.cpSync(source, dir, { recursive: true });
  fs.copyFileSync(
    path.join(CORPUS, 'vendor', 'testlib.h'),
    path.join(dir, 'testlib.h')
  );

  const configPath = path.join(dir, 'Config.json');
  if (args.problemId) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...config, problemId: Number(args.problemId) }, null, 2)
    );
  }

  const pushed = push(args, creds, dir);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.problemId) {
    console.error(pushed.output);
    throw new Error(
      'polyman did not record a Polygon problem ID; the push failed before creating one'
    );
  }
  if (!args.problemId)
    console.log(
      `created Polygon problem ${config.problemId}; set POLYGON_PROBLEM_ID to reuse it`
    );

  const checks = await compare(creds, config.problemId, dir, config);
  const failed = checks.filter(c => !c.ok);
  if (failed.length && pushed.status === 0) {
    checks.push({
      name: 'push reports failures',
      ok: false,
      detail:
        'polyman remote push exited 0, but Polygon differs from the folder',
    });
  }

  for (const c of checks)
    console.log(
      `${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail && !c.ok ? `: ${c.detail}` : ''}`
    );
  junit(args.junit, checks, pushed.status);
  fs.rmSync(dir, { recursive: true, force: true });

  const bad = checks.filter(c => !c.ok).length;
  console.log(
    `${checks.length - bad}/${checks.length} checks match (Polygon problem ${config.problemId}, push exit ${pushed.status})`
  );
  process.exit(bad ? 1 : 0);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
});
