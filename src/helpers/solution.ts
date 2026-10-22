/**
 * @fileoverview Solution compilation, execution, and verification utilities.
 * Provides functions to run solutions on test inputs, compare outputs with checkers,
 * and validate solution behavior against expected verdicts (TLE, MLE, WA, etc.).
 */

import ConfigFile, {
  LocalSolution,
  VerdictTracker,
  LocalTestset,
  TestVerdict,
} from '../types';
import { executor } from '../executor';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { logError, throwError } from './utils';
import {
  compileCPP,
  compileJava,
  isCppSource,
  readConfigFile,
  readFirstLine,
  getTestFiles,
  getCompiledCommandToRun,
} from './utils';
import { fmt } from '../formatter';
import { report } from '../report';
import { ensureCheckerExists, PresentationError, runChecker } from './checker';
import { LimitExceededError } from '../errors';
import type { LocalChecker } from '../types';
import { getTestIndicesForGroup } from './testset';

/**
 * Ensures solutions are defined in configuration.
 * Type assertion function that throws if no solutions exist.
 *
 * @param {LocalSolution[] | undefined} solutions - Solutions array to validate
 *
 * @throws {Error} If no solutions are defined
 *
 * @example
 * const config = readConfigFile();
 * validateSolutionsExist(config.solutions);
 * // Now TypeScript knows solutions is defined and non-empty
 */
export function validateSolutionsExist(
  solutions: LocalSolution[] | undefined
): asserts solutions is LocalSolution[] {
  if (!solutions || solutions.length === 0) {
    throw new Error('No solutions defined in the configuration file.');
  }
}

/**
 * Finds solutions matching a given name or returns all solutions.
 *
 * @param {LocalSolution[]} solutions - Array of solution configurations
 * @param {string} solutionName - Name of solution to find, or 'all' for all solutions
 * @returns {LocalSolution[]} Array of matching solutions
 *
 * @throws {Error} If no solutions match the name
 *
 * @example
 * const matching = findMatchingSolutions(config.solutions, 'main');
 * // Returns: [{ name: 'main', source: 'Solution.cpp', type: 'main-correct' }]
 */
export function findMatchingSolutions(
  solutions: LocalSolution[],
  solutionName: string
): LocalSolution[] {
  const matching = solutions.filter(
    s => solutionName === 'all' || s.name === solutionName
  );

  if (matching.length === 0) {
    throw new Error(
      `Solution named "${solutionName}" not found or no solutions defined.`
    );
  }

  return matching;
}

/**
 * Languages polyman can run a solution as, and therefore scale its time limit
 * for. Anything else (a bare `.js` file, an unknown extension) has no entry.
 */
export type SolutionLanguage = 'cpp' | 'java' | 'python';

/**
 * Keys accepted in `timeLimitMultipliers`.
 */
const SOLUTION_LANGUAGES: readonly SolutionLanguage[] = [
  'cpp',
  'java',
  'python',
];

/**
 * Longest timeout Node's timers accept (2^31 - 1 ms). A bigger value makes
 * `setTimeout` fire right away, which would turn every run into a TLE.
 */
export const MAX_TIME_LIMIT_MS = 2147483647;

/**
 * The time limit a solution is actually run with, as returned by
 * {@link solutionTimeLimit}.
 *
 * @interface SolutionTimeLimit
 * @property {number} timeLimit - Milliseconds the solution is executed with
 * @property {number} multiplier - Factor applied to `config.timeLimit` (1 when nothing was configured)
 * @property {SolutionLanguage | undefined} language - Language the factor was looked up for
 */
export interface SolutionTimeLimit {
  timeLimit: number;
  multiplier: number;
  language: SolutionLanguage | undefined;
}

/**
 * Works out which language a solution runs as locally. Only the file
 * extension decides, with the same checks `getCompiledCommandToRun` uses to
 * pick the program, so the factor always matches how the file is really run.
 * `sourceType` is ignored here: it only picks the compiler on Polygon.
 *
 * @param {LocalSolution} solution - Solution configuration
 * @returns {SolutionLanguage | undefined} The language, or undefined if polyman cannot tell
 *
 * @example
 * solutionLanguage({ name: 'main', source: 'main.cpp', tag: 'MA' }); // 'cpp'
 * solutionLanguage({ name: 'slow', source: 'Main.java', tag: 'OK' }); // 'java'
 */
export function solutionLanguage(
  solution: LocalSolution
): SolutionLanguage | undefined {
  if (isCppSource(solution.source)) return 'cpp';

  switch (path.extname(solution.source)) {
    case '.java':
      return 'java';
    case '.py':
      return 'python';
    default:
      return undefined;
  }
}

/**
 * Scales the declared limit by a factor, never going below 1ms.
 *
 * @private
 * @param {number} timeLimit - Declared limit in milliseconds
 * @param {number} multiplier - Factor to apply
 * @returns {number} Scaled limit in whole milliseconds
 */
function scaleTimeLimit(timeLimit: number, multiplier: number): number {
  return Math.max(1, Math.round(timeLimit * multiplier));
}

/**
 * Prints a value from Config.json for an error message: numbers as they are
 * (so `Infinity` does not show up as `null`), anything else as JSON.
 *
 * @private
 * @param {unknown} value - Value to print
 * @returns {string} Printable form of the value
 */
function describeConfigValue(value: unknown): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value);
}

/**
 * Checks `config.timeLimitMultipliers` before anything runs. A bad value
 * must stop the command: if it only failed inside a run, the error would be
 * read as an expected solution failure and `verify` could pass without the
 * solution ever running.
 *
 * The field is optional. When it is set it must be an object whose keys are
 * `cpp`, `java` or `python`, each a positive number, and the scaled limit
 * must fit in a Node timer ({@link MAX_TIME_LIMIT_MS}).
 *
 * @param {ConfigFile} config - Configuration to check
 *
 * @throws {Error} If the field is not an object, has an unknown key, has a
 * factor that is not a positive number, or makes the limit too large
 *
 * @example
 * validateTimeLimitMultipliers(config); // throws on { "java": 0 }
 */
