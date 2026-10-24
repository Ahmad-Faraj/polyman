/**
 * @fileoverview Test generator compilation and execution.
 *
 * Drives Polygon-format generator scripts: parses, resolves to concrete test
 * indices, then runs each generator (or copies each manual test) into the
 * testset's output directory as `test<index>.txt`.
 */

import type { LocalGenerator, LocalTestset, ResolvedTest } from '../types';
import { executor } from '../executor';
import path from 'path';
import fs from 'fs';
import {
  compileCPP,
  throwError,
  ensureDirectoryExists,
  getCompiledCommandToRun,
} from './utils';
import { DEFAULT_TIMEOUT, DEFAULT_MEMORY_LIMIT } from './utils';
import { quoteShellArgument } from './shell';
import { fmt } from '../formatter';
import { LimitExceededError, PolymanError } from '../errors';
import { report } from '../report';
import {
  parseGeneratorScript,
  readScriptText,
  resolveTests,
  validateGeneratorReferences,
  validateManualTests,
} from './script-parser';

/**
 * Runs a generator with stdout redirected to a single output file.
 */
async function runGeneratorToFile(
  execCommand: string,
  args: string[],
  outputFilePath: string
) {
  const argsString = args.map(quoteShellArgument).join(' ');
  await executor.executeWithRedirect(
    [execCommand, argsString].filter(Boolean).join(' '),
    {
      timeout: DEFAULT_TIMEOUT,
      memoryLimitMB: DEFAULT_MEMORY_LIMIT,
      silent: true,
      onTimeout: () => {
        fmt.error(
          `${fmt.cross()} ${fmt.bold('Generator Unexpectedly Exceeded Time Limit!')} (${DEFAULT_TIMEOUT}ms)`
        );
        void executor.cleanup();
        throw new LimitExceededError(
          `Generator exceeded the time limit (${DEFAULT_TIMEOUT}ms)`
        );
      },
      onMemoryExceeded: () => {
        fmt.error(
          `${fmt.cross()} ${fmt.bold('Generator Unexpectedly Exceeded Memory Limit!')} (${DEFAULT_MEMORY_LIMIT} MB)`
        );
        void executor.cleanup();
        throw new LimitExceededError(
          `Generator exceeded the memory limit (${DEFAULT_MEMORY_LIMIT} MB)`
        );
      },
    },
    undefined,
    outputFilePath
  );
}

/**
 * Runs a generator that writes its own output files (multi-output `> {…}`
 * targets). The generator runs with cwd set to the testset directory so any
 * relative file paths it produces land where the rest of the pipeline expects
 * them.
 */
async function runGeneratorMultiOutput(
  execCommand: string,
  args: string[],
  cwd: string
) {
  const argsString = args.map(quoteShellArgument).join(' ');
  await executor.execute([execCommand, argsString].filter(Boolean).join(' '), {
    timeout: DEFAULT_TIMEOUT,
    memoryLimitMB: DEFAULT_MEMORY_LIMIT,
    silent: true,
    cwd,
    onTimeout: () => {
      fmt.error(
        `${fmt.cross()} ${fmt.bold('Generator Unexpectedly Exceeded Time Limit!')} (${DEFAULT_TIMEOUT}ms)`
      );
      void executor.cleanup();
      throw new LimitExceededError(
        `Generator exceeded the time limit (${DEFAULT_TIMEOUT}ms)`
      );
    },
    onMemoryExceeded: () => {
      fmt.error(
        `${fmt.cross()} ${fmt.bold('Generator Unexpectedly Exceeded Memory Limit!')} (${DEFAULT_MEMORY_LIMIT} MB)`
      );
      void executor.cleanup();
      throw new LimitExceededError(
        `Generator exceeded the memory limit (${DEFAULT_MEMORY_LIMIT} MB)`
      );
    },
  });
}

export function ensureGeneratorsExist(
  generators: LocalGenerator[] | undefined
): asserts generators is LocalGenerator[] {
  if (!generators || generators.length === 0) {
    throw new PolymanError(
      'No test generators defined in the configuration file.',
      2,
      'Add a "generators" entry to Config.json'
    );
  }
}

