import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChecker } from '../../src/helpers/checker';
import type { CheckerVerdict } from '../../src/types';

/**
 * Runs `runChecker` unmocked against checkers compiled with g++ and the
 * vendored testlib.h, so the exit codes are the ones a real checker produces.
 */

const TESTLIB_PATH = path.resolve(__dirname, '../../corpus/vendor/testlib.h');

function hasGpp(): boolean {
  try {
    execFileSync('g++', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * One checker per way of ending: the body of `main` after the checker has
 * read the participant's token (so testlib's dirt check stays quiet).
 */
const CHECKERS: Record<string, string> = {
  ok: 'quitf(_ok, "fine");',
  wa: 'quitf(_wa, "wrong");',
  pe: 'quitf(_pe, "format");',
  fail: 'quitf(_fail, "checker failed");',
  exit4: '_exit(4);',
  abort: 'abort();',
  segv: 'raise(SIGSEGV);',
};

const canRun = process.platform !== 'win32' && hasGpp();

describe.skipIf(!canRun)('runChecker with real checkers', () => {
  let dir = '';
  const commands: Record<string, string> = {};
  let inputPath = '';
  let outputPath = '';
  let answerPath = '';

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyman-checker-'));
    fs.copyFileSync(TESTLIB_PATH, path.join(dir, 'testlib.h'));
    inputPath = path.join(dir, 'input.txt');
    outputPath = path.join(dir, 'output.txt');
    answerPath = path.join(dir, 'answer.txt');
    for (const file of [inputPath, outputPath, answerPath]) {
      fs.writeFileSync(file, '1\n');
    }
    for (const [name, body] of Object.entries(CHECKERS)) {
      const source = path.join(dir, `${name}.cpp`);
      fs.writeFileSync(
        source,
        [
          '#include "testlib.h"',
          '#include <csignal>',
          '#include <cstdlib>',
          '#include <unistd.h>',
          'int main(int argc, char* argv[]) {',
          '  registerTestlibCmd(argc, argv);',
          '  ouf.readToken();',
          `  ${body}`,
          '}',
          '',
        ].join('\n')
      );
      const binary = path.join(dir, name);
      execFileSync('g++', ['-O0', '-o', binary, source], { cwd: dir });
      commands[name] = binary;
    }
  }, 240_000);

  afterAll(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (checkerName: string, verdict: string) =>
    runChecker(
      commands[checkerName],
      inputPath,
      outputPath,
      answerPath,
      verdict as CheckerVerdict
    );

  it('fails expected CRASHED when the checker answers OK', async () => {
    await expect(run('ok', 'CRASHED')).rejects.toThrow(
      'Expected CRASHED but got OK'
    );
  });

  it('fails expected CRASHED when the checker answers WA', async () => {
    await expect(run('wa', 'CRASHED')).rejects.toThrow(
      'Expected CRASHED but got WA'
    );
  });

  it('fails expected CRASHED when the checker answers PE', async () => {
    await expect(run('pe', 'CRASHED')).rejects.toThrow(
      'Expected CRASHED but got PE'
    );
  });

  it("fails expected CRASHED on testlib's dirt exit code (4)", async () => {
    await expect(run('exit4', 'CRASHED')).rejects.toThrow(
      'Expected CRASHED but got exit code 4'
    );
  });

  it("passes expected CRASHED when the checker fails with testlib's fail code", async () => {
    await expect(run('fail', 'CRASHED')).resolves.toBeUndefined();
    await expect(run('fail', 'crashed')).resolves.toBeUndefined();
  });

  it('passes expected CRASHED when the checker aborts', async () => {
    await expect(run('abort', 'CRASHED')).resolves.toBeUndefined();
  });

  it('passes expected CRASHED when the checker segfaults', async () => {
    await expect(run('segv', 'CRASHED')).resolves.toBeUndefined();
  });

  it('still reports a crash as a failure for the other expected verdicts', async () => {
    await expect(run('fail', 'OK')).rejects.toThrow();
    await expect(run('fail', 'WRONG_ANSWER')).rejects.toThrow(
      'Expected WRONG_ANSWER but got exit code 3'
    );
  });
});
