import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isMainThread } from 'worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { executor } from '../../src/executor';
import { PresentationError, runChecker } from '../../src/helpers/checker';
import {
  getCacheStats,
  resetCompileCacheState,
} from '../../src/helpers/compile-cache';
import {
  compileAllSolutions,
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
        ).rejects.toThrow(/Main solution "main" printed nothing on every test/);

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

describe('solution.ts integration: blank output scan', () => {
  const CHUNK = 64 * 1024;
  const checker: LocalChecker = { name: 'chk', source: 'checker/chk.cpp' };
  const main: LocalSolution = { name: 'main', source: 'm.cpp', tag: 'MA' };
  const other: LocalSolution = { name: 'other', source: 'o.cpp', tag: 'OK' };
  const testsets: LocalTestset[] = [{ name: 'tests' }];

  /**
   * Runs the comparison on a temp problem whose main output is `mainOutput`
   * and whose other output is non-blank. The checker is replaced by a no-op
   * so only the blank-output guard decides. cwd is not changed (worker
   * threads cannot chdir), the paths resolve through a spied `process.cwd`.
   */
  async function compare(mainOutput: string): Promise<void> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyman-blank-'));
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    const executeSpy = vi.spyOn(executor, 'execute').mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      success: true,
    });
    try {
      const outDir = (name: string) =>
        path.join(tmpDir, 'solutions-outputs', name, 'tests');
      fs.mkdirSync(path.join(tmpDir, 'testsets', 'tests'), {
        recursive: true,
      });
      fs.mkdirSync(outDir('main'), { recursive: true });
      fs.mkdirSync(outDir('other'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'testsets', 'tests', 'test1.txt'), '');
      fs.writeFileSync(
        path.join(outDir('main'), 'output_test1.txt'),
        mainOutput
      );
      fs.writeFileSync(path.join(outDir('other'), 'output_test1.txt'), '42\n');
      await startTheComparisonProcess(checker, main, other, testsets);
    } finally {
      executeSpy.mockRestore();
      cwdSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it('does not treat a leading blank line followed by output as blank', async () => {
    await expect(compare('\n42\n')).resolves.toBeUndefined();
  });

  it('finds a non-blank byte past the first 64 KB chunk', async () => {
    await expect(
      compare('\n' + ' '.repeat(CHUNK * 2 + 5) + 'x')
    ).resolves.toBeUndefined();
  });

  it('never reads the whole output into a string', async () => {
    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      await expect(
        compare('\n' + ' '.repeat(CHUNK + 5) + 'x')
      ).resolves.toBeUndefined();
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });

  it('finds a non-blank byte at the exact chunk boundary', async () => {
    await expect(
      compare('\n' + ' '.repeat(CHUNK - 1) + 'x')
    ).resolves.toBeUndefined();
  });

  it('keeps a multi-byte character split across chunks as non-blank', async () => {
    await expect(
      compare('\n' + ' '.repeat(CHUNK - 2) + 'é')
    ).resolves.toBeUndefined();
  });

  it('still reports an all-whitespace file, also across chunks, as blank', async () => {
    await expect(compare('\n \t\r\n')).rejects.toThrow(
      /Main solution "main" printed nothing/
    );
    await expect(compare('\n' + ' \t\r\n'.repeat(CHUNK))).rejects.toThrow(
      /Main solution "main" printed nothing/
    );
  });

  it('still reports an empty file as blank', async () => {
    await expect(compare('')).rejects.toThrow(
      /Main solution "main" printed nothing/
    );
  });
});

/** Prints the C++ standard it was built with, from `__cplusplus`. */
const STANDARD_PROBE = `#include <cstdio>
int main() {
#if __cplusplus > 202002L
  std::puts("c++23");
#elif __cplusplus > 201703L
  std::puts("c++20");
#elif __cplusplus > 201402L
  std::puts("c++17");
#else
  std::puts("c++14 or older");
#endif
#ifdef ONLINE_JUDGE
  std::puts("ONLINE_JUDGE");
#endif
}
`;

/**
 * Builds an `OK` solution with `sourceType: cpp.g++17` in a fresh problem
 * directory with the given Config.json fields, runs it and returns the
 * lines it prints.
 */
