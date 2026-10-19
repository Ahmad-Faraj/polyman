/**
 * @fileoverview Common utility functions for compilation, file operations, and error handling.
 * Provides cross-language compilation, test filtering, config reading, and directory management.
 */

import fs from 'fs';
import path from 'path';
import { executor } from '../executor';
import { fmt } from '../formatter';
import { quoteShellArgument } from './shell';
import { cachedCompile } from './compile-cache';
import {
  findPrebuiltTestlib,
  markPrebuiltTestlibUnsupported,
} from './prebuilt-testlib';
import ConfigFile, {
  CompilerConfig,
  LocalChecker,
  LocalGenerator,
  LocalSolution,
  LocalValidator,
} from '../types';

/** Default compilation timeout in milliseconds */
export const DEFAULT_TIMEOUT = 10000;

/** Default memory limit in megabytes */
export const DEFAULT_MEMORY_LIMIT = 1024;

// ENV is win or unix
export const ENV = process.platform === 'win32' ? 'win' : 'unix';

export const SECRET_KEY_LOCATION =
  ENV === 'win'
    ? '%USERPROFILE%\\.polyman\\secret_key'
    : '~/.polyman/secret_key';
export const API_KEY_LOCATION =
  ENV === 'win' ? '%USERPROFILE%\\.polyman\\api_key' : '~/.polyman/api_key';

/** Environment variable that overrides the C++ compiler executable. */
export const CXX_ENV_VAR = 'POLYMAN_CXX';

/** Environment variable that overrides the Java compiler executable. */
export const JAVAC_ENV_VAR = 'POLYMAN_JAVAC';

/** Default C++ compiler executable. */
export const DEFAULT_CXX = 'g++';

/** Default Java compiler executable. */
export const DEFAULT_JAVAC = 'javac';

/**
 * Reads the optional `compiler` block from `Config.json` in the current
 * working directory. Never throws: a missing or malformed config simply
 * yields an empty object so compilation falls back to the defaults.
 *
 * @returns {CompilerConfig} The `compiler` block, or `{}` when unavailable
 */
function readCompilerConfig(): CompilerConfig {
  try {
    const configFilePath = path.resolve(process.cwd(), 'Config.json');
    if (!fs.existsSync(configFilePath)) return {};
    const parsed = JSON.parse(
      fs.readFileSync(configFilePath, 'utf-8')
    ) as Partial<ConfigFile>;
    return parsed.compiler ?? {};
  } catch {
    return {};
  }
}

/**
 * Resolves the C++ compiler executable.
 * Precedence: `POLYMAN_CXX` env var, then `compiler.cpp` in `Config.json`,
 * then `g++`.
 *
 * @returns {string} Compiler executable name or path
 *
 * @example
 * // POLYMAN_CXX=g++-15
 * resolveCppCompiler(); // 'g++-15'
 */
export function resolveCppCompiler(): string {
  const fromEnv = process.env[CXX_ENV_VAR]?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = readCompilerConfig().cpp?.trim();
  if (fromConfig) return fromConfig;
  return DEFAULT_CXX;
}

/**
 * Resolves extra flags appended to every C++ compile command, from
 * `compiler.flags` in `Config.json`. Empty when unset.
 *
 * @returns {string[]} Extra compiler flags
 */
export function resolveCppFlags(): string[] {
  const flags = readCompilerConfig().flags;
  if (!Array.isArray(flags)) return [];
  return flags.filter(
    (flag): flag is string => typeof flag === 'string' && flag.length > 0
  );
}

/**
 * Resolves the Java compiler executable.
 * Precedence: `POLYMAN_JAVAC` env var, then `compiler.javac` in
 * `Config.json`, then `javac`.
 *
 * @returns {string} Compiler executable name or path
 */
export function resolveJavaCompiler(): string {
  const fromEnv = process.env[JAVAC_ENV_VAR]?.trim();
  if (fromEnv) return fromEnv;
  const fromConfig = readCompilerConfig().javac?.trim();
  if (fromConfig) return fromConfig;
  return DEFAULT_JAVAC;
}

/** File extensions recognised as C++ sources. */
export const CPP_EXTENSIONS = ['.cpp', '.cc', '.cxx'] as const;

/**
 * C++ language standard passed to the compiler when `Config.json` does not
 * set `cppStandard`.
 */
export const DEFAULT_CPP_STANDARD = 'c++23';

/**
 * Accepted shapes for `cppStandard`: `c++NN` / `gnu++NN` plus the historical
 * draft aliases (`c++0x`, `c++1z`, `c++2b`, ...). Strict on purpose: the
 * value ends up inside a shell command line.
 */
const CPP_STANDARD_PATTERN = /^(c|gnu)\+\+(\d{2}|0x|1y|1z|2a|2b|2c)$/;

