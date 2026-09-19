/**
 * @fileoverview Machine-readable result collection for `--json` runs.
 *
 * Actions opt in with `report.startRun()` / `report.startVerify()`. From then
 * on the formatter prints human output to stderr, every `fmt.error` line is
 * captured against the current step, helpers record per-test verdicts, and
 * `report.finish()` writes exactly one JSON document to stdout. A process
 * `exit` hook guarantees the document is written even on code paths that call
 * `process.exit(1)` directly.
 */

import fs from 'fs';
import path from 'path';
import { fmt } from './formatter';
import type {
  JsonReport,
  LocalSolution,
  RunReport,
  SolutionResult,
  SolutionTag,
  StepResult,
  TestResult,
  TestVerdict,
  VerifyReport,
} from './types';

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/**
 * Removes ANSI colour codes so captured messages are plain text.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

function readPolymanVersion(): string {
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, '..', 'package.json'),
      'utf8'
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SolutionEntry {
  name: string;
  tag: SolutionTag;
  matchesTag: boolean | null;
  reason: string;
  tests: TestResult[];
}

interface ActiveReport {
  command: 'run' | 'verify';
  requestedSolution: string;
  requestedTag: SolutionTag | null;
  steps: StepResult[];
  currentStep: StepResult | null;
  failedStep: string | null;
  errors: string[];
  solutions: Map<string, SolutionEntry>;
}

/**
 * Collects step, solution, and per-test results for a JSON report.
 * Every method is a no-op until `startRun` / `startVerify` is called, so
 * helpers can record unconditionally.
 */
export class ReportCollector {
  private active: ActiveReport | null = null;
  private finished = false;
  private exitHookInstalled = false;

  /** Whether a JSON report is being collected. */
  isActive(): boolean {
    return this.active !== null && !this.finished;
  }

  /** Begin collecting a `run` report for the requested solution name. */
  startRun(solutionName: string): void {
    this.start('run', solutionName);
  }

  /** Begin collecting a `verify` report. */
  startVerify(): void {
    this.start('verify', '');
  }

  /**
   * Records which solutions a `run` matched. With exactly one match the
   * report's `tag` is that solution's tag; otherwise it is null.
   */
  setRunSolutions(solutions: LocalSolution[]): void {
    if (!this.active) return;
    for (const solution of solutions) {
      this.ensureSolution(solution);
    }
    this.active.requestedTag =
      solutions.length === 1 ? (solutions[0]?.tag ?? null) : null;
  }

  /** Marks the start of a named pipeline step. */
  beginStep(name: string): void {
    if (!this.active) return;
    const step: StepResult = { name, ok: true, errors: [] };
    this.active.steps.push(step);
    this.active.currentStep = step;
  }

  /**
   * Captures an error line against the current step. Called by the formatter
   * for every `fmt.error` while a report is active.
   */
  addError(message: string): void {
    if (!this.active) return;
    const clean = stripAnsi(message).trim();
    if (!clean) return;
    if (!this.active.errors.includes(clean)) {
      this.active.errors.push(clean);
    }
    const step = this.active.currentStep;
    if (step && !step.errors.includes(clean)) {
      step.errors.push(clean);
    }
  }

  /**
   * Marks the current step as failed with the given message. The first
   * failure decides `failedStep`.
   */
  fail(message: string): void {
    if (!this.active) return;
    this.addError(message);
    const step = this.active.currentStep;
    if (step) {
      step.ok = false;
      this.active.failedStep ??= step.name;
    }
  }

  /** Records a test executed for a solution. */
  recordTest(solution: LocalSolution, result: TestResult): void {
    if (!this.active) return;
    const entry = this.ensureSolution(solution);
    const existing = entry.tests.find(
      t => t.testset === result.testset && t.index === result.index
    );
    if (existing) {
      Object.assign(existing, result);
    } else {
      entry.tests.push({ ...result });
    }
  }

  /**
   * Updates the verdict of an already recorded test, e.g. after the checker
   * judged the output. Creates the entry if the run happened elsewhere.
   */
  updateTestVerdict(
    solution: LocalSolution,
    testset: string,
    index: number,
    verdict: TestVerdict,
    message: string
  ): void {
    if (!this.active) return;
    const entry = this.ensureSolution(solution);
    const existing = entry.tests.find(
      t => t.testset === testset && t.index === index
    );
    if (existing) {
      existing.verdict = verdict;
      existing.message = stripAnsi(message).trim();
    } else {
      entry.tests.push({
        testset,
        index,
        verdict,
        timeMs: 0,
        message: stripAnsi(message).trim(),
      });
    }
  }

