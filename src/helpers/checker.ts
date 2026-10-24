/**
 * @fileoverview Checker (output validator) compilation, testing, and execution utilities.
 * Provides functions to run checkers on solution outputs, validate checker behavior,
 * and test checkers against their own test suites.
 */

import type {
  LocalChecker,
  CheckerTest,
  CheckerVerdict,
  SolutionTag,
} from '../types';
import { executor } from '../executor';
import path from 'path';
import fs from 'fs';
import {
  compileCPP,
  readConfigFile,
  throwError,
  ensureDirectoryExists,
  removeDirectoryRecursively,
  getCompiledCommandToRun,
} from './utils';
import { DEFAULT_TIMEOUT, DEFAULT_MEMORY_LIMIT } from './utils';
import { quoteShellArgument } from './shell';
import { fmt } from '../formatter';
import { LimitExceededError, PolymanError } from '../errors';
import { report } from '../report';

/** Exit code testlib's `quitf(_wa, ...)` uses for a wrong answer. */
const TESTLIB_WA_EXIT_CODE = 1;

/** Exit code testlib's `quitf(_pe, ...)` uses for a presentation error. */
const TESTLIB_PE_EXIT_CODE = 2;

/** Exit code testlib's `quitf(_fail, ...)` uses when the checker itself fails. */
const TESTLIB_FAIL_EXIT_CODE = 3;

/** Smallest exit code testlib uses for partially correct (`_pc(n)`). */
const TESTLIB_PARTIAL_EXIT_CODE_MIN = 16;

/**
 * Smallest exit code a shell reports for a process killed by a signal
 * (128 + signal number: 139 for SIGSEGV, 134 for SIGABRT).
 */
const SIGNAL_EXIT_CODE_MIN = 128;

/** Exit codes below 16 that are testlib verdicts other than `_fail`. */
const TESTLIB_NON_CRASH_EXIT_CODES = new Set([0, 1, 2, 4, 5, 7, 8]);

/**
 * Whether a checker exit code counts as CRASHED for an expected `CRASHED`
 * self-test.
 *
 * Counts as CRASHED:
 * - 3, testlib's `_fail` code, and
 * - any code testlib does not define as a verdict, such as a signal exit
 *   (128 and up: 139 for a segfault, 134 for `abort()`) or an `exit(N)` from
 *   the checker with N in 6, 9..15.
 *
 * Does not count, because these are testlib's own verdicts (`TResult` and
 * `resultExitCode` in testlib.h):
 * - 0 (OK), 1 (WA), 2 (PE),
 * - 4 (DIRT),
 * - 5 (the `_points` verdict) and 7 (`POINTS_EXIT_CODE`, the exit code that
 *   verdict is written with),
 * - 8 (unexpected EOF, with ENABLE_UNEXPECTED_EOF),
 * - 16 to 127 (`_pc(n)`, partially correct).
 *
 * A checker killed by a signal reaches here as 128 plus the signal number on
 * every platform (the executor does this). Two of those codes never get here:
 * SIGABRT (134) and SIGKILL (137) are caught first by the executor's
 * `isMemoryError` check, so they throw a `LimitExceededError` and do not count
 * as CRASHED.
 *
 * This is polyman's reading of testlib. How Polygon itself maps a checker's
 * exit code to CRASHED is unverified.
 */
function isCrashedExitCode(exitCode: number): boolean {
  if (exitCode === TESTLIB_FAIL_EXIT_CODE) return true;
  if (exitCode >= SIGNAL_EXIT_CODE_MIN) return true;
  if (exitCode >= TESTLIB_PARTIAL_EXIT_CODE_MIN) return false;
  return !TESTLIB_NON_CRASH_EXIT_CODES.has(exitCode);
}

/**
 * Maps an expected checker verdict to the testlib exit code it stands for.
 * Accepts the documented names (`WRONG_ANSWER`, `PRESENTATION_ERROR`) and the
 * short forms (`WA`, `PE`), in any letter case. Returns `undefined` for `OK`,
 * `CRASHED` and anything else.
 */
