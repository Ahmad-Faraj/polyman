import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as validator from '../../src/helpers/validator';
import { executor } from '../../src/executor';
import type { ExecutionOptions, ExecutionResult } from '../../src/executor';
import * as utils from '../../src/helpers/utils';
import * as testsetHelper from '../../src/helpers/testset';
import { fmt } from '../../src/formatter';
import { report } from '../../src/report';
import fs from 'fs';
import path from 'path';
import { LimitExceededError, PolymanError } from '../../src/errors';
import type ConfigFile from '../../src/types';
import type { LocalValidator, LocalTestset } from '../../src/types';

vi.mock('fs');
vi.mock('path');
vi.mock('../../src/executor', () => ({
  executor: {
    executeWithRedirect: vi.fn(),
    cleanup: vi.fn(),
  },
}));
vi.mock('../../src/helpers/utils');
vi.mock('../../src/helpers/testset');
vi.mock('../../src/formatter', () => ({
  fmt: {
    error: vi.fn(),
    warning: vi.fn(),
    bold: vi.fn((str: string) => str),
    cross: vi.fn(() => '✗'),
  },
}));

// Typed mock references obtained via `vi.mocked(module)` so we never access an
// unbound method directly (which would trip @typescript-eslint/unbound-method).
const mockedPath = vi.mocked(path);
const mockedFs = vi.mocked(fs);
const mockedExecutor = vi.mocked(executor);
const mockedUtils = vi.mocked(utils);
const mockedTestsetHelper = vi.mocked(testsetHelper);
const mockedFmt = vi.mocked(fmt);

// Bracket-form member access avoids the unbound-method rule for methods whose
// declared types lack `this: void`. The aliased values are still proper
// vitest mock functions because vi.mocked is a typed identity.
const mockedPathResolve = mockedPath['resolve'];
const mockedPathJoin = mockedPath['join'];
const mockedExistsSync = mockedFs['existsSync'];
const mockedReadFile = mockedFs['readFile'];
const mockedWriteFileSync = mockedFs['writeFileSync'];
const mockedExecuteWithRedirect = mockedExecutor['executeWithRedirect'];
const mockedCleanup = mockedExecutor['cleanup'];
const mockedCompileCPP = mockedUtils['compileCPP'];
const mockedGetCompiledCommandToRun = mockedUtils['getCompiledCommandToRun'];
const mockedGetTestFiles = mockedUtils['getTestFiles'];
const mockedThrowError = mockedUtils['throwError'];
const mockedLogError = mockedUtils['logError'];
const mockedReadConfigFile = mockedUtils['readConfigFile'];
const mockedEnsureDirectoryExists = mockedUtils['ensureDirectoryExists'];
const mockedRemoveDirectoryRecursively =
  mockedUtils['removeDirectoryRecursively'];
const mockedGetTestIndicesForGroup =
  mockedTestsetHelper['getTestIndicesForGroup'];
const mockedFmtError = mockedFmt['error'];
const mockedFmtWarning = mockedFmt['warning'];

const SUCCESS_RESULT: ExecutionResult = {
  stdout: '',
  stderr: '',
  exitCode: 0,
  success: true,
};

const FAILURE_RESULT: ExecutionResult = {
  stdout: '',
  stderr: '',
  exitCode: 1,
  success: false,
};

/**
 * Make `throwError` actually throw — its real signature returns `never` so the
 * mock impl must as well.
 */
function rethrowImpl(error: unknown): never {
  throw error instanceof Error ? error : new Error(String(error));
}

/**
 * Build a typed `executeWithRedirect` mock implementation that invokes
 * `onError` and then throws the given error. Avoids `any`/unsafe access.
 */
function executeOnErrorThrow(
  stderr: string,
  message: string
): (
  command: string,
  options: ExecutionOptions,
  inputFile?: string,
  outputFile?: string
) => Promise<ExecutionResult> {
  return (_command, options) => {
    options.onError?.({ ...FAILURE_RESULT, stderr });
    throw new Error(message);
  };
}

/**
 * Build a typed `executeWithRedirect` mock implementation that invokes
 * `onError` and resolves with a failure result (does not throw).
 */
function executeOnErrorResolve(
  stderr: string
): (
  command: string,
  options: ExecutionOptions,
  inputFile?: string,
  outputFile?: string
) => Promise<ExecutionResult> {
  return (_command, options) => {
    options.onError?.({ ...FAILURE_RESULT, stderr });
    return Promise.resolve({ ...FAILURE_RESULT, stderr });
  };
}

/**
 * Common required-but-irrelevant fields needed to satisfy the ConfigFile
 * structural type. The validator self-test code only inspects
 * `config.validator`, so these placeholders never affect behaviour.
 */
