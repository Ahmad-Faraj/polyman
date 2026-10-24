import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import * as pushing from '../../../src/helpers/remote/pushing';
import fs from 'fs';
import type { PathLike, PathOrFileDescriptor } from 'fs';
import type { PolygonSDK } from '../../../src/polygon';
import type ConfigFile from '../../../src/types';
import { fmt } from '../../../src/formatter';
import { normalizeLineEndingsFromSystemToRemote } from '../../../src/helpers/remote/utils';

vi.mock('fs');
vi.mock('../../../src/formatter', () => ({
  fmt: {
    warning: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    newLine: vi.fn(),
    cross: vi.fn().mockReturnValue('x'),
    bold: vi.fn().mockImplementation((s: string) => s),
    highlight: vi.fn().mockImplementation((s: string) => s),
  },
}));
vi.mock('../../../src/helpers/remote/utils', () => ({
  normalizeLineEndingsFromSystemToRemote: vi.fn((content: string) => content),
}));
vi.mock('../../../src/helpers/utils', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../src/helpers/utils')>();
  return {
    ...actual,
    logError: vi.fn(),
    throwError: vi.fn((error: unknown, message = '') => {
      throw error instanceof Error
        ? error
        : new Error(`${message}: ${String(error)}`);
    }),
  };
});

/**
 * Subset of PolygonSDK methods exercised by pushing.ts. Each entry is a Mock
 * so the tests can configure return values with the full vitest mock API
 * without having to reach through the type system.
 */
type MockedSdk = {
  saveSolution: Mock;
  saveFile: Mock;
  setChecker: Mock;
  setValidator: Mock;
  saveCheckerTest: Mock;
  saveValidatorTest: Mock;
  saveStatement: Mock;
  saveGeneralDescription: Mock;
  saveTags: Mock;
  saveScript: Mock;
  saveTest: Mock;
  setTestGroup: Mock;
  enableGroups: Mock;
  updateProblemInfo: Mock;
};

/**
 * Build the mocked SDK and a `PolygonSDK`-typed handle pointing at the same
 * underlying mocks. Production code only ever sees the typed handle, while
 * test code uses the raw `MockedSdk` for assertions.
 */
function buildSdk(): { sdk: PolygonSDK; mocks: MockedSdk } {
  const mocks: MockedSdk = {
    saveSolution: vi.fn().mockResolvedValue(undefined),
    saveFile: vi.fn().mockResolvedValue(undefined),
    setChecker: vi.fn().mockResolvedValue(undefined),
    setValidator: vi.fn().mockResolvedValue(undefined),
    saveCheckerTest: vi.fn().mockResolvedValue(undefined),
    saveValidatorTest: vi.fn().mockResolvedValue(undefined),
    saveStatement: vi.fn().mockResolvedValue(undefined),
    saveGeneralDescription: vi.fn().mockResolvedValue(undefined),
    saveTags: vi.fn().mockResolvedValue(undefined),
    saveScript: vi.fn().mockResolvedValue(undefined),
    saveTest: vi.fn().mockResolvedValue(undefined),
    setTestGroup: vi.fn().mockResolvedValue(undefined),
    enableGroups: vi.fn().mockResolvedValue(undefined),
    updateProblemInfo: vi.fn().mockResolvedValue(undefined),
  };
  const sdk = mocks as unknown as PolygonSDK;
  return { sdk, mocks };
}

/**
 * Construct a `ConfigFile` from a partial without forcing tests to fill in
 * unrelated required fields.
 */
function asConfig(partial: Partial<ConfigFile>): ConfigFile {
  return partial as unknown as ConfigFile;
}

const mockedReadFileSync = vi.mocked(fs.readFileSync);
const mockedExistsSync = vi.mocked(fs.existsSync);

/**
 * Type the read-file callback so the lint rules accept the path argument
 * without an `any`. We always read text, so a string is the right return type.
 */
type ReadFileCallback = (path: PathOrFileDescriptor) => string;

function mockReadFileSyncWith(impl: ReadFileCallback): void {
  // `fs.readFileSync` is heavily overloaded; the cast below narrows our
  // text-only mock to a single signature compatible with the union return
  // type expected by vi.mocked.
  mockedReadFileSync.mockImplementation(impl as typeof fs.readFileSync);
}

const mockConfig: ConfigFile = asConfig({
  name: 'Prob',
  solutions: [{ name: 'sol', source: 'sol.cpp', tag: 'MA' }],
  checker: { name: 'check', source: 'check.cpp' },
  validator: { name: 'val', source: 'val.cpp' },
  statements: { english: { encoding: 'UTF-8', name: 'Prob' } },
  testsets: [],
});

