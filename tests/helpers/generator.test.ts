import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as generator from '../../src/helpers/generator';
import { executor } from '../../src/executor';
import * as utils from '../../src/helpers/utils';
import { LimitExceededError, PolymanError } from '../../src/errors';
import fs from 'fs';
import path from 'path';
import { fmt } from '../../src/formatter';
import { report } from '../../src/report';
import type {
  LocalGenerator,
  LocalTestset,
  ResolvedTest,
} from '../../src/types';

vi.mock('../../src/executor', () => ({
  executor: {
    executeWithRedirect: vi.fn(),
    execute: vi.fn(),
    cleanup: vi.fn(),
  },
}));

vi.mock('../../src/helpers/utils', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../src/helpers/utils')>();
  return {
    ...actual,
    compileCPP: vi.fn(),
    throwError: vi.fn((err: unknown, msg: string) => {
      throw new Error(`${msg}: ${(err as Error)?.message ?? String(err)}`);
    }),
    ensureDirectoryExists: vi.fn(),
    getCompiledCommandToRun: vi
      .fn()
      .mockImplementation((g: LocalGenerator) => `./compiled/${g.name}`),
  };
});

vi.mock('../../src/formatter', () => ({
  fmt: {
    warning: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    cross: vi.fn().mockReturnValue('x'),
    bold: vi.fn().mockImplementation((s: string) => s),
  },
}));

vi.mock('fs');

// `fmt.error` as a typed mock, taken from the mocked formatter module.
const fmtError = () => vi.mocked(fmt)['error'];

beforeEach(() => {
  vi.clearAllMocks();
});

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

function exitCodeOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error instanceof PolymanError ? error.exitCode : error;
  }
  return undefined;
}

const genTest = (index: number, multi: number[] | null): ResolvedTest => ({
  index,
  source: {
    kind: 'generator',
    generator: 'gen',
    args: [],
    multiOutputs: multi,
  },
});

describe('ensureGeneratorsExist', () => {
  it('throws on undefined or empty', () => {
    expect(() => generator.ensureGeneratorsExist(undefined)).toThrow(
      /No test generators/
    );
    expect(() => generator.ensureGeneratorsExist([])).toThrow();
  });
  it('reports a missing generators config as a usage error (code 2)', () => {
    expect(exitCodeOf(() => generator.ensureGeneratorsExist(undefined))).toBe(
      2
    );
  });
  it('passes on non-empty', () => {
    expect(() =>
      generator.ensureGeneratorsExist([{ name: 'g', source: 'g.cpp' }])
    ).not.toThrow();
  });
});

describe('compileGenerator', () => {
  it('rejects generators with no source', async () => {
    await expect(
      generator.compileGenerator({ name: 'g', source: '' })
    ).rejects.toThrow(/no source file/);
  });

  it('reports a generator without a source as a usage error (code 2)', async () => {
    const error = await errorOf(
      generator.compileGenerator({ name: 'g', source: '' })
    );
    expect(error).toBeInstanceOf(PolymanError);
    expect((error as PolymanError).exitCode).toBe(2);
  });

  it('compiles via compileCPP', async () => {
    await generator.compileGenerator({ name: 'g', source: 'g.cpp' });
    expect(utils.compileCPP).toHaveBeenCalledWith('g.cpp');
  });
});

describe('compileGeneratorsForTests', () => {
  it('compiles each unique generator referenced by the resolved tests', async () => {
    const generators: LocalGenerator[] = [
      { name: 'g1', source: 'g1.cpp' },
      { name: 'g2', source: 'g2.cpp' },
      { name: 'g3', source: 'g3.cpp' },
    ];
    const tests: ResolvedTest[] = [
      {
        index: 1,
        source: {
          kind: 'generator',
          generator: 'g1',
          args: [],
          multiOutputs: null,
        },
      },
      {
        index: 2,
        source: {
          kind: 'generator',
          generator: 'g2',
          args: [],
          multiOutputs: null,
        },
      },
      {
        index: 3,
        source: {
          kind: 'generator',
          generator: 'g1',
          args: [],
          multiOutputs: null,
        },
      },
      {
        index: 4,
        source: { kind: 'manual', inputFile: 'm.in' },
      },
    ];
    const map = await generator.compileGeneratorsForTests(tests, generators);
    expect(map.size).toBe(2);
    expect(map.has('g1')).toBe(true);
    expect(map.has('g2')).toBe(true);
    expect(utils.compileCPP).toHaveBeenCalledTimes(2);
  });

  it('throws on unknown generator reference', async () => {
    const tests: ResolvedTest[] = [
      {
        index: 1,
        source: {
          kind: 'generator',
          generator: 'missing',
          args: [],
          multiOutputs: null,
        },
      },
    ];
    await expect(
      generator.compileGeneratorsForTests(tests, [])
    ).rejects.toThrow(/"missing" not found/);
    const error = await errorOf(generator.compileGeneratorsForTests(tests, []));
    expect(error).toBeInstanceOf(PolymanError);
    expect((error as PolymanError).exitCode).toBe(2);
  });
});