  /** Records whether a solution's observed verdicts satisfy its tag. */
  setSolutionOutcome(
    solution: LocalSolution,
    matchesTag: boolean,
    reason: unknown
  ): void {
    if (!this.active) return;
    const entry = this.ensureSolution(solution);
    entry.matchesTag = matchesTag;
    entry.reason = stripAnsi(errorMessage(reason)).trim();
  }

  /**
   * Writes the JSON document to stdout exactly once. Safe to call more than
   * once; later calls are ignored.
   */
  finish(ok: boolean): void {
    if (!this.active || this.finished) return;
    this.finished = true;
    if (!ok) {
      const step = this.active.currentStep;
      if (step && this.active.failedStep === null) {
        step.ok = false;
        this.active.failedStep = step.name;
      }
    }
    const document = this.render(ok);
    fs.writeSync(process.stdout.fd, `${JSON.stringify(document, null, 2)}\n`);
  }

  /** Discards any collected state and restores the formatter (tests). */
  reset(): void {
    this.active = null;
    this.finished = false;
    fmt.setOutput('stdout');
    fmt.setErrorSink(null);
  }

  private start(command: 'run' | 'verify', requestedSolution: string): void {
    this.active = {
      command,
      requestedSolution,
      requestedTag: null,
      steps: [],
      currentStep: null,
      failedStep: null,
      errors: [],
      solutions: new Map(),
    };
    this.finished = false;
    fmt.setOutput('stderr');
    fmt.setErrorSink(message => this.addError(message));
    if (!this.exitHookInstalled) {
      this.exitHookInstalled = true;
      process.on('exit', (code: number) => {
        this.finish(code === 0);
      });
    }
  }

  private ensureSolution(solution: LocalSolution): SolutionEntry {
    const active = this.active!;
    let entry = active.solutions.get(solution.name);
    if (!entry) {
      entry = {
        name: solution.name,
        tag: solution.tag,
        matchesTag: null,
        reason: '',
        tests: [],
      };
      active.solutions.set(solution.name, entry);
    }
    return entry;
  }

  private render(ok: boolean): JsonReport {
    const active = this.active!;
    const base = {
      schemaVersion: 1 as const,
      polymanVersion: readPolymanVersion(),
      ok,
    };
    if (active.command === 'run') {
      const entries = Array.from(active.solutions.values());
      const multi = entries.length > 1;
      const tests: TestResult[] = [];
      for (const entry of entries) {
        for (const test of entry.tests) {
          tests.push(multi ? { ...test, solution: entry.name } : { ...test });
        }
      }
      const byVerdict: Partial<Record<TestVerdict, number>> = {};
      for (const test of tests) {
        byVerdict[test.verdict] = (byVerdict[test.verdict] ?? 0) + 1;
      }
      const run: RunReport = {
        ...base,
        command: 'run',
        solution: active.requestedSolution,
        tag: active.requestedTag,
        tests,
        summary: { total: tests.length, byVerdict },
        errors: ok ? [] : [...active.errors],
      };
      return run;
    }
    const solutions: SolutionResult[] = [];
    for (const entry of active.solutions.values()) {
      if (entry.matchesTag === null && entry.tests.length === 0) continue;
      solutions.push({
        name: entry.name,
        tag: entry.tag,
        matchesTag: entry.matchesTag === true,
        reason:
          entry.matchesTag === null
            ? 'Not evaluated: verification stopped before comparison'
            : entry.reason,
        tests: entry.tests.map(t => ({ ...t })),
      });
    }
    const verify: VerifyReport = {
      ...base,
      command: 'verify',
      failedStep: active.failedStep,
      steps: active.steps.map(step => ({
        name: step.name,
        ok: step.ok,
        errors: step.ok ? [] : [...step.errors],
      })),
      solutions,
    };
    return verify;
  }
}

/**
 * Singleton report collector shared by actions, steps, and helpers.
 */
export const report = new ReportCollector();
