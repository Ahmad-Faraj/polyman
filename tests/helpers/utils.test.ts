/* eslint-disable @typescript-eslint/unbound-method */
import type { ReadStream } from 'fs';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { executor } from '../../src/executor';
import { fmt } from '../../src/formatter';
import { cachedCompile } from '../../src/helpers/compile-cache';
import {
  findPrebuiltTestlib,
  markPrebuiltTestlibUnsupported,
} from '../../src/helpers/prebuilt-testlib';
import { findPch, markPchUnsupported } from '../../src/helpers/pch';
import { quoteShellArgument } from '../../src/helpers/shell';
import * as utils from '../../src/helpers/utils';
import { PolymanError } from '../../src/errors';
import type ConfigFile from '../../src/types';
import type {
  LocalChecker,
  LocalGenerator,
  LocalSolution,
  LocalValidator,
} from '../../src/types';

// Manual mock for fs
vi.mock('fs', () => {
  return {
    default: {
      existsSync: vi.fn(),
      rmSync: vi.fn(),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
      readFileSync: vi.fn(),
      createReadStream: vi.fn(),
    },
  };
});

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawnSync: vi.fn() };
});
vi.mock('../../src/executor');
vi.mock('../../src/formatter');
// Pass-through: compile-cache.test.ts covers the cache itself.
vi.mock('../../src/helpers/compile-cache', () => ({
  cachedCompile: vi.fn(
    async (_request: unknown, compile: () => Promise<unknown>) => {
      await compile();
    }
  ),
  debugLog: vi.fn(),
}));
// No PCH unless a test provides one; pch.test.ts covers building it.
vi.mock('../../src/helpers/pch', () => ({
  findPch: vi.fn(() => Promise.resolve(null)),
  markPchUnsupported: vi.fn(),
}));
// No prebuilt testlib unless a test provides one; prebuilt-testlib.test.ts
// covers building it.
vi.mock('../../src/helpers/prebuilt-testlib', () => ({
  findPrebuiltTestlib: vi.fn(() => Promise.resolve(null)),
  markPrebuiltTestlibUnsupported: vi.fn(),
}));

// Nothing in utils may exit the process: fail loudly if something does
vi.spyOn(process, 'exit').mockImplementation(
  (_code?: string | number | null) => {
    throw new Error('process.exit called');
  }
);

/** Runs `fn`, which must throw, and returns what it threw. */
const thrownBy = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
};

/** Asserts `error` is a PolymanError with the given exit code. */
const expectExitCode = (error: unknown, code: number): void => {
  expect(error).toBeInstanceOf(PolymanError);
  expect((error as PolymanError).exitCode).toBe(code);
};

const executorMocked = vi.mocked(executor);
const spawnSyncMocked = vi.mocked(spawnSync);

/**
 * Pretends the machine has exactly these interpreters, each printing the given
 * `--version` output. Anything else fails like a missing command.
 */
function mockInterpreters(versions: Record<string, string>) {
  spawnSyncMocked.mockImplementation(((command: string) => {
    const output = versions[command];
    if (output === undefined) {
      return {
        error: Object.assign(new Error('spawnSync ENOENT'), {
          code: 'ENOENT',
        }),
        status: null,
        stdout: '',
        stderr: '',
      };
    }
    return { status: 0, stdout: output, stderr: '' };
  }) as unknown as typeof spawnSync);
}
const fmtMocked = vi.mocked(fmt);
const executeMock = () => executorMocked['execute'];
const fmtErrorMock = () => fmtMocked['error'];

// Typed helpers for fs mocks (avoid `unbound-method` from passing mocked fns directly)
const readdirSyncMock = vi.mocked(fs.readdirSync);
const existsSyncMock = vi.mocked(fs.existsSync);
const mkdirSyncMock = vi.mocked(fs.mkdirSync);
const rmSyncMock = vi.mocked(fs.rmSync);
const readFileSyncMock = vi.mocked(fs.readFileSync);
const createReadStreamMock = vi.mocked(fs.createReadStream);

/**
 * Builds a minimal stand-in for `fs.ReadStream` whose `on` method routes to
 * the supplied implementation. Returned through `ReadStream` so the mocked
 * `createReadStream` signature is satisfied without `any`.
 */
function makeReadStreamStub(
  on: (event: string, cb: (arg: string | Error | undefined) => void) => unknown
): ReadStream {
  const stub: Pick<ReadStream, 'on' | 'close'> = {
    on: on as unknown as ReadStream['on'],
    close: vi.fn(),
  };
  return stub as ReadStream;
}