function expectedFailureExitCode(
  expectedVerdict: CheckerVerdict
): number | undefined {
  switch (String(expectedVerdict).toUpperCase()) {
    case 'WA':
    case 'WRONG_ANSWER':
      return TESTLIB_WA_EXIT_CODE;
    case 'PE':
    case 'PRESENTATION_ERROR':
      return TESTLIB_PE_EXIT_CODE;
    default:
      return undefined;
  }
}

/** Describes what a failing checker run was, for "Expected X but got ..." messages. */
function describeCheckerFailure(exitCode: number): string {
  if (exitCode === TESTLIB_WA_EXIT_CODE) return 'WA';
  if (exitCode === TESTLIB_PE_EXIT_CODE) return 'PE';
  return `exit code ${exitCode}`;
}

/**
 * Names the verdict a checker gave from its exit code: 0 is OK, testlib's
 * WA and PE codes are WRONG_ANSWER and PRESENTATION_ERROR, anything else is
 * CRASHED.
 */
export function checkerVerdictForExitCode(exitCode: number): CheckerVerdict {
  if (exitCode === 0) return 'OK';
  if (exitCode === TESTLIB_WA_EXIT_CODE) return 'WRONG_ANSWER';
  if (exitCode === TESTLIB_PE_EXIT_CODE) return 'PRESENTATION_ERROR';
  return 'CRASHED';
}

/**
 * Writes an expected checker verdict with its full name, so the short forms
 * `WA` and `PE` (any letter case) compare with what the checker gave.
 */
export function normalizeCheckerVerdict(verdict: CheckerVerdict): string {
  const upper = String(verdict).toUpperCase();
  if (upper === 'WA') return 'WRONG_ANSWER';
  if (upper === 'PE') return 'PRESENTATION_ERROR';
  return upper;
}

/**
 * Raised by {@link runChecker} when a checker that was expected to accept the
 * output exits with testlib's presentation-error code. Any other checker
 * failure stays a plain `Error` and is treated as a wrong answer.
 */
export class PresentationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PresentationError';
  }
}

/**
 * Runs a checker program to validate solution output against expected answer.
 * The checker receives three files: input, output (participant's answer), and answer (jury's answer).
 *
 * @param {string} execCommand - Path to compiled checker executable
 * @param {string} inputFilePath - Path to test input file
 * @param {string} outputFilePath - Path to participant's output file
 * @param {string} answerFilePath - Path to jury's answer file
 * @param {CheckerVerdict} expectedVerdict - Expected verdict: OK, WRONG_ANSWER (or WA), PRESENTATION_ERROR (or PE), CRASHED (exit code 3 or a code testlib does not define, see isCrashedExitCode)
 * @param {Function} [observe] - Called with the verdict the checker gave and its stderr, before it is compared with `expectedVerdict`
 *
 * @throws {PresentationError} If the checker was expected to return OK and exited with testlib's presentation-error code (2)
 * @throws {Error} If checker verdict doesn't match expected verdict (WRONG_ANSWER expects exit code 1, PRESENTATION_ERROR expects exit code 2, CRASHED expects exit code 3 or an undefined code)
 * @throws {Error} If checker exceeds time or memory limits (throws a LimitExceededError)
 *
 * @example
 * await runChecker(
 *   './checker',
 *   'tests/test1.txt',
 *   'output.txt',
 *   'answer.txt',
 *   'OK'
 * );
 */