export async function compileGenerator(generator: LocalGenerator) {
  if (!generator.source) {
    throw new PolymanError(
      `Generator ${generator.name} has no source file specified`,
      2,
      'Set "source" for this generator in Config.json'
    );
  }
  await compileCPP(generator.source);
}

/**
 * Compiles all generators referenced by the given resolved tests.
 * Returns a map of generator name → compiled-run command.
 */
export async function compileGeneratorsForTests(
  tests: ResolvedTest[],
  generators: LocalGenerator[]
): Promise<Map<string, string>> {
  const compiled = new Map<string, string>();
  const referenced = new Set<string>();

  for (const t of tests) {
    if (t.source.kind === 'generator') {
      referenced.add(t.source.generator);
    }
  }

  for (const name of referenced) {
    const gen = generators.find(g => g.name === name);
    if (!gen) {
      throw new PolymanError(
        `Generator "${name}" not found in configuration`,
        2,
        'Check the generator name in the testset script and in Config.json'
      );
    }
    if (!compiled.has(name)) {
      try {
        await compileGenerator(gen);
        compiled.set(name, getCompiledCommandToRun(gen));
      } catch (error) {
        throwError(error, `Failed to compile generator ${name}`);
      }
    }
  }

  return compiled;
}

/**
 * Compiles every generator used across every testset's resolved tests.
 */
export async function compileGeneratorsForTestsets(
  testsets: LocalTestset[],
  generators: LocalGenerator[]
): Promise<void> {
  const referenced = new Set<string>();
  for (const ts of testsets) {
    const lines = parseGeneratorScript(readScriptText(ts));
    for (const line of lines) referenced.add(line.generator);
  }
  for (const name of referenced) {
    const gen = generators.find(g => g.name === name);
    if (!gen) {
      throw new PolymanError(
        `Generator "${name}" not found in configuration`,
        2,
        'Check the generator name in the testset script and in Config.json'
      );
    }
    await compileGenerator(gen);
  }
}

/**
 * Runs the resolved tests for a single testset, writing each input to
 * `<testsDir>/test<index>.txt`.
 *
 * Multi-output lines run once per unique line (not once per produced file)
 * and are expected to write all listed test files themselves.
 *
 * Every test's result is recorded for `generate --json` under `testsetName`
 * (defaults to the name of `testsDir`).
 */
