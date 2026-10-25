import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { ReportCollector, report, stripAnsi } from '../src/report';
import { fmt } from '../src/formatter';
import type {
  GenerateReport,
  LocalSolution,
  RunReport,
  SelfTestReport,
  SolutionTestReport,
  ValidateReport,
  VerifyReport,
} from '../src/types';

const main: LocalSolution = {
  name: 'main',
  source: 'solutions/main.cpp',
  tag: 'MA',
  sourceType: 'cpp.g++17',
};
const wa: LocalSolution = {
  name: 'wa',
  source: 'solutions/wa.cpp',
  tag: 'WA',
  sourceType: 'cpp.g++17',
};

describe('report.ts', () => {
  let writeSpy: ReturnType<typeof vi.spyOn<typeof fs, 'writeSync'>>;
  let collector: ReportCollector;

  const written = (): unknown => {
    expect(writeSpy).toHaveBeenCalledTimes(1);
    const text = String(writeSpy.mock.calls[0][1]);
    return JSON.parse(text);
  };

  beforeEach(() => {
    writeSpy = vi.spyOn(fs, 'writeSync').mockImplementation(() => 0);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    collector = new ReportCollector();
  });

  afterEach(() => {
    collector.reset();
    report.reset();
    vi.restoreAllMocks();
  });

  describe('stripAnsi', () => {
    it('removes colour codes', () => {
      expect(stripAnsi('\u001b[31mred\u001b[39m plain')).toBe('red plain');
    });
  });

  describe('when inactive', () => {
    it('ignores every recording call and writes nothing', () => {
      collector.beginStep('x');
      collector.recordTest(main, {
        testset: 'tests',
        index: 1,
        verdict: 'OK',
        timeMs: 1,
        message: '',
      });
      collector.fail('boom');
      collector.finish(false);
      expect(collector.isActive()).toBe(false);
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe('run report', () => {
    it('routes human output to stderr while active', () => {
      collector.startRun('main');
      expect(fmt.getOutput()).toBe('stderr');
      fmt.info('hello');
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('hello')
      );
      expect(console.log).not.toHaveBeenCalled();
    });

    it('renders tests, tag, and summary for a single solution', () => {
      collector.startRun('main');
      collector.setRunSolutions([main]);
      collector.beginStep('run-solutions');
      collector.recordTest(main, {
        testset: 'tests',
        index: 1,
        verdict: 'OK',
        timeMs: 12,
        message: '',
      });
      collector.recordTest(main, {
        testset: 'tests',
        index: 2,
        verdict: 'TLE',
        timeMs: 1000,
        message: 'Time Limit Exceeded after 1000ms',
      });
      collector.finish(true);

      const doc = written() as RunReport;
      expect(doc.schemaVersion).toBe(1);
      expect(typeof doc.polymanVersion).toBe('string');
      expect(doc.command).toBe('run');
      expect(doc.ok).toBe(true);
      expect(doc.solution).toBe('main');
      expect(doc.tag).toBe('MA');
      expect(doc.tests).toEqual([
        { testset: 'tests', index: 1, verdict: 'OK', timeMs: 12, message: '' },
        {
          testset: 'tests',
          index: 2,
          verdict: 'TLE',
          timeMs: 1000,
          message: 'Time Limit Exceeded after 1000ms',
        },
      ]);
      expect(doc.summary).toEqual({ total: 2, byVerdict: { OK: 1, TLE: 1 } });
      expect(doc.errors).toEqual([]);
    });

    it('labels tests with the solution name when several solutions ran', () => {
      collector.startRun('all');
      collector.setRunSolutions([main, wa]);
      collector.recordTest(main, {
        testset: 'tests',
        index: 1,
        verdict: 'OK',
        timeMs: 1,
        message: '',
      });
      collector.recordTest(wa, {
        testset: 'tests',
        index: 1,
        verdict: 'RTE',
        timeMs: 2,
        message: 'Runtime Error: x',
      });
      collector.finish(true);

      const doc = written() as RunReport;
      expect(doc.tag).toBeNull();
      expect(doc.tests.map(t => t.solution)).toEqual(['main', 'wa']);
    });

    it('keeps captured error lines when the command fails', () => {
      collector.startRun('main');
      collector.beginStep('compile-solutions');
      fmt.error('\u001b[31m  ✖ g++: error: missing ;\u001b[39m');
      collector.fail('Compilation failed');
      collector.finish(false);

      const doc = written() as RunReport;
      expect(doc.ok).toBe(false);
      expect(doc.errors).toEqual([
        '✖ g++: error: missing ;',
        'Compilation failed',
      ]);
    });

    it('replaces an earlier result for the same test', () => {
      collector.startRun('main');
      collector.recordTest(main, {
        testset: 'tests',
        index: 3,
        verdict: 'OK',
        timeMs: 5,
        message: '',
      });
      collector.updateTestVerdict(main, 'tests', 3, 'WA', 'wrong answer');
      collector.finish(true);
      const doc = written() as RunReport;
      expect(doc.tests).toHaveLength(1);
      expect(doc.tests[0]).toMatchObject({
        verdict: 'WA',
        message: 'wrong answer',
      });
    });

    it('creates a test entry when updating an unknown test', () => {
      collector.startRun('main');
      collector.updateTestVerdict(main, 'tests', 9, 'WA', 'bad');
      collector.finish(true);
      const doc = written() as RunReport;
      expect(doc.tests).toEqual([
        {
          testset: 'tests',
          index: 9,
          verdict: 'WA',
          timeMs: 0,
          message: 'bad',
        },
      ]);
    });
  });

  describe('verify report', () => {
    it('carries warnings, empty by default, without failing the step', () => {
      collector.startVerify();
      collector.beginStep('test-validator');
      collector.addWarning('\u001b[33mno INVALID self-tests\u001b[0m');
      collector.addWarning('no INVALID self-tests');
      collector.finish(true);
      const doc = written() as VerifyReport;
      expect(doc.ok).toBe(true);
      expect(doc.warnings).toEqual(['no INVALID self-tests']);
      expect(doc.steps).toEqual([
        { name: 'test-validator', ok: true, errors: [] },
      ]);

      collector.reset();
      writeSpy.mockClear();
      collector.startVerify();
      collector.beginStep('test-validator');
      collector.finish(true);
      expect((written() as VerifyReport).warnings).toEqual([]);
    });

    it('renders steps and solutions on success', () => {
      collector.startVerify();
      collector.beginStep('compile-generators');
      collector.beginStep('run-solutions');
      collector.recordTest(main, {
        testset: 'tests',
        index: 1,
        verdict: 'OK',
        timeMs: 3,
        message: '',
      });
      collector.recordTest(wa, {
        testset: 'tests',
        index: 1,
        verdict: 'OK',
        timeMs: 4,
        message: '',
      });
      collector.setSolutionOutcome(
        main,
        true,
        'Main solution ran on every test'
      );
      collector.beginStep('verify-solutions');
      collector.updateTestVerdict(wa, 'tests', 1, 'WA', 'expected 3 found 4');
      collector.setSolutionOutcome(wa, true, 'Behaves as expected');
      collector.finish(true);

      const doc = written() as VerifyReport;
      expect(doc.command).toBe('verify');
      expect(doc.ok).toBe(true);
      expect(doc.failedStep).toBeNull();
      expect(doc.steps).toEqual([
        { name: 'compile-generators', ok: true, errors: [] },
        { name: 'run-solutions', ok: true, errors: [] },
        { name: 'verify-solutions', ok: true, errors: [] },
      ]);
      expect(doc.solutions).toEqual([
        {
          name: 'main',
          tag: 'MA',
          matchesTag: true,
          reason: 'Main solution ran on every test',
          tests: [
            {
              testset: 'tests',
              index: 1,
              verdict: 'OK',
              timeMs: 3,
              message: '',
            },
          ],
        },
        {
          name: 'wa',
          tag: 'WA',
          matchesTag: true,
          reason: 'Behaves as expected',
          tests: [
            {
              testset: 'tests',
              index: 1,
              verdict: 'WA',
              timeMs: 4,
              message: 'expected 3 found 4',
            },
          ],
        },
      ]);
    });

    it('records the failing step and its error lines on an early abort', () => {
      collector.startVerify();
      collector.beginStep('compile-generators');
      collector.beginStep('test-validator');
      fmt.error('  ✖ Validator Test 1 failed: Expected EOLN');
      collector.fail('Some validator tests failed');
      collector.finish(false);

      const doc = written() as VerifyReport;
      expect(doc.ok).toBe(false);
      expect(doc.failedStep).toBe('test-validator');
      expect(doc.steps).toEqual([
        { name: 'compile-generators', ok: true, errors: [] },
        {
          name: 'test-validator',
          ok: false,
          errors: [
            '✖ Validator Test 1 failed: Expected EOLN',
            'Some validator tests failed',
          ],
        },
      ]);
      expect(doc.solutions).toEqual([]);
    });

    it('marks the current step failed when finished with ok=false', () => {
      collector.startVerify();
      collector.beginStep('validate-tests');
      fmt.error('✖ Test tests/test2.txt failed validation');
      collector.finish(false);
      const doc = written() as VerifyReport;
      expect(doc.failedStep).toBe('validate-tests');
      expect(doc.steps[0].ok).toBe(false);
      expect(doc.steps[0].errors).toEqual([
        '✖ Test tests/test2.txt failed validation',
      ]);
    });

    it('reports a solution that ran but was never compared as not matching', () => {
      collector.startVerify();
      collector.beginStep('run-solutions');
      collector.recordTest(main, {
        testset: 'tests',
        index: 1,
        verdict: 'TLE',
        timeMs: 1000,
        message: 'Time Limit Exceeded after 1000ms',
      });
      collector.setSolutionOutcome(main, false, new Error('Main timed out'));
      collector.recordTest(wa, {
        testset: 'tests',
        index: 1,
        verdict: 'OK',
        timeMs: 1,
        message: '',
      });
      collector.fail('Main timed out');
      collector.finish(false);
      const doc = written() as VerifyReport;
      expect(doc.solutions).toEqual([
        expect.objectContaining({
          name: 'main',
          matchesTag: false,
          reason: 'Main timed out',
        }),
        expect.objectContaining({
          name: 'wa',
          matchesTag: false,
          reason: 'Not evaluated: verification stopped before comparison',
        }),
      ]);
    });

    it('strips ANSI codes from outcome reasons', () => {
      collector.startVerify();
      collector.setSolutionOutcome(
        wa,
        false,
        'Solution \u001b[1m\u001b[34mwa\u001b[39m\u001b[22m marked as WA but passed'
      );
      collector.finish(false);
      const doc = written() as VerifyReport;
      expect(doc.solutions[0].reason).toBe(
        'Solution wa marked as WA but passed'
      );
    });
  });

  describe('simple command reports', () => {
    it('renders a path report with the issue fields', () => {
      collector.startPath('new');
      collector.setPath('/tmp/prob');
      collector.finish(true);
      expect(written()).toMatchObject({
        schemaVersion: 1,
        command: 'new',
        ok: true,
        exitCode: 0,
        errors: [],
        path: '/tmp/prob',
      });
      const doc = written() as { durationMs: number; polymanVersion: string };
      expect(doc.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof doc.polymanVersion).toBe('string');
    });

    it('renders a list report', () => {
      collector.startList('list generators');
      collector.setItems([{ name: 'gen', source: 'gen.cpp' }]);
      collector.finish(true);
      expect(written()).toMatchObject({
        command: 'list generators',
        ok: true,
        exitCode: 0,
        items: [{ name: 'gen', source: 'gen.cpp' }],
      });
    });

    it('renders a failure with exitCode 1 and plain-text errors', () => {
      collector.startList('list solutions');
      collector.fail('\u001b[31mbroken\u001b[39m');
      collector.finish(false);
      expect(written()).toMatchObject({
        ok: false,
        exitCode: 1,
        errors: ['broken'],
        items: [],
      });
    });

    it('renders the exit code it is given for a failure', () => {
      collector.startList('list solutions');
      collector.fail('Config.json is not valid JSON');
      collector.finish(false, 2);
      expect(written()).toMatchObject({ ok: false, exitCode: 2 });
    });

    it('ignores setPath and setItems for other reports', () => {
      collector.startVerify();
      collector.setPath('/x');
      collector.setItems([1]);
      collector.finish(true);
      expect(written()).toMatchObject({ command: 'verify' });
      expect(written()).not.toHaveProperty('path');
    });
  });

  describe('generate report', () => {
    it('lists every test with its source and result', () => {
      collector.startGenerate();
      expect(fmt.getOutput()).toBe('stderr');
      collector.recordGeneratedTest({
        testset: 'tests',
        index: 1,
        source: 'manual',
        ok: true,
      });
      collector.recordGeneratedTest({
        testset: 'tests',
        index: 2,
        source: 'generator',
        generator: 'gen',
        args: ['5'],
        ok: true,
      });
      collector.finish(true);
      const doc = written() as GenerateReport;
      expect(doc).toMatchObject({
        schemaVersion: 1,
        command: 'generate',
        ok: true,
        exitCode: 0,
        errors: [],
        tests: [
          { testset: 'tests', index: 1, source: 'manual', ok: true },
          {
            testset: 'tests',
            index: 2,
            source: 'generator',
            generator: 'gen',
            args: ['5'],
            ok: true,
          },
        ],
      });
      expect(typeof doc.durationMs).toBe('number');
      expect(doc.tests[0]).not.toHaveProperty('error');
    });

    it('keeps a failed test with a plain-text error and the exit code', () => {
      collector.startGenerate();
      collector.recordGeneratedTest({
        testset: 'tests',
        index: 3,
        source: 'generator',
        generator: 'gen',
        args: [],
        ok: false,
        error: '\u001b[31mcrashed\u001b[39m',
      });
      collector.fail('Some tests failed to generate');
      collector.finish(false, 1);
      expect(written()).toMatchObject({
        ok: false,
        exitCode: 1,
        errors: ['Some tests failed to generate'],
        tests: [{ index: 3, ok: false, error: 'crashed' }],
      });
    });

    it('lists a test generated twice once, with its last result', () => {
      collector.startGenerate();
      collector.recordGeneratedTest({
        testset: 'tests',
        index: 1,
        source: 'manual',
        ok: false,
        error: 'missing',
      });
      collector.recordGeneratedTest({
        testset: 'tests',
        index: 1,
        source: 'manual',
        ok: true,
      });
      collector.finish(true);
      expect((written() as GenerateReport).tests).toEqual([
        { testset: 'tests', index: 1, source: 'manual', ok: true },
      ]);
    });
  });

  describe('validate report', () => {
    it('lists every test with valid or invalid and the message', () => {
      collector.startValidate();
      collector.recordValidatedTest({
        testset: 'tests',
        group: 'samples',
        index: 1,
        valid: true,
        message: '',
      });
      collector.recordValidatedTest({
        testset: 'tests',
        group: 'samples',
        index: 2,
        valid: false,
        message: 'FAIL Integer 0 violates the range [1, 10]\n',
      });
      collector.fail('Some tests in group samples failed validation');
      collector.finish(false);
      const doc = written() as ValidateReport;
      expect(doc).toMatchObject({
        command: 'validate',
        ok: false,
        exitCode: 1,
        tests: [
          {
            testset: 'tests',
            group: 'samples',
            index: 1,
            valid: true,
            message: '',
          },
          {
            testset: 'tests',
            group: 'samples',
            index: 2,
            valid: false,
            message: 'FAIL Integer 0 violates the range [1, 10]',
          },
        ],
      });
    });

    it('uses the exit code passed to finish', () => {
      collector.startValidate();
      collector.fail('No validator defined in the configuration file.');
      collector.finish(false, 2);
      expect(written()).toMatchObject({
        ok: false,
        exitCode: 2,
        tests: [],
      });
    });
  });

  describe('per-test records for generate and validate', () => {
    it('are ignored by other reports, so verify does not collect them', () => {
      collector.startVerify();
      collector.recordGeneratedTest({
        testset: 'tests',
        index: 1,
        source: 'manual',
        ok: true,
      });
      collector.recordValidatedTest({
        testset: 'tests',
        index: 1,
        valid: true,
        message: '',
      });
      collector.finish(true);
      expect(written()).not.toHaveProperty('tests');
    });

    it('are ignored by a validate report when they are generate records', () => {
      collector.startValidate();
      collector.recordGeneratedTest({
        testset: 'tests',
        index: 1,
        source: 'manual',
        ok: true,
      });
      collector.finish(true);
      expect((written() as ValidateReport).tests).toEqual([]);
    });

    it('are ignored when no report is active', () => {
      collector.recordGeneratedTest({
        testset: 'tests',
        index: 1,
        source: 'manual',
        ok: true,
      });
      collector.recordValidatedTest({
        testset: 'tests',
        index: 1,
        valid: true,
        message: '',
      });
      collector.finish(true);
      expect(writeSpy).not.toHaveBeenCalled();
    });
  });

  describe('self-test report', () => {
    it('renders each case with expected, actual and message', () => {
      collector.startSelfTest('validator');
      collector.recordSelfTestCase({
        index: 1,
        expected: 'VALID',
        actual: 'VALID',
        ok: true,
        message: '',
      });
      collector.recordSelfTestCase({
        index: 2,
        expected: 'INVALID',
        actual: 'VALID',
        ok: false,
        message: '\u001b[31mValidator did not detect invalid test\u001b[39m',
      });
      fmt.error('Some validator tests failed');
      collector.finish(false);

      const doc = written() as SelfTestReport;
      expect(doc).toMatchObject({
        schemaVersion: 1,
        command: 'test validator',
        ok: false,
        exitCode: 1,
        target: 'validator',
        errors: ['Some validator tests failed'],
      });
      expect(doc.cases).toEqual([
        { index: 1, expected: 'VALID', actual: 'VALID', ok: true, message: '' },
        {
          index: 2,
          expected: 'INVALID',
          actual: 'VALID',
          ok: false,
          message: 'Validator did not detect invalid test',
        },
      ]);
      expect(doc.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('renders an empty case list when nothing ran', () => {
      collector.startSelfTest('checker');
      collector.finish(true);
      expect(written()).toMatchObject({
        command: 'test checker',
        ok: true,
        exitCode: 0,
        target: 'checker',
        cases: [],
        errors: [],
      });
    });

    it('uses the exit code passed to finish', () => {
      collector.startSelfTest('checker');
      collector.fail('No checker defined in the configuration file.');
      collector.finish(false, 2);
      expect(written()).toMatchObject({ ok: false, exitCode: 2 });
    });

    it('ignores self-test cases for other reports', () => {
      collector.startVerify();
      collector.recordSelfTestCase({
        index: 1,
        expected: 'OK',
        actual: 'OK',
        ok: true,
        message: '',
      });
      collector.finish(true);
      expect(written()).not.toHaveProperty('cases');
    });
  });

  describe('solution test report', () => {
    it('renders only the target tests, the main solution and the outcome', () => {
      collector.startSolutionTest('wa');
      collector.setSolutionTest(main, wa);
      collector.recordTest(main, {
        testset: 'tests',
        index: 1,
        verdict: 'OK',
        timeMs: 3,
        message: '',
      });
      collector.recordTest(wa, {
        testset: 'tests',
        index: 1,
        verdict: 'OK',
        timeMs: 4,
        message: '',
      });
      collector.updateTestVerdict(wa, 'tests', 1, 'WA', 'wrong answer 1st');
      collector.setSolutionOutcome(wa, true, 'Behaves as expected');
      collector.finish(true);

      const doc = written() as SolutionTestReport;
      expect(doc).toMatchObject({
        schemaVersion: 1,
        command: 'test',
        ok: true,
        exitCode: 0,
        solution: 'wa',
        tag: 'WA',
        mainSolution: 'main',
        matchesTag: true,
        reason: 'Behaves as expected',
        errors: [],
      });
      expect(doc.tests).toEqual([
        {
          testset: 'tests',
          index: 1,
          verdict: 'WA',
          timeMs: 4,
          message: 'wrong answer 1st',
        },
      ]);
      expect(doc.summary).toEqual({ total: 1, byVerdict: { WA: 1 } });
    });

    it('reports a tag mismatch with its reason', () => {
      collector.startSolutionTest('wa');
      collector.setSolutionTest(main, wa);
      collector.setSolutionOutcome(
        wa,
        false,
        new Error('Solution wa marked as WA but did not get Wrong Answer')
      );
      collector.fail('Solution wa marked as WA but did not get Wrong Answer');
      collector.finish(false);

      expect(written()).toMatchObject({
        ok: false,
        exitCode: 1,
        matchesTag: false,
        reason: 'Solution wa marked as WA but did not get Wrong Answer',
        errors: ['Solution wa marked as WA but did not get Wrong Answer'],
      });
    });

    it('says the solution was not evaluated when the test stopped early', () => {
      collector.startSolutionTest('nope');
      collector.fail('No solution named "nope" found.');
      collector.finish(false);

      expect(written()).toMatchObject({
        command: 'test',
        solution: 'nope',
        tag: null,
        mainSolution: null,
        matchesTag: false,
        reason: 'Not evaluated: the test stopped before comparison',
        tests: [],
        summary: { total: 0, byVerdict: {} },
      });
    });

    it('ignores setSolutionTest for other reports', () => {
      collector.startRun('wa');
      collector.setSolutionTest(main, wa);
      collector.finish(true);
      expect(written()).not.toHaveProperty('mainSolution');
      expect(written()).toMatchObject({ tag: null });
    });
  });

  describe('remote reports', () => {
    it('renders problemId and actions with the base fields', () => {
      collector.startRemote('remote push');
      collector.setProblemId(42);
      collector.addAction({
        component: 'solution',
        name: 'main',
        action: 'upload',
        ok: true,
      });
      collector.addAction({
        component: 'solution',
        name: 'wa',
        action: 'upload',
        ok: false,
        error: '\u001b[31mrejected\u001b[39m',
      });
      collector.finish(true);
      expect(written()).toMatchObject({
        schemaVersion: 1,
        command: 'remote push',
        ok: true,
        exitCode: 0,
        errors: [],
        problemId: 42,
        actions: [
          { component: 'solution', name: 'main', action: 'upload', ok: true },
          {
            component: 'solution',
            name: 'wa',
            action: 'upload',
            ok: false,
            error: 'rejected',
          },
        ],
      });
      const doc = written() as { actions: object[] };
      expect(doc.actions[0]).not.toHaveProperty('error');
    });

    it('keeps problemId null until it is known', () => {
      collector.startRemote('remote commit');
      collector.fail('API key not found');
      collector.finish(false);
      expect(written()).toMatchObject({
        ok: false,
        exitCode: 1,
        problemId: null,
        actions: [],
        errors: ['API key not found'],
      });
    });

    it('replaces the API key and secret in errors and actions', () => {
      collector.startRemote('remote push');
      collector.setSecrets(['KEY123', 'SECRET456']);
      collector.addAction({
        component: 'solution',
        name: 'main',
        action: 'upload',
        ok: false,
        error: 'bad apiKey=KEY123',
      });
      collector.fail('signature SECRET456 and KEY123');
      collector.finish(false);
      const text = String(writeSpy.mock.calls[0][1]);
      expect(text).not.toContain('KEY123');
      expect(text).not.toContain('SECRET456');
      expect(written()).toMatchObject({
        errors: ['signature [REDACTED] and [REDACTED]'],
        actions: [{ error: 'bad apiKey=[REDACTED]' }],
      });
    });

    it('lists warnings, with secrets replaced, also when ok is true', () => {
      collector.startRemote('remote pull');
      collector.setSecrets(['KEY123']);
      collector.addWarning('\u001b[33mcould not fetch KEY123\u001b[39m');
      collector.finish(true);
      expect(written()).toMatchObject({
        ok: true,
        errors: [],
        warnings: ['could not fetch [REDACTED]'],
      });
    });

    it('does not capture fmt.error lines, only reported errors', () => {
      collector.startRemote('remote push');
      fmt.error('  2 item(s) failed to upload:');
      collector.addError('solution wa: rejected');
      collector.finish(false);
      expect(written()).toMatchObject({ errors: ['solution wa: rejected'] });
    });

    it('ignores addAction and setProblemId for other reports', () => {
      collector.startPath('new');
      collector.setProblemId(1);
      collector.addAction({ component: 'x', name: 'y', action: 'z', ok: true });
      collector.finish(true);
      expect(written()).not.toHaveProperty('actions');
      expect(written()).not.toHaveProperty('problemId');
    });

    it('uses the exit code passed to finish', () => {
      collector.startRemote('remote push');
      collector.finish(false, 2);
      expect(written()).toMatchObject({ ok: false, exitCode: 2 });
    });

    it('takes the exit code from the process exit hook', () => {
      const onSpy = vi.spyOn(process, 'on');
      collector.startRemote('remote pull');
      const exitCall = onSpy.mock.calls.find(call => call[0] === 'exit');
      const handler = exitCall![1] as (code: number) => void;
      handler(4);
      expect(written()).toMatchObject({ ok: false, exitCode: 4 });
    });
  });

  describe('finish', () => {
    it('writes the process exit code from the exit hook', () => {
      const onSpy = vi.spyOn(process, 'on');
      collector.startSelfTest('validator');
      const exitCall = onSpy.mock.calls.find(call => call[0] === 'exit');
      const handler = exitCall![1] as (code: number) => void;
      handler(3);
      expect(written()).toMatchObject({ ok: false, exitCode: 3 });
    });

    it('writes exactly once even if called twice', () => {
      collector.startVerify();
      collector.finish(true);
      collector.finish(false);
      expect(writeSpy).toHaveBeenCalledTimes(1);
      expect(collector.isActive()).toBe(false);
    });

    it('is triggered by the process exit hook when not finished', () => {
      const onSpy = vi.spyOn(process, 'on');
      collector.startVerify();
      const exitCall = onSpy.mock.calls.find(call => call[0] === 'exit');
      expect(exitCall).toBeDefined();
      const handler = exitCall![1] as (code: number) => void;
      handler(1);
      const doc = written() as VerifyReport;
      expect(doc.ok).toBe(false);
    });

    it('reports the code the process exits with from the exit hook', () => {
      const onSpy = vi.spyOn(process, 'on');
      collector.startList('list solutions');
      const exitCall = onSpy.mock.calls.find(call => call[0] === 'exit');
      const handler = exitCall![1] as (code: number) => void;
      handler(130);
      expect(written()).toMatchObject({ ok: false, exitCode: 130 });
    });

    it('reports the real exit code from the process exit hook', () => {
      const onSpy = vi.spyOn(process, 'on');
      collector.startGenerate();
      const exitCall = onSpy.mock.calls.find(call => call[0] === 'exit');
      const handler = exitCall![1] as (code: number) => void;
      handler(3);
      expect(written()).toMatchObject({ ok: false, exitCode: 3 });
    });

    it('restores the formatter on reset', () => {
      collector.startRun('main');
      collector.reset();
      expect(fmt.getOutput()).toBe('stdout');
      expect(collector.isActive()).toBe(false);
    });
  });
});