export async function runChecker(
  execCommand: string,
  inputFilePath: string,
  outputFilePath: string,
  answerFilePath: string,
  expectedVerdict: CheckerVerdict,
  observe?: (actual: CheckerVerdict, message: string) => void
) {
  let didCatchInvalid = false;
  let failureExitCode = 0;
  let checkerFailed = false;
  let successStderr = '';
  await executor.execute(
    [
      execCommand,
      quoteShellArgument(inputFilePath),
      quoteShellArgument(outputFilePath),
      quoteShellArgument(answerFilePath),
    ].join(' '),
    {
      timeout: DEFAULT_TIMEOUT,
      memoryLimitMB: DEFAULT_MEMORY_LIMIT,
      silent: true,
      onSuccess: result => {
        successStderr = result.stderr.trim();
      },
      onError: result => {
        checkerFailed = true;
        observe?.(
          checkerVerdictForExitCode(result.exitCode),
          result.stderr.trim()
        );
        if (expectedVerdict.toUpperCase() === 'OK') {
          const message = result.stderr || 'Expected OK but got WA';
          if (result.exitCode === TESTLIB_PE_EXIT_CODE) {
            throw new PresentationError(message);
          }
          throw new Error(message);
        }
        didCatchInvalid = true;
        failureExitCode = result.exitCode;
      },
      onTimeout: () => {
        fmt.error(
          `${fmt.cross()} ${fmt.bold('Checker Unexpectedly Exceeded Time Limit!')} (${DEFAULT_TIMEOUT}ms)`
        );
        void executor.cleanup();
        throw new LimitExceededError(
          `Checker exceeded the time limit (${DEFAULT_TIMEOUT}ms)`
        );
      },
      onMemoryExceeded: () => {
        fmt.error(
          `${fmt.cross()} ${fmt.bold('Checker Unexpectedly Exceeded Memory Limit!')} (${DEFAULT_MEMORY_LIMIT} MB)`
        );
        void executor.cleanup();
        throw new LimitExceededError(
          `Checker exceeded the memory limit (${DEFAULT_MEMORY_LIMIT} MB)`
        );
      },
    }
  );
  if (!checkerFailed) observe?.('OK', successStderr);

  if (String(expectedVerdict).toUpperCase() === 'CRASHED') {
    if (!didCatchInvalid) {
      throw new Error(`Expected ${expectedVerdict} but got OK`);
    }
    if (!isCrashedExitCode(failureExitCode)) {
      throw new Error(
        `Expected ${expectedVerdict} but got ${describeCheckerFailure(failureExitCode)}`
      );
    }
    return;
  }

  const expectedExitCode = expectedFailureExitCode(expectedVerdict);
  if (expectedExitCode === undefined) return;

  if (!didCatchInvalid) {
    throw new Error(`Expected ${expectedVerdict} but got OK`);
  }
  if (failureExitCode !== expectedExitCode) {
    throw new Error(
      `Expected ${expectedVerdict} but got ${describeCheckerFailure(failureExitCode)}`
    );
  }
}

/**
 * Ensures a checker is defined in the configuration.
 * Type assertion function that throws if checker is undefined.
 *
 * @param {LocalChecker | undefined} checker - Checker configuration to validate
 *
 * @throws {Error} If no checker is defined in configuration
 *
 * @example
 * const config = readConfigFile();
 * ensureCheckerExists(config.checker);
 * // Now TypeScript knows checker is defined
 */
export function ensureCheckerExists(
  checker: LocalChecker | undefined
): asserts checker is LocalChecker {
  if (!checker) {
    throw new PolymanError(
      'No checker defined in the configuration file.',
      2,
      'Add a "checker" entry to Config.json'
    );
  }
}

/**
 * Tests the checker against its own test suite.
 * Compiles the checker, creates test files, runs all tests, and cleans up.
 * This is a cancellation point - fails fast on first error.
 *
 * @throws {Error} If checker tests fail
 * @throws {Error} If checker compilation fails
 * @throws {Error} If test file parsing fails
 *
 * @example
 * // From actions.ts testWhat command
 * await testCheckerItself();
 */