/**
 * Whether a path points at a C++ source (`.cpp`, `.cc` or `.cxx`).
 *
 * @param {string} filePath - Path or file name to inspect
 * @returns {boolean} True when the extension is a C++ one
 *
 * @example
 * isCppSource('solutions/main.cc'); // true
 * isCppSource('solutions/main.py'); // false
 */
export function isCppSource(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return (CPP_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * Strips a C++ extension from a path, yielding the executable path polyman
 * compiles to. Paths without a C++ extension are returned unchanged.
 *
 * @param {string} filePath - Path to a C++ source
 * @returns {string} Path without its `.cpp` / `.cc` / `.cxx` suffix
 *
 * @example
 * stripCppExtension('/p/solutions/main.cc'); // '/p/solutions/main'
 */
export function stripCppExtension(filePath: string): string {
  return isCppSource(filePath)
    ? filePath.slice(0, -path.extname(filePath).length)
    : filePath;
}

/**
 * Resolves the C++ standard to compile with. Reads `cppStandard` from the
 * `Config.json` in the current directory when one exists and falls back to
 * {@link DEFAULT_CPP_STANDARD} when the file is missing, unreadable, or does
 * not set the field.
 *
 * @returns {string} A value usable as `-std=<value>`
 *
 * @throws {Error} If `cppStandard` is set but is not a recognised standard
 *
 * @example
 * // Config.json: { "cppStandard": "c++20", ... }
 * resolveCppStandard(); // 'c++20'
 */
export function resolveCppStandard(): string {
  let configured: unknown;
  try {
    configured = readConfigFile().cppStandard;
  } catch {
    return DEFAULT_CPP_STANDARD;
  }

  if (configured === undefined) {
    return DEFAULT_CPP_STANDARD;
  }
  if (
    typeof configured !== 'string' ||
    !CPP_STANDARD_PATTERN.test(configured)
  ) {
    throw new Error(
      `Invalid cppStandard in Config.json: ${JSON.stringify(configured)} ` +
        `(expected something like "c++17", "c++20" or "c++23")`
    );
  }
  return configured;
}

/**
 * Compiles a C++ source file.
 * The compiler executable comes from {@link resolveCppCompiler} (defaults to
 * g++). Uses -O2 optimization and the C++ standard from `Config.json`
 * (`cppStandard`, default C++23); any `compiler.flags` are appended.
 * The problem root (current working directory) is added as a quoted-include
 * search path so sources in subdirectories can `#include "testlib.h"`.
 * Goes through the compilation cache: when the source, its local headers,
 * the flags, and the compiler are unchanged, the cached binary is restored
 * and g++ is not run. A testlib program is compiled against a
 * declarations-only testlib and linked with testlib compiled once per
 * problem (see `prebuilt-testlib.ts`), falling back to the original header.
 *
 * @param {string} sourcePath - Path to the .cpp / .cc / .cxx source file
 * @param {Object} [options] - Compilation overrides
 * @param {string} [options.cppStandard] - Standard to pass as `-std=`; when
 *   omitted it is resolved from `Config.json`
 * @returns {Promise<void>} Resolves once the executable is written next to
 *   the source (same path, extension stripped)
 *
 * @throws {Error} If file is not a C++ source or compilation fails
 *
 * @example
 * await compileCPP('solutions/main.cpp');
 * // Produces: '/path/to/solutions/main'
 */
export async function compileCPP(
  sourcePath: string,
  options: { cppStandard?: string } = {}
): Promise<void> {
  const absolutePath = path.resolve(process.cwd(), sourcePath);

  if (!isCppSource(absolutePath)) {
    throw new Error(
      `Expected ${CPP_EXTENSIONS.join('/')} file, got: ${absolutePath}`
    );
  }

  const outputPath = stripCppExtension(absolutePath);
  const cppStandard = options.cppStandard ?? resolveCppStandard();
  const compiler = resolveCppCompiler();
  const flags = ['-O2', `-std=${cppStandard}`, ...resolveCppFlags()];

  const command = (includeDirs: string[], objects: string[] = []) =>
    [
      quoteShellArgument(compiler),
      ...flags.map(quoteShellArgument),
      ...includeDirs.flatMap(dir => ['-iquote', quoteShellArgument(dir)]),
      '-o',
      quoteShellArgument(outputPath),
      // Objects first: testlib's globals are then initialized before the
      // program's own.
      ...objects.map(quoteShellArgument),
      quoteShellArgument(absolutePath),
    ].join(' ');
  const run = (compileCommand: string) =>
    executor.execute(compileCommand, {
      timeout: DEFAULT_TIMEOUT,
      silent: true,
    });

  await cachedCompile(
    {
      sourcePath: absolutePath,
      // g++ appends `.exe` to extension-less outputs on Windows.
      binaryPath: ENV === 'win' ? `${outputPath}.exe` : outputPath,
      compiler,
      flags,
      includeDirs: [process.cwd()],
    },
    async () => {
      const prebuilt = await findPrebuiltTestlib({
        sourcePath: absolutePath,
        compiler,
        flags,
      });
      if (prebuilt === null) return run(command([process.cwd()]));

      try {
        return await run(
          command([prebuilt.includeDir, process.cwd()], [prebuilt.objectPath])
        );
      } catch {
        // Either the source has an error or the split is wrong for it;
        // compiling against the original header tells which, and reports
        // the error exactly as a normal compile would.
      }
      const result = await run(command([process.cwd()]));
      markPrebuiltTestlibUnsupported(prebuilt);
      return result;
    }
  );
}

/**
 * Compiles a Java source file.
 * The compiler executable comes from {@link resolveJavaCompiler} (defaults
 * to javac).
 *
 * @param {string} sourcePath - Path to the .java source file
 * @returns {Promise<void>} Resolves when compilation succeeds
 *
 * @throws {Error} If compilation fails
 *
 * @example
 * await compileJava('solutions/Solution.java');
 * // Produces: '/path/to/solutions/Solution.class'
 */
export async function compileJava(sourcePath: string): Promise<void> {
  const absolutePath = path.resolve(sourcePath);

  const compileCommand = [
    quoteShellArgument(resolveJavaCompiler()),
    quoteShellArgument(absolutePath),
  ].join(' ');

  await executor.execute(compileCommand, {
    timeout: DEFAULT_TIMEOUT,
    silent: true,
  });
}

/**
 * Filters test files by a numerical range.
 * Looks for files named like "test1.txt", "test2.txt", etc.
 *
 * @param {string[]} testFiles - Array of test file names
 * @param {number} [testBegin] - Start of range (inclusive), optional
 * @param {number} [testEnd] - End of range (inclusive), optional
 * @returns {string[]} Filtered array of test files
 *
 * @example
 * const allTests = ['test1.txt', 'test2.txt', 'test3.txt'];
 * const filtered = filterTestsByRange(allTests, 1, 2);
 * // Returns: ['test1.txt', 'test2.txt']
 */
export function filterTestsByRange(
  testFiles: string[],
  testBegin?: number,
  testEnd?: number
): string[] {
  if (testBegin === undefined || testEnd === undefined) {
    return testFiles;
  }

  return testFiles.filter(file => {
    if (!file.startsWith('test')) return false;

    const numberPart = file.slice(4, file.lastIndexOf('.'));
    const testNumber = parseInt(numberPart, 10);

    return (
      !isNaN(testNumber) && testNumber >= testBegin && testNumber <= testEnd
    );
  });
}

/**
 * Gets all test files from tests directory.
 * Returns only files starting with 'test' prefix in sorted order by test number.
 *
 * @private
 * @param {string} testsDir - Path to tests directory
 * @returns {string[]} Array of test filenames
 *
 * @example
 * getTestFiles('/path/to/tests')
 * // Returns: ['test1.txt', 'test2.txt', 'test3.txt', ...]
 */
export function getTestFiles(testsDir: string): string[] {
  return fs
    .readdirSync(testsDir)
    .filter(file => file.startsWith('test'))
    .sort((a, b) => {
      const numA = parseInt(a.replace('test', '').replace('.txt', ''));
      const numB = parseInt(b.replace('test', '').replace('.txt', ''));
      return numA - numB;
    });
}

/**
 * Reads and parses the Config.json file from the current working directory.
 *
 * @returns {ConfigFile} Parsed configuration object
 *
 * @throws {Error} If Config.json doesn't exist or is invalid JSON
 *
 * @example
 * const config = readConfigFile();
 * console.log(config.solutions); // Array of solutions
 */
export function readConfigFile(): ConfigFile {
  try {
    const configFilePath = path.resolve(process.cwd(), 'Config.json');
    const configData = fs.readFileSync(configFilePath, 'utf-8');
    return JSON.parse(configData) as ConfigFile;
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('Failed to read or parse Config.json file.');
  }
}

/**
 * Whether stdin is an interactive terminal, i.e. a prompt could be answered.
 * Headless agents and CI pipelines get false; commands must not block on a
 * prompt in that case.
 *
 * @returns {boolean} True when stdin is a TTY
 *
 * @example
 * if (!stdinIsInteractive()) {
 *   throw new Error('pass --yes to skip the confirmation');
 * }
 */
export function stdinIsInteractive(): boolean {
  return process.stdin.isTTY === true;
}

/**
 * Checks if a string represents a numeric value.
 *
 * @param {string} value - String to check
 * @returns {boolean} True if value is numeric
 *
 * @example
 * isNumeric('42');  // true
 * isNumeric('all'); // false
 */
export function isNumeric(value: string): boolean {
  return !isNaN(parseInt(value, 10));
}

/**
 * Logs an error message with a cross icon.
 * Formats the error using the formatter.
 *
 * @param {unknown} error - Error to log
 *
 * @example
 * try {
 *   await compileCPP('invalid.cpp');
 * } catch (error) {
 *   logError(error);
 * }
 */
export function logError(error: unknown, indent: number = 1) {
  const message = error instanceof Error ? error.message : String(error);
  fmt.error(`${' '.repeat(indent)} ${fmt.cross()} ${message}`);
}

/**
 * Logs an error and exits the process with code 1.
 *
 * @param {unknown} error - Error to log
 *
 * @example
 * if (!fs.existsSync('Config.json')) {
 *   logErrorAndExit(new Error('Config.json not found'));
 * }
 */
export function logErrorAndExit(error: unknown) {
  logError(error);
  process.exit(1);
}

/**
 * Logs an error and re-throws it.
 *
 * @param {unknown} error - Error to log and throw
 * @param {string} [message=''] - Additional context message
 *
 * @throws {Error} Always throws after logging
 *
 * @example
 * try {
 *   dangerousOperation();
 * } catch (error) {
 *   logErrorAndThrow(error, 'Operation failed');
 * }
 */
export function logErrorAndThrow(error: unknown, message = '') {
  logError(error);
  throwError(error, message);
}

/**
 * Throws an error, ensuring it's an Error instance.
 * If the input is not an Error, wraps it in one.
 *
 * @param {unknown} error - Error to throw
 * @param {string} [message=''] - Additional context message
 *
 * @throws {Error} Always throws
 *
 * @example
 * throwError(new Error('Something went wrong'));
 */
export function throwError(error: unknown, message = ''): never {
  throw error instanceof Error
    ? error
    : new Error(`${message}: ${String(error)}`);
}

/**
 * Ensures a directory exists, creating it if necessary.
 * Creates parent directories recursively.
 *
 * @param {string} dirName - Directory name/path relative to current working directory
 *
 * @example
 * ensureDirectoryExists('testsets');
 * ensureDirectoryExists('nested/path/to/dir');
 */
export function ensureDirectoryExists(dirName: string) {
  const dirPath = path.resolve(process.cwd(), dirName);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Removes a directory and all its contents.
 * Does nothing if directory doesn't exist.
 *
 * @param {string} dirName - Directory name/path relative to current working directory
 *
 * @example
 * removeDirectoryRecursively('temp');
 */
export function removeDirectoryRecursively(dirName: string) {
  const dirPath = path.resolve(process.cwd(), dirName);
  if (fs.existsSync(dirPath)) {
    fs.rmSync(dirPath, { recursive: true, force: true });
  }
}

/**
 * Reads the first line of a file efficiently using streaming.
 * Useful for reading verdict from validator/checker output.
 *
 * @param {string} filePath - Path to the file
 * @returns {Promise<string>} First line of the file
 *
 * @throws {Error} If file cannot be read
 *
 * @example
 * const verdict = await readFirstLine('/tmp/validator_output.txt');
 * // Returns: 'VALID' or 'INVALID'
 */
export function readFirstLine(filePath: string): Promise<string> {
  // use file stream

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
  return new Promise<string>((resolve, reject) => {
    let data = '';
    fileStream.on('data', chunk => {
      data += String(chunk);
      const lines = data.split(/\r?\n/);
      if (lines.length > 1) {
        fileStream.close();
        resolve(lines[0]);
      }
    });
    fileStream.on('end', () => {
      const lines = data.split(/\r?\n/);
      resolve(lines[0] || '');
    });
    fileStream.on('error', err => {
      reject(err);
    });
  });
}

export function getCompiledCommandToRun(
  object: LocalChecker | LocalValidator | LocalSolution | LocalGenerator
): string {
  if ('isStandard' in object && object.isStandard) {
    const checkerName = stripCppExtension(object.source);
    return quoteShellArgument(
      path.resolve(__dirname, '../..', 'assets', 'checkers', checkerName)
    );
  }

  const source = path.resolve(process.cwd(), object.source);
  const extention = path.extname(source);

  if (isCppSource(source)) {
    return quoteShellArgument(stripCppExtension(source));
  }

  switch (extention) {
    case '.java': {
      const dir = path.dirname(source);
      const fileName = path.basename(source);
      const className = fileName.replace(/\.java$/, '');
      return `java -cp ${quoteShellArgument(dir)} ${quoteShellArgument(className)}`;
    }
    case '.py':
      return `python ${quoteShellArgument(source)}`;
    case '.js':
      return `node ${quoteShellArgument(source)}`;
    default:
      throw new Error(`Unsupported source file extension: ${extention}`);
  }
}
