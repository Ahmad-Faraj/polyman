import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { ReportCollector, report, stripAnsi } from '../src/report';
import { fmt } from '../src/formatter';
import type { LocalSolution, RunReport, VerifyReport } from '../src/types';

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
    writeSpy = vi.spyOn(fs, 'writeSync').mockImplementation((() => 0) as never);
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

  describe('finish', () => {
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

    it('restores the formatter on reset', () => {
      collector.startRun('main');
      collector.reset();
      expect(fmt.getOutput()).toBe('stdout');
      expect(collector.isActive()).toBe(false);
    });
  });
});
