import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isMainThread } from 'worker_threads';
import { describe, expect, it } from 'vitest';
import { PresentationError, runChecker } from '../../src/helpers/checker';
import {
  getCacheStats,
  resetCompileCacheState,
} from '../../src/helpers/compile-cache';
import {
  compileSolution,
  runSolutionOnAllTestsets,
  startTheComparisonProcess,
} from '../../src/helpers/solution';
import { compileCPP, getCompiledCommandToRun } from '../../src/helpers/utils';
import type ConfigFile from '../../src/types';
import type {
  LocalChecker,
  LocalSolution,
  LocalTestset,
} from '../../src/types';

function hasGpp(): boolean {
  try {
    execFileSync('g++', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Writes its answer to output.txt unless ONLINE_JUDGE is defined. */
const MAIN_SOURCE = `#include <cstdio>
int main() {
#ifndef ONLINE_JUDGE
  freopen("output.txt", "w", stdout);
#endif
  long long a, b;
  std::scanf("%lld %lld", &a, &b);
  std::printf("%lld\\n", a + b);
}
`;

const OTHER_SOURCE = `#include <iostream>
int main() {
  long long a, b;
  std::cin >> a >> b;
  std::cout << a + b << "\\n";
}
`;

/**
 * Small line checker without testlib: like std::lcmp, an output with more
 * lines than the answer is a presentation error (exit code 2).
 */
const CHECKER_SOURCE = `#include <fstream>
#include <iostream>
#include <string>
int main(int, char* argv[]) {
  std::ifstream out(argv[2]), ans(argv[3]);
  std::string o, a;
  while (std::getline(ans, a)) {
    if (!std::getline(out, o)) { std::cerr << "Unexpected EOF"; return 2; }
    if (o != a) { std::cerr << "wrong answer"; return 1; }
  }
  if (std::getline(out, o)) {
    std::cerr << "wrong output format Extra information in the output file";
    return 2;
  }
  return 0;
}
`;

describe('solution.ts integration: ONLINE_JUDGE', () => {
  // process.chdir() is not allowed in worker threads (Stryker runs vitest
  // in threads), so the test only runs in the normal forks pool.
  it.skipIf(process.platform === 'win32' || !hasGpp() || !isMainThread)(
    'a main that writes to a file without ONLINE_JUDGE gave PE on the other solution, and is OK now',
    async () => {
      const originalCwd = process.cwd();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyman-oj-'));
      const main: LocalSolution = {
        name: 'main',
        source: 'solutions/main.cpp',
        tag: 'MA',
      };
      const other: LocalSolution = {
        name: 'other',
        source: 'solutions/other.cpp',
        tag: 'OK',
      };
      const checker: LocalChecker = {
        name: 'chk',
        source: 'checker/chk.cpp',
      };
      const testsets: LocalTestset[] = [{ name: 'tests' }];
      const config = {
        name: 'p',
        timeLimit: 2000,
        memoryLimit: 256,
        inputFile: 'stdin',
        outputFile: 'stdout',
        interactive: false,
        statements: {},
        solutions: [main, other],
        checker,
        validator: { name: 'val', source: 'validator/val.cpp' },
        testsets,
      } as ConfigFile;
      const outputOf = (name: string) =>
        path.join(
          tmpDir,
          'solutions-outputs',
          name,
          'tests',
          'output_test1.txt'
        );
      const runBoth = async () => {
        await runSolutionOnAllTestsets(main, config, testsets);
        await runSolutionOnAllTestsets(other, config, testsets);
      };

      try {
        process.chdir(tmpDir);
        resetCompileCacheState();
        fs.mkdirSync(path.join(tmpDir, 'solutions'));
        fs.mkdirSync(path.join(tmpDir, 'checker'));
        fs.mkdirSync(path.join(tmpDir, 'testsets', 'tests'), {
          recursive: true,
        });
        fs.writeFileSync(path.join(tmpDir, main.source), MAIN_SOURCE);
        fs.writeFileSync(path.join(tmpDir, other.source), OTHER_SOURCE);
        fs.writeFileSync(path.join(tmpDir, checker.source), CHECKER_SOURCE);
        fs.writeFileSync(
          path.join(tmpDir, 'testsets', 'tests', 'test1.txt'),
          '2 3\n'
        );
        await compileCPP(checker.source);

        // Before: solutions compiled like checkers, without ONLINE_JUDGE.
        await compileCPP(main.source);
        await compileCPP(other.source);
        await runBoth();
        expect(fs.readFileSync(outputOf('main'), 'utf-8')).toBe('');
        expect(fs.readFileSync(path.join(tmpDir, 'output.txt'), 'utf-8')).toBe(
          '5\n'
        );
        await expect(
          runChecker(
            getCompiledCommandToRun(checker),
            path.join(tmpDir, 'testsets', 'tests', 'test1.txt'),
            outputOf('other'),
            outputOf('main'),
            'OK'
          )
        ).rejects.toBeInstanceOf(PresentationError);
        // verify now blames the main instead of the other solution.
        await expect(
          startTheComparisonProcess(checker, main, other, testsets)
        ).rejects.toThrow(/Main solution "main" printed nothing on test/);

        // After: the flags changed, so the cached main is not reused.
        fs.rmSync(path.join(tmpDir, 'output.txt'));
        const missesBefore = getCacheStats().misses;
        await compileSolution(main.source);
        await compileSolution(other.source);
        expect(getCacheStats().misses).toBe(missesBefore + 2);
        await runBoth();
        expect(fs.readFileSync(outputOf('main'), 'utf-8')).toBe('5\n');
        expect(fs.existsSync(path.join(tmpDir, 'output.txt'))).toBe(false);
        await expect(
          startTheComparisonProcess(checker, main, other, testsets)
        ).resolves.toBeUndefined();
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    },
    60_000
  );
});
