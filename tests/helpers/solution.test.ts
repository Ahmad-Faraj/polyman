import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as solution from '../../src/helpers/solution';
import * as executorModule from '../../src/executor';
import type { ExecutionOptions, ExecutionResult } from '../../src/executor';

// Re-export `executor` through a typed indirection so that calls go through a
// plain function reference (avoids @typescript-eslint/unbound-method false
// positives when handing methods to `vi.mocked`).
type ExecuteWithRedirect = (
  command: string,
  options: ExecutionOptions,
  inputFile?: string,
  outputFile?: string
) => Promise<ExecutionResult>;
type CleanupFn = () => Promise<void>;
type ExecuteFn = (
  command: string,
  options: ExecutionOptions
) => Promise<ExecutionResult>;
const executor: {
  execute: ExecuteFn;
  executeWithRedirect: ExecuteWithRedirect;
  cleanup: CleanupFn;
} = executorModule.executor;
import * as utils from '../../src/helpers/utils';
import * as checker from '../../src/helpers/checker';
import { LimitExceededError } from '../../src/errors';
import * as formatterModule from '../../src/formatter';
import { report } from '../../src/report';
import * as testsetHelper from '../../src/helpers/testset';
import fs from 'fs';
import path from 'path';
import type ConfigFile from '../../src/types';
import type {
  LocalSolution,
  LocalTestset,
  LocalChecker,
  CheckerVerdict,
} from '../../src/types';

vi.mock('../../src/executor', () => ({
  executor: {
    execute: vi.fn(),
    executeWithRedirect: vi.fn(),
    cleanup: vi.fn(),
  },
}));

vi.mock('../../src/helpers/utils', async () => {
  const actual = await vi.importActual<
    typeof import('../../src/helpers/utils')
  >('../../src/helpers/utils');
  return {
    ...actual,

    throwError: vi.fn((err: unknown, msg?: string) => {
      if (err instanceof Error && msg) {
        err.message = `${msg}: ${err.message}`;
      }
      throw err;
    }),
    logError: vi.fn(),
    readConfigFile: vi.fn(),
    getCompiledCommandToRun: vi.fn(),
    getTestFiles: vi.fn(),
    compileCPP: vi.fn(),
    compileJava: vi.fn(),
    readFirstLine: vi.fn().mockResolvedValue(''),
  };
});
vi.mock('../../src/helpers/checker', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/helpers/checker')>();
  return {
    ...actual,
    runChecker: vi.fn(),
    ensureCheckerExists: vi.fn(),
  };
});
vi.mock('../../src/helpers/testset');
vi.mock('fs');
vi.mock('path', async () => {
  const actual = await vi.importActual<typeof import('path')>('path');
  return {
    ...actual,
    resolve: vi.fn((...args: string[]) => args.join('/')),
  };
});
vi.mock('../../src/formatter', () => ({
  fmt: {
    info: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    success: vi.fn(),
    newLine: vi.fn(),
    infoIcon: () => 'i',
    highlight: (s: string) => s,
    dim: (s: string) => s,
    primary: (s: string) => s,
    bold: (s: string) => s,
    cross: () => 'x',
  },
}));

// Typed handles for mocked functions used throughout the suite.
// The executor proxy types its members as plain function-typed properties (not
// class methods), so `vi.mocked` returns a real Vitest mock with the full mock
// API while staying lint-clean for `unbound-method`.
const mockedExecuteWithRedirect = vi.mocked(executor.executeWithRedirect);
const mockedReadConfigFile = vi.mocked(utils.readConfigFile);
const mockedGetCompiledCommandToRun = vi.mocked(utils.getCompiledCommandToRun);
const mockedReadFirstLine = vi.mocked(utils.readFirstLine);
const mockedGetTestFiles = vi.mocked(utils.getTestFiles);
const mockedCompileCPP = vi.mocked(utils.compileCPP);
const mockedCompileJava = vi.mocked(utils.compileJava);
const mockedRunChecker = vi.mocked(checker.runChecker);
const mockedGetTestIndicesForGroup = vi.mocked(
  testsetHelper.getTestIndicesForGroup
);
const mockedFsExistsSync = vi.mocked(fs.existsSync);
const mockedFsMkdirSync = vi.mocked(fs.mkdirSync);
const mockedFsUnlinkSync = vi.mocked(fs.unlinkSync);
const mockedFsWriteFileSync = vi.mocked(fs.writeFileSync);
// The automock of 'fs' leaves `promises` undefined, so give it an `open` mock.
const mockedFsOpen = vi.fn<typeof fs.promises.open>();
Object.defineProperty(fs, 'promises', {
  value: { open: mockedFsOpen },
  configurable: true,
});

/**
 * Makes `fs.promises.open` serve `contentOf(path)` through a fake handle that
 * reads in the chunks the caller asks for, like a real file would.
 */
function mockFileContents(contentOf: (file: unknown) => string) {
  mockedFsOpen.mockImplementation(file => {
    const data = Buffer.from(contentOf(file), 'utf-8');
    let position = 0;
    const handle = {
      read: vi.fn((buffer: Buffer, offset: number, length: number) => {
        const bytesRead = data.copy(
          buffer,
          offset,
          position,
          position + length
        );
        position += bytesRead;
        return Promise.resolve({ bytesRead, buffer });
      }),
      close: vi.fn(() => Promise.resolve()),
    };
    return Promise.resolve(handle as unknown as fs.promises.FileHandle);
  });
}

// Same indirection as the executor proxy: `fmt` is the mocked formatter object,
// and reading `log` through a function-typed local keeps `vi.mocked` lint-clean.
const formatter: { log: (message: string) => void } = formatterModule.fmt;
const mockedFormatterLog = vi.mocked(formatter.log);

const okResult: ExecutionResult = {
  stdout: '',
  stderr: '',
  exitCode: 0,
  success: true,
};

function makeConfig(overrides: Partial<ConfigFile> = {}): ConfigFile {
  const base: ConfigFile = {
    name: 'problem',
    timeLimit: 1000,
    memoryLimit: 256,
    inputFile: 'stdin',
    outputFile: 'stdout',
    interactive: false,
    statements: {},
    solutions: [],
    checker: { name: 'chk', source: 'checker.cpp' },
    validator: { name: 'val', source: 'validator.cpp' },
    testsets: [],
  };
  return { ...base, ...overrides };
}

