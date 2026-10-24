/**
 * @fileoverview Common utility functions for compilation, file operations, and error handling.
 * Provides cross-language compilation, test filtering, config reading, and directory management.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { executor } from '../executor';
import { fmt } from '../formatter';
import { PolymanError } from '../errors';
import { quoteShellArgument } from './shell';
import { cachedCompile, debugLog } from './compile-cache';
import {
  findPrebuiltTestlib,
  markPrebuiltTestlibUnsupported,
} from './prebuilt-testlib';
import { findPch, markPchUnsupported } from './pch';
import ConfigFile, {
  CompilerConfig,
  LocalChecker,
  LocalGenerator,
  LocalSolution,
  LocalValidator,
} from '../types';

/** Default compilation timeout in milliseconds */
export const DEFAULT_TIMEOUT = 10000;

/**
 * Reads a compile time limit from the environment: a positive whole number of
 * milliseconds, or the default for anything else.
 */
export function compileTimeoutFrom(raw: string | undefined): number {
  const ms = Number(raw);
  return Number.isInteger(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT;
}

/**
 * Time limit for compiling a C++ or Java source. POLYMAN_COMPILE_TIMEOUT_MS
 * raises it where compiling is slow, such as a busy or sandboxed machine (the
 * verify web service sets it); otherwise it is {@link DEFAULT_TIMEOUT}.
 */
export const COMPILE_TIMEOUT = compileTimeoutFrom(
  process.env['POLYMAN_COMPILE_TIMEOUT_MS']
);

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

/** Keys accepted inside the `compiler` block of `Config.json`. */
const COMPILER_CONFIG_KEYS = ['cpp', 'javac', 'flags'] as const;

/** Optimization flag used when `compiler.flags` has no `-O` flag. */
const DEFAULT_OPTIMIZATION_FLAG = '-O2';

/**
 * Macro defined for solutions, like Codeforces does. Without it a solution
 * with `#ifndef ONLINE_JUDGE freopen(...) #endif` writes to a file instead
 * of stdout.
 */
export const ONLINE_JUDGE_FLAG = '-DONLINE_JUDGE';

/**
 * Checks the optional `compiler` block of `Config.json`. A missing block is
 * fine; anything else must be an object with only `cpp`, `javac` and `flags`,
 * where `cpp` and `javac` are non-blank strings and `flags` is an array of
 * non-blank strings (one flag per item).
 *
 * @param {unknown} value - The raw `compiler` value from `Config.json`
 * @returns {CompilerConfig} The same block, typed (`{}` when missing)
 *
 * @throws {Error} If the block or one of its fields has the wrong shape
 *
 * @example
 * validateCompilerConfig({ cpp: 'g++-15', flags: ['-Wall'] }); // ok
 * validateCompilerConfig({ flags: '-Wall' }); // throws
 */
export function validateCompilerConfig(value: unknown): CompilerConfig {
  if (value === undefined) return {};

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PolymanError(
      `Invalid compiler in Config.json: ${JSON.stringify(value)} ` +
        `(expected an object like { "cpp": "g++-15" })`,
      2
    );
  }

  for (const [key, field] of Object.entries(value)) {
    if (key === 'cpp' || key === 'javac') {
      if (typeof field !== 'string' || field.trim() === '') {
        throw new PolymanError(
          `Invalid compiler.${key} in Config.json: ${JSON.stringify(field)} ` +
            `(expected an executable name or path, like ` +
            `${key === 'cpp' ? '"g++-15"' : '"/usr/lib/jvm/java-21/bin/javac"'})`,
          2
        );
      }
    } else if (key === 'flags') {
      if (
        !Array.isArray(field) ||
        field.some(flag => typeof flag !== 'string' || flag.trim() === '')
      ) {
        throw new PolymanError(
          `Invalid compiler.flags in Config.json: ${JSON.stringify(field)} ` +
            `(expected an array with one flag per item, like ["-Wall", "-std=c++20"])`,
          2
        );
      }
    } else {
      throw new PolymanError(
        `Unknown key in compiler: ${JSON.stringify(key)} ` +
          `(allowed keys: ${COMPILER_CONFIG_KEYS.join(', ')})`,
        2
      );
    }
  }

  return value;
}