describe('compileGeneratorsForTestsets', () => {
  it('compiles every generator referenced across testsets', async () => {
    const generators: LocalGenerator[] = [
      { name: 'gen', source: 'gen.cpp' },
      { name: 'other', source: 'other.cpp' },
    ];
    const testsets: LocalTestset[] = [
      { name: 'a', generatorScript: { script: 'gen 1 > 1' } },
      { name: 'b', generatorScript: { script: 'other 2 > 1\ngen 3 > 2' } },
    ];
    await generator.compileGeneratorsForTestsets(testsets, generators);
    expect(utils.compileCPP).toHaveBeenCalledTimes(2);
  });

  it('refuses a scriptFile outside the problem folder', async () => {
    // compileGeneratorsForTestsets passes no baseDir, so the guard resolves
    // against the cwd.
    await expect(
      generator.compileGeneratorsForTestsets(
        [{ name: 'a', generatorScript: { scriptFile: '../x.txt' } }],
        [{ name: 'gen', source: 'gen.cpp' }]
      )
    ).rejects.toThrow(/outside the problem folder/);
    expect(utils.compileCPP).not.toHaveBeenCalled();
  });

  it('reads an in-folder scriptFile', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('gen 1 > 1');
    await generator.compileGeneratorsForTestsets(
      [{ name: 'a', generatorScript: { scriptFile: 'scripts/a.txt' } }],
      [{ name: 'gen', source: 'gen.cpp' }]
    );
    expect(utils.compileCPP).toHaveBeenCalledWith('gen.cpp');
  });

  it('throws when a script references an undefined generator', async () => {
    await expect(
      generator.compileGeneratorsForTestsets(
        [{ name: 'a', generatorScript: { script: 'unknown 1 > 1' } }],
        []
      )
    ).rejects.toThrow(/"unknown" not found/);
    const error = await errorOf(
      generator.compileGeneratorsForTestsets(
        [{ name: 'a', generatorScript: { script: 'unknown 1 > 1' } }],
        []
      )
    );
    expect((error as PolymanError).exitCode).toBe(2);
  });
});