export async function executeResolvedTests(
  tests: ResolvedTest[],
  generators: LocalGenerator[],
  testsDir: string,
  testsetName: string = path.basename(testsDir)
): Promise<void> {
  ensureDirectoryExists(testsDir);

  const compiled = new Map<string, string>();
  for (const generator of generators) {
    compiled.set(generator.name, getCompiledCommandToRun(generator));
  }

  let someFailed = false;
  // Group multi-output tests by (generator, args, multiOutputs key) so we
  // only invoke the generator once per source line. The value is the line's
  // error message (null when it worked), so every test of the line gets the
  // same result in the report.
  const handled = new Map<string, string | null>();
  // For a multi-output line that failed: the error of each index on it, or
  // null when `test<idx>.txt` was written before the failure.
  const lineResults = new Map<string, Map<number, string | null>>();

  for (const t of tests) {
    let key: string | null = null;
    try {
      if (t.source.kind === 'manual') {
        const dest = path.join(testsDir, `test${t.index}.txt`);
        await copyManualInput(t.source.inputFile, dest);
        recordGenerated(testsetName, t, null);
        continue;
      }

      const src = t.source;
      if (src.multiOutputs) {
        key = `${src.generator}|${src.args.join(' ')}|${src.multiOutputs.join(',')}`;
        if (handled.has(key)) {
          const lineError = handled.get(key) ?? null;
          recordGenerated(
            testsetName,
            t,
            lineError === null
              ? null
              : errorForIndex(lineResults.get(key), t.index, lineError)
          );
          continue;
        }
        handled.set(key, null);

        const compiledPath = compiled.get(src.generator);
        if (!compiledPath) {
          throw new Error(`Generator "${src.generator}" not compiled`);
        }
        await runGeneratorMultiOutput(compiledPath, src.args, testsDir);
        // Verify each promised file exists and rename to test<N>.txt convention.
        for (const idx of src.multiOutputs) {
          const expectedNames = [
            String(idx),
            `${idx}`,
            `test${idx}`,
            `${idx}.txt`,
            `test${idx}.txt`,
          ];
          let found: string | undefined;
          for (const candidate of expectedNames) {
            const p = path.join(testsDir, candidate);
            if (fs.existsSync(p)) {
              found = p;
              break;
            }
          }
          if (!found) {
            throw new Error(
              `Multi-output generator "${src.generator}" did not produce a ` +
                `file for index ${idx} (looked for: ${expectedNames.join(', ')})`
            );
          }
          const target = path.join(testsDir, `test${idx}.txt`);
          if (path.resolve(found) !== path.resolve(target)) {
            fs.renameSync(found, target);
          }
        }
      } else {
        const compiledPath = compiled.get(src.generator);
        if (!compiledPath) {
          throw new Error(`Generator "${src.generator}" not compiled`);
        }
        const dest = path.join(testsDir, `test${t.index}.txt`);
        await runGeneratorToFile(compiledPath, src.args, dest);
      }
      recordGenerated(testsetName, t, null);
    } catch (error) {
      if (error instanceof LimitExceededError) throw error;
      someFailed = true;
      const message = (error as Error).message;
      let testError: string | null = message;
      if (key !== null && t.source.kind === 'generator') {
        handled.set(key, message);
        // A failed multi-output line may still have written some files:
        // `ok` means "the input file was written", so judge each index by
        // whether its file exists.
        const indices = t.source.multiOutputs;
        if (indices) {
          const perIndex = new Map<number, string | null>();
          for (const idx of indices) {
            const written = fs.existsSync(
              path.join(testsDir, `test${idx}.txt`)
            );
            perIndex.set(idx, written ? null : message);
          }
          lineResults.set(key, perIndex);
          testError = errorForIndex(perIndex, t.index, message);
        }
      }
      recordGenerated(testsetName, t, testError);
      fmt.error(
        `  ${fmt.cross()} Test ${t.index} generation failed:\n\t${message}`
      );
    }
  }

  if (someFailed) {
    throw new PolymanError('Some tests failed to generate', 1);
  }
}

/**
 * Error of one index on a failed multi-output line: `null` when its file was
 * written, otherwise the per-index error (or the line's error as a fallback).
 */
function errorForIndex(
  perIndex: Map<number, string | null> | undefined,
  index: number,
  lineError: string
): string | null {
  return perIndex?.has(index) ? (perIndex.get(index) ?? null) : lineError;
}

/**
 * Records one test's generation result for `generate --json`.
 */
function recordGenerated(
  testsetName: string,
  test: ResolvedTest,
  error: string | null
): void {
  const source = test.source;
  report.recordGeneratedTest({
    testset: testsetName,
    index: test.index,
    ...(source.kind === 'manual'
      ? { source: 'manual' as const }
      : {
          source: 'generator' as const,
          generator: source.generator,
          args: [...source.args],
        }),
    ok: error === null,
    ...(error === null ? {} : { error }),
  });
}

async function copyManualInput(
  sourceFilePath: string,
  destFilePath: string
): Promise<void> {
  const sourcePath = path.resolve(process.cwd(), sourceFilePath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Manual test file not found: ${sourceFilePath}`);
  }
  await fs.promises.copyFile(sourcePath, destFilePath);
}

/**
 * Resolves and validates a testset's tests without running anything.
 * Throws on missing generator, missing manual file, or duplicate index.
 *
 * `baseDir` (defaults to cwd) is forwarded to {@link readScriptText} so
 * `scriptFile` paths resolve correctly when callers run from outside the
 * problem directory.
 */
export function resolveTestsetTests(
  testset: LocalTestset,
  generators: LocalGenerator[],
  baseDir?: string
): ResolvedTest[] {
  const lines = parseGeneratorScript(readScriptText(testset, baseDir));
  validateGeneratorReferences(lines, generators);
  const manuals = testset.manualTests ?? [];
  validateManualTests(manuals);
  return resolveTests(lines, manuals);
}