export function validateTimeLimitMultipliers(config: ConfigFile): void {
  const multipliers: unknown = config.timeLimitMultipliers;
  if (multipliers === undefined) return;

  if (
    typeof multipliers !== 'object' ||
    multipliers === null ||
    Array.isArray(multipliers)
  ) {
    throw new Error(
      `Invalid timeLimitMultipliers in Config.json: ${describeConfigValue(multipliers)} ` +
        `(expected an object like { "java": 2, "python": 3 })`
    );
  }

  for (const [key, value] of Object.entries(multipliers)) {
    if (!(SOLUTION_LANGUAGES as readonly string[]).includes(key)) {
      throw new Error(
        `Unknown key in timeLimitMultipliers: ${JSON.stringify(key)} ` +
          `(allowed keys: ${SOLUTION_LANGUAGES.join(', ')})`
      );
    }

    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(
        `Invalid timeLimitMultipliers.${key} in Config.json: ${describeConfigValue(value)} ` +
          `(expected a positive number)`
      );
    }

    const scaled = scaleTimeLimit(config.timeLimit, value);
    if (!(scaled <= MAX_TIME_LIMIT_MS)) {
      throw new Error(
        `timeLimitMultipliers.${key} is too large: ${config.timeLimit}ms x ${value} ` +
          `gives ${Number.isFinite(scaled) ? `${scaled}ms` : 'an infinite limit'}, ` +
          `the maximum is ${MAX_TIME_LIMIT_MS}ms`
      );
    }
  }
}

/**
 * Applies `config.timeLimitMultipliers` to the declared time limit.
 * Java and Python are slower than C++ at the same task (JVM startup,
 * interpreter), so a correct `OK` solution could get TLE locally while the
 * problem itself is fine. The multiplier is opt-in: C++ always defaults to 1,
 * and a config without the field behaves exactly as before. Polygon is still
 * pushed the plain `timeLimit`, this only changes local runs.
 *
 * Commands call {@link validateTimeLimitMultipliers} before running anything;
 * it is called here again so this function never returns a bad limit.
 *
 * @param {ConfigFile} config - Configuration containing `timeLimit` and the optional multipliers
 * @param {LocalSolution} solution - Solution the limit is for
 * @returns {SolutionTimeLimit} Effective limit, the factor used, and the language it was found for
 *
 * @throws {Error} If `timeLimitMultipliers` is invalid
 *
 * @example
 * // 1000ms problem, "java": 2 -> Java solution gets 2000ms locally
 * solutionTimeLimit(config, javaSolution); // { timeLimit: 2000, multiplier: 2, language: 'java' }
 */
export function solutionTimeLimit(
  config: ConfigFile,
  solution: LocalSolution
): SolutionTimeLimit {
  validateTimeLimitMultipliers(config);

  const language = solutionLanguage(solution);
  const multiplier =
    language === undefined ? 1 : (config.timeLimitMultipliers?.[language] ?? 1);

  if (multiplier === 1) {
    return { timeLimit: config.timeLimit, multiplier, language };
  }

  return {
    timeLimit: scaleTimeLimit(config.timeLimit, multiplier),
    multiplier,
    language,
  };
}

/**
 * Renders an effective limit for the terminal, e.g. `2000ms (x2 for java)`.
 * Unscaled limits stay plain: `1000ms`. The factor is shown with at most two
 * decimals (`x1.33`, `x1.5`, `x2`).
 *
 * @param {SolutionTimeLimit} limit - Limit to render
 * @returns {string} Text for the run output
 */
export function formatTimeLimit(limit: SolutionTimeLimit): string {
  if (limit.multiplier === 1 || limit.language === undefined) {
    return `${limit.timeLimit}ms`;
  }
  const factor = Number(limit.multiplier.toFixed(2)).toString();
  return `${limit.timeLimit}ms (x${factor} for ${limit.language})`;
}

/**
 * Mentions the scaled limit once per run, and only when it differs from the
 * declared one, so a passing Java solution is not read as ignoring the limit.
 *
 * @private
 * @param {SolutionTimeLimit} limit - Effective limit of the solution being run
 */
function logTimeLimitForSolution(limit: SolutionTimeLimit): void {
  if (limit.multiplier === 1 || limit.language === undefined) return;
  fmt.log(
    `    ${fmt.dim('→')} Time Limit: ${fmt.highlight(formatTimeLimit(limit))}`
  );
}

/**
 * Runs a compiled solution on a test input file.
 * Executes solution with time/memory limits, handles output files, and error scenarios.
 * Creates output file with either solution output or error message (TLE, MLE, RTE).
 *
 * @private
 * @param {LocalSolution} solution - Solution configuration
 * @param {string} compiledPath - Path to compiled executable or interpreter command
 * @param {number} timeout - Time limit in milliseconds
 * @param {number} memoryLimitMB - Memory limit in megabytes
 * @param {string} inputFile - Name of test input file
 * @param {string} testsetName - Name of testset containing the test
 *
 * @throws {Error} If runtime error occurs
 * @throws {Error} If time limit exceeded
 * @throws {Error} If memory limit exceeded
 *
 * @example
 * await runSolution(
 *   { name: 'main', source: 'Solution.cpp', tag: 'MA' },
 *   './Solution',
 *   2000,
 *   256,
 *   'test1.txt',
 *   'testsets'
 * );
 */