/**
 * Reads the optional `compiler` block from `Config.json` in the current
 * working directory. A missing or unreadable `Config.json` yields `{}` so
 * compilation falls back to the defaults, the same way `cppStandard` does.
 *
 * @returns {CompilerConfig} The checked `compiler` block, or `{}`
 *
 * @throws {Error} If the block is present but malformed
 *   (see {@link validateCompilerConfig})
 */
export function readCompilerConfig(): CompilerConfig {
  let configured: unknown;
  try {
    configured = readConfigFile().compiler;
  } catch {
    return {};
  }
  return validateCompilerConfig(configured);
}

/**
 * Reads an executable override from the environment. Unset, empty and
 * whitespace-only values all count as "not set".
 */
function readExecutableFromEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Resolves the C++ compiler executable.
 * Precedence: `POLYMAN_CXX` env var, then `compiler.cpp` in `Config.json`,
 * then `g++`.
 *
 * @param {CompilerConfig} [config] - Checked `compiler` block; read from
 *   `Config.json` when omitted
 * @returns {string} Compiler executable name or path (not shell-quoted)
 *
 * @throws {Error} If the `compiler` block in `Config.json` is malformed
 *
 * @example
 * // POLYMAN_CXX=g++-15
 * resolveCppCompiler(); // 'g++-15'
 */
export function resolveCppCompiler(
  config: CompilerConfig = readCompilerConfig()
): string {
  return (
    readExecutableFromEnv(CXX_ENV_VAR) ?? config.cpp?.trim() ?? DEFAULT_CXX
  );
}

/**
 * Builds the full list of C++ compile flags: `-O2`, `-std=<cppStandard>`,
 * then every item of `compiler.flags`. A user flag replaces the matching
 * default instead of being added next to it:
 *   - a `-std=` (or `--std=`) flag replaces `-std=<cppStandard>`,
 *   - an `-O` flag (`-O0`, `-O3`, `-Ofast`, ...) replaces `-O2`.
 * So the command never has two different `-std=` or `-O` flags.
 * With `onlineJudge` (solutions only), `-DONLINE_JUDGE` is added after the
 * standard, unless `compiler.flags` already defines `ONLINE_JUDGE`.
 *
 * @param {Object} [options] - Compilation overrides
 * @param {string} [options.cppStandard] - Standard to use instead of the one
 *   from `Config.json`
 * @param {boolean} [options.onlineJudge] - Define `ONLINE_JUDGE`
 * @param {CompilerConfig} [config] - Checked `compiler` block; read from
 *   `Config.json` when omitted
 * @returns {string[]} Flags in order (not shell-quoted)
 *
 * @throws {Error} If `cppStandard` or the `compiler` block is invalid
 *
 * @example
 * // Config.json: { "cppStandard": "c++20", "compiler": { "flags": ["-Wall"] } }
 * resolveCppFlags(); // ['-O2', '-std=c++20', '-Wall']
 *
 * @example
 * // Config.json: { "compiler": { "flags": ["-O0", "-std=gnu++17"] } }
 * resolveCppFlags(); // ['-O0', '-std=gnu++17']
 *
 * @example
 * resolveCppFlags({ onlineJudge: true }); // ['-O2', '-std=c++23', '-DONLINE_JUDGE']
 */