const CONFIG_BASE: Omit<ConfigFile, 'validator'> = {
  name: 'problem',
  timeLimit: 1000,
  memoryLimit: 256,
  inputFile: 'stdin',
  outputFile: 'stdout',
  interactive: false,
  statements: {},
  solutions: [],
  checker: { name: 'chk', source: 'chk.cpp' },
};

/**
 * Build a typed ConfigFile carrying the supplied validator (or a default one
 * if none is given).
 */
function buildConfig(validatorOverride?: LocalValidator): ConfigFile {
  const config: ConfigFile = {
    ...CONFIG_BASE,
    validator: validatorOverride ?? { name: 'val', source: 'val.cpp' },
  };
  return config;
}

/**
 * Build a ConfigFile-shaped object whose `validator` field is missing at
 * runtime. We model this by widening to `ConfigFile`-without-validator and
 * narrowing back, which is structurally truthful without using `any`.
 */
function buildConfigMissingValidator(): ConfigFile {
  const partial: Omit<ConfigFile, 'validator'> = CONFIG_BASE;
  return partial as unknown as ConfigFile;
}

/**
 * Type-safe stand-in for the (path, encoding, callback) overload of
 * fs.readFile that the validator uses. Always resolves with the supplied
 * result, ignoring the call's actual arguments.
 */
type ReadFileWithEncoding = (
  path: fs.PathOrFileDescriptor,
  encoding: BufferEncoding,
  callback: (err: NodeJS.ErrnoException | null, data: string) => void
) => void;

function readFileImpl(
  err: NodeJS.ErrnoException | null,
  data: string
): ReadFileWithEncoding {
  return (_path, _encoding, callback) => {
    callback(err, data);
  };
}