describe('executeResolvedTests', () => {
  it('copies manual inputs to test<index>.txt', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const copyFile = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(fs, 'promises', {
      configurable: true,
      value: { copyFile },
    });
    const tests: ResolvedTest[] = [
      { index: 5, source: { kind: 'manual', inputFile: './m.in' } },
    ];
    await generator.executeResolvedTests(tests, [], '/out');
    expect(copyFile).toHaveBeenCalledWith(
      expect.stringContaining('m.in'),
      expect.stringContaining('test5.txt')
    );
  });

  it('runs single-output generators with stdout redirected to test<index>.txt', async () => {
    const executeWithRedirect = vi.mocked(
      (executor as { executeWithRedirect: typeof executor.executeWithRedirect })
        .executeWithRedirect
    );
    executeWithRedirect.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
      success: true,
    });
    const tests: ResolvedTest[] = [
      {
        index: 3,
        source: {
          kind: 'generator',
          generator: 'gen',
          args: ['7'],
          multiOutputs: null,
        },
      },
    ];
    await generator.executeResolvedTests(
      tests,
      [{ name: 'gen', source: 'gen.cpp' }],
      '/out'
    );
    const args = executeWithRedirect.mock.calls[0];
    expect(args[0]).toContain(
      process.platform === 'win32' ? 'gen "7"' : "gen '7'"
    );
    expect(args[3]).toContain('test3.txt');
  });

  it.skipIf(process.platform === 'win32')(
    'quotes generator script arguments as literal shell arguments',
    async () => {
      const executeWithRedirect = vi.mocked(
        (
          executor as {
            executeWithRedirect: typeof executor.executeWithRedirect;
          }
        ).executeWithRedirect
      );
      executeWithRedirect.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
        success: true,
      });
      const tests: ResolvedTest[] = [
        {
          index: 3,
          source: {
            kind: 'generator',
            generator: 'gen',
            args: ["O'Brien", '3)'],
            multiOutputs: null,
          },
        },
      ];

      await generator.executeResolvedTests(
        tests,
        [{ name: 'gen', source: 'gen.cpp' }],
        '/out'
      );

      const args = executeWithRedirect.mock.calls[0];
      expect(args[0]).toContain("'O'\\''Brien'");
      expect(args[0]).toContain("'3)'");
    }
  );

  it('throws when manual file is missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const tests: ResolvedTest[] = [
      { index: 1, source: { kind: 'manual', inputFile: './m.in' } },
    ];
    await expect(
      generator.executeResolvedTests(tests, [], '/out')
    ).rejects.toThrow(/Some tests failed/);
    const error = await errorOf(
      generator.executeResolvedTests(tests, [], '/out')
    );
    expect(error).toBeInstanceOf(PolymanError);
    expect((error as PolymanError).exitCode).toBe(1);
  });

  describe('limits', () => {
    const redirect = () =>
      vi.mocked(
        (
          executor as {
            executeWithRedirect: typeof executor.executeWithRedirect;
          }
        ).executeWithRedirect
      );
    const execute = () =>
      vi.mocked((executor as { execute: typeof executor.execute }).execute);
    const okResult = { stdout: '', stderr: '', exitCode: 0, success: true };

    it.each([
      ['onTimeout', /Exceeded Time Limit/, /time limit/],
      ['onMemoryExceeded', /Exceeded Memory Limit/, /memory limit/],
    ] as const)(
      'a single-output generator %s throws a PolymanError with code 1',
      async (callback, printed, message) => {
        const exitSpy = vi
          .spyOn(process, 'exit')
          .mockImplementation((() => undefined) as never);
        redirect().mockImplementation((_cmd, options) => {
          options[callback]?.(okResult);
          return Promise.resolve(okResult);
        });

        const error = await errorOf(
          generator.executeResolvedTests(
            [genTest(1, null)],
            [{ name: 'gen', source: 'gen.cpp' }],
            '/out'
          )
        );

        expect(error).toBeInstanceOf(LimitExceededError);
        expect((error as PolymanError).exitCode).toBe(1);
        expect((error as PolymanError).message).toMatch(message);
        expect(fmtError()).toHaveBeenCalledWith(expect.stringMatching(printed));
        expect(vi.mocked(executor)['cleanup']).toHaveBeenCalled();
        expect(exitSpy).not.toHaveBeenCalled();
        exitSpy.mockRestore();
      }
    );

    it.each(['onTimeout', 'onMemoryExceeded'] as const)(
      'a multi-output generator %s throws a PolymanError with code 1',
      async callback => {
        const exitSpy = vi
          .spyOn(process, 'exit')
          .mockImplementation((() => undefined) as never);
        execute().mockImplementation((_cmd, options) => {
          options[callback]?.(okResult);
          return Promise.resolve(okResult);
        });

        const error = await errorOf(
          generator.executeResolvedTests(
            [genTest(1, [1, 2])],
            [{ name: 'gen', source: 'gen.cpp' }],
            '/out'
          )
        );

        expect(error).toBeInstanceOf(LimitExceededError);
        expect((error as PolymanError).exitCode).toBe(1);
        expect(exitSpy).not.toHaveBeenCalled();
        exitSpy.mockRestore();
      }
    );

    it('stops at the first limit hit instead of counting it as a failed test', async () => {
      redirect().mockImplementation((_cmd, options) => {
        options.onTimeout?.(okResult);
        return Promise.resolve(okResult);
      });

      const error = await errorOf(
        generator.executeResolvedTests(
          [genTest(1, null), genTest(2, null)],
          [{ name: 'gen', source: 'gen.cpp' }],
          '/out'
        )
      );

      expect(error).toBeInstanceOf(LimitExceededError);
      expect(redirect()).toHaveBeenCalledTimes(1);
    });
  });
});