export async function testCheckerItself() {
  try {
    const config = readConfigFile();

    if (config.checker.isStandard) {
      fmt.warning(
        `   ⚠️  Using standard checker: ${fmt.highlight(config.checker.source)}`
      );
      fmt.info(
        `   ${fmt.bold('Note:')} Standard checkers are assumed to be correct and are not tested against custom test suites.`
      );
      return;
    }

    if (!config.checker.testsFilePath) {
      fmt.warning(
        'No checker tests file path specified in configuration. Skipping checker self-tests.'
      );
      return;
    }

    await makeCheckerTests(config.checker.testsFilePath);
    await runCheckerTests(config.checker);
  } catch (error) {
    throwError(error, 'Failed to test checker');
  } finally {
    await executor.cleanup();
    removeDirectoryRecursively('checker_tests');
  }
}

/**
 * Creates test files for checker self-testing.
 * Reads checker_tests.json and creates input, output, and answer files.
 *
 * @private
 * @throws {Error} If test file parsing fails
 *
 * @example
 * // Creates files like:
 * // checker_tests/test1_input.txt
 * // checker_tests/test1_output.txt
 * // checker_tests/test1_answer.txt
 */
async function makeCheckerTests(testsFilePath: string) {
  const checkerTests = await parseCheckerTests(testsFilePath);

  ensureDirectoryExists('checker_tests');

  for (const [index, test] of checkerTests.entries()) {
    const inputPath = path.resolve(
      process.cwd(),
      'checker_tests',
      `test${index + 1}_input.txt`
    );
    const outputPath = path.resolve(
      process.cwd(),
      'checker_tests',
      `test${index + 1}_output.txt`
    );
    const answerPath = path.resolve(
      process.cwd(),
      'checker_tests',
      `test${index + 1}_answer.txt`
    );

    fs.writeFileSync(inputPath, test.input);
    fs.writeFileSync(outputPath, test.output);
    fs.writeFileSync(answerPath, test.answer);
  }
}

/**
 * Runs all checker self-tests and validates results.
 * Uses pre-compiled checker via getCompiledCommandToRun.
 * Fails fast - throws on first test failure.
 *
 * @param {LocalChecker} checker - Checker configuration
 *
 * @throws {Error} If checker compilation fails
 * @throws {Error} If any test fails
 *
 * @example
 * const config = readConfigFile();
 * await runCheckerTests(config.checker);
 */
export async function runCheckerTests(checker: LocalChecker) {
  let someFailed = false;
  try {
    const checkerTests = await parseCheckerTests(checker.testsFilePath!);
    const compiledPath = getCompiledCommandToRun(checker);

    const testsDir = path.resolve(process.cwd(), 'checker_tests');

    for (const [index, test] of checkerTests.entries()) {
      const inputFilePath = path.join(testsDir, `test${index + 1}_input.txt`);
      const outputFilePath = path.join(testsDir, `test${index + 1}_output.txt`);
      const answerFilePath = path.join(testsDir, `test${index + 1}_answer.txt`);
      const expected = normalizeCheckerVerdict(test.expectedVerdict);
      let actual = 'ERROR';
      let detail = '';

      try {
        await runChecker(
          compiledPath,
          inputFilePath,
          outputFilePath,
          answerFilePath,
          test.expectedVerdict,
          (verdict, message) => {
            actual = verdict;
            detail = message;
          }
        );
        report.recordSelfTestCase({
          index: index + 1,
          expected,
          actual,
          ok: true,
          message: detail,
        });
      } catch (error) {
        if (error instanceof LimitExceededError) throw error;
        someFailed = true;
        report.recordSelfTestCase({
          index: index + 1,
          expected,
          actual,
          ok: false,
          message: (error as Error).message,
        });
        fmt.error(
          `  ${fmt.cross()} Checker Test ${index + 1} failed:\n\t${(error as Error).message}, expected to be ${test.expectedVerdict}`
        );
      }
    }
  } catch (error) {
    throwError(error, 'Failed to run checker tests');
  } finally {
    await executor.cleanup();
  }

  if (someFailed) throw new PolymanError('Some checker tests failed', 1);
}