describe('validator.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPathResolve.mockImplementation((...args: string[]) => args.join('/'));
    mockedPathJoin.mockImplementation((...args: string[]) => args.join('/'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('ensureValidatorExists', () => {
    it('should not throw if validator is defined', () => {
      expect(() =>
        validator.ensureValidatorExists({ name: 'val', source: 'val.cpp' })
      ).not.toThrow();
    });

    it('should throw if validator is undefined', () => {
      expect(() => validator.ensureValidatorExists(undefined)).toThrow(
        'No validator defined in the configuration file.'
      );
    });
  });

  describe('compileValidator', () => {
    it('should compile validator successfully', async () => {
      const mockValidator: LocalValidator = {
        name: 'val',
        source: 'validator/val.cpp',
      };
      mockedCompileCPP.mockResolvedValue();

      await expect(
        validator.compileValidator(mockValidator)
      ).resolves.not.toThrow();

      expect(mockedCompileCPP).toHaveBeenCalledWith('validator/val.cpp');
    });

    it('should throw if validator has no source file', async () => {
      // Empty `source` lets us exercise the missing-source branch without `any`.
      const mockValidator: LocalValidator = { name: 'val', source: '' };

      await expect(validator.compileValidator(mockValidator)).rejects.toThrow(
        'Validator has no source file specified'
      );

      expect(mockedCompileCPP).not.toHaveBeenCalled();
    });

    it('should propagate compilation errors', async () => {
      const mockValidator: LocalValidator = {
        name: 'val',
        source: 'validator/val.cpp',
      };
      const compileError = new Error('Compilation failed');
      mockedCompileCPP.mockRejectedValue(compileError);

      await expect(validator.compileValidator(mockValidator)).rejects.toThrow(
        'Compilation failed'
      );
    });

    it('should handle non-Error compilation failures', async () => {
      const mockValidator: LocalValidator = {
        name: 'val',
        source: 'validator/val.cpp',
      };
      mockedCompileCPP.mockRejectedValue('string error');

      await expect(validator.compileValidator(mockValidator)).rejects.toThrow(
        'Failed to compile validator'
      );
    });
  });

  describe('validateSingleTest', () => {
    it('should execute validator successfully on valid test', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedExecuteWithRedirect.mockResolvedValue(SUCCESS_RESULT);

      await expect(
        validator.validateSingleTest(mockValidator, 'testsets', 1)
      ).resolves.not.toThrow();

      expect(mockedGetCompiledCommandToRun).toHaveBeenCalledWith(mockValidator);
      expect(mockedExistsSync).toHaveBeenCalled();
      expect(mockedExecuteWithRedirect).toHaveBeenCalled();
    });

    it('should throw if test file does not exist', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(false);
      mockedThrowError.mockImplementation(rethrowImpl);

      await expect(
        validator.validateSingleTest(mockValidator, 'testsets', 1)
      ).rejects.toThrow('Test file not found');
    });

    it('should throw with detailed error message when validator fails', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedExecuteWithRedirect.mockImplementation(
        executeOnErrorThrow('Invalid input', 'Invalid input')
      );
      mockedThrowError.mockImplementation(rethrowImpl);

      await expect(
        validator.validateSingleTest(mockValidator, 'testsets', 5)
      ).rejects.toThrow('Test 5 failed validation');
    });
  });

  describe('validateTestset', () => {
    it('should validate all tests in testset successfully', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedGetTestFiles.mockReturnValue(['test1.txt', 'test2.txt']);
      mockedExecuteWithRedirect.mockResolvedValue(SUCCESS_RESULT);
      mockedCleanup.mockResolvedValue();

      await expect(
        validator.validateTestset(mockValidator, 'samples')
      ).resolves.not.toThrow();

      expect(mockedCleanup).toHaveBeenCalled();
    });

    it('should throw if testset directory does not exist', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(false);
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedCleanup.mockResolvedValue();

      await expect(
        validator.validateTestset(mockValidator, 'nonexistent')
      ).rejects.toThrow('Testset directory not found');

      expect(mockedCleanup).toHaveBeenCalled();
    });

    it('should throw if no test files found in testset', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedGetTestFiles.mockReturnValue([]);
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedCleanup.mockResolvedValue();

      await expect(
        validator.validateTestset(mockValidator, 'empty')
      ).rejects.toThrow('No test files found in testset');

      expect(mockedCleanup).toHaveBeenCalled();
    });

    it('should log errors for failed tests and throw at end', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedGetTestFiles.mockReturnValue(['test1.txt', 'test2.txt']);
      mockedExecuteWithRedirect
        .mockResolvedValueOnce(SUCCESS_RESULT)
        .mockImplementation(
          executeOnErrorThrow('Validation error', 'Validation error')
        );
      mockedLogError.mockImplementation(() => {});
      mockedCleanup.mockResolvedValue();

      await expect(
        validator.validateTestset(mockValidator, 'samples')
      ).rejects.toThrow('Some tests failed validation');

      expect(mockedLogError).toHaveBeenCalled();
      expect(mockedCleanup).toHaveBeenCalled();
    });
  });

  describe('validateGroup', () => {
    it('should validate all tests in group successfully', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      const mockTestset: LocalTestset = {
        name: 'testsets',
        groups: [{ name: 'samples', commands: [] }],
      };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedGetTestIndicesForGroup.mockReturnValue([1]);
      mockedExecuteWithRedirect.mockResolvedValue(SUCCESS_RESULT);
      mockedCleanup.mockResolvedValue();

      await expect(
        validator.validateGroup(mockValidator, mockTestset, 'samples')
      ).resolves.not.toThrow();

      expect(mockedCleanup).toHaveBeenCalled();
    });

    it('should throw if testset directory does not exist', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      const mockTestset: LocalTestset = { name: 'testsets', groups: [] };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(false);
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedCleanup.mockResolvedValue();

      await expect(
        validator.validateGroup(mockValidator, mockTestset, 'samples')
      ).rejects.toThrow('Testset directory not found');

      expect(mockedCleanup).toHaveBeenCalled();
    });

    it('should throw if no tests found in group', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      const mockTestset: LocalTestset = { name: 'testsets', groups: [] };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedGetTestIndicesForGroup.mockReturnValue([]);
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedCleanup.mockResolvedValue();

      await expect(
        validator.validateGroup(mockValidator, mockTestset, 'samples')
      ).rejects.toThrow('No tests found in group');

      expect(mockedCleanup).toHaveBeenCalled();
    });

    it('should handle commands with ranges', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      const mockTestset: LocalTestset = { name: 'testsets', groups: [] };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedGetTestIndicesForGroup.mockReturnValue([1, 2, 3]);
      mockedExecuteWithRedirect.mockResolvedValue(SUCCESS_RESULT);
      mockedCleanup.mockResolvedValue();

      await expect(
        validator.validateGroup(mockValidator, mockTestset, 'samples')
      ).resolves.not.toThrow();

      expect(mockedExecuteWithRedirect).toHaveBeenCalledTimes(3);
      expect(mockedCleanup).toHaveBeenCalled();
    });

    it('should log errors for failed tests in group', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      const mockTestset: LocalTestset = { name: 'testsets', groups: [] };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedGetTestIndicesForGroup.mockReturnValue([1]);
      mockedExecuteWithRedirect.mockImplementation(
        executeOnErrorThrow('Group validation error', 'Group validation error')
      );
      mockedLogError.mockImplementation(() => {});
      mockedCleanup.mockResolvedValue();

      await expect(
        validator.validateGroup(mockValidator, mockTestset, 'samples')
      ).rejects.toThrow('Some tests in group samples failed validation');

      expect(mockedLogError).toHaveBeenCalled();
      expect(mockedCleanup).toHaveBeenCalled();
    });
  });

  describe('records each test for validate --json', () => {
    const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
    let recordSpy: ReturnType<
      typeof vi.spyOn<typeof report, 'recordValidatedTest'>
    >;
    const recorded = () => recordSpy.mock.calls.map(call => call[0]);

    beforeEach(() => {
      recordSpy = vi
        .spyOn(report, 'recordValidatedTest')
        .mockImplementation(() => {});
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedCleanup.mockResolvedValue();
      mockedLogError.mockImplementation(() => {});
      mockedThrowError.mockImplementation(rethrowImpl);
    });

    it('validateTestset records valid and invalid tests by index', async () => {
      mockedGetTestFiles.mockReturnValue(['test1.txt', 'test10.txt']);
      mockedExecuteWithRedirect
        .mockResolvedValueOnce(SUCCESS_RESULT)
        .mockImplementationOnce(
          executeOnErrorResolve('FAIL Integer 0 violates the range [1, 10]')
        );

      await expect(
        validator.validateTestset(mockValidator, 'tests')
      ).rejects.toThrow('Some tests failed validation');

      expect(recorded()).toEqual([
        { testset: 'tests', index: 1, valid: true, message: '' },
        {
          testset: 'tests',
          index: 10,
          valid: false,
          message: 'FAIL Integer 0 violates the range [1, 10]',
        },
      ]);
    });

    it('validateGroup records the group of each test', async () => {
      const mockTestset: LocalTestset = { name: 'tests', groups: [] };
      mockedGetTestIndicesForGroup.mockReturnValue([2, 3]);
      mockedExecuteWithRedirect
        .mockImplementationOnce(executeOnErrorResolve('FAIL bad'))
        .mockResolvedValueOnce(SUCCESS_RESULT);

      await expect(
        validator.validateGroup(mockValidator, mockTestset, 'samples')
      ).rejects.toThrow('Some tests in group samples failed validation');

      expect(recorded()).toEqual([
        {
          testset: 'tests',
          group: 'samples',
          index: 2,
          valid: false,
          message: 'FAIL bad',
        },
        {
          testset: 'tests',
          group: 'samples',
          index: 3,
          valid: true,
          message: '',
        },
      ]);
    });

    it('validateSingleTest records a valid test', async () => {
      mockedExecuteWithRedirect.mockResolvedValue(SUCCESS_RESULT);
      await validator.validateSingleTest(mockValidator, 'tests', 4);
      expect(recorded()).toEqual([
        { testset: 'tests', index: 4, valid: true, message: '' },
      ]);
    });

    it('validateSingleTest records an invalid test with the message', async () => {
      mockedExecuteWithRedirect.mockImplementation(
        executeOnErrorResolve('FAIL Expected EOLN')
      );
      await expect(
        validator.validateSingleTest(mockValidator, 'tests', 4)
      ).rejects.toThrow('Test 4 failed validation');
      expect(recorded()).toEqual([
        {
          testset: 'tests',
          index: 4,
          valid: false,
          message: 'FAIL Expected EOLN',
        },
      ]);
    });

    it('validateSingleTest records a missing test file as invalid', async () => {
      mockedExistsSync.mockReturnValue(false);
      await expect(
        validator.validateSingleTest(mockValidator, 'tests', 4)
      ).rejects.toThrow('Test file not found');
      expect(recorded()).toEqual([
        {
          testset: 'tests',
          index: 4,
          valid: false,
          message: expect.stringContaining('Test file not found') as unknown,
        },
      ]);
    });
  });

  describe('validateAllTestsets', () => {
    it('should validate all testsets successfully', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      const mockTestsets: LocalTestset[] = [
        { name: 'samples' },
        { name: 'tests' },
      ];
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedGetTestFiles.mockReturnValue(['test1.txt']);
      mockedExecuteWithRedirect.mockResolvedValue(SUCCESS_RESULT);
      mockedCleanup.mockResolvedValue();

      await expect(
        validator.validateAllTestsets(mockValidator, mockTestsets)
      ).resolves.not.toThrow();
    });

    it('should log errors and throw if any testset fails', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      const mockTestsets: LocalTestset[] = [
        { name: 'samples' },
        { name: 'tests' },
      ];
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValueOnce(true).mockReturnValueOnce(false);
      mockedGetTestFiles.mockReturnValue(['test1.txt']);
      mockedExecuteWithRedirect.mockResolvedValue(SUCCESS_RESULT);
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedLogError.mockImplementation(() => {});
      mockedCleanup.mockResolvedValue();

      await expect(
        validator.validateAllTestsets(mockValidator, mockTestsets)
      ).rejects.toThrow('Some testsets failed validation');

      expect(mockedLogError).toHaveBeenCalled();
    });
  });

  describe('testValidatorItself', () => {
    it('should skip tests if no testsFilePath specified', async () => {
      const config = buildConfig({ name: 'val', source: 'val.cpp' });
      mockedReadConfigFile.mockReturnValue(config);
      mockedCleanup.mockResolvedValue();
      mockedRemoveDirectoryRecursively.mockImplementation(() => {});

      await expect(validator.testValidatorItself()).resolves.not.toThrow();

      expect(mockedFmtWarning).toHaveBeenCalledWith(
        expect.stringContaining('No validator tests file path')
      );
      expect(mockedCleanup).toHaveBeenCalled();
      expect(mockedRemoveDirectoryRecursively).toHaveBeenCalledWith(
        'validator_tests'
      );
    });

    it('should run validator tests successfully', async () => {
      const config = buildConfig({
        name: 'val',
        source: 'val.cpp',
        testsFilePath: 'validator_tests.json',
      });
      mockedReadConfigFile.mockReturnValue(config);
      mockedReadFile.mockImplementation(
        readFileImpl(null, JSON.stringify({ tests: [] })) as typeof fs.readFile
      );
      mockedEnsureDirectoryExists.mockImplementation(() => {});
      mockedWriteFileSync.mockImplementation(() => {});
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExecuteWithRedirect.mockResolvedValue(SUCCESS_RESULT);
      mockedCleanup.mockResolvedValue();
      mockedRemoveDirectoryRecursively.mockImplementation(() => {});

      await expect(validator.testValidatorItself()).resolves.not.toThrow();

      expect(mockedCleanup).toHaveBeenCalled();
      expect(mockedRemoveDirectoryRecursively).toHaveBeenCalledWith(
        'validator_tests'
      );
    });

    it('should throw if validator is not defined', async () => {
      mockedReadConfigFile.mockReturnValue(buildConfigMissingValidator());
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedCleanup.mockResolvedValue();
      mockedRemoveDirectoryRecursively.mockImplementation(() => {});

      await expect(validator.testValidatorItself()).rejects.toThrow(
        'No validator defined'
      );

      expect(mockedCleanup).toHaveBeenCalled();
      expect(mockedRemoveDirectoryRecursively).toHaveBeenCalledWith(
        'validator_tests'
      );
    });

    it('should cleanup even if tests fail', async () => {
      const config = buildConfig({
        name: 'val',
        source: 'val.cpp',
        testsFilePath: 'validator_tests.json',
      });
      mockedReadConfigFile.mockReturnValue(config);
      mockedReadFile.mockImplementation(
        readFileImpl(new Error('File read error'), '') as typeof fs.readFile
      );
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedCleanup.mockResolvedValue();
      mockedRemoveDirectoryRecursively.mockImplementation(() => {});

      await expect(validator.testValidatorItself()).rejects.toThrow();

      expect(mockedCleanup).toHaveBeenCalled();
      expect(mockedRemoveDirectoryRecursively).toHaveBeenCalledWith(
        'validator_tests'
      );
    });
  });

  describe('runValidatorTests', () => {
    it('should run all validator tests successfully', async () => {
      const mockValidator: LocalValidator = {
        name: 'val',
        source: 'val.cpp',
        testsFilePath: 'validator_tests.json',
      };
      const testsJson = {
        tests: [
          { index: 1, input: '1 2', expectedVerdict: 'VALID' },
          { index: 2, input: '-1', expectedVerdict: 'INVALID' },
        ],
      };
      mockedReadFile.mockImplementation(
        readFileImpl(null, JSON.stringify(testsJson)) as typeof fs.readFile
      );
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExecuteWithRedirect
        .mockResolvedValueOnce(SUCCESS_RESULT)
        .mockImplementation(executeOnErrorResolve('Invalid'));
      mockedCleanup.mockResolvedValue();

      await expect(
        validator.runValidatorTests(mockValidator)
      ).resolves.not.toThrow();

      expect(mockedCleanup).toHaveBeenCalled();
    });

    it('should throw if some validator tests fail', async () => {
      const mockValidator: LocalValidator = {
        name: 'val',
        source: 'val.cpp',
        testsFilePath: 'validator_tests.json',
      };
      const testsJson = {
        tests: [{ index: 1, input: '1 2', expectedVerdict: 'VALID' }],
      };
      mockedReadFile.mockImplementation(
        readFileImpl(null, JSON.stringify(testsJson)) as typeof fs.readFile
      );
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExecuteWithRedirect.mockImplementation(
        executeOnErrorThrow('Unexpected error', 'Unexpected error')
      );
      mockedCleanup.mockResolvedValue();

      await expect(validator.runValidatorTests(mockValidator)).rejects.toThrow(
        'Some validator tests failed'
      );

      expect(mockedFmtError).toHaveBeenCalled();
      expect(mockedCleanup).toHaveBeenCalled();
    });

    it('should record every case with expected, actual and message', async () => {
      const recordSpy = vi
        .spyOn(report, 'recordSelfTestCase')
        .mockImplementation(() => {});
      const mockValidator: LocalValidator = {
        name: 'val',
        source: 'val.cpp',
        testsFilePath: 'validator_tests.json',
      };
      const testsJson = {
        tests: [
          { index: 1, input: '1 2', expectedVerdict: 'VALID' },
          { index: 2, input: '-1', expectedVerdict: 'INVALID' },
          { index: 3, input: '0', expectedVerdict: 'INVALID' },
          { index: 4, input: 'x', expectedVerdict: 'VALID' },
        ],
      };
      mockedReadFile.mockImplementation(
        readFileImpl(null, JSON.stringify(testsJson)) as typeof fs.readFile
      );
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExecuteWithRedirect
        .mockResolvedValueOnce(SUCCESS_RESULT)
        .mockImplementationOnce(executeOnErrorResolve('FAIL n >= 1\n'))
        .mockResolvedValueOnce(SUCCESS_RESULT)
        .mockImplementationOnce(executeOnErrorResolve('FAIL expected int'));
      mockedCleanup.mockResolvedValue();

      await expect(validator.runValidatorTests(mockValidator)).rejects.toThrow(
        'Some validator tests failed'
      );

      expect(recordSpy.mock.calls.map(call => call[0])).toEqual([
        { index: 1, expected: 'VALID', actual: 'VALID', ok: true, message: '' },
        {
          index: 2,
          expected: 'INVALID',
          actual: 'INVALID',
          ok: true,
          message: 'FAIL n >= 1',
        },
        {
          index: 3,
          expected: 'INVALID',
          actual: 'VALID',
          ok: false,
          message: 'Validator did not detect invalid test',
        },
        {
          index: 4,
          expected: 'VALID',
          actual: 'INVALID',
          ok: false,
          message: 'FAIL expected int',
        },
      ]);
    });

    it('should propagate parse errors', async () => {
      const mockValidator: LocalValidator = {
        name: 'val',
        source: 'val.cpp',
        testsFilePath: 'validator_tests.json',
      };
      mockedReadFile.mockImplementation(
        readFileImpl(new Error('Parse error'), '') as typeof fs.readFile
      );
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedCleanup.mockResolvedValue();

      await expect(validator.runValidatorTests(mockValidator)).rejects.toThrow(
        'Failed to read validator tests file'
      );

      expect(mockedCleanup).toHaveBeenCalled();
    });

    it('should cleanup even if tests fail', async () => {
      const mockValidator: LocalValidator = {
        name: 'val',
        source: 'val.cpp',
        testsFilePath: 'validator_tests.json',
      };
      const testsJson = {
        tests: [{ index: 1, input: '1 2', expectedVerdict: 'VALID' }],
      };
      mockedReadFile.mockImplementation(
        readFileImpl(null, JSON.stringify(testsJson)) as typeof fs.readFile
      );
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExecuteWithRedirect.mockRejectedValue(
        new Error('Execution failed')
      );
      mockedCleanup.mockResolvedValue();

      await expect(
        validator.runValidatorTests(mockValidator)
      ).rejects.toThrow();

      expect(mockedCleanup).toHaveBeenCalled();
    });
  });

  describe('edge cases and error handling', () => {
    it('should throw a PolymanError with code 1 on a validator timeout', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedThrowError.mockImplementation(rethrowImpl);

      const mockExit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);
      mockedCleanup.mockResolvedValue();

      mockedExecuteWithRedirect.mockImplementation((_cmd, options) => {
        options.onTimeout?.(SUCCESS_RESULT);
        return Promise.resolve(SUCCESS_RESULT);
      });

      const error = await validator
        .validateSingleTest(mockValidator, 'testsets', 1)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PolymanError);
      expect((error as PolymanError).exitCode).toBe(1);
      expect((error as PolymanError).message).toContain('time limit');
      expect(mockedFmtError).toHaveBeenCalledWith(
        expect.stringContaining('Exceeded Time Limit')
      );
      expect(mockedCleanup).toHaveBeenCalled();
      expect(mockExit).not.toHaveBeenCalled();

      mockExit.mockRestore();
    });

    it('should throw a PolymanError with code 1 on a validator memory limit', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedThrowError.mockImplementation(rethrowImpl);

      const mockExit = vi
        .spyOn(process, 'exit')
        .mockImplementation(() => undefined as never);
      mockedCleanup.mockResolvedValue();

      mockedExecuteWithRedirect.mockImplementation((_cmd, options) => {
        options.onMemoryExceeded?.(SUCCESS_RESULT);
        return Promise.resolve(SUCCESS_RESULT);
      });

      const error = await validator
        .validateSingleTest(mockValidator, 'testsets', 1)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PolymanError);
      expect((error as PolymanError).exitCode).toBe(1);
      expect((error as PolymanError).message).toContain('memory limit');
      expect(mockedFmtError).toHaveBeenCalledWith(
        expect.stringContaining('Exceeded Memory Limit')
      );
      expect(mockedCleanup).toHaveBeenCalled();
      expect(mockExit).not.toHaveBeenCalled();

      mockExit.mockRestore();
    });

    it('should stop validateTestset at the first limit hit instead of counting it', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedGetTestFiles.mockReturnValue(['test1.txt', 'test2.txt']);
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedLogError.mockImplementation(() => {});
      mockedCleanup.mockResolvedValue();
      mockedExecuteWithRedirect.mockImplementation((_cmd, options) => {
        options.onTimeout?.(SUCCESS_RESULT);
        return Promise.resolve(SUCCESS_RESULT);
      });

      const error = await validator
        .validateTestset(mockValidator, 'samples')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LimitExceededError);
      expect(mockedExecuteWithRedirect).toHaveBeenCalledTimes(1);
      expect(mockedLogError).not.toHaveBeenCalled();
    });

    it('should stop validateGroup at the first limit hit instead of counting it', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      const mockTestset: LocalTestset = { name: 'testsets', groups: [] };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedGetTestIndicesForGroup.mockReturnValue([1, 2]);
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedLogError.mockImplementation(() => {});
      mockedCleanup.mockResolvedValue();
      mockedExecuteWithRedirect.mockImplementation((_cmd, options) => {
        options.onMemoryExceeded?.(SUCCESS_RESULT);
        return Promise.resolve(SUCCESS_RESULT);
      });

      const error = await validator
        .validateGroup(mockValidator, mockTestset, 'samples')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LimitExceededError);
      expect(mockedExecuteWithRedirect).toHaveBeenCalledTimes(1);
      expect(mockedLogError).not.toHaveBeenCalled();
    });

    it('should stop validateAllTestsets at the first limit hit', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedGetTestFiles.mockReturnValue(['test1.txt']);
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedLogError.mockImplementation(() => {});
      mockedCleanup.mockResolvedValue();
      mockedExecuteWithRedirect.mockImplementation((_cmd, options) => {
        options.onTimeout?.(SUCCESS_RESULT);
        return Promise.resolve(SUCCESS_RESULT);
      });

      const error = await validator
        .validateAllTestsets(mockValidator, [
          { name: 'samples' },
          { name: 'tests' },
        ])
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LimitExceededError);
      expect(mockedExecuteWithRedirect).toHaveBeenCalledTimes(1);
    });

    it('should stop runValidatorTests at the first limit hit instead of counting it', async () => {
      const mockValidator: LocalValidator = {
        name: 'val',
        source: 'val.cpp',
        testsFilePath: 'validator_tests.json',
      };
      const testsJson = {
        tests: [
          { index: 1, input: '1', expectedVerdict: 'VALID' },
          { index: 2, input: '2', expectedVerdict: 'VALID' },
        ],
      };
      mockedReadFile.mockImplementation(
        readFileImpl(null, JSON.stringify(testsJson)) as typeof fs.readFile
      );
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedCleanup.mockResolvedValue();
      mockedExecuteWithRedirect.mockImplementation((_cmd, options) => {
        options.onTimeout?.(SUCCESS_RESULT);
        return Promise.resolve(SUCCESS_RESULT);
      });

      const error = await validator
        .runValidatorTests(mockValidator)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LimitExceededError);
      expect(mockedExecuteWithRedirect).toHaveBeenCalledTimes(1);
    });

    it('should report failed validation with exit code 1', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedGetTestFiles.mockReturnValue(['test1.txt']);
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedLogError.mockImplementation(() => {});
      mockedCleanup.mockResolvedValue();
      mockedExecuteWithRedirect.mockImplementation(
        executeOnErrorThrow('bad', 'bad')
      );

      const error = await validator
        .validateTestset(mockValidator, 'samples')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PolymanError);
      expect((error as PolymanError).exitCode).toBe(1);
    });

    it('should report a missing validator as a usage error (code 2)', () => {
      let error: unknown;
      try {
        validator.ensureValidatorExists(undefined);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(PolymanError);
      expect((error as PolymanError).exitCode).toBe(2);
    });

    it('should report a validator without a source as a usage error (code 2)', async () => {
      const error = await validator
        .compileValidator({ name: 'val', source: '' })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PolymanError);
      expect((error as PolymanError).exitCode).toBe(2);
    });

    it('should handle validator expecting INVALID but getting VALID', async () => {
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedExecuteWithRedirect.mockResolvedValue(SUCCESS_RESULT);

      const mockValidator2: LocalValidator = {
        name: 'val',
        source: 'val.cpp',
        testsFilePath: 'validator_tests.json',
      };
      const testsJson = {
        tests: [{ index: 1, input: '1 2', expectedVerdict: 'INVALID' }],
      };
      mockedReadFile.mockImplementation(
        readFileImpl(null, JSON.stringify(testsJson)) as typeof fs.readFile
      );
      mockedCleanup.mockResolvedValue();

      await expect(validator.runValidatorTests(mockValidator2)).rejects.toThrow(
        'Some validator tests failed'
      );
    });

    it('should handle invalid JSON in validator tests file', async () => {
      const mockValidator: LocalValidator = {
        name: 'val',
        source: 'val.cpp',
        testsFilePath: 'validator_tests.json',
      };
      mockedReadFile.mockImplementation(
        readFileImpl(null, 'invalid json') as typeof fs.readFile
      );
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedCleanup.mockResolvedValue();

      await expect(validator.runValidatorTests(mockValidator)).rejects.toThrow(
        'Failed to parse validator tests JSON'
      );
    });

    it('should handle missing tests property in JSON', async () => {
      const mockValidator: LocalValidator = {
        name: 'val',
        source: 'val.cpp',
        testsFilePath: 'validator_tests.json',
      };
      mockedReadFile.mockImplementation(
        readFileImpl(
          null,
          JSON.stringify({ other: 'data' })
        ) as typeof fs.readFile
      );
      mockedThrowError.mockImplementation(rethrowImpl);
      mockedCleanup.mockResolvedValue();

      await expect(validator.runValidatorTests(mockValidator)).rejects.toThrow(
        'Invalid validator tests JSON structure'
      );
    });
  });

  describe('additional coverage tests', () => {
    it('should handle ranges in non-target groups correctly', async () => {
      const mockValidator: LocalValidator = { name: 'val', source: 'val.cpp' };
      const mockTestset: LocalTestset = { name: 'testsets', groups: [] };
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExistsSync.mockReturnValue(true);
      mockedGetTestIndicesForGroup.mockReturnValue([6]);
      mockedExecuteWithRedirect.mockResolvedValue(SUCCESS_RESULT);
      mockedCleanup.mockResolvedValue();

      await expect(
        validator.validateGroup(mockValidator, mockTestset, 'samples')
      ).resolves.not.toThrow();

      // Should only execute once for the single test in 'samples' group
      expect(mockedExecuteWithRedirect).toHaveBeenCalledTimes(1);
      expect(mockedCleanup).toHaveBeenCalled();
    });

    it('should create validator test files when running testValidatorItself', async () => {
      const config = buildConfig({
        name: 'val',
        source: 'val.cpp',
        testsFilePath: 'validator_tests.json',
      });
      mockedReadConfigFile.mockReturnValue(config);
      const testsJson = {
        tests: [
          { index: 1, input: '5 10', expectedVerdict: 'VALID' },
          { index: 2, input: '-1 5', expectedVerdict: 'INVALID' },
        ],
      };
      mockedReadFile.mockImplementation(
        readFileImpl(null, JSON.stringify(testsJson)) as typeof fs.readFile
      );
      mockedEnsureDirectoryExists.mockImplementation(() => {});
      mockedWriteFileSync.mockImplementation(() => {});
      mockedGetCompiledCommandToRun.mockReturnValue('./val');
      mockedExecuteWithRedirect
        .mockResolvedValueOnce(SUCCESS_RESULT)
        .mockImplementation(executeOnErrorResolve('Invalid input'));
      mockedCleanup.mockResolvedValue();
      mockedRemoveDirectoryRecursively.mockImplementation(() => {});

      await expect(validator.testValidatorItself()).resolves.not.toThrow();

      // Verify file writing operations were called
      expect(mockedEnsureDirectoryExists).toHaveBeenCalledWith(
        'validator_tests'
      );
      expect(mockedWriteFileSync).toHaveBeenCalledTimes(2);
      expect(mockedCleanup).toHaveBeenCalled();
      expect(mockedRemoveDirectoryRecursively).toHaveBeenCalledWith(
        'validator_tests'
      );
    });
  });
});