export function resolveCppFlags(
  options: { cppStandard?: string; onlineJudge?: boolean } = {},
  config: CompilerConfig = readCompilerConfig()
): string[] {
  const cppStandard = options.cppStandard ?? resolveCppStandard();
  const extra = (config.flags ?? []).map(flag => flag.trim());
  const hasStandard = extra.some(
    flag => flag.startsWith('-std=') || flag.startsWith('--std=')
  );
  const hasOptimization = extra.some(flag => flag.startsWith('-O'));
  const addOnlineJudge =
    options.onlineJudge === true &&
    !extra.some(flag => /^-D\s*ONLINE_JUDGE(=|$)/.test(flag));

  return [
    ...(hasOptimization ? [] : [DEFAULT_OPTIMIZATION_FLAG]),
    ...(hasStandard ? [] : [`-std=${cppStandard}`]),
    ...(addOnlineJudge ? [ONLINE_JUDGE_FLAG] : []),
    ...extra,
  ];
}

/**
 * Resolves the Java compiler executable.
 * Precedence: `POLYMAN_JAVAC` env var, then `compiler.javac` in
 * `Config.json`, then `javac`. Java programs still run with `java` from
 * `PATH`.
 *
 * @param {CompilerConfig} [config] - Checked `compiler` block; read from
 *   `Config.json` when omitted
 * @returns {string} Compiler executable name or path (not shell-quoted)
 *
 * @throws {Error} If the `compiler` block in `Config.json` is malformed
 */