describe('solution.ts', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as (code?: number | string | null) => never);
  void exitSpy;

  beforeEach(() => {
    vi.clearAllMocks();

    mockedFsExistsSync.mockReturnValue(true);
    mockedFsMkdirSync.mockReturnValue(undefined);
    mockedFsUnlinkSync.mockReturnValue(undefined);
    mockedReadConfigFile.mockReturnValue(makeConfig());
    mockedGetCompiledCommandToRun.mockReturnValue('./solution');
    mockedReadFirstLine.mockResolvedValue('');
    mockFileContents(() => '');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('validateSolutionsExist', () => {
    it('should not throw if solutions exist', () => {
      const solutions: LocalSolution[] = [
        { name: 'sol1', source: 'sol1.cpp', tag: 'MA' },
      ];
      expect(() => solution.validateSolutionsExist(solutions)).not.toThrow();
    });

    it('should throw if solutions is undefined', () => {
      expect(() => solution.validateSolutionsExist(undefined)).toThrow(
        'No solutions defined'
      );
    });

    it('should throw if solutions is empty', () => {
      expect(() => solution.validateSolutionsExist([])).toThrow(
        'No solutions defined'
      );
    });
  });

  describe('findMatchingSolutions', () => {
    const solutions: LocalSolution[] = [
      { name: 'main', source: 'main.cpp', tag: 'MA' },
      { name: 'wa', source: 'wa.cpp', tag: 'WA' },
    ];

    it('should return all solutions if name is all', () => {
      expect(solution.findMatchingSolutions(solutions, 'all')).toEqual(
        solutions
      );
    });

    it('should return matching solution', () => {
      expect(solution.findMatchingSolutions(solutions, 'main')).toEqual([
        solutions[0],
      ]);
    });

    it('should throw if solution not found', () => {
      expect(() =>
        solution.findMatchingSolutions(solutions, 'missing')
      ).toThrow(/Solution named "missing" not found/);
    });
  });

  describe('compileSolution', () => {
    it('should compile cpp solution', async () => {
      vi.spyOn(path, 'extname').mockReturnValue('.cpp');
      await solution.compileSolution('sol.cpp');
      expect(mockedCompileCPP).toHaveBeenCalledWith('sol.cpp', {
        onlineJudge: true,
      });
    });

    it.each(['.cc', '.cxx'])(
      'should compile %s solution with compileCPP',
      async ext => {
        vi.spyOn(path, 'extname').mockReturnValue(ext);
        await solution.compileSolution(`sol${ext}`);
        expect(mockedCompileCPP).toHaveBeenCalledWith(`sol${ext}`, {
          onlineJudge: true,
        });
        expect(mockedCompileJava).not.toHaveBeenCalled();
      }
    );

    it('should compile java solution', async () => {
      vi.spyOn(path, 'extname').mockReturnValue('.java');
      await solution.compileSolution('sol.java');
      expect(mockedCompileJava).toHaveBeenCalledWith('sol.java');
    });

    it('should not compile python solution', async () => {
      vi.spyOn(path, 'extname').mockReturnValue('.py');
      await solution.compileSolution('sol.py');
      expect(mockedCompileCPP).not.toHaveBeenCalled();
      expect(mockedCompileJava).not.toHaveBeenCalled();
    });

    it('should throw on unsupported extension', async () => {
      vi.spyOn(path, 'extname').mockReturnValue('.txt');
      await expect(solution.compileSolution('sol.txt')).rejects.toThrow(
        'Unsupported solution file extension: .txt'
      );
    });
  });

  describe('compileAllSolutions', () => {
    it('should compile all solutions', async () => {
      const solutions: LocalSolution[] = [
        { name: 's1', source: 's1.cpp', tag: 'MA' },
        { name: 's2', source: 's2.java', tag: 'WA' },
      ];
      vi.spyOn(path, 'extname').mockImplementation(p =>
        p.endsWith('.cpp') ? '.cpp' : '.java'
      );

      await solution.compileAllSolutions(solutions);
      expect(mockedCompileCPP).toHaveBeenCalledWith('s1.cpp', {
        onlineJudge: true,
      });
      expect(mockedCompileJava).toHaveBeenCalledWith('s2.java');
    });

    const makeSolutions = (n: number): LocalSolution[] =>
      Array.from({ length: n }, (_, i) => ({
        name: `s${i}`,
        source: `s${i}.cpp`,
        tag: 'MA' as const,
      }));

    it('should run at most `limit` compiles at once and compile all', async () => {
      vi.spyOn(path, 'extname').mockReturnValue('.cpp');
      let running = 0;
      let peak = 0;
      const started: string[] = [];
      mockedCompileCPP.mockImplementation(async (source: string) => {
        started.push(source);
        running++;
        peak = Math.max(peak, running);
        await new Promise(resolve => setTimeout(resolve, 5));
        running--;
        return source;
      });

      await solution.compileAllSolutions(makeSolutions(7), 2);

      expect(peak).toBe(2);
      expect(started).toEqual(makeSolutions(7).map(s => s.source));
    });

    it('should reject with the failing compile error and skip solutions not started', async () => {
      vi.spyOn(path, 'extname').mockReturnValue('.cpp');
      const started: string[] = [];
      mockedCompileCPP.mockImplementation((source: string) => {
        started.push(source);
        return source === 's1.cpp'
          ? Promise.reject(new Error('boom s1'))
          : Promise.resolve(source);
      });

      await expect(
        solution.compileAllSolutions(makeSolutions(5), 1)
      ).rejects.toThrow('boom s1');
      expect(started).toEqual(['s0.cpp', 's1.cpp']);
    });

    it('should compile everything when the limit exceeds the solution count', async () => {
      vi.spyOn(path, 'extname').mockReturnValue('.cpp');
      mockedCompileCPP.mockImplementation((source: string) =>
        Promise.resolve(source)
      );

      await solution.compileAllSolutions(makeSolutions(3), 10);

      expect(mockedCompileCPP).toHaveBeenCalledTimes(3);
    });

    it('should treat a limit below 1 as 1', async () => {
      vi.spyOn(path, 'extname').mockReturnValue('.cpp');
      mockedCompileCPP.mockImplementation((source: string) =>
        Promise.resolve(source)
      );

      await solution.compileAllSolutions(makeSolutions(2), 0);

      expect(mockedCompileCPP).toHaveBeenCalledTimes(2);
    });

    it('should resolve for an empty list', async () => {
      await expect(solution.compileAllSolutions([])).resolves.toBeUndefined();
    });
  });

  // `path.extname` is spied on by earlier suites and this project does not
  // enable `restoreMocks`, so every suite that reads extensions installs a
  // working one of its own.
  function stubRealExtname() {
    vi.spyOn(path, 'extname').mockImplementation(file => {
      const match = /\.([A-Za-z0-9]+)$/.exec(file);
      return match ? `.${match[1]}` : '';
    });
  }

  describe('solutionLanguage', () => {
    beforeEach(stubRealExtname);

    it('detects C++ from .cpp, .cc and .cxx', () => {
      expect(
        solution.solutionLanguage({ name: 'm', source: 'm.cpp', tag: 'MA' })
      ).toBe('cpp');
      expect(
        solution.solutionLanguage({ name: 'm', source: 'gen.cc', tag: 'MA' })
      ).toBe('cpp');
      expect(
        solution.solutionLanguage({ name: 'm', source: 'gen.cxx', tag: 'MA' })
      ).toBe('cpp');
    });

    it('detects java and python from their extensions', () => {
      expect(
        solution.solutionLanguage({ name: 'j', source: 'Main.java', tag: 'OK' })
      ).toBe('java');
      expect(
        solution.solutionLanguage({ name: 'p', source: 'main.py', tag: 'OK' })
      ).toBe('python');
    });

    it('follows the file extension and ignores sourceType', () => {
      // The local runner picks the program by extension only, so the factor
      // must follow the extension too.
      expect(
        solution.solutionLanguage({
          name: 'j',
          source: 'Solution',
          tag: 'OK',
          sourceType: 'java.17',
        })
      ).toBeUndefined();
      expect(
        solution.solutionLanguage({
          name: 'p',
          source: 'sol.cpp',
          tag: 'OK',
          sourceType: 'python.pypy3',
        })
      ).toBe('cpp');
    });

    it('returns undefined for a source polyman cannot classify', () => {
      expect(
        solution.solutionLanguage({ name: 'x', source: 'x.js', tag: 'OK' })
      ).toBeUndefined();
    });
  });

  describe('solutionTimeLimit', () => {
    beforeEach(stubRealExtname);

    const cppSolution: LocalSolution = {
      name: 'm',
      source: 'm.cpp',
      tag: 'MA',
    };
    const javaSolution: LocalSolution = {
      name: 'j',
      source: 'Main.java',
      tag: 'OK',
    };
    const pythonSolution: LocalSolution = {
      name: 'p',
      source: 'main.py',
      tag: 'OK',
    };

    it('keeps the declared limit when the field is absent', () => {
      expect(solution.solutionTimeLimit(makeConfig(), javaSolution)).toEqual({
        timeLimit: 1000,
        multiplier: 1,
        language: 'java',
      });
    });

    it('scales java and python and leaves cpp at the declared limit', () => {
      const config = makeConfig({
        timeLimitMultipliers: { java: 2, python: 3 },
      });

      expect(solution.solutionTimeLimit(config, javaSolution)).toEqual({
        timeLimit: 2000,
        multiplier: 2,
        language: 'java',
      });
      expect(solution.solutionTimeLimit(config, pythonSolution).timeLimit).toBe(
        3000
      );
      expect(solution.solutionTimeLimit(config, cppSolution)).toEqual({
        timeLimit: 1000,
        multiplier: 1,
        language: 'cpp',
      });
    });

    it('scales cpp too when a cpp factor is configured', () => {
      const config = makeConfig({ timeLimitMultipliers: { cpp: 1.5 } });
      expect(solution.solutionTimeLimit(config, cppSolution).timeLimit).toBe(
        1500
      );
    });

    it('rounds the scaled limit to whole milliseconds', () => {
      const config = makeConfig({
        timeLimit: 1500,
        timeLimitMultipliers: { python: 1.33 },
      });
      expect(solution.solutionTimeLimit(config, pythonSolution).timeLimit).toBe(
        1995
      );
    });

    it('never drops the limit below a millisecond', () => {
      const config = makeConfig({
        timeLimit: 1,
        timeLimitMultipliers: { java: 0.2 },
      });
      expect(solution.solutionTimeLimit(config, javaSolution).timeLimit).toBe(
        1
      );
    });

    it('keeps the declared limit for a language it cannot detect', () => {
      const config = makeConfig({ timeLimitMultipliers: { java: 5 } });
      expect(
        solution.solutionTimeLimit(config, {
          name: 'x',
          source: 'x.js',
          tag: 'OK',
        })
      ).toEqual({ timeLimit: 1000, multiplier: 1, language: undefined });
    });

    it.each([0, -2, Number.NaN, Number.POSITIVE_INFINITY])(
      'throws on a java multiplier of %p',
      value => {
        const config = makeConfig({ timeLimitMultipliers: { java: value } });
        expect(() => solution.solutionTimeLimit(config, javaSolution)).toThrow(
          /Invalid timeLimitMultipliers\.java/
        );
      }
    );

    it('throws on an invalid factor even for a solution of another language', () => {
      const config = makeConfig({ timeLimitMultipliers: { java: 0 } });
      expect(() => solution.solutionTimeLimit(config, cppSolution)).toThrow(
        /Invalid timeLimitMultipliers\.java/
      );
    });
  });

  describe('validateTimeLimitMultipliers', () => {
    // Config.json is parsed JSON, so any shape can reach the validator.
    function withMultipliers(value: unknown): ConfigFile {
      return makeConfig({
        timeLimitMultipliers: value as ConfigFile['timeLimitMultipliers'],
      });
    }

    it('accepts a config without the field', () => {
      expect(() =>
        solution.validateTimeLimitMultipliers(makeConfig())
      ).not.toThrow();
    });

    it('accepts positive factors for cpp, java and python', () => {
      expect(() =>
        solution.validateTimeLimitMultipliers(
          withMultipliers({ cpp: 1.5, java: 2, python: 0.5 })
        )
      ).not.toThrow();
    });

    it.each([
      [0, '0'],
      [-1, '-1'],
      [null, 'null'],
      ['2', '"2"'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
      [{ value: 2 }, '{"value":2}'],
    ])('rejects a java factor of %p', (value, printed) => {
      expect(() =>
        solution.validateTimeLimitMultipliers(withMultipliers({ java: value }))
      ).toThrow(
        `Invalid timeLimitMultipliers.java in Config.json: ${printed} (expected a positive number)`
      );
    });

    it.each(['Java', 'kotlin', 'py'])(
      'rejects the unknown key %p and names the allowed ones',
      key => {
        expect(() =>
          solution.validateTimeLimitMultipliers(withMultipliers({ [key]: 2 }))
        ).toThrow(
          `Unknown key in timeLimitMultipliers: ${JSON.stringify(key)} (allowed keys: cpp, java, python)`
        );
      }
    );

    it.each([
      ['abc', '"abc"'],
      [null, 'null'],
      [2, '2'],
      [[2], '[2]'],
    ])('rejects a non-object value %p', (value, printed) => {
      expect(() =>
        solution.validateTimeLimitMultipliers(withMultipliers(value))
      ).toThrow(`Invalid timeLimitMultipliers in Config.json: ${printed}`);
    });

    it.each([1e7, 1e306])(
      'rejects a factor of %p that overflows the Node timer',
      value => {
        expect(() =>
          solution.validateTimeLimitMultipliers(
            withMultipliers({ java: value })
          )
        ).toThrow(/timeLimitMultipliers\.java is too large/);
      }
    );

    it('accepts a factor that lands exactly on the timer maximum', () => {
      expect(() =>
        solution.validateTimeLimitMultipliers(
          makeConfig({
            timeLimit: 1,
            timeLimitMultipliers: { java: solution.MAX_TIME_LIMIT_MS },
          })
        )
      ).not.toThrow();
      expect(() =>
        solution.validateTimeLimitMultipliers(
          makeConfig({
            timeLimit: 1,
            timeLimitMultipliers: { java: solution.MAX_TIME_LIMIT_MS + 1 },
          })
        )
      ).toThrow(/too large/);
    });
  });

  describe('formatTimeLimit', () => {
    it('shows the plain limit when nothing was scaled', () => {
      expect(
        solution.formatTimeLimit({
          timeLimit: 1000,
          multiplier: 1,
          language: 'java',
        })
      ).toBe('1000ms');
      expect(
        solution.formatTimeLimit({
          timeLimit: 1000,
          multiplier: 1,
          language: undefined,
        })
      ).toBe('1000ms');
    });

    it('names the factor and the language once scaled', () => {
      expect(
        solution.formatTimeLimit({
          timeLimit: 2000,
          multiplier: 2,
          language: 'java',
        })
      ).toBe('2000ms (x2 for java)');
      expect(
        solution.formatTimeLimit({
          timeLimit: 1500,
          multiplier: 1.5,
          language: 'python',
        })
      ).toBe('1500ms (x1.5 for python)');
    });

    it('shows the factor with at most two decimals', () => {
      expect(
        solution.formatTimeLimit({
          timeLimit: 1333,
          multiplier: 1.3333333,
          language: 'java',
        })
      ).toBe('1333ms (x1.33 for java)');
      expect(
        solution.formatTimeLimit({
          timeLimit: 2000,
          multiplier: 2.0001,
          language: 'java',
        })
      ).toBe('2000ms (x2 for java)');
    });
  });

  describe('scaled limits in the run paths', () => {
    const javaSolution: LocalSolution = {
      name: 'slow',
      source: 'slow.java',
      tag: 'OK',
    };
    const scaledConfig = makeConfig({
      timeLimitMultipliers: { java: 2 },
    });

    beforeEach(() => {
      stubRealExtname();
      mockedExecuteWithRedirect.mockResolvedValue(okResult);
    });

    it('runs a testset with the scaled timeout', async () => {
      mockedGetTestFiles.mockReturnValue(['test1.txt']);

      await solution.runSolutionOnTestset(javaSolution, scaledConfig, 'ts1');

      expect(mockedExecuteWithRedirect).toHaveBeenCalled();
      expect(mockedExecuteWithRedirect.mock.calls[0][1]).toMatchObject({
        timeout: 2000,
        memoryLimitMB: 256,
      });
    });

    it('runs a single test with the scaled timeout', async () => {
      await solution.runSolutionOnSingleTest(
        javaSolution,
        scaledConfig,
        'ts1',
        1
      );

      expect(mockedExecuteWithRedirect.mock.calls[0][1]).toMatchObject({
        timeout: 2000,
      });
    });

    it('mentions the effective limit in the output', async () => {
      mockedGetTestFiles.mockReturnValue(['test1.txt']);

      await solution.runSolutionOnTestset(javaSolution, scaledConfig, 'ts1');

      expect(mockedFormatterLog).toHaveBeenCalledWith(
        '    → Time Limit: 2000ms (x2 for java)'
      );
    });

    it('says nothing extra when the limit is not scaled', async () => {
      mockedGetTestFiles.mockReturnValue(['test1.txt']);

      await solution.runSolutionOnTestset(javaSolution, makeConfig(), 'ts1');

      expect(mockedFormatterLog).not.toHaveBeenCalledWith(
        expect.stringContaining('Time Limit')
      );
    });

    it('does not run anything when the multiplier is invalid', async () => {
      mockedGetTestFiles.mockReturnValue(['test1.txt']);

      await expect(
        solution.runSolutionOnTestset(
          javaSolution,
          makeConfig({ timeLimitMultipliers: { java: 0 } }),
          'ts1'
        )
      ).rejects.toThrow(/Invalid timeLimitMultipliers\.java/);

      expect(mockedExecuteWithRedirect).not.toHaveBeenCalled();
    });

    it('runs a group with the scaled timeout', async () => {
      mockedGetTestIndicesForGroup.mockReturnValue([1, 2]);

      await solution.runSolutionOnGroup(
        javaSolution,
        scaledConfig,
        { name: 'ts1' },
        'g1'
      );

      expect(mockedExecuteWithRedirect).toHaveBeenCalledTimes(2);
      for (const call of mockedExecuteWithRedirect.mock.calls) {
        expect(call[1]).toMatchObject({ timeout: 2000, memoryLimitMB: 256 });
      }
    });

    it('keeps the declared timeout in a group for a cpp solution', async () => {
      mockedGetTestIndicesForGroup.mockReturnValue([1]);

      await solution.runSolutionOnGroup(
        { name: 'main', source: 'main.cpp', tag: 'MA' },
        scaledConfig,
        { name: 'ts1' },
        'g1'
      );

      expect(mockedExecuteWithRedirect.mock.calls[0][1]).toMatchObject({
        timeout: 1000,
      });
    });
  });

  describe('runSolutionOnSingleTest', () => {
    const mockSolution: LocalSolution = {
      name: 'main',
      source: 'main.cpp',
      tag: 'MA',
    };
    const mockConfig: ConfigFile = makeConfig();

    it('should execute solution successfully', async () => {
      mockedExecuteWithRedirect.mockResolvedValue(okResult);

      await solution.runSolutionOnSingleTest(
        mockSolution,
        mockConfig,
        'testsets',
        1
      );

      expect(mockedExecuteWithRedirect).toHaveBeenCalled();
      const call = mockedExecuteWithRedirect.mock.calls[0];
      expect(call).toBeDefined();
      const options = call[1];
      expect(options).toMatchObject({ timeout: 1000, memoryLimitMB: 256 });
    });

    it('should throw if execution fails', async () => {
      mockedExecuteWithRedirect.mockRejectedValue(
        new Error('Execution failed')
      );
      await expect(
        solution.runSolutionOnSingleTest(
          mockSolution,
          mockConfig,
          'testsets',
          1
        )
      ).rejects.toThrow('Execution failed');
    });

    it('should handle runtime error (onError callback)', async () => {
      mockedExecuteWithRedirect.mockImplementation(
        (_cmd: string, options: ExecutionOptions) => {
          options.onError?.({
            stdout: '',
            stderr: 'Segfault',
            exitCode: 1,
            success: false,
          });
          return Promise.resolve(okResult);
        }
      );
      mockedFsWriteFileSync.mockImplementation(() => {});

      await expect(
        solution.runSolutionOnSingleTest(
          mockSolution,
          mockConfig,
          'testset1',
          1
        )
      ).rejects.toThrow('Runtime Error: Segfault');

      expect(mockedFsWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('output_test1.txt'),
        'Runtime Error: Segfault'
      );
    });

    it('should handle timeout (onTimeout callback)', async () => {
      mockedExecuteWithRedirect.mockImplementation(
        (_cmd: string, options: ExecutionOptions) => {
          options.onTimeout?.({
            stdout: '',
            stderr: '',
            exitCode: 124,
            success: false,
            timedOut: true,
          });
          return Promise.resolve(okResult);
        }
      );

      await expect(
        solution.runSolutionOnSingleTest(
          mockSolution,
          mockConfig,
          'testset1',
          1
        )
      ).rejects.toThrow('Time Limit Exceeded');

      expect(mockedFsWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('output_test1.txt'),
        expect.stringContaining('Time Limit Exceeded')
      );
    });

    it('should handle memory exceeded (onMemoryExceeded callback)', async () => {
      mockedExecuteWithRedirect.mockImplementation(
        (_cmd: string, options: ExecutionOptions) => {
          options.onMemoryExceeded?.({
            stdout: '',
            stderr: '',
            exitCode: 137,
            success: false,
            memoryExceeded: true,
          });
          return Promise.resolve(okResult);
        }
      );

      await expect(
        solution.runSolutionOnSingleTest(
          mockSolution,
          mockConfig,
          'testset1',
          1
        )
      ).rejects.toThrow('Memory Limit Exceeded');

      expect(mockedFsWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining('output_test1.txt'),
        expect.stringContaining('Memory Limit Exceeded')
      );
    });
  });

  describe('runSolutionOnTestset', () => {
    const mockSolution: LocalSolution = {
      name: 'main',
      source: 'main.cpp',
      tag: 'MA',
    };
    const mockConfig: ConfigFile = makeConfig();

    it('should run on all test files', async () => {
      mockedGetTestFiles.mockReturnValue(['test1.txt', 'test2.txt']);
      mockedExecuteWithRedirect.mockResolvedValue(okResult);

      await solution.runSolutionOnTestset(mockSolution, mockConfig, 'testset1');

      expect(mockedExecuteWithRedirect).toHaveBeenCalledTimes(2);
    });

    it('should throw aggregate error if tests fail', async () => {
      mockedGetTestFiles.mockReturnValue(['test1.txt']);
      mockedExecuteWithRedirect.mockRejectedValue(new Error('Fail'));

      await expect(
        solution.runSolutionOnTestset(mockSolution, mockConfig, 'testset1')
      ).rejects.toThrow(/Solution .* failed on testset/);
    });
  });

  describe('runSolutionOnGroup', () => {
    const mockSolution: LocalSolution = {
      name: 'main',
      source: 'main.cpp',
      tag: 'MA',
      sourceType: 'cpp.g++17',
    };
    const mockConfig: ConfigFile = makeConfig();
    const mockTestset: LocalTestset = { name: 'ts1' };

    it('should run tests belonging to group', async () => {
      mockedGetTestIndicesForGroup.mockReturnValue([1, 3]);
      mockedExecuteWithRedirect.mockResolvedValue(okResult);

      await solution.runSolutionOnGroup(
        mockSolution,
        mockConfig,
        mockTestset,
        'g1'
      );

      expect(mockedExecuteWithRedirect).toHaveBeenCalledTimes(2);

      expect(mockedExecuteWithRedirect).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.stringContaining('test1.txt'),
        expect.anything()
      );
      expect(mockedExecuteWithRedirect).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.stringContaining('test3.txt'),
        expect.anything()
      );
    });

    it('should throw if no tests found for group', async () => {
      mockedGetTestIndicesForGroup.mockReturnValue([]);
      await expect(
        solution.runSolutionOnGroup(mockSolution, mockConfig, mockTestset, 'g1')
      ).rejects.toThrow('No tests found for group "g1"');
    });

    it('should throw if tests fail', async () => {
      mockedGetTestIndicesForGroup.mockReturnValue([1]);
      mockedExecuteWithRedirect.mockRejectedValue(new Error('Fail'));

      await expect(
        solution.runSolutionOnGroup(mockSolution, mockConfig, mockTestset, 'g1')
      ).rejects.toThrow(/Solution .* failed on group/);
    });
  });

  describe('runSolutionOnAllTestsets', () => {
    const mockSolution: LocalSolution = {
      name: 'main',
      source: 'main.cpp',
      tag: 'MA',
      sourceType: 'cpp.g++17',
    };
    const mockConfig: ConfigFile = makeConfig();

    it('should run on all testsets', async () => {
      const testsets: LocalTestset[] = [{ name: 'ts1' }, { name: 'ts2' }];
      mockedGetTestFiles.mockReturnValue(['t1.txt']);
      mockedExecuteWithRedirect.mockResolvedValue(okResult);

      await solution.runSolutionOnAllTestsets(
        mockSolution,
        mockConfig,
        testsets
      );
      expect(mockedExecuteWithRedirect).toHaveBeenCalledTimes(2);
    });

    it('should aggregate errors from multiple testsets', async () => {
      const testsets: LocalTestset[] = [{ name: 'ts1' }];
      mockedGetTestFiles.mockReturnValue(['t1.txt']);
      mockedExecuteWithRedirect.mockRejectedValue(new Error('Fail'));

      await expect(
        solution.runSolutionOnAllTestsets(mockSolution, mockConfig, testsets)
      ).rejects.toThrow(/Solution .* failed on some testsets/);
    });
  });

  describe('ensureMainSolutionExists', () => {
    it('should pass if MA solution exists', () => {
      expect(() =>
        solution.ensureMainSolutionExists([
          { name: 'm', source: '', tag: 'MA', sourceType: 'cpp.g++17' },
        ])
      ).not.toThrow();
    });

    it('should throw if no solutions', () => {
      expect(() => solution.ensureMainSolutionExists([])).toThrow();
      expect(() => solution.ensureMainSolutionExists(undefined)).toThrow();
    });

    it('should throw if no MA solution', () => {
      expect(() =>
        solution.ensureMainSolutionExists([
          { name: 'w', source: '', tag: 'WA', sourceType: 'cpp.g++17' },
        ])
      ).toThrow(/No solution with tag "MA"/);
    });
  });

  describe('ensureSolutionExists', () => {
    it('should pass if solution exists', () => {
      expect(() =>
        solution.ensureSolutionExists(
          [{ name: 'm', source: '', tag: 'MA', sourceType: 'cpp.g++17' }],
          'm'
        )
      ).not.toThrow();
    });
    it('should throw if solution missing', () => {
      expect(() =>
        solution.ensureSolutionExists(
          [{ name: 'm', source: '', tag: 'MA', sourceType: 'cpp.g++17' }],
          'z'
        )
      ).toThrow(/No solution named "z"/);
    });
  });

  describe('getMainSolution', () => {
    it('should return MA solution', () => {
      const sol: LocalSolution = {
        name: 'm',
        source: '',
        tag: 'MA',
        sourceType: 'cpp.g++17',
      };
      expect(solution.getMainSolution([sol])).toEqual(sol);
    });
    it('should throw if not found', () => {
      expect(() => solution.getMainSolution([])).toThrow();
    });
  });

  describe('testSolutionAgainstMainCorrect', () => {
    beforeEach(() => {
      mockedReadConfigFile.mockReturnValue(
        makeConfig({
          solutions: [
            {
              name: 'main',
              source: 'main.cpp',
              tag: 'MA',
              sourceType: 'cpp.g++17',
            },
            {
              name: 'wa',
              source: 'wa.cpp',
              tag: 'WA',
              sourceType: 'cpp.g++17',
            },
          ],
          checker: { name: 'chk', source: 'chk.cpp' },
          testsets: [{ name: 'ts1' }],
        })
      );
      mockedGetTestFiles.mockReturnValue(['test1.txt']);
    });

    it('should run main then target then compare', async () => {
      mockedExecuteWithRedirect.mockResolvedValue(okResult);

      mockedRunChecker.mockRejectedValue(new Error('Wrong Answer'));

      await solution.testSolutionAgainstMainCorrect('wa');

      expect(mockedExecuteWithRedirect).toHaveBeenCalledTimes(2);
      expect(mockedRunChecker).toHaveBeenCalledTimes(1);
    });

    it('should fail before running anything when a multiplier is invalid', async () => {
      // Regression: the bad factor used to be swallowed as an expected
      // failure of the target solution, so the check passed without running it.
      mockedReadConfigFile.mockReturnValue(
        makeConfig({
          solutions: [
            { name: 'main', source: 'main.cpp', tag: 'MA' },
            { name: 'slow', source: 'Slow.java', tag: 'OK' },
          ],
          checker: { name: 'chk', source: 'chk.cpp' },
          testsets: [{ name: 'ts1' }],
          timeLimitMultipliers: { java: 0 },
        })
      );

      await expect(
        solution.testSolutionAgainstMainCorrect('slow')
      ).rejects.toThrow(/Invalid timeLimitMultipliers\.java/);
      expect(mockedExecuteWithRedirect).not.toHaveBeenCalled();
      expect(mockedRunChecker).not.toHaveBeenCalled();
    });

    it('should fail if main solution fails', async () => {
      mockedExecuteWithRedirect.mockRejectedValueOnce(new Error('Main fail'));
      await expect(
        solution.testSolutionAgainstMainCorrect('wa')
      ).rejects.toThrow(/Failed to test solution "wa"/);
    });

    it('should fail if comparison process fails', async () => {
      mockedGetCompiledCommandToRun.mockImplementation(() => {
        throw new Error('Compilation missing');
      });

      await expect(
        solution.testSolutionAgainstMainCorrect('wa')
      ).rejects.toThrow(/Compilation missing/);
    });
  });

  describe('startTheComparisonProcess', () => {
    const checkerOk: Awaited<ReturnType<typeof checker.runChecker>> =
      undefined as unknown as Awaited<ReturnType<typeof checker.runChecker>>;

    it('should validate expected verdicts', async () => {
      const mainSol: LocalSolution = {
        name: 'm',
        source: '',
        tag: 'MA',
        sourceType: 'cpp.g++17',
      };
      const targetSol: LocalSolution = {
        name: 'w',
        source: '',
        tag: 'WA',
        sourceType: 'cpp.g++17',
      };
      const testsets: LocalTestset[] = [{ name: 'ts1' }];
      const checkerConfig: LocalChecker = { name: 'chk', source: 'chk.cpp' };

      mockedGetTestFiles.mockReturnValue(['t1.txt']);
      mockedRunChecker.mockRejectedValue(new Error('Wrong Answer'));

      await expect(
        solution.startTheComparisonProcess(
          checkerConfig,
          mainSol,
          targetSol,
          testsets
        )
      ).resolves.not.toThrow();
    });

    it('should throw if verdict does not match expected', async () => {
      const mainSol: LocalSolution = {
        name: 'm',
        source: '',
        tag: 'MA',
        sourceType: 'cpp.g++17',
      };
      const targetSol: LocalSolution = {
        name: 'w',
        source: '',
        tag: 'WA',
        sourceType: 'cpp.g++17',
      };
      const testsets: LocalTestset[] = [{ name: 'ts1' }];

      mockedGetTestFiles.mockReturnValue(['t1.txt']);
      mockedRunChecker.mockResolvedValue(checkerOk);

      await expect(
        solution.startTheComparisonProcess(
          { name: 'chk', source: '' },
          mainSol,
          targetSol,
          testsets
        )
      ).rejects.toThrow('Error during solution comparison process');
    });

    it('judges every test when the solution is wrong on more than one', async () => {
      const mainSol: LocalSolution = {
        name: 'm',
        source: '',
        tag: 'MA',
        sourceType: 'cpp.g++17',
      };
      const targetSol: LocalSolution = {
        name: 'w',
        source: '',
        tag: 'WA',
        sourceType: 'cpp.g++17',
      };
      const spy = vi.spyOn(report, 'updateTestVerdict');

      mockedGetTestFiles.mockReturnValue(['t1.txt', 't2.txt', 't3.txt']);
      mockedRunChecker.mockRejectedValue(new Error('Wrong Answer'));

      await solution.startTheComparisonProcess(
        { name: 'chk', source: 'chk.cpp' },
        mainSol,
        targetSol,
        [{ name: 'ts1' }]
      );

      expect(mockedRunChecker).toHaveBeenCalledTimes(3);
      expect(spy).toHaveBeenCalledTimes(3);
      for (const index of [1, 2, 3]) {
        expect(spy).toHaveBeenCalledWith(
          targetSol,
          'ts1',
          index,
          'WA',
          'Wrong Answer'
        );
      }
      spy.mockRestore();
    });

    describe('presentation errors', () => {
      const mainSol: LocalSolution = {
        name: 'm',
        source: '',
        tag: 'MA',
        sourceType: 'cpp.g++17',
      };
      const solutionWithTag = (tag: LocalSolution['tag']): LocalSolution => ({
        name: 'p',
        source: '',
        tag,
        sourceType: 'cpp.g++17',
      });
      const checkerConfig: LocalChecker = { name: 'chk', source: 'chk.cpp' };

      it('records PE on every test and accepts a PE-tagged solution', async () => {
        const targetSol = solutionWithTag('PE');
        const spy = vi.spyOn(report, 'updateTestVerdict');

        mockedGetTestFiles.mockReturnValue(['t1.txt', 't2.txt', 't3.txt']);
        mockedRunChecker.mockRejectedValue(
          new checker.PresentationError('wrong output format')
        );

        await expect(
          solution.startTheComparisonProcess(
            checkerConfig,
            mainSol,
            targetSol,
            [{ name: 'ts1' }]
          )
        ).resolves.not.toThrow();

        expect(mockedRunChecker).toHaveBeenCalledTimes(3);
        expect(spy).toHaveBeenCalledTimes(3);
        for (const index of [1, 2, 3]) {
          expect(spy).toHaveBeenCalledWith(
            targetSol,
            'ts1',
            index,
            'PE',
            'wrong output format'
          );
        }
        expect(spy).not.toHaveBeenCalledWith(
          targetSol,
          'ts1',
          expect.anything(),
          'WA',
          expect.anything()
        );
        spy.mockRestore();
      });

      it('rejects an MA-tagged solution that gets a presentation error', async () => {
        mockedGetTestFiles.mockReturnValue(['t1.txt']);
        mockedRunChecker.mockRejectedValue(
          new checker.PresentationError('wrong output format')
        );

        await expect(
          solution.startTheComparisonProcess(
            checkerConfig,
            mainSol,
            solutionWithTag('MA'),
            [{ name: 'ts1' }]
          )
        ).rejects.toThrow(/Presentation Error/);
      });

      it('rejects a PE-tagged solution that passes every test', async () => {
        mockedGetTestFiles.mockReturnValue(['t1.txt']);
        mockedRunChecker.mockResolvedValue(undefined);

        await expect(
          solution.startTheComparisonProcess(
            checkerConfig,
            mainSol,
            solutionWithTag('PE'),
            [{ name: 'ts1' }]
          )
        ).rejects.toThrow(/did not get Presentation Error/);
      });

      it('rejects a PE-tagged solution that only gets wrong answers', async () => {
        mockedGetTestFiles.mockReturnValue(['t1.txt']);
        mockedRunChecker.mockRejectedValue(new Error('Wrong Answer'));

        await expect(
          solution.startTheComparisonProcess(
            checkerConfig,
            mainSol,
            solutionWithTag('PE'),
            [{ name: 'ts1' }]
          )
        ).rejects.toThrow(/did not get Presentation Error/);
      });

      it('accepts a PE-tagged solution with both PE and WA tests, and records each', async () => {
        const targetSol = solutionWithTag('PE');
        const spy = vi.spyOn(report, 'updateTestVerdict');

        mockedGetTestFiles.mockReturnValue(['t1.txt', 't2.txt']);
        mockedRunChecker
          .mockRejectedValueOnce(new checker.PresentationError('bad format'))
          .mockRejectedValueOnce(new Error('Wrong Answer'));

        await expect(
          solution.startTheComparisonProcess(
            checkerConfig,
            mainSol,
            targetSol,
            [{ name: 'ts1' }]
          )
        ).resolves.not.toThrow();

        expect(spy).toHaveBeenCalledWith(
          targetSol,
          'ts1',
          1,
          'PE',
          'bad format'
        );
        expect(spy).toHaveBeenCalledWith(
          targetSol,
          'ts1',
          2,
          'WA',
          'Wrong Answer'
        );
        spy.mockRestore();
      });

      it('still records WA for a plain checker failure', async () => {
        const targetSol = solutionWithTag('WA');
        const spy = vi.spyOn(report, 'updateTestVerdict');

        mockedGetTestFiles.mockReturnValue(['t1.txt']);
        mockedRunChecker.mockRejectedValue(new Error('Wrong Answer'));

        await solution.startTheComparisonProcess(
          checkerConfig,
          mainSol,
          targetSol,
          [{ name: 'ts1' }]
        );

        expect(spy).toHaveBeenCalledWith(
          targetSol,
          'ts1',
          1,
          'WA',
          'Wrong Answer'
        );
        spy.mockRestore();
      });

      it('rethrows a checker limit hit and does not record it as WA', async () => {
        const targetSol = solutionWithTag('WA');
        const spy = vi.spyOn(report, 'updateTestVerdict');

        mockedGetTestFiles.mockReturnValue(['t1.txt', 't2.txt']);
        mockedRunChecker.mockRejectedValue(
          new LimitExceededError('Checker exceeded the time limit (1000ms)')
        );

        await expect(
          solution.startTheComparisonProcess(
            checkerConfig,
            mainSol,
            targetSol,
            [{ name: 'ts1' }]
          )
        ).rejects.toBeInstanceOf(LimitExceededError);

        expect(mockedRunChecker).toHaveBeenCalledTimes(1);
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      });
    });

    describe('empty main output', () => {
      const mainSol: LocalSolution = { name: 'main', source: '', tag: 'MA' };
      const otherSol: LocalSolution = { name: 'other', source: '', tag: 'OK' };
      const checkerConfig: LocalChecker = { name: 'chk', source: 'chk.cpp' };
      const isMainOutput = (file: unknown) => String(file).includes('/main/');
      const compare = (target: LocalSolution = otherSol) =>
        solution.startTheComparisonProcess(checkerConfig, mainSol, target, [
          { name: 'tests' },
        ]);

      /** Serves `outputs[name][testFile]` for both readFirstLine and open. */
      function mockOutputs(outputs: {
        main: Record<string, string>;
        other: Record<string, string>;
      }) {
        const contentOf = (file: unknown) => {
          const name = String(file);
          const byTest = isMainOutput(name) ? outputs.main : outputs.other;
          const test = path.basename(name).replace(/^output_/, '');
          return byTest[test] ?? '';
        };
        mockedReadFirstLine.mockImplementation(file =>
          Promise.resolve(contentOf(file).split(/\r?\n/)[0] ?? '')
        );
        mockFileContents(contentOf);
      }

      it('sends a single empty answer to the checker like any other answer', async () => {
        mockedGetTestFiles.mockReturnValue(['test1.txt', 'test2.txt']);
        mockOutputs({
          main: { 'test1.txt': '', 'test2.txt': '7\n' },
          other: { 'test1.txt': '', 'test2.txt': '7\n' },
        });
        mockedRunChecker.mockResolvedValue(undefined);

        await expect(compare()).resolves.toBeUndefined();
        expect(mockedRunChecker).toHaveBeenCalledTimes(2);
      });

      it('does not fail when the main is empty on one test and the other prints output there', async () => {
        mockedGetTestFiles.mockReturnValue(['test1.txt', 'test2.txt']);
        mockOutputs({
          main: { 'test1.txt': '', 'test2.txt': '7\n' },
          other: { 'test1.txt': '42\n', 'test2.txt': '7\n' },
        });
        mockedRunChecker.mockRejectedValueOnce(new Error('Wrong Answer'));
        mockedRunChecker.mockResolvedValue(undefined);
        const wrongSol: LocalSolution = { ...otherSol, tag: 'WA' };

        await expect(compare(wrongSol)).resolves.toBeUndefined();
        expect(mockedRunChecker).toHaveBeenCalledTimes(2);
      });

      it('fails and names the main when it prints nothing on every test and the other prints output', async () => {
        mockedGetTestFiles.mockReturnValue(['test1.txt', 'test2.txt']);
        mockOutputs({
          main: { 'test1.txt': '', 'test2.txt': '' },
          other: { 'test1.txt': '', 'test2.txt': '42\n' },
        });

        const rejection = compare();
        await expect(rejection).rejects.toThrow(
          'Main solution "main" printed nothing on every test (2 in total), but "other" printed output (first on test test2.txt in testset tests).'
        );
        await expect(rejection).rejects.toThrow(/ONLINE_JUDGE/);
        expect(mockedRunChecker).not.toHaveBeenCalled();
      });

      it('treats a main output of only whitespace as nothing', async () => {
        mockedGetTestFiles.mockReturnValue(['test1.txt']);
        mockOutputs({
          main: { 'test1.txt': '\n  \n' },
          other: { 'test1.txt': '42\n' },
        });

        await expect(compare()).rejects.toThrow(
          /Main solution "main" printed nothing on every test/
        );
      });

      it('accepts a main output that starts with an empty line', async () => {
        mockedGetTestFiles.mockReturnValue(['test1.txt']);
        mockOutputs({
          main: { 'test1.txt': '\n42\n' },
          other: { 'test1.txt': '42\n' },
        });
        mockedRunChecker.mockResolvedValue(undefined);

        await expect(compare()).resolves.toBeUndefined();
        expect(mockedRunChecker).toHaveBeenCalledTimes(1);
      });

      it('does not fail when the main and the other solution print nothing on every test', async () => {
        mockedGetTestFiles.mockReturnValue(['test1.txt', 'test2.txt']);
        mockedRunChecker.mockResolvedValue(undefined);

        await expect(compare()).resolves.toBeUndefined();
        expect(mockedRunChecker).toHaveBeenCalledTimes(2);
      });

      it('does not count a runtime error marker as output of the other solution', async () => {
        mockedGetTestFiles.mockReturnValue(['test1.txt']);
        mockOutputs({
          main: { 'test1.txt': '' },
          other: { 'test1.txt': 'Runtime Error: segfault' },
        });
        const crashingSol: LocalSolution = { ...otherSol, tag: 'RE' };

        await expect(compare(crashingSol)).resolves.toBeUndefined();
        expect(mockedRunChecker).not.toHaveBeenCalled();
      });

      it('does not count a missing output of the other solution as output', async () => {
        mockedGetTestFiles.mockReturnValue(['test1.txt']);
        mockedFsExistsSync.mockImplementation(file => isMainOutput(file));

        await expect(compare()).resolves.toBeUndefined();
        expect(mockedRunChecker).not.toHaveBeenCalled();
      });
    });

    it('should handle skip logic via checkIfShouldSkipRest interception', () => {
      // Placeholder
    });

    describe('Extended Branch Coverage', () => {
      describe('Verdict Validation via startTheComparisonProcess', () => {
        const testsets: LocalTestset[] = [{ name: 'ts1' }];
        const checkerConfig: LocalChecker = {
          name: 'chk',
          source: 'chk.cpp',
        };

        beforeEach(() => {
          mockedGetTestFiles.mockReturnValue(['t1.txt']);
          // Default: main solution OK
          mockedReadFirstLine.mockImplementation((p: string) => {
            if (p.includes('sol_main')) return Promise.resolve('42'); // Main OK
            return Promise.resolve(''); // Target default
          });
        });

        it('should pass if solution tag is TL and it gets TLE', async () => {
          const mainSol: LocalSolution = {
            name: 'sol_main',
            source: '',
            tag: 'MA',
            sourceType: 'cpp.g++17',
          };
          const targetSol: LocalSolution = {
            name: 'sol_target',
            source: '',
            tag: 'TL',
            sourceType: 'cpp.g++17',
          };

          mockedReadFirstLine.mockImplementation((p: string) => {
            if (p.includes('sol_main')) return Promise.resolve('42');
            if (p.includes('sol_target'))
              return Promise.resolve('Time Limit Exceeded');
            return Promise.resolve('');
          });

          await expect(
            solution.startTheComparisonProcess(
              checkerConfig,
              mainSol,
              targetSol,
              testsets
            )
          ).resolves.not.toThrow();
        });

        it('should fail if solution tag is MA but gets TLE', async () => {
          const mainSol: LocalSolution = {
            name: 'sol_main',
            source: '',
            tag: 'MA',
            sourceType: 'cpp.g++17',
          };
          const targetSol: LocalSolution = {
            name: 'sol_target',
            source: '',
            tag: 'MA',
            sourceType: 'cpp.g++17',
          };

          mockedReadFirstLine.mockImplementation((p: string) => {
            if (p.includes('sol_main')) return Promise.resolve('42');
            if (p.includes('sol_target'))
              return Promise.resolve('Time Limit Exceeded');
            return Promise.resolve('');
          });

          await expect(
            solution.startTheComparisonProcess(
              checkerConfig,
              mainSol,
              targetSol,
              testsets
            )
          ).rejects.toThrow(/marked as.*MA.*but got.*Time Limit Exceeded/);
        });

        it('should pass if solution tag is ML and it gets MLE', async () => {
          const mainSol: LocalSolution = {
            name: 'sol_main',
            source: '',
            tag: 'MA',
            sourceType: 'cpp.g++17',
          };
          const targetSol: LocalSolution = {
            name: 'sol_target',
            source: '',
            tag: 'ML',
            sourceType: 'cpp.g++17',
          };

          mockedReadFirstLine.mockImplementation((p: string) => {
            if (p.includes('sol_main')) return Promise.resolve('42');
            if (p.includes('sol_target'))
              return Promise.resolve('Memory Limit Exceeded');
            return Promise.resolve('');
          });

          await expect(
            solution.startTheComparisonProcess(
              checkerConfig,
              mainSol,
              targetSol,
              testsets
            )
          ).resolves.not.toThrow();
        });

        it('should fail if solution tag is MA but gets MLE', async () => {
          const mainSol: LocalSolution = {
            name: 'sol_main',
            source: '',
            tag: 'MA',
            sourceType: 'cpp.g++17',
          };
          const targetSol: LocalSolution = {
            name: 'sol_target',
            source: '',
            tag: 'MA',
            sourceType: 'cpp.g++17',
          };

          mockedReadFirstLine.mockImplementation((p: string) => {
            if (p.includes('sol_main')) return Promise.resolve('42');
            if (p.includes('sol_target'))
              return Promise.resolve('Memory Limit Exceeded');
            return Promise.resolve('');
          });

          await expect(
            solution.startTheComparisonProcess(
              checkerConfig,
              mainSol,
              targetSol,
              testsets
            )
          ).rejects.toThrow(/marked as.*MA.*but got.*Memory Limit Exceeded/);
        });

        it('should pass if solution tag is RE and it gets RTE', async () => {
          const mainSol: LocalSolution = {
            name: 'sol_main',
            source: '',
            tag: 'MA',
            sourceType: 'cpp.g++17',
          };
          const targetSol: LocalSolution = {
            name: 'sol_target',
            source: '',
            tag: 'RE',
            sourceType: 'cpp.g++17',
          };

          mockedReadFirstLine.mockImplementation((p: string) => {
            if (p.includes('sol_main')) return Promise.resolve('42');
            if (p.includes('sol_target'))
              return Promise.resolve('Runtime Error');
            return Promise.resolve('');
          });

          await expect(
            solution.startTheComparisonProcess(
              checkerConfig,
              mainSol,
              targetSol,
              testsets
            )
          ).resolves.not.toThrow();
        });

        it('should fail if solution tag is MA but gets RTE', async () => {
          const mainSol: LocalSolution = {
            name: 'sol_main',
            source: '',
            tag: 'MA',
            sourceType: 'cpp.g++17',
          };
          const targetSol: LocalSolution = {
            name: 'sol_target',
            source: '',
            tag: 'MA',
            sourceType: 'cpp.g++17',
          };

          mockedReadFirstLine.mockImplementation((p: string) => {
            if (p.includes('sol_main')) return Promise.resolve('42');
            if (p.includes('sol_target'))
              return Promise.resolve('Runtime Error');
            return Promise.resolve('');
          });

          await expect(
            solution.startTheComparisonProcess(
              checkerConfig,
              mainSol,
              targetSol,
              testsets
            )
          ).rejects.toThrow(/marked as.*MA.*but got.*Runtime Error/);
        });

        it('should fail if tag is TL but did not get TLE', async () => {
          const mainSol: LocalSolution = {
            name: 'sol_main',
            source: '',
            tag: 'MA',
            sourceType: 'cpp.g++17',
          };
          const targetSol: LocalSolution = {
            name: 'sol_target',
            source: '',
            tag: 'TL',
            sourceType: 'cpp.g++17',
          };

          // Normal output -> No TLE
          mockedReadFirstLine.mockResolvedValue('42');
          mockedRunChecker.mockResolvedValue(checkerOk);

          await expect(
            solution.startTheComparisonProcess(
              checkerConfig,
              mainSol,
              targetSol,
              testsets
            )
          ).rejects.toThrow(
            /marked as.*TL.*but did not get.*Time Limit Exceeded/
          );
        });

        it('should fail if tag is WA but did not get WA', async () => {
          const mainSol: LocalSolution = {
            name: 'sol_main',
            source: '',
            tag: 'MA',
            sourceType: 'cpp.g++17',
          };
          const targetSol: LocalSolution = {
            name: 'sol_target',
            source: '',
            tag: 'WA',
            sourceType: 'cpp.g++17',
          };

          // Checker passes -> No WA
          mockedReadFirstLine.mockResolvedValue('42');
          mockedRunChecker.mockResolvedValue(checkerOk);

          await expect(
            solution.startTheComparisonProcess(
              checkerConfig,
              mainSol,
              targetSol,
              testsets
            )
          ).rejects.toThrow(/marked as.*WA.*but did not get.*Wrong Answer/);
        });
      });

      describe('Control Flow', () => {
        it('should stop running testset after first failure', async () => {
          const mockSolution: LocalSolution = {
            name: 'main',
            source: 'main.cpp',
            tag: 'MA',
          };
          const mockConfig: ConfigFile = makeConfig();

          mockedGetTestFiles.mockReturnValue(['t1.txt', 't2.txt', 't3.txt']);
          // Fail on first
          mockedExecuteWithRedirect.mockRejectedValueOnce(new Error('Fail'));

          await expect(
            solution.runSolutionOnTestset(mockSolution, mockConfig, 'ts1')
          ).rejects.toThrow();

          // Should only be called once due to break
          expect(mockedExecuteWithRedirect).toHaveBeenCalledTimes(1);
        });

        it('should stop running group after first failure', async () => {
          const mockSolution: LocalSolution = {
            name: 'main',
            source: 'main.cpp',
            tag: 'MA',
          };
          const mockConfig: ConfigFile = makeConfig();
          const mockTestset: LocalTestset = { name: 'ts1' };

          mockedGetTestIndicesForGroup.mockReturnValue([1, 2]);

          mockedExecuteWithRedirect.mockRejectedValueOnce(new Error('Fail'));

          await expect(
            solution.runSolutionOnGroup(
              mockSolution,
              mockConfig,
              mockTestset,
              'g1'
            )
          ).rejects.toThrow();
          expect(mockedExecuteWithRedirect).toHaveBeenCalledTimes(1);
        });
      });

      describe('Filesystem', () => {
        it('should ensure output directory is created', async () => {
          const mockSolution: LocalSolution = {
            name: 'main',
            source: 'main.cpp',
            tag: 'MA',
          };
          const mockConfig: ConfigFile = makeConfig();

          // Mock fs.existsSync to return false, forcing mkdirSync
          mockedFsExistsSync.mockReturnValue(false);
          mockedExecuteWithRedirect.mockResolvedValue(okResult);

          await solution.runSolutionOnSingleTest(
            mockSolution,
            mockConfig,
            'ts1',
            1
          );

          expect(mockedFsMkdirSync).toHaveBeenCalledWith(
            expect.stringMatching(/main[\\/]ts1/),
            expect.anything()
          );
        });

        it('should delete existing output file', async () => {
          const mockSolution: LocalSolution = {
            name: 'main',
            source: 'main.cpp',
            tag: 'MA',
          };
          const mockConfig: ConfigFile = makeConfig();

          mockedFsExistsSync.mockReturnValue(true);
          mockedExecuteWithRedirect.mockResolvedValue(okResult);

          await solution.runSolutionOnSingleTest(
            mockSolution,
            mockConfig,
            'ts1',
            1
          );

          expect(mockedFsUnlinkSync).toHaveBeenCalled();
        });
      });
    });
  });
  describe('tag rules', () => {
    type Tag = LocalSolution['tag'];
    type Outcome = 'pass' | 'TLE' | 'MLE' | 'RTE' | 'WA' | 'PE';

    const mainSol: LocalSolution = {
      name: 'sol_main',
      source: '',
      tag: 'MA',
      sourceType: 'cpp.g++17',
    };
    const checkerConfig: LocalChecker = { name: 'chk', source: 'chk.cpp' };

    // What the target solution produced, as the comparison process sees it.
    function arrange(outcome: Outcome) {
      const firstLines: Partial<Record<Outcome, string>> = {
        TLE: 'Time Limit Exceeded after 1000ms',
        MLE: 'Memory Limit Exceeded (256 MB)',
        RTE: 'Runtime Error: segmentation fault',
      };
      mockedGetTestFiles.mockReturnValue(['t1.txt']);
      mockedReadFirstLine.mockImplementation((p: string) =>
        Promise.resolve(
          p.includes('sol_main') ? '42' : (firstLines[outcome] ?? '42')
        )
      );
      if (outcome === 'WA') {
        mockedRunChecker.mockRejectedValue(new Error('Wrong Answer'));
      } else if (outcome === 'PE') {
        mockedRunChecker.mockRejectedValue(
          new checker.PresentationError('bad format')
        );
      } else {
        mockedRunChecker.mockResolvedValue(
          undefined as unknown as Awaited<ReturnType<typeof checker.runChecker>>
        );
      }
    }

    function compare(tag: Tag, outcome: Outcome) {
      arrange(outcome);
      const target: LocalSolution = {
        name: 'sol_target',
        source: '',
        tag,
        sourceType: 'cpp.g++17',
      };
      return solution.startTheComparisonProcess(
        checkerConfig,
        mainSol,
        target,
        [{ name: 'ts1' }]
      );
    }

    const verdictName: Record<Exclude<Outcome, 'pass'>, string> = {
      TLE: 'Time Limit Exceeded',
      MLE: 'Memory Limit Exceeded',
      RTE: 'Runtime Error',
      WA: 'Wrong Answer',
      PE: 'Presentation Error',
    };

    // Tags that must accept / reject a solution that got only this verdict.
    const verdictRules: {
      outcome: Exclude<Outcome, 'pass'>;
      accepted: Tag[];
      rejected: Tag[];
    }[] = [
      {
        outcome: 'TLE',
        accepted: ['TL', 'TO', 'RJ'],
        rejected: ['MA', 'OK', 'WA', 'PE', 'ML', 'RE'],
      },
      {
        outcome: 'MLE',
        accepted: ['ML', 'RJ'],
        rejected: ['MA', 'OK', 'TL', 'TO', 'WA', 'PE', 'RE'],
      },
      {
        outcome: 'RTE',
        accepted: ['RE', 'RJ'],
        rejected: ['MA', 'OK', 'TL', 'TO', 'WA', 'PE', 'ML'],
      },
      {
        outcome: 'WA',
        // PE is not accepted here: a PE-tagged solution needs a PE verdict
        accepted: ['WA', 'RJ'],
        rejected: ['MA', 'OK', 'TL', 'TO', 'ML', 'RE'],
      },
      {
        outcome: 'PE',
        accepted: ['WA', 'PE', 'RJ'],
        rejected: ['MA', 'OK', 'TL', 'TO', 'ML', 'RE'],
      },
    ];

    for (const { outcome, accepted, rejected } of verdictRules) {
      describe(`when the solution gets ${verdictName[outcome]}`, () => {
        for (const tag of accepted) {
          it(`accepts tag ${tag}`, async () => {
            await expect(compare(tag, outcome)).resolves.toBeUndefined();
          });
        }
        for (const tag of rejected) {
          it(`rejects tag ${tag}`, async () => {
            await expect(compare(tag, outcome)).rejects.toThrow(
              `marked as ${tag} but got ${verdictName[outcome]} on some tests`
            );
          });
        }
      });
    }

    describe('when the solution passes every test', () => {
      for (const tag of ['MA', 'OK', 'TO'] as Tag[]) {
        it(`accepts tag ${tag}`, async () => {
          await expect(compare(tag, 'pass')).resolves.toBeUndefined();
        });
      }

      const mustFail: [Tag, string][] = [
        ['TL', 'marked as TL but did not get Time Limit Exceeded on any test'],
        [
          'ML',
          'marked as ML but did not get Memory Limit Exceeded on any test',
        ],
        ['WA', 'marked as WA but did not get Wrong Answer on any test'],
        ['PE', 'marked as PE but did not get Presentation Error on any test'],
        ['RJ', 'marked as RJ but passed all tests correctly'],
      ];
      for (const [tag, message] of mustFail) {
        it(`rejects tag ${tag}`, async () => {
          await expect(compare(tag, 'pass')).rejects.toThrow(message);
        });
      }
    });
  });

  describe('parseTestIndex', () => {
    it('extracts the numeric index from a test file name', () => {
      expect(solution.parseTestIndex('test12.txt')).toBe(12);
      expect(solution.parseTestIndex('test1.txt')).toBe(1);
    });

    it('returns 0 when there is no number', () => {
      expect(solution.parseTestIndex('weird.txt')).toBe(0);
    });
  });

  describe('JSON report recording', () => {
    const mockSolution: LocalSolution = {
      name: 'main',
      source: 'main.cpp',
      tag: 'MA',
    };
    const mockConfig: ConfigFile = makeConfig();

    it('records OK with the test index after a clean run', async () => {
      const spy = vi.spyOn(report, 'recordTest');
      mockedExecuteWithRedirect.mockResolvedValue(okResult);
      await solution.runSolutionOnSingleTest(
        mockSolution,
        mockConfig,
        'tests',
        7
      );
      expect(spy).toHaveBeenCalledWith(
        mockSolution,
        expect.objectContaining({
          testset: 'tests',
          index: 7,
          verdict: 'OK',
          message: '',
        })
      );
      expect(spy.mock.calls[0][1]).not.toHaveProperty('group');
      spy.mockRestore();
    });

    it('records TLE before the timeout error propagates', async () => {
      const spy = vi.spyOn(report, 'recordTest');
      mockedExecuteWithRedirect.mockImplementation(
        (_cmd: string, options: ExecutionOptions) => {
          options.onTimeout?.({
            stdout: '',
            stderr: '',
            exitCode: 124,
            success: false,
            timedOut: true,
          });
          return Promise.resolve(okResult);
        }
      );
      mockedFsWriteFileSync.mockImplementation(() => {});
      await expect(
        solution.runSolutionOnSingleTest(mockSolution, mockConfig, 'tests', 2)
      ).rejects.toThrow('Time Limit Exceeded');
      expect(spy).toHaveBeenCalledWith(
        mockSolution,
        expect.objectContaining({
          index: 2,
          verdict: 'TLE',
          message: 'Time Limit Exceeded after 1000ms',
        })
      );
      spy.mockRestore();
    });

    it('records the group name when running a group', async () => {
      const spy = vi.spyOn(report, 'recordTest');
      mockedExecuteWithRedirect.mockResolvedValue(okResult);
      mockedGetTestIndicesForGroup.mockReturnValue([3]);
      await solution.runSolutionOnGroup(
        mockSolution,
        mockConfig,
        { name: 'tests' } as unknown as Parameters<
          typeof solution.runSolutionOnGroup
        >[2],
        'samples'
      );
      expect(spy).toHaveBeenCalledWith(
        mockSolution,
        expect.objectContaining({
          testset: 'tests',
          index: 3,
          group: 'samples',
        })
      );
      spy.mockRestore();
    });
  });
});

// Reference type-only imports to avoid unused-import errors with verbatim modes.
export type { CheckerVerdict };