/**
 * Parses checker_tests.json file.
 * Reads the JSON file containing checker test cases.
 *
 * @private
 * @returns {Promise<CheckerTest[]>} Array of checker test cases
 * @param {string} testsFilePath The path to the tests JSON file
 * @throws {Error} If file doesn't exist or has invalid JSON
 *
 * @example
 * // Expects file structure (Polygon format):
 * // {
 * //   "tests": [
 * //     {
 * //       "index": 1,
 * //       "input": "5",
 * //       "output": "25",
 * //       "answer": "25",
 * //       "expectedVerdict": "OK"
 * //     }
 * //   ]
 * // }
 */
function parseCheckerTests(testsFilePath: string): Promise<CheckerTest[]> {
  return new Promise((resolve, reject) => {
    const absouluteTestsFilePath = path.resolve(process.cwd(), testsFilePath);
    fs.readFile(absouluteTestsFilePath, 'utf-8', (err, data) => {
      if (err) {
        return reject(new Error('Failed to read checker tests file.'));
      }
      try {
        const tests = JSON.parse(data) as { tests: CheckerTest[] };
        if (tests.tests) {
          return resolve(tests.tests);
        } else {
          return reject(new Error('Invalid checker tests JSON structure.'));
        }
      } catch {
        reject(new Error('Failed to parse checker tests JSON.'));
      }
    });
  });
}

/**
 * Compiles a checker program.
 * Handles both custom checkers and standard testlib checkers.
 * Wrapper around compileCPP with consistent error handling.
 *
 * @param {LocalChecker} checker - Checker configuration
 * @returns {Promise<string>} Path to compiled checker executable
 *
 * @throws {Error} If compilation fails
 *
 * @example
 * // Custom checker
 * const path = await compileChecker({ name: 'checker', source: 'checker/Checker.cpp', isStandard: false });
 *
 * @example
 * // Standard checker
 * const path = await compileChecker({ name: 'wcmp', source: 'wcmp.cpp', isStandard: true });
 */
export async function compileChecker(checker: LocalChecker): Promise<void> {
  try {
    const checkerSource = checker.isStandard
      ? path.resolve(
          __dirname,
          '../..',
          'assets',
          'checkers',
          `${checker.source}`
        )
      : checker.source;
    await compileCPP(checkerSource);
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('Failed to compile checker');
  }
}

/**
 * Determines expected checker verdict based on solution tag (Polygon format).
 * Maps Polygon solution tags to their expected checker verdicts.
 *
 * @param {SolutionTag} tag - Polygon solution tag
 * @returns {CheckerVerdict} Expected verdict for this solution tag
 *
 * @example
 * getExpectedCheckerVerdict('MA');  // Returns: 'OK' (Main Accepted)
 * getExpectedCheckerVerdict('OK');  // Returns: 'OK' (Alternative correct)
 * getExpectedCheckerVerdict('WA');  // Returns: 'WRONG_ANSWER'
 * getExpectedCheckerVerdict('PE');  // Returns: 'PRESENTATION_ERROR'
 * getExpectedCheckerVerdict('TL');  // Returns: 'OK' (TLE handled elsewhere)
 * getExpectedCheckerVerdict('RJ');  // Returns: 'WRONG_ANSWER' (Rejected)
 */
export function getExpectedCheckerVerdict(tag: SolutionTag): CheckerVerdict {
  switch (tag) {
    case 'MA': // Main Accepted
    case 'OK': // Alternative correct solution
    case 'TL': // Time Limit (checker doesn't validate this)
    case 'TO': // Time Limit or OK (checker validates OK part)
    case 'ML': // Memory Limit (checker doesn't validate this)
    case 'RE': // Runtime Error (checker doesn't validate this)
      return 'OK';
    case 'WA': // Wrong Answer
    case 'RJ': // Rejected (any error)
      return 'WRONG_ANSWER';
    case 'PE': // Presentation Error
      return 'PRESENTATION_ERROR';
    default:
      return 'OK';
  }
}