async function runSolution(
  solution: LocalSolution,
  compiledPath: string,
  timeout: number,
  memoryLimitMB: number,
  inputFile: string,
  testsetName: string,
  groupName?: string
) {
  const outputFilePath = path.resolve(
    process.cwd(),
    'solutions-outputs',
    solution.name,
    testsetName,
    `output_${inputFile}`
  );
  const inputFilePath = path.resolve(
    process.cwd(),
    'testsets',
    testsetName,
    inputFile
  );

  // if ouputFilePath exists from previous runs, delete it first
  if (fs.existsSync(outputFilePath)) {
    fs.unlinkSync(outputFilePath);
  }
  const testIndex = parseTestIndex(inputFile);
  const startedAt = Date.now();
  const record = (verdict: TestVerdict, message: string) => {
    report.recordTest(solution, {
      testset: testsetName,
      ...(groupName !== undefined ? { group: groupName } : {}),
      index: testIndex,
      verdict,
      timeMs: Date.now() - startedAt,
      message,
    });
  };
  await executor.executeWithRedirect(
    compiledPath,
    {
      timeout,
      memoryLimitMB,
      silent: true,
      onError: result => {
        record('RTE', `Runtime Error: ${result.stderr}`);
        writeErrorOutputAndThrow(outputFilePath, result.stderr);
      },
      onTimeout: () => {
        record('TLE', `Time Limit Exceeded after ${timeout}ms`);
        writeTimeoutOutputAndThrow(outputFilePath, timeout);
      },
      onMemoryExceeded: () => {
        record('MLE', `Memory Limit Exceeded (${memoryLimitMB} MB)`);
        writeMemoryOutputAndThrow(outputFilePath, memoryLimitMB);
      },
    },
    inputFilePath,
    outputFilePath
  );
  record('OK', '');
}

/**
 * Extracts the Polygon test index from a test file name.
 *
 * @param {string} testFile - File name such as `test12.txt`
 * @returns {number} The numeric index, or 0 if the name has no number
 *
 * @example
 * parseTestIndex('test12.txt'); // 12
 */
export function parseTestIndex(testFile: string): number {
  const match = /(\d+)/.exec(testFile);
  return match ? parseInt(match[1], 10) : 0;
}
/**
 * Creates output directory for solution if it doesn't exist.
 * Directory structure: solutions-outputs/<solution-name>/[testset-name/]
 *
 * @private
 * @param {string} solutionName - Name of solution
 * @param {string} [testsetName] - Optional testset name for subdirectory
 * @returns {string} Absolute path to created output directory
 *
 * @example
 * const dir = ensureOutputDirectory('main');
 * // Returns: '/path/to/project/solutions-outputs/main'
 *
 * @example
 * const dir = ensureOutputDirectory('main', 'testsets');
 * // Returns: '/path/to/project/solutions-outputs/main/tests'
 */
function ensureOutputDirectory(
  solutionName: string,
  testsetName?: string
): string {
  const outputDir = testsetName
    ? path.resolve(
        process.cwd(),
        'solutions-outputs',
        solutionName,
        testsetName
      )
    : path.resolve(process.cwd(), 'solutions-outputs', solutionName);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  return outputDir;
}

/**
 * Compiles a solution based on file extension.
 * Supports C++ (.cpp), Python (.py), and Java (.java).
 * For interpreted languages, returns the interpreter command.
 *
 * @param {string} sourcePath - Path to solution source file
 * @returns {Promise<void>} Resolves when compilation completes
 *
 * @throws {Error} If compilation fails
 * @throws {Error} If file extension is not supported
 *
 * @example
 * await compileSolution('Solution.cpp')
 * // Compiles to ./Solution executable
 *
 * @example
 * await compileSolution('Solution.py')
 * // No compilation needed (interpreted)
 */
export async function compileSolution(sourcePath: string): Promise<void> {
  if (isCppSource(sourcePath)) {
    await compileCPP(sourcePath);
    return;
  }

  const ext = path.extname(sourcePath);

  switch (ext) {
    case '.py':
      // No compilation needed for Python
      break;
    case '.java':
      await compileJava(sourcePath);
      break;
    default:
      throw new Error(`Unsupported solution file extension: ${ext}`);
  }
}

/**
 * Compiles all solutions, at most `limit` at a time.
 * A compile starts only when a slot is free, so its timeout covers the time
 * it spends compiling and not the time it waits for a CPU. Compilation order
 * follows the order of `solutions`.
 *
 * @param {LocalSolution[]} solutions - Array of solutions to compile
 * @param {number} [limit=os.availableParallelism()] - Most compiles running at once (at least 1)
 * @returns {Promise<void>} Resolves when all compilations complete
 *
 * @throws {Error} If any compilation fails; no new compile starts after that
 *
 * @example
 * await compileAllSolutions(config.solutions);
 * // Compiles all solutions, one per CPU at a time
 */
export async function compileAllSolutions(
  solutions: LocalSolution[],
  limit: number = os.availableParallelism()
): Promise<void> {
  const workers = Math.max(
    1,
    Math.min(Math.floor(limit) || 1, solutions.length)
  );
  let next = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed && next < solutions.length) {
      const solution = solutions[next++];
      try {
        await compileSolution(solution.source);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, () => worker()));
}

/**
 * Runs a single solution on a single test within a testset.
 * Executes it on the specified test using pre-compiled executable.
 * Note: Solution must be compiled before calling this function.
 *
 * @param {LocalSolution} solution - Solution configuration
 * @param {ConfigFile} config - Configuration containing time/memory limits
 * @param {string} testsetName - Name of testset containing the test
 * @param {number} testIndex - Test index (1-based)
 *
 * @throws {Error} If solution execution fails
 *
 * @example
 * await runSolutionOnSingleTest(solution, config, 'testsets', 5);
 */