describe('utils.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isNumeric', () => {
    it('should return true for numeric strings', () => {
      expect(utils.isNumeric('123')).toBe(true);
      expect(utils.isNumeric('0')).toBe(true);
      expect(utils.isNumeric('-1')).toBe(true);
    });
    it('should return false for non-numeric strings', () => {
      expect(utils.isNumeric('abc')).toBe(false);
      expect(utils.isNumeric('12a')).toBe(true); // Int parsing behavior
      expect(utils.isNumeric('all')).toBe(false);
    });
  });

  describe('insideProblem', () => {
    const dir = path.resolve('problem-dir');

    it('should resolve a plain relative path inside the folder', () => {
      expect(utils.insideProblem(dir, 'file.txt')).toBe(
        path.join(dir, 'file.txt')
      );
    });

    it('should resolve a nested relative path', () => {
      expect(utils.insideProblem(dir, 'sub/dir/file')).toBe(
        path.join(dir, 'sub', 'dir', 'file')
      );
    });

    it('should allow ".." inside the folder when it stays inside', () => {
      expect(utils.insideProblem(dir, 'a/../b.txt')).toBe(
        path.join(dir, 'b.txt')
      );
    });

    it('should allow names that merely start with two dots', () => {
      expect(utils.insideProblem(dir, '..x')).toBe(path.join(dir, '..x'));
      expect(utils.insideProblem(dir, '..notes.tex')).toBe(
        path.join(dir, '..notes.tex')
      );
    });

    it('should refuse a path that climbs out of the folder', () => {
      expect(() => utils.insideProblem(dir, '../x')).toThrow(
        'Refusing path outside the problem folder: ../x'
      );
      expect(() => utils.insideProblem(dir, '..')).toThrow(/Refusing path/);
      expect(() => utils.insideProblem(dir, 'sub/../../x')).toThrow(
        /Refusing path/
      );
      expect(() => utils.insideProblem(dir, '../../.ssh/id_rsa')).toThrow(
        /Refusing path/
      );
    });

    it('should refuse an absolute path outside the folder', () => {
      const outside = path.resolve(dir, '..', 'elsewhere', 'file.txt');
      expect(() => utils.insideProblem(dir, outside)).toThrow(
        `Refusing path outside the problem folder: ${outside}`
      );
    });

    it('should accept an absolute path that is inside the folder', () => {
      const inside = path.join(dir, 'a.txt');
      expect(utils.insideProblem(dir, inside)).toBe(inside);
    });
  });

  describe('filterTestsByRange', () => {
    const testFiles = ['test1.txt', 'test2.txt', 'test3.txt', 'not-test.txt'];
    it('should return all tests if no range is specified', () => {
      expect(utils.filterTestsByRange(testFiles)).toEqual(testFiles);
    });
    it('should filter by range', () => {
      expect(utils.filterTestsByRange(testFiles, 2, 3)).toEqual([
        'test2.txt',
        'test3.txt',
      ]);
    });
    it('should ignore non-test files during filtering', () => {
      expect(utils.filterTestsByRange(testFiles, 1, 3)).toEqual([
        'test1.txt',
        'test2.txt',
        'test3.txt',
      ]);
    });
    it('should handle NaN parsing gracefully', () => {
      expect(utils.filterTestsByRange(['testA.txt'], 1, 10)).toEqual([]);
    });
  });

  describe('getTestFiles', () => {
    it('should return sorted test files', () => {
      // `fs.readdirSync` is overloaded; cast to the string-array branch.
      (
        readdirSyncMock as unknown as ReturnType<
          typeof vi.fn<(p: string) => string[]>
        >
      ).mockReturnValue(['test10.txt', 'test2.txt', 'other.txt']);
      const result = utils.getTestFiles('dir');
      expect(result).toEqual(['test2.txt', 'test10.txt']);
    });

    /** Makes `fs.readdirSync` list the given names. */
    function listDir(names: string[]): void {
      (
        readdirSyncMock as unknown as ReturnType<
          typeof vi.fn<(p: string) => string[]>
        >
      ).mockReturnValue(names);
    }

    it('returns a normal test<N>.txt set in numeric order', () => {
      listDir(['test3.txt', 'test1.txt', 'test11.txt', 'test2.txt']);
      expect(utils.getTestFiles('dir')).toEqual([
        'test1.txt',
        'test2.txt',
        'test3.txt',
        'test11.txt',
      ]);
    });

    it('puts test2.txt before test10.txt', () => {
      listDir(['test10.txt', 'test9.txt', 'test100.txt', 'test2.txt']);
      expect(utils.getTestFiles('dir')).toEqual([
        'test2.txt',
        'test9.txt',
        'test10.txt',
        'test100.txt',
      ]);
    });

    it.each(['test1.txt.bak', 'test_notes.txt', 'test0.txt'])(
      'skips %s',
      stray => {
        listDir(['test2.txt', stray, 'test1.txt']);
        expect(utils.getTestFiles('dir')).toEqual(['test1.txt', 'test2.txt']);
      }
    );

    it('returns nothing when no file is test<N>.txt', () => {
      listDir(['test1.txt.bak', 'test_notes.txt', 'test0.txt', 'test01.txt']);
      expect(utils.getTestFiles('dir')).toEqual([]);
    });
  });

  describe('testFileIndex', () => {
    it.each([
      ['test1.txt', 1],
      ['test2.txt', 2],
      ['test10.txt', 10],
      ['test123.txt', 123],
    ])('%s is test %d', (name, index) => {
      expect(utils.testFileIndex(name)).toBe(index);
    });

    it.each([
      'test1.txt.bak',
      'test_notes.txt',
      'test0.txt',
      'test01.txt',
      'test.txt',
      'test1.TXT',
      'test1',
      'output_test1.txt',
      'testA.txt',
    ])('%s is not a test', name => {
      expect(utils.testFileIndex(name)).toBeNull();
    });
  });

  describe('Compilation', () => {
    const cwd = '/tmp/polyman path 3)test';
    const q = (value: string) => quoteShellArgument(value);

    /**
     * Makes `Config.json` in cwd read as the given content: an object is
     * serialised, a string is used as is, and undefined means "no file".
     */
    function mockConfig(content: object | string | undefined): void {
      readFileSyncMock.mockImplementation(p => {
        if (content !== undefined && String(p).endsWith('Config.json')) {
          return typeof content === 'string'
            ? content
            : JSON.stringify(content);
        }
        throw new Error(`ENOENT: ${String(p)}`);
      });
    }

    let cwdSpy: MockInstance<() => string>;

    beforeEach(() => {
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
      mockConfig(undefined);
      delete process.env['POLYMAN_CXX'];
      delete process.env['POLYMAN_JAVAC'];
    });

    afterEach(() => {
      cwdSpy.mockRestore();
      delete process.env['POLYMAN_CXX'];
      delete process.env['POLYMAN_JAVAC'];
    });

    describe('validateCompilerConfig', () => {
      it('accepts a missing block and a full block', () => {
        expect(utils.validateCompilerConfig(undefined)).toEqual({});
        const full = {
          cpp: '/opt/gcc 15/bin/g++',
          javac: 'javac',
          flags: ['-Wall', '-DNAME=a b'],
        };
        expect(utils.validateCompilerConfig(full)).toEqual(full);
      });

      it.each([
        ['a string', 'g++-15', /Invalid compiler in Config.json/],
        ['null', null, /Invalid compiler in Config.json/],
        ['an array', ['g++'], /Invalid compiler in Config.json/],
        ['a non-string cpp', { cpp: 15 }, /Invalid compiler\.cpp/],
        ['a blank cpp', { cpp: '   ' }, /Invalid compiler\.cpp/],
        ['a blank javac', { javac: '' }, /Invalid compiler\.javac/],
        ['string flags', { flags: '-Wall' }, /Invalid compiler\.flags/],
        [
          'a non-string flag',
          { flags: ['-Wall', 3] },
          /Invalid compiler\.flags/,
        ],
        ['a blank flag', { flags: ['-Wall', ' '] }, /Invalid compiler\.flags/],
        ['an unknown key', { cxx: 'g++-15' }, /Unknown key in compiler: "cxx"/],
      ])('rejects %s', (_label, value, message) => {
        expect(() => utils.validateCompilerConfig(value)).toThrow(message);
        expectExitCode(
          thrownBy(() => utils.validateCompilerConfig(value)),
          2
        );
      });
    });

    describe('readCompilerConfig', () => {
      it('is empty when Config.json is missing or malformed', () => {
        expect(utils.readCompilerConfig()).toEqual({});
        mockConfig('{ not json');
        expect(utils.readCompilerConfig()).toEqual({});
      });

      it('throws on a malformed compiler block', () => {
        mockConfig({ compiler: { flags: '-O2' } });
        expect(() => utils.readCompilerConfig()).toThrow(
          /Invalid compiler\.flags/
        );
      });
    });

    describe('resolveCppCompiler', () => {
      it('defaults to g++ without env or config', () => {
        expect(utils.resolveCppCompiler()).toBe('g++');
      });

      it('reads compiler.cpp from Config.json and trims it', () => {
        mockConfig({ compiler: { cpp: ' g++-15 ' } });
        expect(utils.resolveCppCompiler()).toBe('g++-15');
      });

      it('prefers POLYMAN_CXX over Config.json', () => {
        mockConfig({ compiler: { cpp: 'g++-15' } });
        process.env['POLYMAN_CXX'] = 'clang++';
        expect(utils.resolveCppCompiler()).toBe('clang++');
      });

      it.each(['', '   '])('treats POLYMAN_CXX=%j as not set', value => {
        mockConfig({ compiler: { cpp: 'g++-15' } });
        process.env['POLYMAN_CXX'] = value;
        expect(utils.resolveCppCompiler()).toBe('g++-15');
      });

      it('keeps Windows paths as they are', () => {
        process.env['POLYMAN_CXX'] = 'C:\\Program Files\\mingw64\\bin\\g++.exe';
        expect(utils.resolveCppCompiler()).toBe(
          'C:\\Program Files\\mingw64\\bin\\g++.exe'
        );
      });

      it('falls back to g++ when Config.json is malformed', () => {
        mockConfig('{ not json');
        expect(utils.resolveCppCompiler()).toBe('g++');
      });

      it('throws on an invalid compiler.cpp even when POLYMAN_CXX is set', () => {
        mockConfig({ compiler: { cpp: 15 } });
        process.env['POLYMAN_CXX'] = 'clang++';
        expect(() => utils.resolveCppCompiler()).toThrow(
          /Invalid compiler\.cpp/
        );
      });
    });

    describe('resolveCppFlags', () => {
      it('is -O2 and the default standard without config', () => {
        expect(utils.resolveCppFlags()).toEqual(['-O2', '-std=c++23']);
      });

      it('uses cppStandard from Config.json', () => {
        mockConfig({ cppStandard: 'c++17' });
        expect(utils.resolveCppFlags()).toEqual(['-O2', '-std=c++17']);
      });

      it('prefers the cppStandard option over Config.json', () => {
        mockConfig({ cppStandard: 'c++17' });
        expect(utils.resolveCppFlags({ cppStandard: 'c++20' })).toEqual([
          '-O2',
          '-std=c++20',
        ]);
      });

      it('appends compiler.flags after the defaults', () => {
        mockConfig({
          cppStandard: 'c++20',
          compiler: { flags: ['-Wall', '-DLOCAL'] },
        });
        expect(utils.resolveCppFlags()).toEqual([
          '-O2',
          '-std=c++20',
          '-Wall',
          '-DLOCAL',
        ]);
      });

      it.each(['-std=gnu++17', '--std=c++14'])(
        'lets %s in compiler.flags replace cppStandard',
        std => {
          mockConfig({ cppStandard: 'c++20', compiler: { flags: [std] } });
          expect(utils.resolveCppFlags()).toEqual(['-O2', std]);
        }
      );

      it.each(['-O0', '-O3', '-Ofast', '-Os'])(
        'lets %s in compiler.flags replace -O2',
        opt => {
          mockConfig({ compiler: { flags: [opt] } });
          expect(utils.resolveCppFlags()).toEqual(['-std=c++23', opt]);
        }
      );

      it('does not define ONLINE_JUDGE by default', () => {
        mockConfig({ compiler: { flags: ['-Wall'] } });
        expect(utils.resolveCppFlags()).not.toContain('-DONLINE_JUDGE');
      });

      it('adds -DONLINE_JUDGE after the standard with onlineJudge', () => {
        mockConfig({ compiler: { flags: ['-Wall'] } });
        expect(utils.resolveCppFlags({ onlineJudge: true })).toEqual([
          '-O2',
          '-std=c++23',
          '-DONLINE_JUDGE',
          '-Wall',
        ]);
      });

      it.each(['-DONLINE_JUDGE', '-DONLINE_JUDGE=1'])(
        'does not add -DONLINE_JUDGE twice when compiler.flags has %s',
        flag => {
          mockConfig({ compiler: { flags: [flag] } });
          expect(utils.resolveCppFlags({ onlineJudge: true })).toEqual([
            '-O2',
            '-std=c++23',
            flag,
          ]);
        }
      );

      it('still adds -DONLINE_JUDGE when compiler.flags has a longer macro name', () => {
        mockConfig({ compiler: { flags: ['-DONLINE_JUDGE_X'] } });
        expect(utils.resolveCppFlags({ onlineJudge: true })).toEqual([
          '-O2',
          '-std=c++23',
          '-DONLINE_JUDGE',
          '-DONLINE_JUDGE_X',
        ]);
      });

      it('still rejects an invalid cppStandard', () => {
        mockConfig({
          cppStandard: 'c++23; rm -rf /',
          compiler: { flags: ['-std=c++17'] },
        });
        expect(() => utils.resolveCppFlags()).toThrow(/Invalid cppStandard/);
        expectExitCode(
          thrownBy(() => utils.resolveCppFlags()),
          2
        );
      });

      it('rejects malformed compiler.flags', () => {
        mockConfig({ compiler: { flags: ['-O2', 3] } });
        expect(() => utils.resolveCppFlags()).toThrow(
          /Invalid compiler\.flags/
        );
      });
    });

    describe('resolveJavaCompiler', () => {
      it('defaults to javac', () => {
        expect(utils.resolveJavaCompiler()).toBe('javac');
      });

      it('reads compiler.javac from Config.json', () => {
        mockConfig({ compiler: { javac: '/opt/jdk/bin/javac' } });
        expect(utils.resolveJavaCompiler()).toBe('/opt/jdk/bin/javac');
      });

      it('prefers POLYMAN_JAVAC over Config.json', () => {
        mockConfig({ compiler: { javac: '/opt/jdk/bin/javac' } });
        process.env['POLYMAN_JAVAC'] = 'javac-21';
        expect(utils.resolveJavaCompiler()).toBe('javac-21');
      });

      it('treats a blank POLYMAN_JAVAC as not set', () => {
        process.env['POLYMAN_JAVAC'] = '  ';
        expect(utils.resolveJavaCompiler()).toBe('javac');
      });
    });

    describe('compileCPP', () => {
      it('should compile cpp file with g++, -O2 and C++23 by default', async () => {
        await utils.compileCPP('main.cpp');

        expect(executeMock()).toHaveBeenCalledWith(
          expect.stringContaining(
            `${q('g++')} ${q('-O2')} ${q('-std=c++23')} -iquote `
          ),
          expect.anything()
        );
      });

      it('passes -DONLINE_JUDGE with the onlineJudge option', async () => {
        await utils.compileCPP('main.cpp', { onlineJudge: true });

        expect(executeMock()).toHaveBeenCalledWith(
          expect.stringContaining(
            `${q('g++')} ${q('-O2')} ${q('-std=c++23')} ${q('-DONLINE_JUDGE')} -iquote `
          ),
          expect.anything()
        );
      });

      it('should honor the cppStandard option', async () => {
        await utils.compileCPP('main.cpp', { cppStandard: 'c++17' });

        expect(executeMock()).toHaveBeenCalledWith(
          expect.stringContaining(
            `${q('g++')} ${q('-O2')} ${q('-std=c++17')} -iquote `
          ),
          expect.anything()
        );
      });

      it('should read cppStandard from Config.json when no option given', async () => {
        mockConfig({ cppStandard: 'c++20' });

        await utils.compileCPP('main.cpp');

        expect(executeMock()).toHaveBeenCalledWith(
          expect.stringContaining(`${q('-std=c++20')} `),
          expect.anything()
        );
      });

      it('should reject an invalid cppStandard from Config.json', async () => {
        mockConfig({ cppStandard: 'c++23; rm -rf /' });

        await expect(utils.compileCPP('main.cpp')).rejects.toThrow(
          /Invalid cppStandard/
        );
        expect(executeMock()).not.toHaveBeenCalled();
      });

      it('should reject a malformed compiler block before compiling', async () => {
        mockConfig({ compiler: { cpp: ['g++-15'] } });

        await expect(utils.compileCPP('main.cpp')).rejects.toThrow(
          /Invalid compiler\.cpp/
        );
        expect(executeMock()).not.toHaveBeenCalled();
        expect(vi.mocked(cachedCompile)).not.toHaveBeenCalled();
      });

      it.each(['.cc', '.cxx'])(
        'should compile %s file and strip the extension for the output',
        async ext => {
          const cwd = path.resolve('/p');
          const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
          try {
            await utils.compileCPP(`solutions/main${ext}`);

            const output = path.join(cwd, 'solutions', 'main');
            const source = path.join(cwd, 'solutions', `main${ext}`);
            expect(executeMock()).toHaveBeenCalledWith(
              expect.stringContaining(
                `-o ${quoteShellArgument(output)} ${quoteShellArgument(source)}`
              ),
              expect.anything()
            );
          } finally {
            cwdSpy.mockRestore();
          }
        }
      );

      it.skipIf(process.platform === 'win32')(
        'should protect C++ paths containing spaces and parentheses',
        async () => {
          await utils.compileCPP('gen.cpp');

          expect(executeMock()).toHaveBeenCalledWith(
            "'g++' '-O2' '-std=c++23' -iquote '/tmp/polyman path 3)test' " +
              "-o '/tmp/polyman path 3)test/gen' " +
              "'/tmp/polyman path 3)test/gen.cpp'",
            expect.anything()
          );
        }
      );

      it.skipIf(process.platform === 'win32')(
        'should use compiler.cpp and compiler.flags from Config.json',
        async () => {
          mockConfig({
            cppStandard: 'c++20',
            compiler: {
              cpp: '/opt/gcc 15/bin/g++',
              flags: ['-Wall', "-DNAME=it's"],
            },
          });

          await utils.compileCPP('gen.cpp');

          expect(executeMock()).toHaveBeenCalledWith(
            "'/opt/gcc 15/bin/g++' '-O2' '-std=c++20' '-Wall' " +
              "'-DNAME=it'\\''s' -iquote '/tmp/polyman path 3)test' " +
              "-o '/tmp/polyman path 3)test/gen' " +
              "'/tmp/polyman path 3)test/gen.cpp'",
            expect.anything()
          );
        }
      );

      it.skipIf(process.platform === 'win32')(
        'should let POLYMAN_CXX override Config.json and quote paths with spaces',
        async () => {
          mockConfig({ compiler: { cpp: 'g++-15' } });
          process.env['POLYMAN_CXX'] = '/opt/my compilers/bin/clang++';

          await utils.compileCPP('gen.cpp');

          expect(executeMock()).toHaveBeenCalledWith(
            "'/opt/my compilers/bin/clang++' '-O2' '-std=c++23' " +
              "-iquote '/tmp/polyman path 3)test' " +
              "-o '/tmp/polyman path 3)test/gen' " +
              "'/tmp/polyman path 3)test/gen.cpp'",
            expect.anything()
          );
        }
      );

      it('should use double quotes for a Windows compiler path', async () => {
        const platform = process.platform;
        Object.defineProperty(process, 'platform', { value: 'win32' });
        try {
          process.env['POLYMAN_CXX'] =
            'C:\\Program Files\\mingw64\\bin\\g++.exe';

          await utils.compileCPP('gen.cpp');

          expect(executeMock()).toHaveBeenCalledWith(
            expect.stringMatching(
              /^"C:\\Program Files\\mingw64\\bin\\g\+\+\.exe" "-O2" "-std=c\+\+23" -iquote /
            ),
            expect.anything()
          );
        } finally {
          Object.defineProperty(process, 'platform', { value: platform });
        }
      });

      it('should throw if file is not a C++ source', async () => {
        await expect(utils.compileCPP('main.c')).rejects.toThrow(
          /Expected .cpp\/.cc\/.cxx file/
        );
        expect(executeMock()).not.toHaveBeenCalled();
      });

      it('should route the compile through the cache with its inputs', async () => {
        const root = path.resolve('/p');
        cwdSpy.mockReturnValue(root);
        await utils.compileCPP('solutions/main.cpp', {
          cppStandard: 'c++20',
        });

        const output = path.join(root, 'solutions', 'main');
        expect(vi.mocked(cachedCompile)).toHaveBeenCalledWith(
          {
            sourcePath: path.join(root, 'solutions', 'main.cpp'),
            binaryPath: process.platform === 'win32' ? `${output}.exe` : output,
            compiler: 'g++',
            flags: ['-O2', '-std=c++20'],
            includeDirs: [root],
          },
          expect.any(Function)
        );
      });

      it('should key the cache on the resolved compiler and flags', async () => {
        cwdSpy.mockReturnValue(path.resolve('/p'));
        mockConfig({
          compiler: { cpp: 'g++-15', flags: ['-Wall', '-std=gnu++20'] },
        });
        process.env['POLYMAN_CXX'] = '/opt/my compilers/bin/clang++';

        await utils.compileCPP('solutions/main.cpp');

        expect(vi.mocked(cachedCompile)).toHaveBeenCalledWith(
          expect.objectContaining({
            compiler: '/opt/my compilers/bin/clang++',
            flags: ['-O2', '-Wall', '-std=gnu++20'],
          }),
          expect.any(Function)
        );
        expect(vi.mocked(findPrebuiltTestlib)).toHaveBeenCalledWith(
          expect.objectContaining({
            compiler: '/opt/my compilers/bin/clang++',
            flags: ['-O2', '-Wall', '-std=gnu++20'],
          })
        );
      });

      describe('with flags that are not known to be cache-safe', () => {
        const source = path.join(cwd, 'solutions', 'main.cpp');
        const output = path.join(cwd, 'solutions', 'main');
        const fullCommand = (flags: string[]) =>
          [
            q('g++'),
            ...flags.map(q),
            `-iquote ${q(cwd)}`,
            `-o ${q(output)}`,
            q(source),
          ].join(' ');

        it.each([
          ['-include hdr.h', ['-include', 'hdr.h']],
          ['-imacros', ['-imacros', 'm.h']],
          ['-I dir', ['-I', 'inc']],
          ['-Idir', ['-Iinc']],
          ['-isystem', ['-isystem', 'sys']],
          ['-iquote', ['-iquote', 'q']],
          ['-idirafter', ['-idirafter', 'd']],
          ['--include=', ['--include=h.h']],
          ['-Wp,-include', ['-Wp,-include,h.h']],
          ['-iprefix', ['-iprefix', 'p/', '-iwithprefix', 'inc']],
          ['-specs=', ['-specs=my.specs']],
          ['-L and -l', ['-Llib', '-lfoo']],
          ['an object file', ['extra.o']],
          ['a static library', ['libfoo.a']],
          ['-Wl,@file', ['-Wl,@link.rsp']],
          ['a linker script', ['-T', 'link.ld']],
          ['-fprofile-use', ['-fprofile-use']],
          ['-fbranch-probabilities', ['-fbranch-probabilities']],
          ['an -f flag not on the list', ['-fsome-new-flag']],
          ['-fplugin=', ['-fplugin=p.so']],
          ['an @file response file', ['@flags.rsp']],
        ])('skips the cache and prebuilt testlib for %s', async (_n, flags) => {
          mockConfig({ compiler: { flags } });

          await utils.compileCPP('solutions/main.cpp');

          expect(vi.mocked(cachedCompile)).not.toHaveBeenCalled();
          expect(vi.mocked(findPrebuiltTestlib)).not.toHaveBeenCalled();
          expect(executeMock()).toHaveBeenCalledTimes(1);
          expect(executeMock().mock.calls[0][0]).toBe(
            fullCommand(['-O2', '-std=c++23', ...flags])
          );
        });

        it('checks the flags after trimming and the default replacement', async () => {
          mockConfig({
            compiler: { flags: [' -I inc ', '-O0', '-std=gnu++20'] },
          });

          await utils.compileCPP('solutions/main.cpp');

          expect(vi.mocked(cachedCompile)).not.toHaveBeenCalled();
          expect(executeMock().mock.calls[0][0]).toBe(
            fullCommand(['-I inc', '-O0', '-std=gnu++20'])
          );
        });

        it.each([
          ['-Wall', '-Wextra', '-Wno-unused-result', '-Werror=shadow'],
          ['-DLOCAL', '-DN=100', '-UNDEBUG'],
          ['-O0', '-Ofast', '--std=gnu++20', '-pedantic-errors', '-w'],
          ['-fsanitize=address,undefined', '-fno-omit-frame-pointer'],
          ['-fopenmp', '-fstack-protector-strong', '-ftrapv', '-fwrapv'],
          [
            '-fno-exceptions',
            '-fno-rtti',
            '-funroll-loops',
            '-fno-strict-aliasing',
          ],
          [
            '-fmax-errors=3',
            '-fdiagnostics-color=always',
            '-fconstexpr-steps=100000000',
          ],
          ['-g', '-ggdb3', '-march=native', '-m64', '-mavx2'],
          ['-static', '-pthread', '-pipe', '-s'],
        ])('still uses the cache for %s ...', async (...flags) => {
          mockConfig({ compiler: { flags } });

          await utils.compileCPP('solutions/main.cpp');

          expect(vi.mocked(cachedCompile)).toHaveBeenCalledTimes(1);
        });

        it('propagates a compile failure', async () => {
          mockConfig({ compiler: { flags: ['-include', 'hdr.h'] } });
          executeMock().mockRejectedValueOnce(new Error('boom'));

          await expect(utils.compileCPP('solutions/main.cpp')).rejects.toThrow(
            'boom'
          );
        });
      });

      describe('with a prebuilt testlib', () => {
        const cwd = path.resolve('/p');
        const prebuilt = {
          key: 'k',
          includeDir: path.join(cwd, '.polyman', 'cache', 'testlib', 'k'),
          objectPath: path.join(
            cwd,
            '.polyman',
            'cache',
            'testlib',
            'k',
            'testlib.o'
          ),
        };
        const q = (value: string) => quoteShellArgument(value);
        const source = path.join(cwd, 'validator', 'val.cpp');
        const output = path.join(cwd, 'validator', 'val');
        const splitCommand =
          `${q('g++')} ${q('-O2')} ${q('-std=c++23')} -iquote ${q(prebuilt.includeDir)} -iquote ${q(cwd)} ` +
          `-o ${q(output)} ${q(prebuilt.objectPath)} ${q(source)}`;
        const fullCommand = `${q('g++')} ${q('-O2')} ${q('-std=c++23')} -iquote ${q(cwd)} -o ${q(output)} ${q(source)}`;
        let cwdSpy: MockInstance<() => string>;

        beforeEach(() => {
          cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
          vi.mocked(findPrebuiltTestlib).mockResolvedValueOnce(prebuilt);
        });

        afterEach(() => {
          cwdSpy.mockRestore();
        });

        it('compiles against the split header and links the object', async () => {
          await utils.compileCPP('validator/val.cpp', { cppStandard: 'c++23' });

          expect(executeMock()).toHaveBeenCalledTimes(1);
          expect(executeMock()).toHaveBeenCalledWith(
            splitCommand,
            expect.anything()
          );
          expect(vi.mocked(findPrebuiltTestlib)).toHaveBeenCalledWith({
            sourcePath: source,
            compiler: 'g++',
            flags: ['-O2', '-std=c++23'],
          });
        });

        it('falls back to the original header and marks the split unsupported', async () => {
          executeMock()
            .mockRejectedValueOnce(new Error('undefined reference'))
            .mockResolvedValueOnce({
              stdout: '',
              stderr: '',
              exitCode: 0,
              success: true,
            });

          await utils.compileCPP('validator/val.cpp', { cppStandard: 'c++23' });

          expect(executeMock()).toHaveBeenLastCalledWith(
            fullCommand,
            expect.anything()
          );
          expect(
            vi.mocked(markPrebuiltTestlibUnsupported)
          ).toHaveBeenCalledWith(prebuilt);
        });

        it('reports the normal compile error when the source is broken', async () => {
          executeMock()
            .mockRejectedValueOnce(new Error('split: expected ;'))
            .mockRejectedValueOnce(new Error('val.cpp:3: expected ;'));

          await expect(
            utils.compileCPP('validator/val.cpp', { cppStandard: 'c++23' })
          ).rejects.toThrow('val.cpp:3: expected ;');
          expect(
            vi.mocked(markPrebuiltTestlibUnsupported)
          ).not.toHaveBeenCalled();
        });
      });

      describe('with a precompiled header', () => {
        const cwd = path.resolve('/p');
        const pch = { key: 'pk', includeDir: path.join('/cache', 'pch', 'pk') };
        const q = (value: string) => quoteShellArgument(value);
        const source = path.join(cwd, 'solutions', 'main.cpp');
        const output = path.join(cwd, 'solutions', 'main');
        const base = `${q('g++')} ${q('-O2')} ${q('-std=c++23')} -iquote ${q(cwd)}`;
        const pchCommand = `${base} -I ${q(pch.includeDir)} -o ${q(output)} ${q(source)}`;
        const fullCommand = `${base} -o ${q(output)} ${q(source)}`;
        let cwdSpy: MockInstance<() => string>;

        beforeEach(() => {
          cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
          vi.mocked(findPch).mockResolvedValueOnce(pch);
        });

        afterEach(() => {
          cwdSpy.mockRestore();
        });

        it('puts the PCH folder on the include path', async () => {
          await utils.compileCPP('solutions/main.cpp');

          expect(executeMock()).toHaveBeenCalledTimes(1);
          expect(executeMock()).toHaveBeenCalledWith(
            pchCommand,
            expect.anything()
          );
          expect(vi.mocked(findPch)).toHaveBeenCalledWith({
            sourcePath: source,
            compiler: 'g++',
            flags: ['-O2', '-std=c++23'],
          });
        });

        it('compiles without it and marks it unsupported when it fails', async () => {
          executeMock()
            .mockRejectedValueOnce(new Error('bad pch'))
            .mockResolvedValueOnce({
              stdout: '',
              stderr: '',
              exitCode: 0,
              success: true,
            });

          await utils.compileCPP('solutions/main.cpp');

          expect(executeMock()).toHaveBeenLastCalledWith(
            fullCommand,
            expect.anything()
          );
          expect(vi.mocked(markPchUnsupported)).toHaveBeenCalledWith(pch);
        });

        it('reports the normal compile error when the source is broken', async () => {
          executeMock()
            .mockRejectedValueOnce(new Error('with pch: expected ;'))
            .mockRejectedValueOnce(new Error('main.cpp:3: expected ;'));

          await expect(utils.compileCPP('solutions/main.cpp')).rejects.toThrow(
            'main.cpp:3: expected ;'
          );
          expect(vi.mocked(markPchUnsupported)).not.toHaveBeenCalled();
        });

        describe('and a prebuilt testlib', () => {
          const prebuilt = {
            key: 'tk',
            includeDir: path.join('/cache', 'testlib', 'tk'),
            objectPath: path.join('/cache', 'testlib', 'tk', 'testlib.o'),
          };
          const both = `${base.replace(` -iquote ${q(cwd)}`, '')} -iquote ${q(prebuilt.includeDir)} -iquote ${q(cwd)} -I ${q(pch.includeDir)} -o ${q(output)} ${q(prebuilt.objectPath)} ${q(source)}`;
          const prebuiltOnly = `${base.replace(` -iquote ${q(cwd)}`, '')} -iquote ${q(prebuilt.includeDir)} -iquote ${q(cwd)} -o ${q(output)} ${q(prebuilt.objectPath)} ${q(source)}`;
          const pchOnly = pchCommand;
          const plain = fullCommand;
          const ok = {
            stdout: '',
            stderr: '',
            exitCode: 0,
            success: true,
          };

          beforeEach(() => {
            vi.mocked(findPrebuiltTestlib).mockResolvedValueOnce(prebuilt);
          });

          it('uses both in one command', async () => {
            await utils.compileCPP('solutions/main.cpp');

            expect(executeMock()).toHaveBeenCalledTimes(1);
            expect(executeMock()).toHaveBeenCalledWith(both, expect.anything());
            expect(vi.mocked(markPchUnsupported)).not.toHaveBeenCalled();
            expect(
              vi.mocked(markPrebuiltTestlibUnsupported)
            ).not.toHaveBeenCalled();
          });

          it('retries with the prebuilt only when the PCH is at fault', async () => {
            executeMock()
              .mockRejectedValueOnce(new Error('bad pch'))
              .mockRejectedValueOnce(new Error('bad pch, original header'))
              .mockResolvedValueOnce(ok);

            await utils.compileCPP('solutions/main.cpp');

            expect(
              executeMock().mock.calls.map(([command]) => command)
            ).toEqual([both, pchOnly, prebuiltOnly]);
            expect(vi.mocked(markPchUnsupported)).toHaveBeenCalledWith(pch);
            expect(
              vi.mocked(markPrebuiltTestlibUnsupported)
            ).not.toHaveBeenCalled();
          });

          it('compiles plain and marks both when neither works', async () => {
            executeMock()
              .mockRejectedValueOnce(new Error('both fail'))
              .mockRejectedValueOnce(new Error('pch fails'))
              .mockRejectedValueOnce(new Error('prebuilt fails'))
              .mockResolvedValueOnce(ok);

            await utils.compileCPP('solutions/main.cpp');

            expect(
              executeMock().mock.calls.map(([command]) => command)
            ).toEqual([both, pchOnly, prebuiltOnly, plain]);
            expect(vi.mocked(markPchUnsupported)).toHaveBeenCalledWith(pch);
            expect(
              vi.mocked(markPrebuiltTestlibUnsupported)
            ).toHaveBeenCalledWith(prebuilt);
          });

          it('reports the plain compile error and marks nothing when the source is broken', async () => {
            executeMock()
              .mockRejectedValueOnce(new Error('with both: expected ;'))
              .mockRejectedValueOnce(new Error('with pch: expected ;'))
              .mockRejectedValueOnce(new Error('with prebuilt: expected ;'))
              .mockRejectedValueOnce(new Error('main.cpp:3: expected ;'));

            await expect(
              utils.compileCPP('solutions/main.cpp')
            ).rejects.toThrow('main.cpp:3: expected ;');
            expect(executeMock()).toHaveBeenCalledTimes(4);
            expect(vi.mocked(markPchUnsupported)).not.toHaveBeenCalled();
            expect(
              vi.mocked(markPrebuiltTestlibUnsupported)
            ).not.toHaveBeenCalled();
          });
        });
      });
    });

    describe('C++ source helpers', () => {
      beforeEach(() => {
        readFileSyncMock.mockReset();
      });

      it('isCppSource recognises .cpp, .cc and .cxx (case-insensitively)', () => {
        expect(utils.isCppSource('a/b/main.cpp')).toBe(true);
        expect(utils.isCppSource('main.cc')).toBe(true);
        expect(utils.isCppSource('main.cxx')).toBe(true);
        expect(utils.isCppSource('MAIN.CPP')).toBe(true);
        expect(utils.isCppSource('main.c')).toBe(false);
        expect(utils.isCppSource('main.py')).toBe(false);
        expect(utils.isCppSource('testlib.h')).toBe(false);
      });

      it('stripCppExtension removes only C++ extensions', () => {
        expect(utils.stripCppExtension('/p/main.cpp')).toBe('/p/main');
        expect(utils.stripCppExtension('/p/main.cc')).toBe('/p/main');
        expect(utils.stripCppExtension('/p/main.cxx')).toBe('/p/main');
        expect(utils.stripCppExtension('/p/Main.java')).toBe('/p/Main.java');
        expect(utils.stripCppExtension('ncmp')).toBe('ncmp');
      });

      it('resolveCppStandard falls back to c++23 without Config.json', () => {
        readFileSyncMock.mockImplementation(() => {
          throw new Error('ENOENT');
        });
        expect(utils.resolveCppStandard()).toBe(utils.DEFAULT_CPP_STANDARD);
        expect(utils.DEFAULT_CPP_STANDARD).toBe('c++23');
      });

      it('resolveCppStandard falls back to c++23 when the field is absent', () => {
        (
          readFileSyncMock as unknown as ReturnType<
            typeof vi.fn<(...args: unknown[]) => string>
          >
        ).mockReturnValue('{"solutions": []}');
        expect(utils.resolveCppStandard()).toBe('c++23');
      });

      it('resolveCppStandard uses the fallback when the field is absent', () => {
        (
          readFileSyncMock as unknown as ReturnType<
            typeof vi.fn<(...args: unknown[]) => string>
          >
        ).mockReturnValue('{"solutions": []}');
        expect(utils.resolveCppStandard('c++17')).toBe('c++17');
      });

      it('resolveCppStandard prefers cppStandard over the fallback', () => {
        (
          readFileSyncMock as unknown as ReturnType<
            typeof vi.fn<(...args: unknown[]) => string>
          >
        ).mockReturnValue(JSON.stringify({ cppStandard: 'c++20' }));
        expect(utils.resolveCppStandard('c++17')).toBe('c++20');
      });

      it.each([
        ['cpp.g++11', 'c++11'],
        ['cpp.g++14', 'c++14'],
        ['cpp.g++17', 'c++17'],
        ['cpp.g++20', 'c++20'],
        ['cpp.msys2-mingw64-9-g++17', 'c++17'],
        ['cpp.gcc13-64-winlibs-g++20', 'c++20'],
        ['cpp.gcc14-64-msys2-g++23', 'c++23'],
        ['cpp.clang++17', 'c++17'],
        ['cpp.clang++20', 'c++20'],
      ])('cppStandardFromSourceType reads %s as %s', (sourceType, std) => {
        expect(utils.cppStandardFromSourceType(sourceType)).toBe(std);
      });

      it.each([
        undefined,
        '',
        'cpp.ms2017',
        'cpp.ms2019',
        'java21',
        'python.3',
        'c.gcc11',
      ])('cppStandardFromSourceType gives no standard for %j', sourceType => {
        expect(utils.cppStandardFromSourceType(sourceType)).toBeUndefined();
      });

      it.each([17, {}, true, ['a']])(
        'cppStandardFromSourceType gives no standard for non-string %j',
        sourceType => {
          expect(
            utils.cppStandardFromSourceType(sourceType as unknown as string)
          ).toBeUndefined();
        }
      );

      it.each(['c++11', 'c++17', 'gnu++20', 'c++2b', 'c++26'])(
        'resolveCppStandard accepts %s',
        std => {
          (
            readFileSyncMock as unknown as ReturnType<
              typeof vi.fn<(...args: unknown[]) => string>
            >
          ).mockReturnValue(JSON.stringify({ cppStandard: std }));
          expect(utils.resolveCppStandard()).toBe(std);
        }
      );

      it.each(['17', 'c++', 'c++23 -fno-exceptions', 23])(
        'resolveCppStandard rejects %s',
        std => {
          (
            readFileSyncMock as unknown as ReturnType<
              typeof vi.fn<(...args: unknown[]) => string>
            >
          ).mockReturnValue(JSON.stringify({ cppStandard: std }));
          expect(() => utils.resolveCppStandard()).toThrow(
            /Invalid cppStandard/
          );
        }
      );
    });

    describe('compileJava', () => {
      it('should compile java file with javac by default', async () => {
        await utils.compileJava('Main.java');
        expect(executeMock()).toHaveBeenCalledWith(
          expect.stringMatching(/^['"]javac['"] /),
          expect.anything()
        );
      });

      it.skipIf(process.platform === 'win32')(
        'should protect Java source paths containing spaces and parentheses',
        async () => {
          await utils.compileJava('Main.java');

          expect(executeMock()).toHaveBeenCalledWith(
            "'javac' '/tmp/polyman path 3)test/Main.java'",
            expect.anything()
          );
        }
      );

      it.skipIf(process.platform === 'win32')(
        'should use compiler.javac from Config.json',
        async () => {
          mockConfig({ compiler: { javac: '/usr/lib/jvm/jdk 21/bin/javac' } });

          await utils.compileJava('Main.java');

          expect(executeMock()).toHaveBeenCalledWith(
            "'/usr/lib/jvm/jdk 21/bin/javac' '/tmp/polyman path 3)test/Main.java'",
            expect.anything()
          );
        }
      );

      it.skipIf(process.platform === 'win32')(
        'should use POLYMAN_JAVAC when set',
        async () => {
          mockConfig({ compiler: { javac: 'javac-17' } });
          process.env['POLYMAN_JAVAC'] = '/opt/jdk 21/bin/javac';

          await utils.compileJava('Main.java');

          expect(executeMock()).toHaveBeenCalledWith(
            "'/opt/jdk 21/bin/javac' '/tmp/polyman path 3)test/Main.java'",
            expect.anything()
          );
        }
      );

      it('should not pass compiler.flags to javac', async () => {
        mockConfig({ compiler: { flags: ['-Wall'] } });

        await utils.compileJava('Main.java');

        expect(executeMock()).toHaveBeenCalledWith(
          expect.not.stringContaining('-Wall'),
          expect.anything()
        );
      });

      it('should reject a malformed compiler block before compiling', async () => {
        mockConfig({ compiler: { javac: '' } });

        await expect(utils.compileJava('Main.java')).rejects.toThrow(
          /Invalid compiler\.javac/
        );
        expect(executeMock()).not.toHaveBeenCalled();
      });
    });
  });

  describe('Directories', () => {
    describe('ensureDirectoryExists', () => {
      it('should create directory if missing', () => {
        existsSyncMock.mockReturnValue(false);
        utils.ensureDirectoryExists('new-dir');
        expect(mkdirSyncMock).toHaveBeenCalledWith(
          expect.stringContaining('new-dir'),
          { recursive: true }
        );
      });
      it('should do nothing if directory exists', () => {
        existsSyncMock.mockReturnValue(true);
        utils.ensureDirectoryExists('exists');
        expect(mkdirSyncMock).not.toHaveBeenCalled();
      });
    });

    describe('removeDirectoryRecursively', () => {
      it('should remove directory if exists', () => {
        existsSyncMock.mockReturnValue(true);
        utils.removeDirectoryRecursively('del-dir');
        expect(rmSyncMock).toHaveBeenCalledWith(
          expect.stringContaining('del-dir'),
          { recursive: true, force: true }
        );
      });
      it('should do nothing if directory missing', () => {
        existsSyncMock.mockReturnValue(false);
        utils.removeDirectoryRecursively('missing');
        expect(rmSyncMock).not.toHaveBeenCalled();
      });
    });
  });

  describe('readConfigFile', () => {
    it('should return parsed config', () => {
      (
        readFileSyncMock as unknown as ReturnType<
          typeof vi.fn<(...args: unknown[]) => string>
        >
      ).mockReturnValue('{"solutions": []}');
      expect(utils.readConfigFile()).toEqual({ solutions: [] });
    });
    it('should throw if file reading fails', () => {
      readFileSyncMock.mockImplementation(() => {
        throw new Error('Fail');
      });
      expect(() => utils.readConfigFile()).toThrow('Fail');
    });

    it('should fail with exit code 2 and a hint when Config.json is missing', () => {
      readFileSyncMock.mockImplementation(() => {
        throw new Error(
          "ENOENT: no such file or directory, open 'Config.json'"
        );
      });
      const error = thrownBy(() => utils.readConfigFile());
      expectExitCode(error, 2);
      expect((error as PolymanError).message).toContain('ENOENT');
      expect((error as PolymanError).hint).toContain('polyman new');
    });

    it('should fail with exit code 2 when Config.json is not valid JSON', () => {
      (
        readFileSyncMock as unknown as ReturnType<
          typeof vi.fn<(...args: unknown[]) => string>
        >
      ).mockReturnValue('{ not json');
      expectExitCode(
        thrownBy(() => utils.readConfigFile()),
        2
      );
    });
  });

  describe('ensureConfigSourcesExist', () => {
    const baseConfig = (): ConfigFile =>
      ({
        validator: { name: 'validator', source: 'validator/val.cpp' },
        checker: { name: 'chk', source: 'checker/chk.cpp' },
        generators: [{ name: 'gen', source: 'generators/gen.cpp' }],
        solutions: [{ name: 'main', source: 'solutions/main.cpp', tag: 'MA' }],
      }) as ConfigFile;

    const existing = (...files: string[]) => {
      vi.mocked(fs.existsSync).mockImplementation(p =>
        files.some(f => path.resolve(process.cwd(), f) === String(p))
      );
    };

    it('passes when every named file exists', () => {
      existing(
        'validator/val.cpp',
        'checker/chk.cpp',
        'generators/gen.cpp',
        'solutions/main.cpp'
      );
      expect(() => utils.ensureConfigSourcesExist(baseConfig())).not.toThrow();
    });

    it('reports a missing validator', () => {
      existing('checker/chk.cpp', 'generators/gen.cpp', 'solutions/main.cpp');
      expect(() => utils.ensureConfigSourcesExist(baseConfig())).toThrow(
        'validator file not found: validator/val.cpp'
      );
    });

    it('fails with exit code 2, since Config.json is wrong', () => {
      existing('checker/chk.cpp', 'generators/gen.cpp', 'solutions/main.cpp');
      expectExitCode(
        thrownBy(() => utils.ensureConfigSourcesExist(baseConfig())),
        2
      );
    });

    it('lists a missing validator, generator and solution together', () => {
      existing('checker/chk.cpp');
      let message = '';
      try {
        utils.ensureConfigSourcesExist(baseConfig());
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('validator file not found: validator/val.cpp');
      expect(message).toContain(
        'generator "gen" file not found: generators/gen.cpp'
      );
      expect(message).toContain(
        'solution "main" file not found: solutions/main.cpp'
      );
      expect(message).not.toContain('checker file not found');
    });

    it('skips a standard checker', () => {
      const config = baseConfig();
      config.checker = { name: 'wcmp', source: 'wcmp.cpp', isStandard: true };
      existing('validator/val.cpp', 'generators/gen.cpp', 'solutions/main.cpp');
      expect(() => utils.ensureConfigSourcesExist(config)).not.toThrow();
    });

    it('reports a missing custom checker', () => {
      existing('validator/val.cpp', 'generators/gen.cpp', 'solutions/main.cpp');
      expect(() => utils.ensureConfigSourcesExist(baseConfig())).toThrow(
        'checker file not found: checker/chk.cpp'
      );
    });

    it('requires every listed generator to exist, even if no testset uses it', () => {
      const config = baseConfig();
      config.generators = [
        { name: 'gen', source: 'generators/gen.cpp' },
        { name: 'unused', source: 'generators/unused.cpp' },
      ];
      // No testset references "unused"; its file is still required.
      existing(
        'validator/val.cpp',
        'checker/chk.cpp',
        'generators/gen.cpp',
        'solutions/main.cpp'
      );
      expect(() => utils.ensureConfigSourcesExist(config)).toThrow(
        'generator "unused" file not found: generators/unused.cpp'
      );
    });
  });

  describe('readFirstLine', () => {
    it('should return first line from stream', async () => {
      const onImpl = (
        event: string,
        cb: (arg: string | Error | undefined) => void
      ): unknown => {
        if (event === 'data') {
          setTimeout(() => cb('first line\nsecond line'), 0);
        }
        return undefined;
      };
      createReadStreamMock.mockReturnValue(makeReadStreamStub(onImpl));
      await expect(utils.readFirstLine('file.txt')).resolves.toBe('first line');
    });

    it('should handle empty file', async () => {
      const onImpl = (
        event: string,
        cb: (arg: string | Error | undefined) => void
      ): unknown => {
        if (event === 'end') {
          setTimeout(() => cb(undefined), 0);
        }
        return undefined;
      };
      createReadStreamMock.mockReturnValue(makeReadStreamStub(onImpl));
      await expect(utils.readFirstLine('file.txt')).resolves.toBe('');
    });

    it('should handle stream error', async () => {
      const onImpl = (
        event: string,
        cb: (arg: string | Error | undefined) => void
      ): unknown => {
        if (event === 'error') {
          setTimeout(() => cb(new Error('Stream Error')), 0);
        }
        return undefined;
      };
      createReadStreamMock.mockReturnValue(makeReadStreamStub(onImpl));
      await expect(utils.readFirstLine('file.txt')).rejects.toThrow(
        'Stream Error'
      );
    });
  });

  describe('getCompiledCommandToRun', () => {
    it('should handle .cpp', () => {
      const obj: LocalSolution = {
        source: 'main.cpp',
        name: 'main',
        tag: 'MA',
      };
      expect(utils.getCompiledCommandToRun(obj)).toContain('main');
      expect(utils.getCompiledCommandToRun(obj)).not.toContain('.cpp');
    });

    it.each(['.cc', '.cxx'])('should handle %s like .cpp', ext => {
      const cwd = path.resolve('/p');
      const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
      const obj: LocalSolution = {
        source: `solutions/main${ext}`,
        name: 'main',
        tag: 'MA',
      };
      try {
        expect(utils.getCompiledCommandToRun(obj)).toBe(
          quoteShellArgument(path.join(cwd, 'solutions', 'main'))
        );
      } finally {
        cwdSpy.mockRestore();
      }
    });

    it.skipIf(process.platform === 'win32')(
      'should protect C++ executable paths containing shell metacharacters',
      () => {
        const cwdSpy = vi
          .spyOn(process, 'cwd')
          .mockReturnValue("/tmp/polyman path 3)'test");
        const obj: LocalSolution = {
          source: 'main.cpp',
          name: 'main',
          tag: 'MA',
        };

        try {
          expect(utils.getCompiledCommandToRun(obj)).toBe(
            "'/tmp/polyman path 3)'\\''test/main'"
          );
        } finally {
          cwdSpy.mockRestore();
        }
      }
    );

    it('should handle .java', () => {
      const obj: LocalSolution = {
        source: 'pkg/Main.java',
        name: 'Main',
        tag: 'MA',
      };
      // Should return java -cp ... Main
      expect(utils.getCompiledCommandToRun(obj)).toContain('java -cp');
    });

    it.skipIf(process.platform === 'win32')(
      'should protect Java classpath paths containing shell metacharacters',
      () => {
        const cwdSpy = vi
          .spyOn(process, 'cwd')
          .mockReturnValue("/tmp/polyman path 3)'test");
        const obj: LocalSolution = {
          source: 'pkg/Main.java',
          name: 'Main',
          tag: 'MA',
        };

        try {
          const command = utils.getCompiledCommandToRun(obj);
          expect(command).toContain(
            "java -cp '/tmp/polyman path 3)'\\''test/pkg'"
          );
          expect(command).toContain("'Main'");
        } finally {
          cwdSpy.mockRestore();
        }
      }
    );

    describe('python interpreter lookup', () => {
      const pySolution: LocalSolution = {
        source: 'script.py',
        name: 'script',
        tag: 'MA',
      };

      beforeEach(() => {
        utils.resetPythonCommandCache();
        spawnSyncMocked.mockReset();
      });

      afterEach(() => {
        utils.resetPythonCommandCache();
      });

      it('should handle .py with python3', () => {
        mockInterpreters({ python3: 'Python 3.11.2\n' });
        expect(utils.getCompiledCommandToRun(pySolution)).toMatch(
          /^python3 .*script\.py/
        );
      });

      it('should fall back to python when python3 is missing', () => {
        mockInterpreters({ python: 'Python 3.12.0\n' });
        expect(utils.getCompiledCommandToRun(pySolution)).toMatch(
          /^python .*script\.py/
        );
      });

      it('should prefer python3 when both exist', () => {
        mockInterpreters({
          python3: 'Python 3.11.2\n',
          python: 'Python 3.12.0\n',
        });
        expect(utils.getCompiledCommandToRun(pySolution)).toMatch(/^python3 /);
      });

      it('should reject a python that is Python 2', () => {
        mockInterpreters({ python: 'Python 2.7.18\n' });
        expect(() => utils.getCompiledCommandToRun(pySolution)).toThrow(
          /Python 3 was not found/
        );
      });

      it('should skip a Python 2 python3 and use python', () => {
        mockInterpreters({
          python3: 'Python 2.7.18\n',
          python: 'Python 3.10.0\n',
        });
        expect(utils.getCompiledCommandToRun(pySolution)).toMatch(/^python /);
      });

      it('should say Python is missing when no interpreter exists', () => {
        mockInterpreters({});
        expect(() => utils.getCompiledCommandToRun(pySolution)).toThrow(
          'Python 3 was not found (tried python3, python). Install Python 3 to run script.py'
        );
      });

      it('should fail with exit code 3 when Python is missing', () => {
        mockInterpreters({});
        expectExitCode(
          thrownBy(() => utils.getCompiledCommandToRun(pySolution)),
          3
        );
      });

      it('should look the interpreter up once per process', () => {
        mockInterpreters({ python3: 'Python 3.11.2\n' });
        utils.getCompiledCommandToRun(pySolution);
        utils.getCompiledCommandToRun(pySolution);
        expect(spawnSyncMocked).toHaveBeenCalledTimes(1);
      });

      it.skipIf(process.platform === 'win32')(
        'should protect Python source paths containing shell metacharacters',
        () => {
          mockInterpreters({ python3: 'Python 3.11.2\n' });
          const cwdSpy = vi
            .spyOn(process, 'cwd')
            .mockReturnValue("/tmp/polyman path 3)'test");

          try {
            expect(utils.getCompiledCommandToRun(pySolution)).toBe(
              "python3 '/tmp/polyman path 3)'\\''test/script.py'"
            );
          } finally {
            cwdSpy.mockRestore();
          }
        }
      );
    });

    it('should handle .js', () => {
      const obj: LocalSolution = {
        source: 'script.js',
        name: 'script',
        tag: 'MA',
      };
      expect(utils.getCompiledCommandToRun(obj)).toContain('node');
    });

    it.skipIf(process.platform === 'win32')(
      'should protect JavaScript source paths containing shell metacharacters',
      () => {
        const cwdSpy = vi
          .spyOn(process, 'cwd')
          .mockReturnValue("/tmp/polyman path 3)'test");
        const obj: LocalSolution = {
          source: 'script.js',
          name: 'script',
          tag: 'MA',
        };

        try {
          expect(utils.getCompiledCommandToRun(obj)).toBe(
            "node '/tmp/polyman path 3)'\\''test/script.js'"
          );
        } finally {
          cwdSpy.mockRestore();
        }
      }
    );

    it('should throw on unknown extension', () => {
      const obj: LocalGenerator = { source: 'script.rb', name: 'script' };
      expect(() => utils.getCompiledCommandToRun(obj)).toThrow(
        /Unsupported source file extension/
      );
    });

    it('should handle standard checkers', () => {
      const obj: LocalChecker = {
        source: 'std.cpp',
        name: 'std',
        isStandard: true,
      };
      const res = utils.getCompiledCommandToRun(obj);
      expect(res).toContain(path.join('assets', 'checkers', 'std'));
    });

    it('should not include cpp extension for standard checkers', () => {
      const obj: LocalChecker = {
        source: 'std.cpp',
        name: 'std',
        isStandard: true,
      };
      const res = utils.getCompiledCommandToRun(obj);
      expect(res).not.toContain('std.cpp');
    });
  });

  describe('Error Handling', () => {
    it('logError should call fmt.error', () => {
      utils.logError('message');
      expect(fmtErrorMock()).toHaveBeenCalled();
    });

    it('logErrorAndThrow should throw', () => {
      expect(() => utils.logErrorAndThrow('bad')).toThrow();
    });

    it('throwError should format error', () => {
      expect(() => utils.throwError('str error', 'ctx')).toThrow(
        /ctx: str error/
      );
    });
  });

  // Reference unused imports so TypeScript keeps them when stripping.
  void ([] as LocalValidator[]);
});