async function runStandardProbe(
  config: Record<string, unknown>
): Promise<string[]> {
  const originalCwd = process.cwd();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyman-std-'));
  const solution: LocalSolution = {
    name: 'second',
    source: 'solutions/second.cpp',
    tag: 'OK',
    sourceType: 'cpp.g++17',
  };

  try {
    process.chdir(tmpDir);
    resetCompileCacheState();
    fs.writeFileSync(
      path.join(tmpDir, 'Config.json'),
      JSON.stringify({ solutions: [solution], ...config })
    );
    fs.mkdirSync(path.join(tmpDir, 'solutions'));
    fs.writeFileSync(path.join(tmpDir, solution.source), STANDARD_PROBE);

    await compileAllSolutions([solution]);
    const result = await executor.execute(getCompiledCommandToRun(solution), {
      timeout: 1000,
      silent: true,
    });
    return result.stdout.trim().split('\n');
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** The C++ standard the probe solution was built with. */
async function standardBuiltWith(
  config: Record<string, unknown>
): Promise<string | undefined> {
  return (await runStandardProbe(config))[0];
}

describe('solution.ts integration: C++ standard from sourceType', () => {
  // These tests use process.chdir(), see the ONLINE_JUDGE test above.
  const skip = process.platform === 'win32' || !hasGpp() || !isMainThread;

  it.skipIf(skip)(
    'builds a cpp.g++17 solution as C++17 when Config.json sets no standard',
    async () => {
      expect(await standardBuiltWith({})).toBe('c++17');
    },
    30_000
  );

  it.skipIf(skip)(
    'lets cppStandard in Config.json win over sourceType',
    async () => {
      expect(await standardBuiltWith({ cppStandard: 'c++20' })).toBe('c++20');
    },
    30_000
  );

  it.skipIf(skip)(
    'lets a -std= item in compiler.flags win over cppStandard and sourceType',
    async () => {
      expect(
        await standardBuiltWith({
          cppStandard: 'c++20',
          compiler: { flags: ['-std=c++14'] },
        })
      ).toBe('c++14 or older');
    },
    30_000
  );

  it.skipIf(skip)(
    'builds a cpp.g++17 solution with both C++17 and ONLINE_JUDGE',
    async () => {
      expect(await runStandardProbe({})).toEqual(['c++17', 'ONLINE_JUDGE']);
    },
    30_000
  );
});

/** Reads input.txt and writes output.txt, like a file problem on Polygon. */
const FILE_IO_SOURCE = `#include <cstdio>
int main() {
  freopen("input.txt", "r", stdin);
  freopen("output.txt", "w", stdout);
  long long a, b;
  std::scanf("%lld %lld", &a, &b);
  std::printf("%lld\\n", a + b);
}
`;

/** Prints how many bytes it got on stdin, then the files in its folder. */
const STDIN_PROBE_SOURCE = `#include <cstdio>
int main() {
  long long n = 0;
  while (std::getchar() != EOF) ++n;
  std::printf("%lld\\n", n);
}
`;

/** Never ends, to check the time limit on a file problem. */
const LOOP_SOURCE = `#include <cstdio>
int main() {
  freopen("input.txt", "r", stdin);
  freopen("output.txt", "w", stdout);
  std::printf("partial\\n");
  std::fflush(stdout);
  volatile unsigned long long x = 0;
  for (;;) ++x;
}
`;

describe('solution.ts integration: inputFile and outputFile', () => {
  // These tests use process.chdir(), see the ONLINE_JUDGE test above.
  const skip = process.platform === 'win32' || !hasGpp() || !isMainThread;
  const checker: LocalChecker = { name: 'chk', source: 'checker/chk.cpp' };
  const testsets: LocalTestset[] = [{ name: 'tests' }];

  interface Problem {
    dir: string;
    config: ConfigFile;
    outputOf: (name: string, test?: number) => string;
    /** Temp folders the runs made, so a test can check they are gone. */
    runDirs: string[];
  }

  /**
   * Makes a problem folder with two tests and the given solutions (name to
   * source), compiles them as solutions and runs `body` inside the folder.
   */
  async function withProblem(
    io: { inputFile: string; outputFile: string },
    sources: Record<string, string>,
    body: (problem: Problem) => Promise<void>,
    timeLimit = 2000
  ): Promise<void> {
    const originalCwd = process.cwd();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyman-fileio-'));
    const runDirs: string[] = [];
    const realMkdtemp = fs.mkdtempSync.bind(fs);
    const mkdtempSpy = vi
      .spyOn(fs, 'mkdtempSync')
      .mockImplementation((prefix, options) => {
        const made = realMkdtemp(prefix, options as BufferEncoding);
        if (String(prefix).includes('polyman-run-')) runDirs.push(made);
        return made;
      });
    const solutions: LocalSolution[] = Object.keys(sources).map((name, i) => ({
      name,
      source: `solutions/${name}.cpp`,
      tag: i === 0 ? 'MA' : 'OK',
    }));
    const config = {
      name: 'p',
      timeLimit,
      memoryLimit: 256,
      ...io,
      interactive: false,
      statements: {},
      solutions,
      checker,
      validator: { name: 'val', source: 'validator/val.cpp' },
      testsets,
    } as ConfigFile;

    try {
      process.chdir(dir);
      resetCompileCacheState();
      fs.mkdirSync(path.join(dir, 'solutions'));
      fs.mkdirSync(path.join(dir, 'checker'));
      fs.mkdirSync(path.join(dir, 'testsets', 'tests'), { recursive: true });
      for (const s of solutions) {
        fs.writeFileSync(path.join(dir, s.source), sources[s.name]);
      }
      fs.writeFileSync(path.join(dir, checker.source), CHECKER_SOURCE);
      fs.writeFileSync(path.join(dir, 'testsets/tests/test1.txt'), '2 3\n');
      fs.writeFileSync(path.join(dir, 'testsets/tests/test2.txt'), '40 2\n');
      await compileCPP(checker.source);
      await compileAllSolutions(solutions);

      await body({
        dir,
        config,
        runDirs,
        outputOf: (name, test = 1) =>
          path.join(
            dir,
            'solutions-outputs',
            name,
            'tests',
            `output_test${test}.txt`
          ),
      });
    } finally {
      mkdtempSpy.mockRestore();
      process.chdir(originalCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Files and folders in the problem folder, without the build outputs. */
  function problemEntries(dir: string): string[] {
    return fs.readdirSync(dir).sort();
  }

  const FILE_PROBLEM = { inputFile: 'input.txt', outputFile: 'output.txt' };
  const STD_PROBLEM = { inputFile: 'stdin', outputFile: 'stdout' };

  it.skipIf(skip)(
    'gives OK to file input/output solutions on a file problem and writes nothing to the problem folder',
    async () => {
      await withProblem(
        FILE_PROBLEM,
        { main: FILE_IO_SOURCE, second: FILE_IO_SOURCE },
        async ({ dir, config, outputOf, runDirs }) => {
          const before = problemEntries(dir);
          const [main, second] = config.solutions;
          await runSolutionOnAllTestsets(main, config, testsets);
          await runSolutionOnAllTestsets(second, config, testsets);

          expect(fs.readFileSync(outputOf('main', 1), 'utf-8')).toBe('5\n');
          expect(fs.readFileSync(outputOf('main', 2), 'utf-8')).toBe('42\n');
          expect(fs.readFileSync(outputOf('second', 2), 'utf-8')).toBe('42\n');
          await expect(
            startTheComparisonProcess(checker, main, second, testsets)
          ).resolves.toBeUndefined();

          // Only solutions-outputs/ is new; no input.txt or output.txt.
          expect(problemEntries(dir)).toEqual(
            [...before, 'solutions-outputs'].sort()
          );
          // One temp folder per test, all removed.
          expect(runDirs).toHaveLength(4);
          for (const runDir of runDirs) {
            expect(fs.existsSync(runDir)).toBe(false);
          }
        }
      );
    },
    60_000
  );

  it.skipIf(skip)(
    'gives an empty output to a main that prints to stdout on a file problem, so verify blames the main',
    async () => {
      await withProblem(
        FILE_PROBLEM,
        { main: OTHER_SOURCE, second: FILE_IO_SOURCE },
        async ({ dir, config, outputOf }) => {
          const [main, second] = config.solutions;
          await runSolutionOnAllTestsets(main, config, testsets);
          await runSolutionOnAllTestsets(second, config, testsets);

          expect(fs.readFileSync(outputOf('main', 1), 'utf-8')).toBe('');
          expect(fs.readFileSync(outputOf('second', 1), 'utf-8')).toBe('5\n');
          await expect(
            startTheComparisonProcess(checker, main, second, testsets)
          ).rejects.toThrow(
            /Main solution "main" printed nothing on every test/
          );
          expect(fs.existsSync(path.join(dir, 'output.txt'))).toBe(false);
        }
      );
    },
    60_000
  );

  it.skipIf(skip)(
    'gives the solution an empty stdin when the input is a file',
    async () => {
      await withProblem(
        FILE_PROBLEM,
        { main: STDIN_PROBE_SOURCE },
        async ({ config, outputOf }) => {
          await runSolutionOnAllTestsets(config.solutions[0], config, testsets);
          // stdout is thrown away and output.txt was not made: empty output.
          expect(fs.readFileSync(outputOf('main'), 'utf-8')).toBe('');
        }
      );
      await withProblem(
        { inputFile: 'input.txt', outputFile: 'stdout' },
        { main: STDIN_PROBE_SOURCE },
        async ({ config, outputOf }) => {
          await runSolutionOnAllTestsets(config.solutions[0], config, testsets);
          // 0 bytes on stdin, the test is only in input.txt.
          expect(fs.readFileSync(outputOf('main'), 'utf-8')).toBe('0\n');
        }
      );
    },
    60_000
  );

  it.skipIf(skip)(
    'reads only the output file when the input is stdin',
    async () => {
      const source = `#include <cstdio>
int main() {
  freopen("out.txt", "w", stdout);
  long long a, b;
  std::scanf("%lld %lld", &a, &b);
  std::printf("%lld\\n", a * b);
}
`;
      await withProblem(
        { inputFile: 'stdin', outputFile: 'out.txt' },
        { main: source },
        async ({ dir, config, outputOf }) => {
          const before = problemEntries(dir);
          await runSolutionOnAllTestsets(config.solutions[0], config, testsets);
          expect(fs.readFileSync(outputOf('main', 1), 'utf-8')).toBe('6\n');
          expect(fs.readFileSync(outputOf('main', 2), 'utf-8')).toBe('80\n');
          expect(problemEntries(dir)).toEqual(
            [...before, 'solutions-outputs'].sort()
          );
        }
      );
    },
    60_000
  );

  it.skipIf(skip)(
    'still stops a solution at the time limit on a file problem',
    async () => {
      await withProblem(
        FILE_PROBLEM,
        { main: LOOP_SOURCE },
        async ({ dir, config, outputOf, runDirs }) => {
          await expect(
            runSolutionOnAllTestsets(config.solutions[0], config, testsets)
          ).rejects.toThrow(/Time Limit Exceeded after 300ms/);
          expect(fs.readFileSync(outputOf('main'), 'utf-8')).toBe(
            'Time Limit Exceeded after 300ms'
          );
          expect(fs.existsSync(path.join(dir, 'output.txt'))).toBe(false);
          expect(runDirs.length).toBeGreaterThan(0);
          for (const runDir of runDirs) {
            expect(fs.existsSync(runDir)).toBe(false);
          }
        },
        300
      );
    },
    60_000
  );

  it.skipIf(skip)(
    'runs a stdin/stdout problem in the problem folder as before',
    async () => {
      await withProblem(
        STD_PROBLEM,
        { main: OTHER_SOURCE, second: OTHER_SOURCE },
        async ({ dir, config, outputOf, runDirs }) => {
          const spy = vi.spyOn(executor, 'executeWithRedirect');
          try {
            const [main, second] = config.solutions;
            await runSolutionOnAllTestsets(main, config, testsets);
            await runSolutionOnAllTestsets(second, config, testsets);
            expect(fs.readFileSync(outputOf('main', 2), 'utf-8')).toBe('42\n');
            await expect(
              startTheComparisonProcess(checker, main, second, testsets)
            ).resolves.toBeUndefined();

            const [, options, input, output] = spy.mock.calls[0];
            expect(options.cwd).toBeUndefined();
            expect(input).toBe(path.join(dir, 'testsets/tests/test1.txt'));
            expect(output).toBe(outputOf('main', 1));
            expect(runDirs).toHaveLength(0);
          } finally {
            spy.mockRestore();
          }
        }
      );
    },
    60_000
  );
});