export async function runSolutionOnSingleTest(
  solution: LocalSolution,
  config: ConfigFile,
  testsetName: string,
  testIndex: number
) {
  fmt.info(
    `  ${fmt.infoIcon()} Running solution: ${fmt.highlight(solution.name)} on test ${testIndex} in ${fmt.highlight(testsetName)}`
  );

  const limit = solutionTimeLimit(config, solution);
  logTimeLimitForSolution(limit);

  try {
    const compiledPath = getCompiledCommandToRun(solution);
    ensureOutputDirectory(solution.name, testsetName);

    const testFile = `test${testIndex}.txt`;

    await runSolution(
      solution,
      compiledPath,
      limit.timeLimit,
      config.memoryLimit,
      testFile,
      testsetName
    );

    fmt.log(`    ${fmt.dim('→')} Test ${testIndex} completed successfully`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Solution ${fmt.highlight(solution.name)} failed on test ${testIndex}: ${message}`
    );
  }
}

/**
 * Runs a single solution on an entire testset.
 * Executes it on all tests in the testset using pre-compiled executable.
 * Note: Solution must be compiled before calling this function.
 *
 * @param {LocalSolution} solution - Solution configuration
 * @param {ConfigFile} config - Configuration containing time/memory limits
 * @param {string} testsetName - Name of testset to run on
 *
 * @throws {Error} If solution fails on any test
 *
 * @example
 * await runSolutionOnTestset(solution, config, 'testsets');
 */
export async function runSolutionOnTestset(
  solution: LocalSolution,
  config: ConfigFile,
  testsetName: string
) {
  fmt.info(
    `  ${fmt.infoIcon()} Running solution: ${fmt.highlight(solution.name)} on testset ${fmt.highlight(testsetName)}`
  );
  const thrownErrors = new Set<string>();

  const limit = solutionTimeLimit(config, solution);
  logTimeLimitForSolution(limit);

  try {
    const compiledPath = getCompiledCommandToRun(solution);
    ensureOutputDirectory(solution.name, testsetName);

    const testsDir = path.resolve(process.cwd(), 'testsets', testsetName);
    const testFiles = getTestFiles(testsDir);

    for (const testFile of testFiles) {
      if (thrownErrors.size > 0) {
        break;
      }
      try {
        await runSolution(
          solution,
          compiledPath,
          limit.timeLimit,
          config.memoryLimit,
          testFile,
          testsetName
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message + ` (${testsetName}/${testFile})`
            : String(error);
        thrownErrors.add(message);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    thrownErrors.add(
      `Failed to get compiled solution ${solution.name}:\n\t${message}`
    );
  }

  if (thrownErrors.size > 0) {
    fmt.log(
      `    ${fmt.dim('→')} Completed testset ${fmt.highlight(testsetName)} ${fmt.bold('With Failures:')}`
    );
    for (const errMsg of thrownErrors) {
      fmt.error(`      ${fmt.cross()} ${errMsg}`);
    }
    fmt.newLine();
    throw new Error(
      `Solution ${fmt.highlight(solution.name)} failed on testset ${testsetName}:\n${Array.from(thrownErrors).join('\n')}`
    );
  } else {
    fmt.log(
      `    ${fmt.dim('→')} Completed testset ${fmt.highlight(testsetName)}`
    );
  }
  fmt.newLine();
}

/**
 * Runs a single solution on a specific group within a testset.
 * Executes it on all tests in the group using pre-compiled executable.
 * Note: Solution must be compiled before calling this function.
 *
 * @param {LocalSolution} solution - Solution configuration
 * @param {ConfigFile} config - Configuration containing time/memory limits
 * @param {LocalTestset} testset - Testset configuration
 * @param {string} groupName - Name of group to run on
 *
 * @throws {Error} If solution fails on any test in the group
 *
 * @example
 * await runSolutionOnGroup(solution, config, testset, 'samples');
 */
export async function runSolutionOnGroup(
  solution: LocalSolution,
  config: ConfigFile,
  testset: LocalTestset,
  groupName: string
) {
  fmt.info(
    `  ${fmt.infoIcon()} Running solution: ${fmt.highlight(solution.name)} on group ${fmt.highlight(groupName)} in ${fmt.highlight(testset.name)}`
  );
  const thrownErrors = new Set<string>();

  const limit = solutionTimeLimit(config, solution);
  logTimeLimitForSolution(limit);

  try {
    const compiledPath = getCompiledCommandToRun(solution);
    ensureOutputDirectory(solution.name, testset.name);

    const groupIndices = getTestIndicesForGroup(testset, groupName);

    if (groupIndices.length === 0) {
      throw new Error(
        `No tests found for group "${groupName}" in testset "${testset.name}"`
      );
    }

    for (const idx of groupIndices) {
      const testFile = `test${idx}.txt`;
      try {
        await runSolution(
          solution,
          compiledPath,
          limit.timeLimit,
          config.memoryLimit,
          testFile,
          testset.name,
          groupName
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message + ` (test: ${testFile})`
            : String(error);
        thrownErrors.add(message);
      }
      if (thrownErrors.size > 0) {
        break;
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    thrownErrors.add(
      `Failed to get compiled solution ${solution.name}:\n\t${message}`
    );
  }

  if (thrownErrors.size > 0) {
    fmt.log(
      `    ${fmt.dim('→')} Completed group ${fmt.highlight(groupName)} ${fmt.bold('With Failures:')}`
    );
    for (const errMsg of thrownErrors) {
      fmt.error(`      ${fmt.cross()} ${errMsg}`);
    }
    fmt.newLine();
    throw new Error(
      `Solution ${fmt.highlight(solution.name)} failed on group ${groupName}:\n${Array.from(thrownErrors).join('\n')}`
    );
  } else {
    fmt.log(`    ${fmt.dim('→')} Completed group ${fmt.highlight(groupName)}`);
  }
  fmt.newLine();
}

/**
 * Runs a single solution on all testsets.
 * Compiles the solution and executes it on every test in every testset.
 *
 * @param {LocalSolution} solution - Solution configuration
 * @param {ConfigFile} config - Configuration containing time/memory limits
 * @param {LocalTestset[]} testsets - Array of testset configurations
 *
 * @throws {Error} If solution compilation fails
 * @throws {Error} If solution fails on any test
 *
 * @example
 * await runSolutionOnAllTestsets(solution, config, config.testsets);
 */
export async function runSolutionOnAllTestsets(
  solution: LocalSolution,
  config: ConfigFile,
  testsets: LocalTestset[]
) {
  const failedTestsets = new Set<string>();

  for (const testset of testsets) {
    try {
      await runSolutionOnTestset(solution, config, testset.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedTestsets.add(message);
    }
  }

  if (failedTestsets.size > 0) {
    throw new Error(
      `Solution ${fmt.highlight(solution.name)} failed on some testsets:\n${Array.from(failedTestsets).join('\n\n')}`
    );
  }
}

/**
 * Tests a solution against the main correct solution using the checker.
 * Runs both solutions on all testsets, then compares outputs with the checker.
 * Validates that the solution behaves according to its expected type (TLE, WA, etc.).
 * Note: Solutions and checker must be compiled before calling this function.
 *
 * @param {string} solutionName - Name of solution to test
 *
 * @throws {Error} If main solution doesn't exist
 * @throws {Error} If target solution doesn't exist
 * @throws {Error} If main solution fails
 * @throws {Error} If comparison fails
 *
 * @example
 * // From actions.ts testWhat command
 * await testSolutionAgainstMainCorrect('wa-solution');
 * // Validates that wa-solution gets WA on at least one test
 */
export async function testSolutionAgainstMainCorrect(solutionName: string) {
  try {
    const config = readConfigFile();
    const solutions = config.solutions;
    const checker = config.checker;
    const testsets = config.testsets || [];

    if (testsets.length === 0) {
      throw new Error('No testsets defined in configuration');
    }
    validateTimeLimitMultipliers(config);

    ensureMainSolutionExists(solutions);
    ensureSolutionExists(solutions, solutionName);
    ensureCheckerExists(checker);

    const mainSolution = getMainSolution(solutions);
    const solution = solutions.find(s => s.name === solutionName)!;

    fmt.info(
      `  ${fmt.infoIcon()} Main solution: ${fmt.primary(mainSolution.name)} ${fmt.dim(`(${mainSolution.tag})`)}`
    );
    fmt.info(
      `  ${fmt.infoIcon()} Target solution: ${fmt.highlight(solutionName)} ${fmt.dim(`(${solution.tag})`)}`
    );
    fmt.newLine();

    fmt.log(
      `  ${fmt.dim('→')} Running main solution ${fmt.dim('(generating outputs...)')}`
    );
    try {
      await runSolutionOnAllTestsets(mainSolution, config, testsets);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const newErrorMessage = `Failed to run ${fmt.bold('Main Solution')}: \n\t${message}`;
      throwError(new Error(newErrorMessage));
    }

    fmt.log(
      `  ${fmt.dim('→')} Running target solution ${fmt.dim('(generating outputs...)')}`
    );
    try {
      await runSolutionOnAllTestsets(solution, config, testsets);
    } catch {
      // @ts-nocheck
    }

    fmt.log(
      `  ${fmt.dim('→')} Comparing with checker ${fmt.dim('(validating verdicts...)')}`
    );
    try {
      await startTheComparisonProcess(
        checker,
        mainSolution,
        solution,
        testsets
      );
    } catch (error) {
      throwError(error, 'Comparison with checker failed');
    }
  } catch (error) {
    throwError(error, `Failed to test solution "${solutionName}"`);
  }
}

/**
 * Ensures a main-correct solution exists in the configuration.
 * Type assertion function that throws if no MA (main correct) solution found.
 *
 * @param {LocalSolution[] | undefined} solutions - Solutions array to validate
 *
 * @throws {Error} If no solutions are defined
 * @throws {Error} If no MA (main correct) solution exists
 *
 * @example
 * const config = readConfigFile();
 * ensureMainSolutionExists(config.solutions);
 */
export function ensureMainSolutionExists(
  solutions: LocalSolution[] | undefined
): asserts solutions is LocalSolution[] {
  if (!solutions || solutions.length === 0) {
    throw new Error('No solutions defined in the configuration file.');
  }

  for (const solution of solutions) {
    if (solution.tag === 'MA') {
      return;
    }
  }

  throw new Error(
    'No solution with tag "MA" (main correct) found in the configuration file.'
  );
}

/**
 * Ensures a specific solution exists in the configuration.
 * Type assertion function that throws if solution not found.
 *
 * @param {LocalSolution[] | undefined} solutions - Solutions array to validate
 * @param {string} solutionName - Name of solution to find
 *
 * @throws {Error} If no solutions are defined
 * @throws {Error} If solution with given name doesn't exist
 *
 * @example
 * ensureSolutionExists(config.solutions, 'wa-solution');
 */
export function ensureSolutionExists(
  solutions: LocalSolution[] | undefined,
  solutionName: string
): asserts solutions is LocalSolution[] {
  if (!solutions || solutions.length === 0) {
    throw new Error('No solutions defined in the configuration file.');
  }

  for (const solution of solutions) {
    if (solution.name === solutionName) {
      return;
    }
  }

  throw new Error(`No solution named "${solutionName}" found.`);
}

/**
 * Gets the MA (main correct) solution from solutions array.
 *
 * @param {LocalSolution[]} solutions - Array of solution configurations
 * @returns {LocalSolution} The MA (main correct) solution
 *
 * @throws {Error} If no MA solution found (should never happen if ensureMainSolutionExists called first)
 *
 * @example
 * const mainSolution = getMainSolution(config.solutions);
 * // Returns: { name: 'main', source: 'Solution.cpp', tag: 'MA' }
 */
export function getMainSolution(solutions: LocalSolution[]): LocalSolution {
  for (const solution of solutions) {
    if (solution.tag === 'MA') {
      return solution;
    }
  }
  // tell ts that this line is never reached
  throw new Error('Main correct solution (tag "MA") not found.');
}

/**
 * Compares target solution outputs against main solution using checker.
 * Runs checker on all test cases in all testsets and tracks verdicts (WA, TLE, MLE, RTE).
 * Validates that verdicts match the target solution's expected tag.
 * Note: Checker must be compiled before calling this function.
 *
 * @param {LocalChecker} checker - Checker configuration
 * @param {LocalSolution} mainSolution - Main correct solution
 * @param {LocalSolution} targetSolution - Solution to validate
 * @param {LocalTestset[]} testsets - Array of testsets to check
 *
 * @throws {Error} If verdict validation fails
 * @throws {Error} If main solution has unexpected errors
 *
 * @example
 * // From fullVerification and testSolutionAgainstMainCorrect
 * await startTheComparisonProcess(
 *   config.checker,
 *   mainSolution,
 *   waSolution,
 *   config.testsets
 * );
 */
export async function startTheComparisonProcess(
  checker: LocalChecker,
  mainSolution: LocalSolution,
  targetSolution: LocalSolution,
  testsets: LocalTestset[]
) {
  try {
    const compiledCheckerPath = getCompiledCommandToRun(checker);
    const verdictTracker = createVerdictTracker();

    for (const testset of testsets) {
      const mainOutputDir = ensureOutputDirectory(
        mainSolution.name,
        testset.name
      );
      const targetOutputDir = ensureOutputDirectory(
        targetSolution.name,
        testset.name
      );
      const testsDir = path.resolve(process.cwd(), 'testsets', testset.name);
      const testFiles = getTestFiles(testsDir);

      for (const testFile of testFiles) {
        if (
          await checkIfShouldSkipRest(
            testFile,
            mainOutputDir,
            targetOutputDir,
            verdictTracker
          )
        ) {
          break;
        }

        const inputFilePath = path.join(testsDir, testFile);
        const outputFilePath = path.join(targetOutputDir, `output_${testFile}`);
        const answerFilePath = path.join(mainOutputDir, `output_${testFile}`);
        const expectedVerdict = 'OK';

        try {
          await runChecker(
            compiledCheckerPath,
            inputFilePath,
            outputFilePath,
            answerFilePath,
            expectedVerdict
          );
          report.updateTestVerdict(
            targetSolution,
            testset.name,
            parseTestIndex(testFile),
            'OK',
            ''
          );
        } catch (error) {
          if (error instanceof LimitExceededError) throw error;
          const msg = error instanceof Error ? error.message : String(error);
          logError(`${testFile} in testset ${testset.name}: ${msg}`, 4);
          const isPE = error instanceof PresentationError;
          report.updateTestVerdict(
            targetSolution,
            testset.name,
            parseTestIndex(testFile),
            isPE ? 'PE' : 'WA',
            msg
          );
          if (isPE) {
            verdictTracker.didPE = true;
          } else {
            verdictTracker.didWA = true;
          }
        }
      }
    }

    validateExpectedVerdicts(targetSolution, verdictTracker);
  } catch (error) {
    throwError(error, 'Error during solution comparison process');
  } finally {
    await executor.cleanup();
  }
}
/**
 * Creates a verdict tracker object to monitor solution outcomes.
 * Tracks TLE, MLE, RTE, PE, and WA verdicts during comparison.
 *
 * @private
 * @returns {VerdictTracker} Tracker object with all flags set to false
 *
 * @example
 * const tracker = createVerdictTracker();
 * // Returns: { didTLE: false, didMLE: false, didRTE: false, didPE: false, didWA: false }
 */
function createVerdictTracker(): VerdictTracker {
  return {
    didTLE: false,
    didMLE: false,
    didRTE: false,
    didPE: false,
    didWA: false,
  };
}

/**
 * Writes runtime error message to output file and throws error.
 * Used when solution crashes or has runtime errors.
 *
 * @private
 * @param {string} outputPath - Path to output file
 * @param {string} stderr - Error message from stderr
 *
 * @throws {Error} Always throws with runtime error message
 *
 * @example
 * writeErrorOutputAndThrow('/path/to/output.txt', 'segmentation fault');
 * // Creates file with: "Runtime Error: segmentation fault"
 * // Then throws error
 */
function writeErrorOutputAndThrow(outputPath: string, stderr: string) {
  fs.writeFileSync(outputPath, `Runtime Error: ${stderr}`);
  throw new Error(`Runtime Error: ${stderr}`);
}

/**
 * Writes timeout message to output file and throws error.
 * Used when solution exceeds time limit.
 *
 * @private
 * @param {string} outputPath - Path to output file
 * @param {number} timeout - Time limit that was exceeded (in ms)
 *
 * @throws {Error} Always throws with TLE message
 *
 * @example
 * writeTimeoutOutputAndThrow('/path/to/output.txt', 2000);
 * // Creates file with: "Time Limit Exceeded after 2000ms"
 * // Then throws error
 */
function writeTimeoutOutputAndThrow(outputPath: string, timeout: number) {
  fs.writeFileSync(outputPath, `Time Limit Exceeded after ${timeout}ms`);
  throw new Error(`Time Limit Exceeded after ${timeout}ms`);
}

/**
 * Writes memory limit exceeded message to output file and throws error.
 * Used when solution exceeds memory limit.
 *
 * @private
 * @param {string} outputPath - Path to output file
 * @param {number} memoryLimit - Memory limit that was exceeded (in MB)
 *
 * @throws {Error} Always throws with MLE message
 *
 * @example
 * writeMemoryOutputAndThrow('/path/to/output.txt', 256);
 * // Creates file with: "Memory Limit Exceeded (256 MB)"
 * // Then throws error
 */
function writeMemoryOutputAndThrow(outputPath: string, memoryLimit: number) {
  fs.writeFileSync(outputPath, `Memory Limit Exceeded (${memoryLimit} MB)`);
  throw new Error(`Memory Limit Exceeded (${memoryLimit} MB)`);
}

/**
 * Checks if tests should be skipped during checker comparison.
 * Skips if output file doesn't exist or if output indicates TLE/MLE/RTE.
 * Validates both main and target solution outputs for errors.
 * Skipping Tests mean no checker comparison is needed.
 *
 * @private
 * @param {string} testFile - Test filename
 * @param {string} mainOutputDir - Main solution output directory
 * @param {string} targetOutputDir - Target solution output directory
 * @param {VerdictTracker} verdictTracker - Verdict tracking object
 * @returns {Promise<boolean>} True if test should be skipped
 *
 * @throws {Error} If main solution has errors on test
 * @throws {Error} If target solution has unexpected errors
 *
 * @example
 * const shouldSkip = await checkIfShouldSkipRest(
 *   'test1.txt',
 *   '/path/to/main',
 *   '/path/to/wa-solution',
 *   waSolution,
 *   tracker
 * );
 */
async function checkIfShouldSkipRest(
  testFile: string,
  mainOutputDir: string,
  targetOutputDir: string,
  verdictTracker: VerdictTracker
) {
  const mainOutputPath = path.join(mainOutputDir, `output_${testFile}`);
  const targetOutputPath = path.join(targetOutputDir, `output_${testFile}`);

  // if target ouput file does not exist, it means the solution failed to run on this test, either TLE, MLE, RTE
  // So, the verdictTracker must have caught that already
  if (!fs.existsSync(targetOutputPath)) {
    return true;
  }

  const mainFirstLine = await readFirstLine(mainOutputPath);
  const targetFirstLine = await readFirstLine(targetOutputPath);

  validateMainSolutionOutput(mainFirstLine, testFile);
  validateTargetSolutionOutput(targetFirstLine, verdictTracker);

  return shouldSkipCheckerComparison(targetFirstLine);
}

/**
 * Validates main solution output for errors.
 * Main solution should never have TLE, MLE, or RTE.
 *
 * @private
 * @param {string} firstLine - First line of output file
 * @param {string} testFile - Test filename
 *
 * @throws {Error} If main solution timed out
 * @throws {Error} If main solution exceeded memory
 * @throws {Error} If main solution had runtime error
 *
 * @example
 * validateMainSolutionOutput('42', 'test1.txt'); // OK
 * validateMainSolutionOutput('Time Limit Exceeded', 'test1.txt'); // Throws
 */
function validateMainSolutionOutput(firstLine: string, testFile: string) {
  if (isTLE(firstLine)) {
    throw new Error(`Main Solution timed out on test ${testFile}`);
  }
  if (isMLE(firstLine)) {
    throw new Error(`Main Solution exceeded memory limit on test ${testFile}`);
  }
  if (isRTE(firstLine)) {
    throw new Error(`Main Solution had runtime error on test ${testFile}`);
  }
}

/**
 * Validates target solution output against expected solution tag.
 * Updates verdict tracker and throws if behavior doesn't match tag.
 *
 * @private
 * @param {string} firstLine - First line of output file
 * @param {VerdictTracker} verdictTracker - Verdict tracking object
 *
 * @example
 * // For TL solution
 * validateTargetSolutionOutput('Time Limit Exceeded', tracker);
 * // Updates tracker.didTLE = true
 */
function validateTargetSolutionOutput(
  firstLine: string,
  verdictTracker: VerdictTracker
) {
  if (isTLE(firstLine)) {
    verdictTracker.didTLE = true;
  }

  if (isMLE(firstLine)) {
    verdictTracker.didMLE = true;
  }

  if (isRTE(firstLine)) {
    verdictTracker.didRTE = true;
  }
}

/**
 * Determines if checker comparison should be skipped for this output.
 * Skip if output indicates TLE, MLE, or RTE (already handled).
 *
 * @private
 * @param {string} firstLine - First line of output file
 * @returns {boolean} True if should skip checker comparison
 *
 * @example
 * shouldSkipCheckerComparison('Time Limit Exceeded') // returns true
 * shouldSkipCheckerComparison('42') // returns false
 */
function shouldSkipCheckerComparison(firstLine: string): boolean {
  if (isTLE(firstLine)) return true;
  if (isMLE(firstLine)) return true;
  if (isRTE(firstLine)) return true;
  return false;
}

/**
 * Validates that observed verdicts match expected solution tag.
 * Ensures solutions behave according to their declared tag (TL, ML, WA, RJ, etc.).
 *
 * @private
 * @param {LocalSolution} targetSolution - Target solution configuration
 * @param {VerdictTracker} verdictTracker - Verdict tracking object
 *
 * @throws {Error} If TLE observed but solution not marked with TL/TO tag
 * @throws {Error} If MLE observed but solution not marked with ML tag
 * @throws {Error} If RTE observed but solution not marked with RE/RJ tag
 * @throws {Error} If WA or PE observed but solution not marked with WA/PE/RJ tag
 * @throws {Error} If PE solution didn't get a presentation error on any test
 * @throws {Error} If no errors but solution marked as RJ
 * @throws {Error} If TL solution didn't timeout on any test
 * @throws {Error} If ML solution didn't exceed memory on any test
 *
 * @example
 * // For TL solution that timed out
 * validateExpectedVerdicts(tlSolution, { didTLE: true, ... }); // OK
 *
 * @example
 * // For TL solution that didn't timeout
 * validateExpectedVerdicts(tlSolution, { didTLE: false, ... }); // Throws
 */
function validateExpectedVerdicts(
  targetSolution: LocalSolution,
  verdictTracker: VerdictTracker
) {
  if (verdictTracker.didTLE) {
    if (!isTLTag(targetSolution.tag)) {
      throw new Error(
        `Solution ${fmt.highlight(targetSolution.name)} marked as ${fmt.highlight(targetSolution.tag)} but got ${fmt.bold('Time Limit Exceeded')} on some tests`
      );
    }
  }
  if (verdictTracker.didMLE) {
    if (!isMLTag(targetSolution.tag)) {
      throw new Error(
        `Solution ${fmt.highlight(targetSolution.name)} marked as ${fmt.highlight(targetSolution.tag)} but got ${fmt.bold('Memory Limit Exceeded')} on some tests`
      );
    }
  }

  if (verdictTracker.didRTE) {
    if (!isRTETag(targetSolution.tag)) {
      throw new Error(
        `Solution ${fmt.highlight(targetSolution.name)} marked as ${fmt.highlight(targetSolution.tag)} but got ${fmt.bold('Runtime Error')} on some tests`
      );
    }
  }

  if (verdictTracker.didPE) {
    if (!isWATag(targetSolution.tag)) {
      throw new Error(
        `Solution ${fmt.highlight(targetSolution.name)} marked as ${fmt.highlight(targetSolution.tag)} but got ${fmt.bold('Presentation Error')} on some tests`
      );
    }
  }

  if (verdictTracker.didWA) {
    if (!isWATag(targetSolution.tag)) {
      throw new Error(
        `Solution ${fmt.highlight(targetSolution.name)} marked as ${fmt.highlight(targetSolution.tag)} but got ${fmt.bold('Wrong Answer')} on some tests`
      );
    }
  }
  if (targetSolution.tag === 'TL' && !verdictTracker.didTLE) {
    throw new Error(
      `Solution ${fmt.highlight(targetSolution.name)} marked as ${fmt.highlight(targetSolution.tag)} but did not get ${fmt.bold('Time Limit Exceeded')} on any test`
    );
  }

  if (targetSolution.tag === 'ML' && !verdictTracker.didMLE) {
    throw new Error(
      `Solution ${fmt.highlight(targetSolution.name)} marked as ${fmt.highlight(targetSolution.tag)} but did not get ${fmt.bold('Memory Limit Exceeded')} on any test`
    );
  }

  if (
    targetSolution.tag === 'WA' &&
    !verdictTracker.didWA &&
    !verdictTracker.didPE
  ) {
    throw new Error(
      `Solution ${fmt.highlight(targetSolution.name)} marked as ${fmt.highlight(targetSolution.tag)} but did not get ${fmt.bold('Wrong Answer')} on any test`
    );
  }
  if (targetSolution.tag === 'PE' && !verdictTracker.didPE) {
    throw new Error(
      `Solution ${fmt.highlight(targetSolution.name)} marked as ${fmt.highlight(targetSolution.tag)} but did not get ${fmt.bold('Presentation Error')} on any test`
    );
  }
  if (
    targetSolution.tag === 'RJ' &&
    !verdictTracker.didTLE &&
    !verdictTracker.didMLE &&
    !verdictTracker.didRTE &&
    !verdictTracker.didWA &&
    !verdictTracker.didPE
  ) {
    throw new Error(
      `Solution ${fmt.highlight(targetSolution.name)} marked as ${fmt.highlight(targetSolution.tag)} but passed all tests correctly`
    );
  }
}

/**
 * Checks if first line indicates Time Limit Exceeded.
 *
 * @private
 * @param {string} firstLine - First line of output file
 * @returns {boolean} True if TLE detected
 *
 * @example
 * isTLE('Time Limit Exceeded after 2000ms') // returns true
 * isTLE('42') // returns false
 */
function isTLE(firstLine: string): boolean {
  return firstLine.startsWith('Time Limit Exceeded');
}

/**
 * Checks if first line indicates Memory Limit Exceeded.
 *
 * @private
 * @param {string} firstLine - First line of output file
 * @returns {boolean} True if MLE detected
 *
 * @example
 * isMLE('Memory Limit Exceeded (256 MB)') // returns true
 * isMLE('42') // returns false
 */
function isMLE(firstLine: string): boolean {
  return firstLine.startsWith('Memory Limit Exceeded');
}

/**
 * Checks if first line indicates Runtime Error.
 *
 * @private
 * @param {string} firstLine - First line of output file
 * @returns {boolean} True if RTE detected
 *
 * @example
 * isRTE('Runtime Error: segmentation fault') // returns true
 * isRTE('42') // returns false
 */
function isRTE(firstLine: string): boolean {
  return firstLine.startsWith('Runtime Error');
}

/**
 * Checks if solution tag allows TLE verdict.
 *
 * @private
 * @param {import('../types').SolutionTag} tag - Solution tag to check
 * @returns {boolean} True if TLE is valid for this tag
 *
 * @example
 * isTLTag('TL') // returns true
 * isTLTag('TO') // returns true (TLE or OK)
 * isTLTag('MA') // returns false
 */
function isTLTag(tag: import('../types').SolutionTag): boolean {
  // TL: Time Limit Exceeded
  // TO: Time Limit or Accepted (may TLE but correct)
  // RJ: Rejected (any error including TLE)
  return tag === 'TL' || tag === 'TO' || tag === 'RJ';
}

/**
 * Checks if solution tag allows MLE verdict.
 *
 * @private
 * @param {import('../types').SolutionTag} tag - Solution tag to check
 * @returns {boolean} True if MLE is valid for this tag
 *
 * @example
 * isMLTag('ML') // returns true
 * isMLTag('RJ') // returns true (any rejection)
 * isMLTag('WA') // returns false
 */
function isMLTag(tag: import('../types').SolutionTag): boolean {
  // ML: Memory Limit Exceeded
  // RJ: Rejected (any error including MLE)
  return tag === 'ML' || tag === 'RJ';
}

/**
 * Checks if solution tag allows RTE verdict.
 *
 * @private
 * @param {import('../types').SolutionTag} tag - Solution tag to check
 * @returns {boolean} True if RTE is valid for this tag
 *
 * @example
 * isRTETag('RE') // returns true
 * isRTETag('RJ') // returns true (any rejection)
 * isRTETag('MA') // returns false
 */
function isRTETag(tag: import('../types').SolutionTag): boolean {
  // RE: Runtime Error
  // RJ: Rejected (any error including RTE)
  return tag === 'RE' || tag === 'RJ';
}

/**
 * Checks if solution tag allows WA verdict.
 *
 * @private
 * @param {import('../types').SolutionTag} tag - Solution tag to check
 * @returns {boolean} True if WA is valid for this tag
 *
 * @example
 * isWATag('WA') // returns true
 * isWATag('RJ') // returns true (any rejection)
 * isWATag('MA') // returns false
 */
function isWATag(tag: import('../types').SolutionTag): boolean {
  // WA: Wrong Answer
  // PE: Presentation Error (also wrong)
  // RJ: Rejected (any error including WA)
  return tag === 'WA' || tag === 'PE' || tag === 'RJ';
}