describe('executeResolvedTests records each test for generate --json', () => {
  const okResult = { stdout: '', stderr: '', exitCode: 0, success: true };
  const gens: LocalGenerator[] = [{ name: 'gen', source: 'gen.cpp' }];
  const redirect = () =>
    vi.mocked(
      (executor as { executeWithRedirect: typeof executor.executeWithRedirect })
        .executeWithRedirect
    );
  const execute = () =>
    vi.mocked((executor as { execute: typeof executor.execute }).execute);
  let recordSpy: ReturnType<
    typeof vi.spyOn<typeof report, 'recordGeneratedTest'>
  >;
  const recorded = () => recordSpy.mock.calls.map(call => call[0]);

  beforeEach(() => {
    recordSpy = vi
      .spyOn(report, 'recordGeneratedTest')
      .mockImplementation(() => {});
    Object.defineProperty(fs, 'promises', {
      configurable: true,
      value: { copyFile: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => {
    recordSpy.mockRestore();
  });

  it('records manual and generated tests with their source', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    redirect().mockResolvedValue(okResult);
    const tests: ResolvedTest[] = [
      { index: 1, source: { kind: 'manual', inputFile: './m.in' } },
      {
        index: 2,
        source: {
          kind: 'generator',
          generator: 'gen',
          args: ['5', 'x'],
          multiOutputs: null,
        },
      },
    ];

    await generator.executeResolvedTests(tests, gens, '/out/x', 'main');

    expect(recorded()).toEqual([
      { testset: 'main', index: 1, source: 'manual', ok: true },
      {
        testset: 'main',
        index: 2,
        source: 'generator',
        generator: 'gen',
        args: ['5', 'x'],
        ok: true,
      },
    ]);
  });

  it('uses the output directory name when no testset name is given', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    await generator.executeResolvedTests(
      [{ index: 1, source: { kind: 'manual', inputFile: './m.in' } }],
      [],
      path.join('/p', 'testsets', 'tests')
    );
    expect(recorded()[0]).toMatchObject({ testset: 'tests', index: 1 });
  });

  it('records failed tests with the error and keeps going', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    redirect().mockRejectedValueOnce(new Error('generator crashed'));
    const tests: ResolvedTest[] = [
      { index: 1, source: { kind: 'manual', inputFile: './m.in' } },
      genTest(2, null),
    ];

    await expect(
      generator.executeResolvedTests(tests, gens, '/out', 'main')
    ).rejects.toThrow(/Some tests failed/);

    expect(recorded()).toEqual([
      {
        testset: 'main',
        index: 1,
        source: 'manual',
        ok: false,
        error: 'Manual test file not found: ./m.in',
      },
      {
        testset: 'main',
        index: 2,
        source: 'generator',
        generator: 'gen',
        args: [],
        ok: false,
        error: 'generator crashed',
      },
    ]);
  });

  it('records every test of a multi-output line that ran once', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    execute().mockResolvedValue(okResult);

    await generator.executeResolvedTests(
      [genTest(1, [1, 2]), genTest(2, [1, 2])],
      gens,
      '/out',
      'main'
    );

    expect(execute()).toHaveBeenCalledTimes(1);
    expect(recorded().map(t => [t.index, t.ok])).toEqual([
      [1, true],
      [2, true],
    ]);
  });

  it('gives every test of a failed multi-output line the same error', async () => {
    execute().mockRejectedValueOnce(new Error('bad line'));

    await expect(
      generator.executeResolvedTests(
        [genTest(1, [1, 2]), genTest(2, [1, 2])],
        gens,
        '/out',
        'main'
      )
    ).rejects.toThrow(/Some tests failed/);

    expect(execute()).toHaveBeenCalledTimes(1);
    expect(recorded().map(t => [t.index, t.ok, t.error])).toEqual([
      [1, false, 'bad line'],
      [2, false, 'bad line'],
    ]);
  });
});

describe('resolveTestsetTests', () => {
  it('parses, validates, and resolves into indexed tests', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const ts: LocalTestset = {
      name: 'main',
      generatorScript: { script: 'gen 1 > 2\ngen 2 > $' },
      manualTests: [{ input: './m.in', index: 1 }],
    };
    const result = generator.resolveTestsetTests(ts, [
      { name: 'gen', source: 'gen.cpp' },
    ]);
    expect(result.map(t => t.index)).toEqual([1, 2, 3]);
    expect(result[0].source.kind).toBe('manual');
  });

  it('refuses a scriptFile outside the problem folder', () => {
    const ts: LocalTestset = {
      name: 'main',
      generatorScript: { scriptFile: '../x.txt' },
    };
    expect(() =>
      generator.resolveTestsetTests(
        ts,
        [{ name: 'gen', source: 'gen.cpp' }],
        '/problem'
      )
    ).toThrow(/outside the problem folder/);
  });

  it('resolves an in-folder scriptFile against baseDir', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('gen 1 > 1');
    const ts: LocalTestset = {
      name: 'main',
      generatorScript: { scriptFile: 'scripts/a.txt' },
    };
    const result = generator.resolveTestsetTests(
      ts,
      [{ name: 'gen', source: 'gen.cpp' }],
      '/problem'
    );
    expect(result.map(t => t.index)).toEqual([1]);
    expect(fs.readFileSync).toHaveBeenCalledWith(
      path.resolve('/problem', 'scripts/a.txt'),
      'utf-8'
    );
  });

  it('throws when the script references an undefined generator', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const ts: LocalTestset = {
      name: 'main',
      generatorScript: { script: 'bogus 1 > 1' },
    };
    expect(() => generator.resolveTestsetTests(ts, [])).toThrow(
      /"bogus".*not found/s
    );
  });
});