describe('pushing.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveSourceType', () => {
    it('should prefer the declared sourceType over the extension', () => {
      expect(
        pushing.resolveSourceType('sol.cpp', 'cpp.gcc14-64-msys2-g++23')
      ).toBe('cpp.gcc14-64-msys2-g++23');
      expect(pushing.resolveSourceType('Sol.java', 'java21')).toBe('java21');
      expect(pushing.resolveSourceType('Sol.java', 'java8')).toBe('java8');
    });

    it('should reject Java types Polygon does not accept', () => {
      for (const bad of ['java.8', 'java.11', 'java.21', 'java11', 'java17']) {
        expect(() => pushing.resolveSourceType('Sol.java', bad)).toThrow(
          /java8, java21/
        );
      }
    });

    it('should trim the declared sourceType before checking and returning it', () => {
      expect(pushing.resolveSourceType('Sol.java', ' java21')).toBe('java21');
      expect(pushing.resolveSourceType('Sol.java', 'java21 ')).toBe('java21');
      expect(pushing.resolveSourceType('sol.cpp', ' cpp.g++20 ')).toBe(
        'cpp.g++20'
      );
      expect(pushing.resolveSourceType('sol.py', '  ')).toBe('python.3');
    });

    it('should reject Java types that differ only by case or are bare', () => {
      for (const bad of ['Java21', 'JAVA8', 'java', ' java.11 ']) {
        expect(() => pushing.resolveSourceType('Sol.java', bad)).toThrow(
          /java8, java21/
        );
      }
    });

    it('should infer from the extension when nothing is declared', () => {
      expect(pushing.resolveSourceType('sol.cpp')).toBe('cpp.g++17');
      expect(pushing.resolveSourceType('sol.cc')).toBe('cpp.g++17');
      expect(pushing.resolveSourceType('sol.CXX')).toBe('cpp.g++17');
      expect(pushing.resolveSourceType('Sol.java')).toBe('java21');
      expect(pushing.resolveSourceType('sol.py')).toBe('python.3');
      expect(pushing.resolveSourceType('sol.c')).toBe('c.gcc11');
      expect(pushing.resolveSourceType('sol.unknown')).toBe('cpp.g++17');
    });

    it('should treat an empty declared sourceType as absent', () => {
      expect(pushing.resolveSourceType('sol.py', '')).toBe('python.3');
    });
  });

  describe('uploadSolutions', () => {
    it('should upload solutions successfully', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);

      const result = await pushing.uploadSolutions(sdk, 1, 'dir', mockConfig);

      expect(mocks.saveSolution).toHaveBeenCalled();
      expect(mocks.saveSolution).toHaveBeenCalledWith(
        1,
        'sol.cpp',
        'code',
        'MA',
        { sourceType: 'cpp.g++17', checkExisting: false }
      );
      expect(result).toBe(1);
    });

    it('should honor the sourceType declared in Config.json', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      const cfg = asConfig({
        solutions: [
          {
            name: 'sol',
            source: 'sol.cpp',
            tag: 'MA',
            sourceType: 'cpp.gcc14-64-msys2-g++23',
          },
        ],
      });

      await pushing.uploadSolutions(sdk, 1, 'dir', cfg);

      expect(mocks.saveSolution).toHaveBeenCalledWith(
        1,
        'sol.cpp',
        'code',
        'MA',
        { sourceType: 'cpp.gcc14-64-msys2-g++23', checkExisting: false }
      );
    });

    it('should warn and skip a solution with an unsupported Java type, then upload the next', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      const cfg = asConfig({
        solutions: [
          { name: 'bad', source: 'Bad.java', tag: 'OK', sourceType: 'java.11' },
          { name: 'good', source: 'sol.cpp', tag: 'MA' },
        ],
      });

      const result = await pushing.uploadSolutions(sdk, 1, 'dir', cfg);

      expect(result).toBe(1);
      expect(mocks.saveSolution).toHaveBeenCalledTimes(1);
      expect(mocks.saveSolution).toHaveBeenCalledWith(
        1,
        'sol.cpp',
        'code',
        'MA',
        expect.objectContaining({ sourceType: 'cpp.g++17' })
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fmt.warning).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported Java sourceType 'java.11'")
      );
    });

    it('should upload .cc solutions as C++', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      const cfg = asConfig({
        solutions: [{ name: 'sol', source: 'sol.cc', tag: 'MA' }],
      });

      await pushing.uploadSolutions(sdk, 1, 'dir', cfg);

      expect(mocks.saveSolution).toHaveBeenCalledWith(
        1,
        'sol.cc',
        'code',
        'MA',
        { sourceType: 'cpp.g++17', checkExisting: false }
      );
    });

    it('should return 0 when solutions list is empty', async () => {
      const { sdk, mocks } = buildSdk();
      const result = await pushing.uploadSolutions(
        sdk,
        1,
        'dir',
        asConfig({ solutions: [] })
      );
      expect(result).toBe(0);
      expect(mocks.saveSolution).not.toHaveBeenCalled();
    });

    it('should return 0 when solutions is undefined', async () => {
      const { sdk } = buildSdk();
      const result = await pushing.uploadSolutions(sdk, 1, 'dir', asConfig({}));
      expect(result).toBe(0);
    });

    it('should detect java source type', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      const cfg = asConfig({
        solutions: [{ name: 's', source: 'Sol.java', tag: 'OK' }],
      });
      await pushing.uploadSolutions(sdk, 1, 'dir', cfg);
      expect(mocks.saveSolution).toHaveBeenCalledWith(
        1,
        'Sol.java',
        'code',
        'OK',
        expect.objectContaining({ sourceType: 'java21' })
      );
    });

    it('should detect python source type', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      const cfg = asConfig({
        solutions: [{ name: 's', source: 'sol.py', tag: 'WA' }],
      });
      await pushing.uploadSolutions(sdk, 1, 'dir', cfg);
      expect(mocks.saveSolution).toHaveBeenCalledWith(
        1,
        'sol.py',
        'code',
        'WA',
        expect.objectContaining({ sourceType: 'python.3' })
      );
    });

    it('should detect c source type', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      const cfg = asConfig({
        solutions: [{ name: 's', source: 'sol.c', tag: 'OK' }],
      });
      await pushing.uploadSolutions(sdk, 1, 'dir', cfg);
      expect(mocks.saveSolution).toHaveBeenCalledWith(
        1,
        'sol.c',
        'code',
        'OK',
        expect.objectContaining({ sourceType: 'c.gcc11' })
      );
    });

    it('should warn and continue when a solution file is missing', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(false);
      const cfg = asConfig({
        solutions: [
          { name: 'a', source: 'a.cpp', tag: 'MA' },
          { name: 'b', source: 'b.cpp', tag: 'OK' },
        ],
      });
      const result = await pushing.uploadSolutions(sdk, 1, 'dir', cfg);
      expect(result).toBe(0);
      expect(mocks.saveSolution).not.toHaveBeenCalled();
    });

    it('should keep counting on partial sdk failure', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      mocks.saveSolution
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('boom'));
      const cfg = asConfig({
        solutions: [
          { name: 'a', source: 'a.cpp', tag: 'MA' },
          { name: 'b', source: 'b.cpp', tag: 'OK' },
        ],
      });
      const result = await pushing.uploadSolutions(sdk, 1, 'dir', cfg);
      expect(result).toBe(1);
    });

    describe('Java class naming', () => {
      const javaCode =
        'public class ProblemA {\n  String s = "ProblemA";\n  public static void main(String[] a) { new ProblemA(); }\n}\n';

      it('renames the public class to Main in the uploaded copy', async () => {
        const { sdk, mocks } = buildSdk();
        mockedReadFileSync.mockReturnValue(javaCode);
        mockedExistsSync.mockReturnValue(true);
        const cfg = asConfig({
          solutions: [{ name: 'a', source: 'ProblemA.java', tag: 'MA' }],
        });

        await pushing.uploadSolutions(sdk, 1, 'dir', cfg);

        const uploaded = mocks.saveSolution.mock.calls[0][2] as string;
        expect(uploaded).toContain('public class Main {');
        expect(uploaded).toContain('new Main();');
        expect(uploaded).toContain('"ProblemA"');
        expect(mocks.saveSolution.mock.calls[0][1]).toBe('ProblemA.java');
        expect(fs.writeFileSync).not.toHaveBeenCalled();
      });

      it('leaves Main.java unchanged', async () => {
        const { sdk, mocks } = buildSdk();
        const code = 'public class Main {}\n';
        mockedReadFileSync.mockReturnValue(code);
        mockedExistsSync.mockReturnValue(true);
        const cfg = asConfig({
          solutions: [{ name: 'a', source: 'Main.java', tag: 'MA' }],
        });

        await pushing.uploadSolutions(sdk, 1, 'dir', cfg);

        expect(mocks.saveSolution.mock.calls[0][2]).toBe(code);
      });

      it('renames the public class to Main for an uppercase .JAVA extension', async () => {
        const { sdk, mocks } = buildSdk();
        mockedReadFileSync.mockReturnValue(javaCode);
        mockedExistsSync.mockReturnValue(true);
        const cfg = asConfig({
          solutions: [
            {
              name: 'a',
              source: 'ProblemA.JAVA',
              tag: 'MA',
              sourceType: 'java21',
            },
          ],
        });

        await pushing.uploadSolutions(sdk, 1, 'dir', cfg);

        const uploaded = mocks.saveSolution.mock.calls[0][2] as string;
        expect(uploaded).toContain('public class Main {');
        expect(uploaded).toContain('new Main();');
        expect(uploaded).not.toContain('public class ProblemA');
        expect(mocks.saveSolution.mock.calls[0][1]).toBe('ProblemA.JAVA');
      });

      it.each(['sol-a.java', '1a.java', 'class.java'])(
        'leaves %s byte-identical when the base name is not an identifier',
        async source => {
          const { sdk, mocks } = buildSdk();
          const code = 'public class Main {\n  Main() {}\n}\n';
          mockedReadFileSync.mockReturnValue(code);
          mockedExistsSync.mockReturnValue(true);
          const cfg = asConfig({
            solutions: [{ name: 'a', source, tag: 'MA' }],
          });

          await pushing.uploadSolutions(sdk, 1, 'dir', cfg);

          expect(mocks.saveSolution.mock.calls[0][2]).toBe(code);
        }
      );

      it('renames to Main in CRLF input, then normalizes line endings', async () => {
        const actual = await vi.importActual<
          typeof import('../../../src/helpers/remote/utils')
        >('../../../src/helpers/remote/utils');
        vi.mocked(
          normalizeLineEndingsFromSystemToRemote
        ).mockImplementationOnce(actual.normalizeLineEndingsFromSystemToRemote);
        const { sdk, mocks } = buildSdk();
        const crlf =
          'public class ProblemA {\r\n  ProblemA() {}\r\n  String s = "ProblemA";\r\n}\r\n';
        mockedReadFileSync.mockReturnValue(crlf);
        mockedExistsSync.mockReturnValue(true);
        const cfg = asConfig({
          solutions: [{ name: 'a', source: 'ProblemA.java', tag: 'MA' }],
        });

        await pushing.uploadSolutions(sdk, 1, 'dir', cfg);

        // The rename sees the CRLF text and normalization receives its result.
        const renamed =
          'public class Main {\r\n  Main() {}\r\n  String s = "ProblemA";\r\n}\r\n';
        expect(normalizeLineEndingsFromSystemToRemote).toHaveBeenCalledWith(
          renamed
        );
        // Remote text is CRLF with no stray bare LF or doubled CR.
        expect(mocks.saveSolution.mock.calls[0][2]).toBe(renamed);
      });

      it('leaves C++ solutions unchanged', async () => {
        const { sdk, mocks } = buildSdk();
        const code = 'class ProblemA {};\n';
        mockedReadFileSync.mockReturnValue(code);
        mockedExistsSync.mockReturnValue(true);
        const cfg = asConfig({
          solutions: [{ name: 'a', source: 'ProblemA.cpp', tag: 'MA' }],
        });

        await pushing.uploadSolutions(sdk, 1, 'dir', cfg);

        expect(mocks.saveSolution.mock.calls[0][2]).toBe(code);
      });
    });
  });

  describe('uploadSolutions error reporting', () => {
    it('should include the sdk error message in the warning', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      mocks.saveSolution.mockRejectedValue(new Error('quota exceeded'));

      const result = await pushing.uploadSolutions(sdk, 1, 'dir', mockConfig);
      expect(result).toBe(0);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fmt.warning).toHaveBeenCalledWith(
        expect.stringContaining('sol: quota exceeded')
      );
    });
  });

  describe('failure recording', () => {
    it('should record a failed solution upload', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      mocks.saveSolution.mockRejectedValue(
        new Error("Unknown file type 'java.11'")
      );
      const failures: string[] = [];
      const result = await pushing.uploadSolutions(
        sdk,
        1,
        'dir',
        mockConfig,
        failures
      );
      expect(result).toBe(0);
      expect(failures).toEqual(["solution sol: Unknown file type 'java.11'"]);
    });

    it('should record each failed checker test upload and keep going', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(true);
      const test = {
        input: 'in',
        output: 'out',
        answer: 'ans',
        expectedVerdict: 'OK',
      };
      mockReadFileSyncWith(p =>
        String(p).includes('tests.json')
          ? JSON.stringify({
              tests: [
                { index: 1, ...test },
                { index: 2, ...test },
                { index: 3, ...test },
              ],
            })
          : 'code'
      );
      mocks.saveCheckerTest
        .mockRejectedValueOnce(new Error('bad test'))
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('worse test'));
      const failures: string[] = [];
      const cfg = asConfig({
        checker: {
          name: 'c',
          source: 'check.cpp',
          testsFilePath: 'tests.json',
        },
      });
      await pushing.uploadChecker(sdk, 1, 'dir', cfg, failures);
      expect(mocks.saveCheckerTest).toHaveBeenCalledTimes(3);
      expect(failures).toEqual([
        'checker test #1: bad test',
        'checker test #3: worse test',
      ]);
    });

    it('should record each failed validator test upload and keep going', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(true);
      mockReadFileSyncWith(p =>
        String(p).includes('tests.json')
          ? JSON.stringify({
              tests: [
                { input: '1', expectedVerdict: 'VALID' },
                { input: '2', expectedVerdict: 'VALID' },
                { input: '-1', expectedVerdict: 'INVALID' },
              ],
            })
          : 'code'
      );
      mocks.saveValidatorTest
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('bad test'))
        .mockResolvedValueOnce(undefined);
      const failures: string[] = [];
      const cfg = asConfig({
        validator: {
          name: 'v',
          source: 'val.cpp',
          testsFilePath: 'tests.json',
        },
      });
      const result = await pushing.uploadValidator(
        sdk,
        1,
        'dir',
        cfg,
        failures
      );
      expect(result).toBe(1);
      expect(mocks.saveValidatorTest).toHaveBeenCalledTimes(3);
      expect(mocks.saveValidatorTest).toHaveBeenLastCalledWith(
        1,
        3,
        '-1',
        'INVALID'
      );
      expect(failures).toEqual(['validator test #2: bad test']);
    });

    it('should record a failed validator upload', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue('code');
      mocks.setValidator.mockRejectedValue(new Error('nope'));
      const failures: string[] = [];
      const result = await pushing.uploadValidator(
        sdk,
        1,
        'dir',
        mockConfig,
        failures
      );
      expect(result).toBe(0);
      expect(failures).toEqual(['validator: nope']);
    });

    it('should record a failed generator upload', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue('code');
      mocks.saveFile.mockRejectedValue(new Error('nope'));
      const failures: string[] = [];
      const cfg = asConfig({
        generators: [{ name: 'gen', source: 'gen.cpp' }],
      });
      await pushing.uploadGenerators(sdk, 1, 'dir', cfg, failures);
      expect(failures).toEqual(['generator gen: nope']);
    });

    it('should record a failed statement upload', async () => {
      const { sdk, mocks } = buildSdk();
      mocks.saveStatement.mockRejectedValue(new Error('nope'));
      const failures: string[] = [];
      await pushing.uploadStatements(sdk, 1, 'dir', mockConfig, failures);
      expect(failures).toEqual(['statement english: nope']);
    });

    it('should record failed description and tags uploads', async () => {
      const { sdk, mocks } = buildSdk();
      mocks.saveGeneralDescription.mockRejectedValue(new Error('d'));
      mocks.saveTags.mockRejectedValue(new Error('t'));
      const failures: string[] = [];
      await pushing.uploadMetadata(
        sdk,
        1,
        asConfig({ description: 'x', tags: ['dp'] }),
        failures
      );
      expect(failures).toEqual(['description: d', 'tags: t']);
    });

    it('should record a testset with a missing manual test file', async () => {
      const { sdk } = buildSdk();
      mockedExistsSync.mockReturnValue(false);
      const failures: string[] = [];
      const cfg = asConfig({
        testsets: [
          {
            name: 'tests',
            manualTests: [{ input: 'missing.txt', index: 1 }],
          },
        ],
      });
      await pushing.uploadTestsets(sdk, 1, 'dir', cfg, failures);
      expect(failures).toEqual([
        'testset tests manual test missing.txt: Manual test file not found: missing.txt',
        'testset tests tests: Manual test input not found: missing.txt',
      ]);
    });

    it('should record a failed generator script upload', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(true);
      mocks.saveScript.mockImplementation(
        (_id: number, _n: string, script: string) =>
          script === ' '
            ? Promise.resolve(undefined)
            : Promise.reject(new Error('s'))
      );
      const failures: string[] = [];
      const cfg = asConfig({
        generators: [{ name: 'gen', source: './gen.cpp' }],
        testsets: [{ name: 'tests', generatorScript: { script: 'gen 1 > $' } }],
      });
      await pushing.uploadTestsets(sdk, 1, 'dir', cfg, failures);
      expect(failures).toEqual(['testset tests script: s']);
    });

    it('should record a failed testset clear when enableGroups rejects', async () => {
      const { sdk, mocks } = buildSdk();
      mocks.enableGroups.mockRejectedValue(new Error('c'));
      const failures: string[] = [];
      const cfg = asConfig({
        generators: [{ name: 'gen', source: './gen.cpp' }],
        testsets: [{ name: 'tests', generatorScript: { script: 'gen 1 > $' } }],
      });
      await pushing.uploadTestsets(sdk, 1, 'dir', cfg, failures);
      expect(failures).toEqual(['testset tests clear: c']);
    });

    it('should record a failed testset clear when saveScript rejects', async () => {
      const { sdk, mocks } = buildSdk();
      mocks.saveScript.mockImplementation(
        (_id: number, _n: string, script: string) =>
          script === ' '
            ? Promise.reject(new Error('c'))
            : Promise.resolve(undefined)
      );
      const failures: string[] = [];
      const cfg = asConfig({
        generators: [{ name: 'gen', source: './gen.cpp' }],
        testsets: [{ name: 'tests', generatorScript: { script: 'gen 1 > $' } }],
      });
      await pushing.uploadTestsets(sdk, 1, 'dir', cfg, failures);
      expect(failures).toEqual(['testset tests clear: c']);
    });

    it('should record a failed enableGroups call', async () => {
      const { sdk, mocks } = buildSdk();
      mocks.enableGroups.mockImplementation(
        (_id: number, _name: string, on: boolean) =>
          on ? Promise.reject(new Error('g')) : Promise.resolve(undefined)
      );
      const failures: string[] = [];
      const cfg = asConfig({
        generators: [{ name: 'gen', source: './gen.cpp' }],
        testsets: [
          {
            name: 'tests',
            groupsEnabled: true,
            generatorScript: { script: 'gen 1 > $' },
          },
        ],
      });
      await pushing.uploadTestsets(sdk, 1, 'dir', cfg, failures);
      expect(failures).toEqual(['testset tests groups: g']);
    });

    it('should record failed manual test uploads', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue('m');
      mocks.saveTest.mockRejectedValue(new Error('m'));
      const failures: string[] = [];
      const cfg = asConfig({
        testsets: [
          { name: 'tests', manualTests: [{ input: 'm.txt', index: 1 }] },
        ],
      });
      await pushing.uploadTestsets(sdk, 1, 'dir', cfg, failures);
      expect(failures).toEqual(['testset tests manual test m.txt: m']);
    });

    it('should await started manual uploads when a later manual file is missing (#115)', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockImplementation(
        (p: PathLike) => !String(p).endsWith('m2.txt')
      );
      mockedReadFileSync.mockReturnValue('m');
      // A plain function, not vi.fn: vitest attaches a .then to promises
      // returned by its mocks, which would mark the rejection as handled
      // and hide the bug.
      (sdk as unknown as { saveTest: unknown }).saveTest = () =>
        Promise.reject(new Error('saveTest m1'));
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);
      const failures: string[] = [];
      const cfg = asConfig({
        generators: [{ name: 'gen', source: './gen.cpp' }],
        testsets: [
          {
            name: 'tests',
            generatorScript: { script: 'gen 1 > $' },
            manualTests: [
              { input: 'm1.txt', index: 2 },
              { input: 'm2.txt', index: 3 },
            ],
          },
        ],
      });
      try {
        const result = await pushing.uploadTestsets(
          sdk,
          1,
          'dir',
          cfg,
          failures
        );
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(unhandled).toEqual([]);
        expect(failures).toEqual([
          'testset tests manual test m2.txt: Manual test file not found: m2.txt',
          'testset tests manual test m1.txt: saveTest m1',
          // The test list cannot be resolved without m2.txt either.
          'testset tests tests: Manual test input not found: m2.txt',
        ]);
        expect(result.manualsCount).toBe(0);
        // The push goes on with the generator script after the manual tests.
        expect(mocks.saveScript).toHaveBeenCalledWith(
          1,
          'tests',
          expect.stringContaining('gen 1 > $')
        );
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('should read every manual input before uploading and count only uploaded tests', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(true);
      mockReadFileSyncWith(p => {
        if (String(p).endsWith('m2.txt')) throw new Error('EACCES');
        return 'm';
      });
      const failures: string[] = [];
      const cfg = asConfig({
        testsets: [
          {
            name: 'tests',
            manualTests: [
              { input: 'm1.txt', index: 1 },
              { input: 'm2.txt', index: 2 },
            ],
          },
        ],
      });
      const result = await pushing.uploadTestsets(sdk, 1, 'dir', cfg, failures);
      expect(failures[0]).toBe('testset tests manual test m2.txt: EACCES');
      expect(mocks.saveTest).toHaveBeenCalledTimes(1);
      expect(result.manualsCount).toBe(1);
    });

    it('should record a failure when the tests cannot be resolved', async () => {
      const { sdk } = buildSdk();
      const failures: string[] = [];
      const cfg = asConfig({
        generators: [{ name: 'gen', source: './gen.cpp' }],
        testsets: [
          { name: 'tests', generatorScript: { script: 'unknown 1 > $' } },
        ],
      });
      await pushing.uploadTestsets(sdk, 1, 'dir', cfg, failures);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatch(/^testset tests tests: /);
    });

    it('should record a failed setTestGroup call', async () => {
      const { sdk, mocks } = buildSdk();
      mocks.setTestGroup.mockRejectedValue(new Error('sg'));
      const failures: string[] = [];
      const cfg = asConfig({
        generators: [{ name: 'gen', source: './gen.cpp' }],
        testsets: [
          {
            name: 'tests',
            generatorScript: { script: '<#-- @group g1 -->\ngen 1 > $' },
          },
        ],
      });
      await pushing.uploadTestsets(sdk, 1, 'dir', cfg, failures);
      expect(failures).toEqual(['testset tests group g1: sg']);
    });

    it('should leave failures empty when everything uploads', async () => {
      const { sdk } = buildSdk();
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue('code');
      const failures: string[] = [];
      await pushing.uploadSolutions(sdk, 1, 'dir', mockConfig, failures);
      expect(failures).toEqual([]);
    });
  });

  describe('uploadChecker', () => {
    it('should upload custom checker successfully', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);

      const result = await pushing.uploadChecker(sdk, 1, 'dir', mockConfig);

      expect(mocks.saveFile).toHaveBeenCalledWith(
        1,
        'source',
        'check.cpp',
        'code',
        { sourceType: 'cpp.g++17', checkExisting: false }
      );
      expect(mocks.setChecker).toHaveBeenCalledWith(1, 'check.cpp');
      expect(result).toBe(1);
    });

    it('should honor the checker sourceType from Config.json', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      const cfg = asConfig({
        checker: {
          name: 'check',
          source: 'check.cc',
          sourceType: 'cpp.gcc14-64-msys2-g++23',
        },
      });

      await pushing.uploadChecker(sdk, 1, 'dir', cfg);

      expect(mocks.saveFile).toHaveBeenCalledWith(
        1,
        'source',
        'check.cc',
        'code',
        { sourceType: 'cpp.gcc14-64-msys2-g++23', checkExisting: false }
      );
      expect(mocks.setChecker).toHaveBeenCalledWith(1, 'check.cc');
    });

    it('should reject an unsupported Java checker type without calling the sdk', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      const cfg = asConfig({
        checker: { name: 'check', source: 'Check.java', sourceType: 'java.11' },
      });

      await expect(pushing.uploadChecker(sdk, 1, 'dir', cfg)).rejects.toThrow(
        /Unsupported Java sourceType 'java.11'/
      );
      expect(mocks.saveFile).not.toHaveBeenCalled();
      expect(mocks.setChecker).not.toHaveBeenCalled();
    });

    it('should set standard checker without uploading file', async () => {
      const { sdk, mocks } = buildSdk();
      const cfg = asConfig({
        checker: { name: 'wcmp', source: 'wcmp.cpp', isStandard: true },
      });

      const result = await pushing.uploadChecker(sdk, 1, 'dir', cfg);

      expect(mocks.setChecker).toHaveBeenCalledWith(1, 'std::wcmp.cpp');
      expect(mocks.saveFile).not.toHaveBeenCalled();
      expect(result).toBe(1);
    });

    it('should return 0 when no checker configured', async () => {
      const { sdk } = buildSdk();
      const result = await pushing.uploadChecker(sdk, 1, 'dir', asConfig({}));
      expect(result).toBe(0);
    });

    it('should throw if checker source file is missing', async () => {
      const { sdk } = buildSdk();
      mockedExistsSync.mockReturnValue(false);
      await expect(
        pushing.uploadChecker(sdk, 1, 'dir', mockConfig)
      ).rejects.toThrow();
    });

    it('should upload checker tests when testsFilePath is set', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(true);
      mockReadFileSyncWith(p => {
        if (String(p).includes('tests.json')) {
          return JSON.stringify({
            tests: [
              {
                index: 1,
                input: 'in',
                output: 'out',
                answer: 'ans',
                expectedVerdict: 'OK',
              },
            ],
          });
        }
        return 'code';
      });

      const cfg = asConfig({
        checker: {
          name: 'c',
          source: 'check.cpp',
          testsFilePath: 'tests.json',
        },
      });

      const result = await pushing.uploadChecker(sdk, 1, 'dir', cfg);

      expect(mocks.saveCheckerTest).toHaveBeenCalledWith(
        1,
        1,
        'in',
        'out',
        'ans',
        'OK'
      );
      expect(result).toBe(1);
    });

    it.each([
      ['malformed', () => 'not json'],
      [
        'unreadable',
        () => {
          throw new Error('EACCES');
        },
      ],
    ])(
      'should record a checker tests file that is %s and keep the checker',
      async (_kind, readTests) => {
        const { sdk, mocks } = buildSdk();
        mockedExistsSync.mockReturnValue(true);
        mockReadFileSyncWith(p => {
          if (String(p).includes('tests.json')) return readTests();
          return 'code';
        });

        const cfg = asConfig({
          checker: {
            name: 'c',
            source: 'check.cpp',
            testsFilePath: 'tests.json',
          },
        });

        const failures: string[] = [];
        const result = await pushing.uploadChecker(
          sdk,
          1,
          'dir',
          cfg,
          failures
        );
        expect(result).toBe(1);
        expect(mocks.saveCheckerTest).not.toHaveBeenCalled();
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatch(/^checker tests: /);
      }
    );

    it('should skip incomplete checker tests', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(true);
      mockReadFileSyncWith(p => {
        if (String(p).includes('tests.json')) {
          return JSON.stringify({
            tests: [{ index: 1, input: 'in' }],
          });
        }
        return 'code';
      });

      const cfg = asConfig({
        checker: {
          name: 'c',
          source: 'check.cpp',
          testsFilePath: 'tests.json',
        },
      });

      const result = await pushing.uploadChecker(sdk, 1, 'dir', cfg);
      expect(result).toBe(1);
      expect(mocks.saveCheckerTest).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fmt.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          'Skipped checker test #1: missing output, answer, expectedVerdict'
        )
      );
    });

    function checkerCfgWithTests(tests: unknown[]): ConfigFile {
      mockedExistsSync.mockReturnValue(true);
      mockReadFileSyncWith(p =>
        String(p).includes('tests.json') ? JSON.stringify({ tests }) : 'code'
      );
      return asConfig({
        checker: {
          name: 'c',
          source: 'check.cpp',
          testsFilePath: 'tests.json',
        },
      });
    }

    it('should number checker tests without an index (template format)', async () => {
      const { sdk, mocks } = buildSdk();
      const cfg = checkerCfgWithTests([
        {
          input: 'MY BE INGNORED',
          output: 'YeS',
          answer: 'YES',
          expectedVerdict: 'OK',
        },
      ]);

      await pushing.uploadChecker(sdk, 1, 'dir', cfg);

      expect(mocks.saveCheckerTest).toHaveBeenCalledTimes(1);
      expect(mocks.saveCheckerTest).toHaveBeenCalledWith(
        1,
        1,
        'MY BE INGNORED',
        'YeS',
        'YES',
        'OK'
      );
    });

    it('should number several checker tests without an index as 1, 2, 3', async () => {
      const { sdk, mocks } = buildSdk();
      const t = { input: 'i', output: 'o', answer: 'a', expectedVerdict: 'OK' };
      const cfg = checkerCfgWithTests([t, t, t]);

      await pushing.uploadChecker(sdk, 1, 'dir', cfg);

      const indexes = mocks.saveCheckerTest.mock.calls.map(c => c[1] as number);
      expect(indexes).toEqual([1, 2, 3]);
    });

    it('should not reuse an index that another checker test declares', async () => {
      const { sdk, mocks } = buildSdk();
      const t = { input: 'i', output: 'o', answer: 'a', expectedVerdict: 'OK' };
      const cfg = checkerCfgWithTests([
        t,
        { ...t, index: 1 },
        t,
        { ...t, index: 3 },
      ]);

      await pushing.uploadChecker(sdk, 1, 'dir', cfg);

      const indexes = mocks.saveCheckerTest.mock.calls.map(c => c[1] as number);
      expect(indexes).toEqual([2, 1, 4, 3]);
    });

    it('should treat a string index as declared and send it as a number', async () => {
      const { sdk, mocks } = buildSdk();
      const t = { input: 'i', output: 'o', answer: 'a', expectedVerdict: 'OK' };
      const cfg = checkerCfgWithTests([t, t, { ...t, index: '2' }]);

      await pushing.uploadChecker(sdk, 1, 'dir', cfg);

      const indexes = mocks.saveCheckerTest.mock.calls.map(c => c[1] as number);
      expect(indexes).toEqual([1, 3, 2]);
    });

    it.each([0, -1, 1.5, 'abc', ''])(
      'should warn and renumber a checker test with invalid index %j',
      async bad => {
        const { sdk, mocks } = buildSdk();
        const t = {
          input: 'i',
          output: 'o',
          answer: 'a',
          expectedVerdict: 'OK',
        };
        const cfg = checkerCfgWithTests([{ ...t, index: bad }, t]);

        await pushing.uploadChecker(sdk, 1, 'dir', cfg);

        const indexes = mocks.saveCheckerTest.mock.calls.map(
          c => c[1] as number
        );
        expect(indexes).toEqual([1, 2]);
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(fmt.warning).toHaveBeenCalledWith(
          expect.stringContaining('Checker test #1 has an invalid index')
        );
      }
    );

    it('should warn when two checker tests declare the same index', async () => {
      const { sdk, mocks } = buildSdk();
      const t = { input: 'i', output: 'o', answer: 'a', expectedVerdict: 'OK' };
      const cfg = checkerCfgWithTests([
        { ...t, index: 2 },
        { ...t, index: 2 },
        t,
      ]);

      await pushing.uploadChecker(sdk, 1, 'dir', cfg);

      const indexes = mocks.saveCheckerTest.mock.calls.map(c => c[1] as number);
      expect(indexes).toEqual([2, 2, 1]);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fmt.warning).toHaveBeenCalledWith(
        expect.stringContaining('Checker test #2 repeats index 2')
      );
    });

    it('should upload a checker test with an empty output', async () => {
      const { sdk, mocks } = buildSdk();
      const cfg = checkerCfgWithTests([
        { input: 'i', output: '', answer: 'a', expectedVerdict: 'WA' },
      ]);

      await pushing.uploadChecker(sdk, 1, 'dir', cfg);

      expect(mocks.saveCheckerTest).toHaveBeenCalledWith(
        1,
        1,
        'i',
        '',
        'a',
        'WA'
      );
    });

    it('should report only the truly absent field as missing', async () => {
      const { sdk, mocks } = buildSdk();
      const cfg = checkerCfgWithTests([
        { input: 'i', output: '', expectedVerdict: 'OK' },
      ]);

      await pushing.uploadChecker(sdk, 1, 'dir', cfg);

      expect(mocks.saveCheckerTest).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fmt.warning).toHaveBeenCalledWith(
        expect.stringMatching(/Skipped checker test #1: missing answer$/)
      );
    });

    it('should warn and continue when one checker test fails to upload', async () => {
      const { sdk, mocks } = buildSdk();
      mocks.saveCheckerTest
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(undefined);
      const t = { input: 'i', output: 'o', answer: 'a', expectedVerdict: 'OK' };
      const cfg = checkerCfgWithTests([t, t]);

      const result = await pushing.uploadChecker(sdk, 1, 'dir', cfg);

      expect(result).toBe(1);
      expect(mocks.saveCheckerTest).toHaveBeenCalledTimes(2);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fmt.warning).toHaveBeenCalledWith(
        expect.stringContaining('Failed to upload checker test #1')
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fmt.warning).toHaveBeenCalledWith(expect.stringContaining('boom'));
    });

    it('should skip tests upload when testsFilePath does not exist on disk', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockImplementation(
        (p: PathLike) => !String(p).includes('tests.json')
      );
      mockedReadFileSync.mockReturnValue('code');

      const cfg = asConfig({
        checker: {
          name: 'c',
          source: 'check.cpp',
          testsFilePath: 'tests.json',
        },
      });

      const result = await pushing.uploadChecker(sdk, 1, 'dir', cfg);
      expect(result).toBe(1);
      expect(mocks.saveCheckerTest).not.toHaveBeenCalled();
    });
  });

  describe('uploadValidator', () => {
    it('should upload validator successfully', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);

      const result = await pushing.uploadValidator(sdk, 1, 'dir', mockConfig);

      expect(mocks.saveFile).toHaveBeenCalledWith(
        1,
        'source',
        'val.cpp',
        'code',
        { sourceType: 'cpp.g++17', checkExisting: false }
      );
      expect(mocks.setValidator).toHaveBeenCalledWith(1, 'val.cpp');
      expect(result).toBe(1);
    });

    it('should honor the validator sourceType from Config.json', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      const cfg = asConfig({
        validator: {
          name: 'val',
          source: 'val.cpp',
          sourceType: 'cpp.gcc13-64-winlibs-g++20',
        },
      });

      await pushing.uploadValidator(sdk, 1, 'dir', cfg);

      expect(mocks.saveFile).toHaveBeenCalledWith(
        1,
        'source',
        'val.cpp',
        'code',
        { sourceType: 'cpp.gcc13-64-winlibs-g++20', checkExisting: false }
      );
    });

    it('should return 0 and not call the sdk for an unsupported Java validator type', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      const cfg = asConfig({
        validator: { name: 'val', source: 'Val.java', sourceType: 'java.11' },
      });

      const result = await pushing.uploadValidator(sdk, 1, 'dir', cfg);

      expect(result).toBe(0);
      expect(mocks.saveFile).not.toHaveBeenCalled();
      expect(mocks.setValidator).not.toHaveBeenCalled();
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fmt.warning).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported Java sourceType 'java.11'")
      );
    });

    it('should return 0 when no validator configured', async () => {
      const { sdk } = buildSdk();
      const result = await pushing.uploadValidator(sdk, 1, 'dir', asConfig({}));
      expect(result).toBe(0);
    });

    it('should return 0 when validator source missing', async () => {
      const { sdk } = buildSdk();
      mockedExistsSync.mockReturnValue(false);
      const result = await pushing.uploadValidator(sdk, 1, 'dir', mockConfig);
      expect(result).toBe(0);
    });

    it('should upload validator tests', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(true);
      mockReadFileSyncWith(p => {
        if (String(p).includes('tests.json')) {
          return JSON.stringify({
            tests: [
              { index: 1, input: 'a', expectedVerdict: 'VALID' },
              { input: 'b', expectedVerdict: 'INVALID' },
            ],
          });
        }
        return 'code';
      });

      const cfg = asConfig({
        validator: {
          name: 'v',
          source: 'val.cpp',
          testsFilePath: 'tests.json',
        },
      });

      const result = await pushing.uploadValidator(sdk, 1, 'dir', cfg);
      expect(result).toBe(1);
      expect(mocks.saveValidatorTest).toHaveBeenCalledWith(1, 1, 'a', 'VALID');
      expect(mocks.saveValidatorTest).toHaveBeenCalledWith(
        1,
        1,
        'b',
        'INVALID'
      );
    });

    it.each([
      ['malformed', () => 'not json'],
      [
        'unreadable',
        () => {
          throw new Error('EACCES');
        },
      ],
    ])(
      'should record a validator tests file that is %s and keep the validator',
      async (_kind, readTests) => {
        const { sdk, mocks } = buildSdk();
        mockedExistsSync.mockReturnValue(true);
        mockReadFileSyncWith(p => {
          if (String(p).includes('tests.json')) return readTests();
          return 'code';
        });

        const cfg = asConfig({
          validator: {
            name: 'v',
            source: 'val.cpp',
            testsFilePath: 'tests.json',
          },
        });

        const failures: string[] = [];
        const result = await pushing.uploadValidator(
          sdk,
          1,
          'dir',
          cfg,
          failures
        );
        expect(result).toBe(1);
        expect(mocks.saveValidatorTest).not.toHaveBeenCalled();
        expect(failures).toHaveLength(1);
        expect(failures[0]).toMatch(/^validator tests: /);
      }
    );

    it('should swallow sdk failure and return 0', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      mocks.saveFile.mockRejectedValue(new Error('boom'));

      const result = await pushing.uploadValidator(sdk, 1, 'dir', mockConfig);
      expect(result).toBe(0);
    });
  });

  describe('uploadGenerators', () => {
    it('should upload generators successfully', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      const cfg = asConfig({
        generators: [
          { name: 'g1', source: 'g1.cpp' },
          { name: 'g2', source: 'g2.py' },
        ],
      });

      const result = await pushing.uploadGenerators(sdk, 1, 'dir', cfg);
      expect(result).toBe(2);
      expect(mocks.saveFile).toHaveBeenCalledTimes(2);
      expect(mocks.saveFile).toHaveBeenCalledWith(
        1,
        'source',
        'g1.cpp',
        'code',
        { sourceType: 'cpp.g++17', checkExisting: false }
      );
      expect(mocks.saveFile).toHaveBeenCalledWith(
        1,
        'source',
        'g2.py',
        'code',
        { sourceType: 'python.3', checkExisting: false }
      );
    });

    it('should honor the generator sourceType from Config.json', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      const cfg = asConfig({
        generators: [
          {
            name: 'g1',
            source: 'g1.cxx',
            sourceType: 'cpp.gcc14-64-msys2-g++23',
          },
        ],
      });

      await pushing.uploadGenerators(sdk, 1, 'dir', cfg);

      expect(mocks.saveFile).toHaveBeenCalledWith(
        1,
        'source',
        'g1.cxx',
        'code',
        { sourceType: 'cpp.gcc14-64-msys2-g++23', checkExisting: false }
      );
    });

    it('should warn and skip a generator with an unsupported Java type, then upload the next', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      const cfg = asConfig({
        generators: [
          { name: 'bad', source: 'Gen.java', sourceType: 'java.21' },
          { name: 'good', source: 'g1.cpp' },
        ],
      });

      const result = await pushing.uploadGenerators(sdk, 1, 'dir', cfg);

      expect(result).toBe(1);
      expect(mocks.saveFile).toHaveBeenCalledTimes(1);
      expect(mocks.saveFile).toHaveBeenCalledWith(
        1,
        'source',
        'g1.cpp',
        'code',
        expect.objectContaining({ sourceType: 'cpp.g++17' })
      );
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fmt.warning).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported Java sourceType 'java.21'")
      );
    });

    it('should return 0 when generators undefined', async () => {
      const { sdk } = buildSdk();
      const result = await pushing.uploadGenerators(
        sdk,
        1,
        'dir',
        asConfig({})
      );
      expect(result).toBe(0);
    });

    it('should return 0 when generators empty', async () => {
      const { sdk } = buildSdk();
      const result = await pushing.uploadGenerators(
        sdk,
        1,
        'dir',
        asConfig({ generators: [] })
      );
      expect(result).toBe(0);
    });

    it('should detect java generator source type', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      const cfg = asConfig({
        generators: [{ name: 'g', source: 'Gen.java' }],
      });
      await pushing.uploadGenerators(sdk, 1, 'dir', cfg);
      expect(mocks.saveFile).toHaveBeenCalledWith(
        1,
        'source',
        'Gen.java',
        'code',
        expect.objectContaining({ sourceType: 'java21' })
      );
    });

    it('should warn and skip missing generator files', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(false);
      const cfg = asConfig({
        generators: [{ name: 'g', source: 'gen.cpp' }],
      });
      const result = await pushing.uploadGenerators(sdk, 1, 'dir', cfg);
      expect(result).toBe(0);
      expect(mocks.saveFile).not.toHaveBeenCalled();
    });

    it('should surface the underlying error message on generator failure', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      mocks.saveFile.mockRejectedValue(
        new Error('Polygon API Error: sourceType: unknown')
      );
      const cfg = asConfig({
        generators: [{ name: 'gen', source: './generators/gen.cpp' }],
      });

      const result = await pushing.uploadGenerators(sdk, 1, 'dir', cfg);
      expect(result).toBe(0);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fmt.warning).toHaveBeenCalledWith(
        expect.stringContaining('gen: Polygon API Error: sourceType: unknown')
      );
    });

    it('should keep counting on partial sdk failure', async () => {
      const { sdk, mocks } = buildSdk();
      mockedReadFileSync.mockReturnValue('code');
      mockedExistsSync.mockReturnValue(true);
      mocks.saveFile
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('boom'));
      const cfg = asConfig({
        generators: [
          { name: 'a', source: 'a.cpp' },
          { name: 'b', source: 'b.cpp' },
        ],
      });
      const result = await pushing.uploadGenerators(sdk, 1, 'dir', cfg);
      expect(result).toBe(1);
    });
  });

  describe('uploadStatements', () => {
    it('should return 0 when no statements', async () => {
      const { sdk } = buildSdk();
      const result = await pushing.uploadStatements(
        sdk,
        1,
        'dir',
        asConfig({})
      );
      expect(result).toBe(0);
    });

    it('should upload statement with all components present', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(true);
      mockReadFileSyncWith(p => `content-${String(p)}`);

      const cfg = asConfig({
        name: 'Default',
        statements: {
          english: {
            encoding: 'UTF-8',
            name: 'My Problem',
            legend: 'legend.tex',
            input: 'input.tex',
            output: 'output.tex',
            notes: 'notes.tex',
            tutorial: 'tutorial.tex',
            interaction: 'interaction.tex',
            scoring: 'scoring.tex',
          },
        },
      });

      const result = await pushing.uploadStatements(sdk, 1, 'dir', cfg);
      expect(result).toBe(1);
      expect(mocks.saveStatement).toHaveBeenCalledWith(
        1,
        'english',
        expect.objectContaining({
          encoding: 'UTF-8',
          name: 'My Problem',
          legend: expect.any(String) as string,
          input: expect.any(String) as string,
          output: expect.any(String) as string,
          notes: expect.any(String) as string,
          tutorial: expect.any(String) as string,
          interaction: expect.any(String) as string,
          scoring: expect.any(String) as string,
        })
      );
    });

    it('should skip non-existent statement component files', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(false);

      const cfg = asConfig({
        name: 'Default',
        statements: {
          english: {
            encoding: 'UTF-8',
            name: 'My Problem',
            legend: 'legend.tex',
            input: 'input.tex',
            output: 'output.tex',
            notes: 'notes.tex',
            tutorial: 'tutorial.tex',
            interaction: 'interaction.tex',
            scoring: 'scoring.tex',
          },
        },
      });

      const result = await pushing.uploadStatements(sdk, 1, 'dir', cfg);
      expect(result).toBe(1);
      const firstCall = mocks.saveStatement.mock.calls[0] as [
        number,
        string,
        Record<string, string | undefined>,
      ];
      const statementData = firstCall[2];
      expect(statementData.legend).toBeUndefined();
      expect(statementData.input).toBeUndefined();
    });

    it('should fall back to config.name when statement.name missing', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(false);
      const cfg = asConfig({
        name: 'FallbackName',
        statements: {
          english: {
            encoding: 'UTF-8',
          } as unknown as ConfigFile['statements'][string],
        },
      });
      await pushing.uploadStatements(sdk, 1, 'dir', cfg);
      expect(mocks.saveStatement).toHaveBeenCalledWith(
        1,
        'english',
        expect.objectContaining({ name: 'FallbackName', encoding: 'UTF-8' })
      );
    });

    it('should default encoding to UTF-8', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(false);
      const cfg = asConfig({
        name: 'P',
        statements: {
          english: { name: 'X' } as unknown as ConfigFile['statements'][string],
        },
      });
      await pushing.uploadStatements(sdk, 1, 'dir', cfg);
      expect(mocks.saveStatement).toHaveBeenCalledWith(
        1,
        'english',
        expect.objectContaining({ encoding: 'UTF-8' })
      );
    });

    it('should warn and continue on per-language failure', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(false);
      mocks.saveStatement
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce(undefined);
      const cfg = asConfig({
        name: 'P',
        statements: {
          english: { encoding: 'UTF-8', name: 'X' },
          russian: { encoding: 'UTF-8', name: 'Y' },
        },
      });
      const result = await pushing.uploadStatements(sdk, 1, 'dir', cfg);
      expect(result).toBe(1);
    });
  });

  describe('uploadMetadata', () => {
    it('should upload description and tags', async () => {
      const { sdk, mocks } = buildSdk();
      const cfg = asConfig({ description: 'desc', tags: ['dp', 'graphs'] });
      const result = await pushing.uploadMetadata(sdk, 1, cfg);
      expect(result).toBe(2);
      expect(mocks.saveGeneralDescription).toHaveBeenCalledWith(1, 'desc');
      expect(mocks.saveTags).toHaveBeenCalledWith(1, ['dp', 'graphs']);
    });

    it('should return 0 when no metadata', async () => {
      const { sdk } = buildSdk();
      const result = await pushing.uploadMetadata(sdk, 1, asConfig({}));
      expect(result).toBe(0);
    });

    it('should upload only description when tags missing', async () => {
      const { sdk, mocks } = buildSdk();
      const result = await pushing.uploadMetadata(
        sdk,
        1,
        asConfig({ description: 'd' })
      );
      expect(result).toBe(1);
      expect(mocks.saveGeneralDescription).toHaveBeenCalled();
      expect(mocks.saveTags).not.toHaveBeenCalled();
    });

    it('should still count description even if tags upload fails', async () => {
      const { sdk, mocks } = buildSdk();
      mocks.saveTags.mockRejectedValue(new Error('boom'));
      const cfg = asConfig({ description: 'd', tags: ['x'] });
      const result = await pushing.uploadMetadata(sdk, 1, cfg);
      expect(result).toBe(1);
    });

    it('should still count tags even if description upload fails', async () => {
      const { sdk, mocks } = buildSdk();
      mocks.saveGeneralDescription.mockRejectedValue(new Error('boom'));
      const cfg = asConfig({ description: 'd', tags: ['x'] });
      const result = await pushing.uploadMetadata(sdk, 1, cfg);
      expect(result).toBe(1);
    });

    it('should accept empty description string', async () => {
      const { sdk, mocks } = buildSdk();
      const result = await pushing.uploadMetadata(
        sdk,
        1,
        asConfig({ description: '' })
      );
      expect(result).toBe(1);
      expect(mocks.saveGeneralDescription).toHaveBeenCalledWith(1, '');
    });
  });

  describe('updateProblemInfo', () => {
    it('should send all populated fields', async () => {
      const { sdk, mocks } = buildSdk();
      const cfg = asConfig({
        inputFile: 'in.txt',
        outputFile: 'out.txt',
        interactive: true,
        timeLimit: 1000,
        memoryLimit: 256,
      });
      await pushing.updateProblemInfo(sdk, 1, cfg);
      expect(mocks.updateProblemInfo).toHaveBeenCalledWith(1, {
        inputFile: 'in.txt',
        outputFile: 'out.txt',
        interactive: true,
        timeLimit: 1000,
        memoryLimit: 256,
      });
    });

    it('should send empty object when nothing set', async () => {
      const { sdk, mocks } = buildSdk();
      await pushing.updateProblemInfo(sdk, 1, asConfig({}));
      expect(mocks.updateProblemInfo).toHaveBeenCalledWith(1, {});
    });

    it('should include interactive=false explicitly', async () => {
      const { sdk, mocks } = buildSdk();
      await pushing.updateProblemInfo(sdk, 1, asConfig({ interactive: false }));
      expect(mocks.updateProblemInfo).toHaveBeenCalledWith(1, {
        interactive: false,
      });
    });
  });

  describe('uploadTestsets', () => {
    it('should return zeros when no testsets', async () => {
      const { sdk } = buildSdk();
      const result = await pushing.uploadTestsets(sdk, 1, 'dir', asConfig({}));
      expect(result).toEqual({ testsCount: 0, manualsCount: 0 });
    });

    it('should return zeros when testsets array empty', async () => {
      const { sdk } = buildSdk();
      const result = await pushing.uploadTestsets(
        sdk,
        1,
        'dir',
        asConfig({ testsets: [] })
      );
      expect(result).toEqual({ testsCount: 0, manualsCount: 0 });
    });

    it('should warn and skip testsets without commands', async () => {
      const { sdk, mocks } = buildSdk();
      const cfg = asConfig({
        testsets: [{ name: 'tests', generatorScript: {} }],
      });
      const result = await pushing.uploadTestsets(sdk, 1, 'dir', cfg);
      expect(result).toEqual({ testsCount: 0, manualsCount: 0 });
      expect(mocks.saveScript).toHaveBeenCalledWith(1, 'tests', ' ');
    });

    it('should upload manual tests and generator script', async () => {
      const { sdk, mocks } = buildSdk();
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue('manual-input');

      const cfg = asConfig({
        generators: [{ name: 'gen', source: './gen.cpp' }],
        testsets: [
          {
            name: 'tests',
            groupsEnabled: true,
            generatorScript: {
              script: '<#-- @group main -->\ngen 1 > $\ngen 2 > $\ngen 3 > $',
            },
            manualTests: [
              {
                input: 'm1.txt',
                index: 4,
                group: 'samples',
                points: 5,
                useInStatements: true,
              },
            ],
          },
        ],
      });

      const result = await pushing.uploadTestsets(sdk, 1, 'dir', cfg);

      expect(mocks.enableGroups).toHaveBeenCalledWith(1, 'tests', true);
      expect(mocks.saveScript).toHaveBeenCalledWith(
        1,
        'tests',
        expect.stringContaining('gen 1 > $')
      );
      expect(mocks.saveTest).toHaveBeenCalledWith(
        1,
        'tests',
        4,
        'manual-input',
        expect.objectContaining({
          testGroup: 'samples',
          testPoints: 5,
          testUseInStatements: true,
        })
      );
      expect(result.manualsCount).toBe(1);
      expect(result.testsCount).toBe(4);
    });

    it('should not count a manual test whose file is missing', async () => {
      const { sdk } = buildSdk();
      mockedExistsSync.mockReturnValue(false);

      const cfg = asConfig({
        testsets: [
          {
            name: 'tests',
            manualTests: [{ input: 'missing.txt', index: 1 }],
          },
        ],
      });

      const result = await pushing.uploadTestsets(sdk, 1, 'dir', cfg);
      expect(result.manualsCount).toBe(0);
    });

    it('should swallow enableGroups failure when groupsEnabled', async () => {
      const { sdk, mocks } = buildSdk();
      mocks.enableGroups.mockImplementation(
        (_id: number, _name: string, on: boolean) => {
          if (on) return Promise.reject(new Error('cannot enable'));
          return Promise.resolve(undefined);
        }
      );
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue('m');

      const cfg = asConfig({
        generators: [{ name: 'gen', source: './gen.cpp' }],
        testsets: [
          {
            name: 'tests',
            groupsEnabled: true,
            generatorScript: { script: 'gen 1 > $\ngen 2 > $' },
            manualTests: [{ input: 'm.txt', index: 3 }],
          },
        ],
      });

      const result = await pushing.uploadTestsets(sdk, 1, 'dir', cfg);
      expect(result.testsCount).toBe(3);
    });

    it('should not call saveTest for generator tests with no per-test metadata', async () => {
      const { sdk, mocks } = buildSdk();
      const cfg = asConfig({
        generators: [{ name: 'gen', source: './gen.cpp' }],
        testsets: [
          {
            name: 'tests',
            generatorScript: { script: 'gen 1 > $\ngen 2 > $' },
          },
        ],
      });
      const result = await pushing.uploadTestsets(sdk, 1, 'dir', cfg);
      expect(result.testsCount).toBe(2);
      expect(mocks.saveTest).not.toHaveBeenCalled();
    });

    it('should swallow saveScript failure', async () => {
      const { sdk, mocks } = buildSdk();
      let scriptCalls = 0;
      mocks.saveScript.mockImplementation(() => {
        scriptCalls++;
        if (scriptCalls === 2) return Promise.reject(new Error('script fail'));
        return Promise.resolve(undefined);
      });
      const cfg = asConfig({
        generators: [{ name: 'gen', source: './gen.cpp' }],
        testsets: [
          {
            name: 'tests',
            generatorScript: { script: 'gen 1 > $' },
          },
        ],
      });
      const result = await pushing.uploadTestsets(sdk, 1, 'dir', cfg);
      expect(result.testsCount).toBe(1);
    });

    it('should assign groups to generated tests via setTestGroup, not saveTest', async () => {
      const { sdk, mocks } = buildSdk();
      const cfg = asConfig({
        generators: [{ name: 'gen', source: './gen.cpp' }],
        testsets: [
          {
            name: 'tests',
            groupsEnabled: true,
            generatorScript: {
              script:
                '<#-- @group g1 -->\ngen 1 > $\ngen 2 > $\n<#-- @group g2 -->\ngen 3 > $',
            },
          },
        ],
      });
      const result = await pushing.uploadTestsets(sdk, 1, 'dir', cfg);
      expect(result.testsCount).toBe(3);
      expect(mocks.setTestGroup).toHaveBeenCalledTimes(2);
      expect(mocks.setTestGroup).toHaveBeenCalledWith(1, 'tests', 'g1', [1, 2]);
      expect(mocks.setTestGroup).toHaveBeenCalledWith(1, 'tests', 'g2', [3]);
      expect(mocks.saveTest).not.toHaveBeenCalled();
    });

    it('should rewrite generator names to source basenames in the pushed script', async () => {
      const { sdk, mocks } = buildSdk();
      const cfg = asConfig({
        generators: [{ name: 'gen-random', source: './generators/gen.cpp' }],
        testsets: [
          {
            name: 'tests',
            generatorScript: {
              script:
                '<#-- Header -->\n<#-- @group main -->\ngen-random 10 > $\ngen-random 100 > $',
            },
          },
        ],
      });
      const result = await pushing.uploadTestsets(sdk, 1, 'dir', cfg);
      expect(result.testsCount).toBe(2);
      // Second saveScript call: the first one clears the testset.
      const pushed = mocks.saveScript.mock.calls[1][2] as string;
      expect(pushed).toBe(
        '<#-- Header -->\n<#-- @group main -->\ngen 10 > $\ngen 100 > $'
      );
    });

    it('should swallow setTestGroup failure for grouped generator tests', async () => {
      const { sdk, mocks } = buildSdk();
      mocks.setTestGroup.mockRejectedValue(new Error('group fail'));
      const cfg = asConfig({
        generators: [{ name: 'gen', source: './gen.cpp' }],
        testsets: [
          {
            name: 'tests',
            generatorScript: {
              script: '<#-- @group g1 -->\ngen 1 > $\ngen 2 > $',
            },
          },
        ],
      });
      const result = await pushing.uploadTestsets(sdk, 1, 'dir', cfg);
      expect(result.testsCount).toBe(2);
    });

    it('resolves scriptFile relative to problemDir, not cwd', async () => {
      const { sdk, mocks } = buildSdk();
      const path = await import('path');
      const expectedPath = path.resolve(
        '/abs/problem',
        './generators/gen-script.txt'
      );

      mockedExistsSync.mockImplementation((p: PathLike) => {
        return String(p) === expectedPath;
      });
      mockReadFileSyncWith((p: PathOrFileDescriptor) => {
        if (String(p) === expectedPath) return 'gen 1 > $';
        throw new Error(`unexpected read: ${String(p)}`);
      });

      const cfg = asConfig({
        generators: [{ name: 'gen', source: './gen.cpp' }],
        testsets: [
          {
            name: 'tests',
            generatorScript: {
              scriptFile: './generators/gen-script.txt',
            },
          },
        ],
      });

      const result = await pushing.uploadTestsets(sdk, 1, '/abs/problem', cfg);

      expect(mocks.saveScript).toHaveBeenCalledWith(1, 'tests', 'gen 1 > $');
      expect(result.testsCount).toBe(1);
    });
  });
  describe('paths outside the problem folder', () => {
    const outside = '../../.ssh/id_rsa';

    beforeEach(() => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFileSync.mockReturnValue('secret');
    });

    it('should not read or upload a solution outside the folder', async () => {
      const { sdk, mocks } = buildSdk();
      const failures: string[] = [];
      const cfg = asConfig({
        solutions: [{ name: 'sol', source: outside, tag: 'MA' }],
      });
      const result = await pushing.uploadSolutions(
        sdk,
        1,
        'dir',
        cfg,
        failures
      );
      expect(result).toBe(0);
      expect(mockedReadFileSync).not.toHaveBeenCalled();
      expect(mocks.saveSolution).not.toHaveBeenCalled();
      expect(failures).toEqual([
        `solution sol: Refusing path outside the problem folder: ${outside}`,
      ]);
    });

    it('should throw for a checker outside the folder', async () => {
      const { sdk, mocks } = buildSdk();
      const cfg = asConfig({
        checker: { name: 'check', source: '../check.cpp' },
      });
      await expect(pushing.uploadChecker(sdk, 1, 'dir', cfg)).rejects.toThrow(
        'Refusing path outside the problem folder: ../check.cpp'
      );
      expect(mockedReadFileSync).not.toHaveBeenCalled();
      expect(mocks.saveFile).not.toHaveBeenCalled();
    });

    it('should upload nothing when checker tests are outside the folder', async () => {
      const { sdk, mocks } = buildSdk();
      const cfg = asConfig({
        checker: {
          name: 'check',
          source: 'check.cpp',
          testsFilePath: outside,
        },
      });
      await expect(pushing.uploadChecker(sdk, 1, 'dir', cfg)).rejects.toThrow(
        /Refusing path outside the problem folder/
      );
      expect(mocks.saveFile).not.toHaveBeenCalled();
      expect(mocks.setChecker).not.toHaveBeenCalled();
      expect(mocks.saveCheckerTest).not.toHaveBeenCalled();
    });

    it('should upload nothing when validator tests are outside the folder', async () => {
      const { sdk, mocks } = buildSdk();
      const failures: string[] = [];
      const cfg = asConfig({
        validator: {
          name: 'val',
          source: 'val.cpp',
          testsFilePath: outside,
        },
      });
      const result = await pushing.uploadValidator(
        sdk,
        1,
        'dir',
        cfg,
        failures
      );
      expect(result).toBe(0);
      expect(mocks.saveFile).not.toHaveBeenCalled();
      expect(mocks.setValidator).not.toHaveBeenCalled();
      expect(mocks.saveValidatorTest).not.toHaveBeenCalled();
      expect(failures).toEqual([
        `validator: Refusing path outside the problem folder: ${outside}`,
      ]);
    });

    it('should not read a validator outside the folder', async () => {
      const { sdk, mocks } = buildSdk();
      const failures: string[] = [];
      const cfg = asConfig({
        validator: { name: 'val', source: '../val.cpp' },
      });
      const result = await pushing.uploadValidator(
        sdk,
        1,
        'dir',
        cfg,
        failures
      );
      expect(result).toBe(0);
      expect(mockedReadFileSync).not.toHaveBeenCalled();
      expect(mocks.saveFile).not.toHaveBeenCalled();
      expect(failures).toEqual([
        'validator: Refusing path outside the problem folder: ../val.cpp',
      ]);
    });

    it('should not read a generator outside the folder', async () => {
      const { sdk, mocks } = buildSdk();
      const failures: string[] = [];
      const cfg = asConfig({
        generators: [{ name: 'gen', source: '../gen.cpp' }],
      });
      await pushing.uploadGenerators(sdk, 1, 'dir', cfg, failures);
      expect(mockedReadFileSync).not.toHaveBeenCalled();
      expect(mocks.saveFile).not.toHaveBeenCalled();
      expect(failures).toEqual([
        'generator gen: Refusing path outside the problem folder: ../gen.cpp',
      ]);
    });

    it.each([
      'legend',
      'input',
      'output',
      'notes',
      'tutorial',
      'interaction',
      'scoring',
    ])('should not read statement %s outside the folder', async field => {
      const { sdk, mocks } = buildSdk();
      const failures: string[] = [];
      const cfg = asConfig({
        name: 'Prob',
        statements: {
          english: { encoding: 'UTF-8', name: 'Prob', [field]: outside },
        },
      });
      await pushing.uploadStatements(sdk, 1, 'dir', cfg, failures);
      expect(mockedReadFileSync).not.toHaveBeenCalled();
      expect(mocks.saveStatement).not.toHaveBeenCalled();
      expect(failures).toEqual([
        `statement english: Refusing path outside the problem folder: ${outside}`,
      ]);
    });

    it('should refuse an absolute solution path outside the folder', async () => {
      const { sdk, mocks } = buildSdk();
      const failures: string[] = [];
      const cfg = asConfig({
        solutions: [{ name: 'sol', source: '/etc/passwd', tag: 'MA' }],
      });
      const result = await pushing.uploadSolutions(
        sdk,
        1,
        'dir',
        cfg,
        failures
      );
      expect(result).toBe(0);
      expect(mockedReadFileSync).not.toHaveBeenCalled();
      expect(mocks.saveSolution).not.toHaveBeenCalled();
      expect(failures).toEqual([
        'solution sol: Refusing path outside the problem folder: /etc/passwd',
      ]);
    });

    it('should refuse an absolute statement path outside the folder', async () => {
      const { sdk, mocks } = buildSdk();
      const failures: string[] = [];
      const cfg = asConfig({
        name: 'Prob',
        statements: {
          english: {
            encoding: 'UTF-8',
            name: 'Prob',
            legend: '/etc/passwd',
          },
        },
      });
      await pushing.uploadStatements(sdk, 1, 'dir', cfg, failures);
      expect(mockedReadFileSync).not.toHaveBeenCalled();
      expect(mocks.saveStatement).not.toHaveBeenCalled();
      expect(failures).toEqual([
        'statement english: Refusing path outside the problem folder: /etc/passwd',
      ]);
    });

    it('should not read a manual test outside the folder', async () => {
      const { sdk, mocks } = buildSdk();
      const failures: string[] = [];
      const cfg = asConfig({
        testsets: [
          { name: 'tests', manualTests: [{ input: '../t.txt', index: 1 }] },
        ],
      });
      await pushing.uploadTestsets(sdk, 1, 'dir', cfg, failures);
      expect(mocks.saveTest).not.toHaveBeenCalled();
      expect(failures).toEqual([
        'testset tests: Refusing path outside the problem folder: ../t.txt',
      ]);
    });

    it('should refuse a generator scriptFile outside the folder', async () => {
      const { sdk, mocks } = buildSdk();
      const failures: string[] = [];
      const cfg = asConfig({
        testsets: [{ name: 'tests', generatorScript: { scriptFile: '../x' } }],
      });
      await pushing.uploadTestsets(sdk, 1, 'dir', cfg, failures);
      expect(mocks.saveScript).not.toHaveBeenCalled();
      expect(failures).toEqual([
        'testset tests: Refusing path outside the problem folder: ../x',
      ]);
    });

    it('should refuse a manual test outside the folder before clearing the testset', async () => {
      const { sdk, mocks } = buildSdk();
      const cfg = asConfig({
        testsets: [
          {
            name: 'tests',
            manualTests: [
              { input: 'ok.txt', index: 1 },
              { input: '../t.txt', index: 2 },
            ],
          },
        ],
      });
      await pushing.uploadTestsets(sdk, 1, 'dir', cfg, []);
      expect(mocks.enableGroups).not.toHaveBeenCalled();
      expect(mocks.saveScript).not.toHaveBeenCalled();
      expect(mocks.saveTest).not.toHaveBeenCalled();
    });

    it('should still read a file whose name starts with two dots', async () => {
      const { sdk, mocks } = buildSdk();
      const cfg = asConfig({
        solutions: [{ name: 'sol', source: '..sol.cpp', tag: 'MA' }],
      });
      const result = await pushing.uploadSolutions(sdk, 1, 'dir', cfg);
      expect(result).toBe(1);
      expect(mocks.saveSolution).toHaveBeenCalled();
    });
  });
});