export function resolveJavaCompiler(
  config: CompilerConfig = readCompilerConfig()
): string {
  return (
    readExecutableFromEnv(JAVAC_ENV_VAR) ??
    config.javac?.trim() ??
    DEFAULT_JAVAC
  );
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
 * Reads the C++ standard named in a Polygon `sourceType`, for example
 * `cpp.g++17` or `cpp.gcc14-64-msys2-g++23`. Types that name no standard
 * (`cpp.ms2017`, `java21`, ...) give `undefined`.
 *
 * @param {string} [sourceType] - Polygon compiler identifier
 * @returns {string | undefined} A value usable as `-std=<value>`, or
 *   undefined when the type names no C++ standard
 *
 * @example
 * cppStandardFromSourceType('cpp.g++17'); // 'c++17'
 * cppStandardFromSourceType('cpp.clang++20'); // 'c++20'
 * cppStandardFromSourceType('cpp.ms2019'); // undefined
 */
export function cppStandardFromSourceType(
  sourceType?: string
): string | undefined {
  const match = /^cpp\..*\+\+(\d{2})$/.exec(sourceType?.trim() ?? '');
  return match ? `c++${match[1]}` : undefined;
}

/**
 * Resolves the C++ standard to compile with. Reads `cppStandard` from the
 * `Config.json` in the current directory when one exists and falls back to
 * `fallback` when the file is missing, unreadable, or does not set the field.
 *
 * @param {string} [fallback=DEFAULT_CPP_STANDARD] - Standard used when
 *   `Config.json` sets no `cppStandard`
 * @returns {string} A value usable as `-std=<value>`
 *
 * @throws {Error} If `cppStandard` is set but is not a recognised standard
 *
 * @example
 * // Config.json: { "cppStandard": "c++20", ... }
 * resolveCppStandard(); // 'c++20'
 */
export function resolveCppStandard(
  fallback: string = DEFAULT_CPP_STANDARD
): string {
  let configured: unknown;
  try {
    configured = readConfigFile().cppStandard;
  } catch {
    return fallback;
  }

  if (configured === undefined) {
    return fallback;
  }
  if (
    typeof configured !== 'string' ||
    !CPP_STANDARD_PATTERN.test(configured)
  ) {
    throw new PolymanError(
      `Invalid cppStandard in Config.json: ${JSON.stringify(configured)} ` +
        `(expected something like "c++17", "c++20" or "c++23")`,
      2
    );
  }
  return configured;
}

/**
 * Flags known to read no file the compile cache does not hash. Anything else
 * (`-I`, `-include`, `-L`, `-l`, `-specs=`, `-T`, `-Wl,...`, `@file`, object
 * files, a flag's value given as the next item, ...) could change the binary
 * without changing the cache key, so it disables the cache.
 */
const CACHE_SAFE_FLAG_PATTERNS = [
  /^-O([0-3]|s|z|g|fast)?$/,
  /^--?std=[a-z0-9+]+$/,
  /^-D[A-Za-z_]\w*(=.*)?$/,
  /^-U[A-Za-z_]\w*$/,
  // No comma, so -Wl, -Wp, and -Wa, (pass-through to other tools) are out.
  /^-W[a-z][a-z0-9+=-]*$/,
  /^-w$/,
  /^-pedantic(-errors)?$/,
  // Named -f flags only: -fprofile-use, -fauto-profile and
  // -fbranch-probabilities read profile data files.
  /^-f(no-)?(omit-frame-pointer|strict-aliasing|openmp|stack-protector(-strong|-all)?|trapv|wrapv|exceptions|rtti|unroll-loops|sanitize-recover)$/,
  /^-f(no-)?sanitize=[a-z,-]+$/,
  /^-f(max-errors|template-depth|constexpr-depth|constexpr-steps|constexpr-ops-limit|constexpr-loop-limit)=\d+$/,
  /^-fdiagnostics-color=(auto|always|never)$/,
  /^-g(gdb)?[0-3]?$/,
  /^-m[a-z0-9][a-z0-9-]*(=[a-z0-9-]+)?$/,
  /^-(static|pthread|pipe|s)$/,
];

/**
 * Whether a compiler flag is on {@link CACHE_SAFE_FLAG_PATTERNS}.
 */
function isCacheSafeFlag(flag: string): boolean {
  return CACHE_SAFE_FLAG_PATTERNS.some(pattern => pattern.test(flag));
}

/**
 * Compiles a C++ source file.
 * The compiler executable comes from {@link resolveCppCompiler} (`POLYMAN_CXX`,
 * then `compiler.cpp`, then g++) and the flags from {@link resolveCppFlags}
 * (`-O2`, `-std=<cppStandard>`, `-DONLINE_JUDGE` for solutions and
 * `compiler.flags`). The flags are part of the cache key, so a solution
 * built before `-DONLINE_JUDGE` was added is compiled again.
 * The problem root (current working directory) is added as a quoted-include
 * search path so sources in subdirectories can `#include "testlib.h"`.
 * Goes through the compilation cache: when the source, its local headers,
 * the flags, and the compiler are unchanged, the cached binary is restored
 * and the compiler is not run. A testlib program is compiled against a
 * declarations-only testlib and linked with testlib compiled once per
 * problem (see `prebuilt-testlib.ts`), falling back to the original header.
 * When `compiler.flags` holds a flag that is not known to be safe for the
 * cache (see {@link CACHE_SAFE_FLAG_PATTERNS}: `-O`, `-std=`, `-D`, `-W`,
 * `-f`, `-g`, `-m` and a few more), neither the cache nor the prebuilt
 * testlib is used: the source is compiled in full every time.
 * With g++ and a source that starts with `#include <bits/stdc++.h>`, the
 * header comes precompiled, built once per compiler and flags (see
 * `pch.ts`); any other case, or a compile that fails with it, compiles
 * without it.
 *
 * @param {string} sourcePath - Path to the .cpp / .cc / .cxx source file
 * @param {Object} [options] - Compilation overrides
 * @param {string} [options.cppStandard] - Standard to pass as `-std=`; when
 *   omitted it is resolved from `Config.json`
 * @param {boolean} [options.onlineJudge] - Define `ONLINE_JUDGE`; set for
 *   solutions, not for checkers, validators and generators
 * @returns {Promise<void>} Resolves once the executable is written next to
 *   the source (same path, extension stripped)
 *
 * @throws {Error} If file is not a C++ source, `cppStandard` or the
 *   `compiler` block is invalid, or compilation fails
 *
 * @example
 * await compileCPP('solutions/main.cpp');
 * // Produces: '/path/to/solutions/main'
 */
export async function compileCPP(
  sourcePath: string,
  options: { cppStandard?: string; onlineJudge?: boolean } = {}
): Promise<void> {
  const absolutePath = path.resolve(process.cwd(), sourcePath);

  if (!isCppSource(absolutePath)) {
    throw new Error(
      `Expected ${CPP_EXTENSIONS.join('/')} file, got: ${absolutePath}`
    );
  }

  const outputPath = stripCppExtension(absolutePath);
  const compilerConfig = readCompilerConfig();
  const compiler = resolveCppCompiler(compilerConfig);
  const flags = resolveCppFlags(options, compilerConfig);

  const command = (
    includeDirs: string[],
    objects: string[] = [],
    pchDirs: string[] = []
  ) =>
    [
      quoteShellArgument(compiler),
      ...flags.map(quoteShellArgument),
      ...includeDirs.flatMap(dir => ['-iquote', quoteShellArgument(dir)]),
      ...pchDirs.flatMap(dir => ['-I', quoteShellArgument(dir)]),
      '-o',
      quoteShellArgument(outputPath),
      // Objects first: testlib's globals are then initialized before the
      // program's own.
      ...objects.map(quoteShellArgument),
      quoteShellArgument(absolutePath),
    ].join(' ');
  const run = (compileCommand: string) =>
    executor.execute(compileCommand, {
      timeout: COMPILE_TIMEOUT,
      silent: true,
    });

  if (!flags.every(isCacheSafeFlag)) {
    debugLog(
      `pch: flags not cache-safe, normal compile: ${path.basename(absolutePath)}`
    );
    await run(command([process.cwd()]));
    return;
  }

  await cachedCompile(
    {
      sourcePath: absolutePath,
      // g++ and clang++ append `.exe` to extension-less outputs on Windows.
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
      const compileOnce = async (pchDirs: string[]) => {
        if (prebuilt === null) {
          return run(command([process.cwd()], [], pchDirs));
        }
        try {
          return await run(
            command(
              [prebuilt.includeDir, process.cwd()],
              [prebuilt.objectPath],
              pchDirs
            )
          );
        } catch {
          // Either the source has an error or the split is wrong for it;
          // compiling against the original header tells which, and reports
          // the error exactly as a normal compile would.
        }
        const result = await run(command([process.cwd()], [], pchDirs));
        markPrebuiltTestlibUnsupported(prebuilt);
        return result;
      };

      const pch = await findPch({ sourcePath: absolutePath, compiler, flags });
      if (pch === null) return compileOnce([]);
      try {
        return await compileOnce([pch.includeDir]);
      } catch {
        // Same idea: without the PCH either the error stays, and is reported
        // exactly as a normal compile reports it, or the PCH was at fault.
        debugLog(`pch: compile failed with the PCH, retrying without it`);
      }
      const result = await compileOnce([]);
      markPchUnsupported(pch);
      return result;
    }
  );
}

/**
 * Compiles a Java source file.
 * The compiler executable comes from {@link resolveJavaCompiler}
 * (`POLYMAN_JAVAC`, then `compiler.javac`, then javac). Java is not cached,
 * and `compiler.flags` only applies to C++.
 *
 * @param {string} sourcePath - Path to the .java source file
 * @returns {Promise<void>} Resolves when compilation succeeds
 *
 * @throws {Error} If the `compiler` block is invalid or compilation fails
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
    timeout: COMPILE_TIMEOUT,
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
 * @throws {PolymanError} With exit code 2 if Config.json doesn't exist or
 *   is invalid JSON
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
    throw new PolymanError(
      error instanceof Error
        ? error.message
        : 'Failed to read or parse Config.json file.',
      2,
      'Run polyman inside a problem folder, or create one with: polyman new <dir>',
      { cause: error }
    );
  }
}

/**
 * Checks that every source file Config.json names exists: the validator, the
 * checker (unless it is a standard one shipped with polyman), the generators
 * and the solutions. Paths are resolved against the current directory, as the
 * compile steps do. All missing files are reported in one error, so the setter
 * can fix them in one go instead of meeting them one compile step at a time.
 *
 * @param {ConfigFile} config - Parsed Config.json
 * @throws {Error} If any named source file does not exist
 *
 * @example
 * ensureConfigSourcesExist(readConfigFile());
 * // throws: Config.json names source files that do not exist:
 * //   - validator file not found: val.cpp
 */
export function ensureConfigSourcesExist(config: ConfigFile): void {
  const missing: string[] = [];
  const check = (label: string, source: string | undefined): void => {
    if (!source) {
      return;
    }
    if (!fs.existsSync(path.resolve(process.cwd(), source))) {
      missing.push(`${label} file not found: ${source}`);
    }
  };

  check('validator', config.validator?.source);
  if (!config.checker?.isStandard) {
    check('checker', config.checker?.source);
  }
  for (const generator of config.generators ?? []) {
    check(`generator "${generator.name}"`, generator.source);
  }
  for (const solution of config.solutions ?? []) {
    check(`solution "${solution.name}"`, solution.source);
  }

  if (missing.length > 0) {
    throw new PolymanError(
      `Config.json names source files that do not exist:\n${missing
        .map(line => `  - ${line}`)
        .join('\n')}`,
      2
    );
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
 * Resolves a path from Config.json against the problem folder and refuses
 * anything that lands outside it, so a crafted Config.json cannot make
 * polyman read (and upload) files like `../../.ssh/id_rsa`.
 * Names that merely start with two dots, like `..notes.tex`, are allowed.
 *
 * @param {string} problemDir - Problem directory path
 * @param {string} rel - Path from Config.json, relative to the problem folder
 * @returns {string} The absolute path, guaranteed to be inside `problemDir`
 * @throws {Error} If the path resolves outside the problem folder
 *
 * @example
 * insideProblem('/p', 'solutions/main.cpp'); // '/p/solutions/main.cpp'
 * insideProblem('/p', '../x');               // throws
 */
export function insideProblem(problemDir: string, rel: string): string {
  const resolved = path.resolve(problemDir, rel);
  const relative = path.relative(path.resolve(problemDir), resolved);
  if (
    path.isAbsolute(relative) ||
    relative === '..' ||
    relative.startsWith('..' + path.sep)
  ) {
    throw new Error(`Refusing path outside the problem folder: ${rel}`);
  }
  return resolved;
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

/** Interpreter names tried for `.py` files, in order of preference. */
const PYTHON_CANDIDATES = ['python3', 'python'];

let cachedPythonCommand: string | undefined;

/**
 * Forgets the interpreter found by {@link findPythonCommand}. Used by tests.
 */
export function resetPythonCommandCache(): void {
  cachedPythonCommand = undefined;
}

/**
 * Finds a Python 3 interpreter on this machine: `python3`, then `python`.
 * A candidate counts only if it runs and reports `Python 3.x`, so a `python`
 * that is really Python 2 is skipped. The result is cached for the process.
 *
 * @param {string} [source] - Source file that needs Python, named in the error
 * @throws {Error} If no Python 3 interpreter is found
 */
export function findPythonCommand(source?: string): string {
  if (cachedPythonCommand !== undefined) {
    return cachedPythonCommand;
  }

  for (const candidate of PYTHON_CANDIDATES) {
    const result = spawnSync(candidate, ['--version'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.error || result.status !== 0) {
      continue;
    }
    // Python 3.4+ prints the version on stdout, older versions on stderr.
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (/^Python 3\./m.test(output)) {
      cachedPythonCommand = candidate;
      return candidate;
    }
  }

  throw new PolymanError(
    `Python 3 was not found (tried ${PYTHON_CANDIDATES.join(', ')}).` +
      (source ? ` Install Python 3 to run ${source}` : ' Install Python 3'),
    3
  );
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
      return `${findPythonCommand(object.source)} ${quoteShellArgument(source)}`;
    case '.js':
      return `node ${quoteShellArgument(source)}`;
    default:
      throw new Error(`Unsupported source file extension: ${extention}`);
  }
}
