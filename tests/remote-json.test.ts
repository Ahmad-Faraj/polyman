/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/**
 * End-to-end tests for `polyman remote ... --json`: the real actions, steps,
 * remote helpers and report, with a mocked Polygon client and credentials.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as actions from '../src/actions';
import { report } from '../src/report';
import { exitCodeFor } from '../src/errors';
import type { RemoteReport } from '../src/types';

const API_KEY = 'key0123456789abcdef';
const SECRET = 'secret9876543210fedcba';

const sdk: Record<string, Mock<(...args: never[]) => unknown>> = {};

vi.mock('../src/polygon', () => ({
  PolygonSDK: vi.fn(function () {
    return sdk;
  }),
}));

vi.mock('../src/helpers/remote/utils', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../src/helpers/remote/utils')>();
  return {
    ...actual,
    readCredentials: vi.fn(() => ({ apiKey: API_KEY, secret: SECRET })),
  };
});

const resetSdk = (): void => {
  for (const key of Object.keys(sdk)) delete sdk[key];
  const resolved = (value: unknown = undefined) =>
    vi.fn().mockResolvedValue(value);
  Object.assign(sdk, {
    // push
    saveSolution: resolved(),
    saveFile: resolved(),
    setChecker: resolved(),
    setValidator: resolved(),
    saveGeneralDescription: resolved(),
    saveTags: resolved(),
    updateProblemInfo: resolved(),
    listProblems: resolved([
      { id: 7, name: 'two-sum', owner: 'me', accessType: 'OWNER' },
    ]),
    createProblem: resolved({ id: 99 }),
    // commit / package
    commitChanges: resolved(),
    listPackages: resolved([]),
    buildPackage: resolved(),
    // pull / view
    getProblemInfo: resolved({
      inputFile: 'stdin',
      outputFile: 'stdout',
      interactive: false,
      timeLimit: 1000,
      memoryLimit: 256,
    }),
    getSolutions: resolved([{ name: 'main.cpp', tag: 'MA' }]),
    viewSolution: resolved('int main() {}\n'),
    getChecker: resolved('std::wcmp.cpp'),
    getValidator: resolved('val.cpp'),
    getValidatorTests: resolved([]),
    viewFile: resolved('int main() {}\n'),
    getFiles: resolved({
      resourceFiles: [],
      sourceFiles: [{ name: 'gen.cpp', sourceType: 'cpp.g++17' }],
      auxFiles: [],
    }),
    getStatements: resolved({ english: { name: 'Two Sum', legend: 'L' } }),
    viewGeneralDescription: resolved(''),
    viewTags: resolved([]),
    getTests: vi.fn().mockRejectedValue(new Error('no tests')),
    getScript: vi.fn().mockRejectedValue(new Error('no tests')),
  });
};

let tmp: string;
let writeSpy: ReturnType<typeof vi.spyOn<typeof fs, 'writeSync'>>;
let exitSpy: ReturnType<typeof vi.spyOn>;

/** The one JSON document written to stdout. */
const written = (): RemoteReport => {
  const calls = writeSpy.mock.calls.filter(
    call => call[0] === process.stdout.fd
  );
  expect(calls).toHaveLength(1);
  return JSON.parse(String(calls[0][1])) as RemoteReport;
};

/**
 * Awaits an action that must fail and returns what it threw. The action
 * rethrows so that cli.ts, the one exit point, can pick the exit code.
 */
const failure = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected the action to fail');
    },
    (error: unknown) => error
  );

const writeProblem = (config: Record<string, unknown>): string => {
  const dir = path.join(tmp, 'prob');
  fs.mkdirSync(path.join(dir, 'solutions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'solutions', 'main.cpp'), 'int main(){}');
  fs.writeFileSync(path.join(dir, 'solutions', 'wa.cpp'), 'int main(){}');
  fs.writeFileSync(path.join(dir, 'Config.json'), JSON.stringify(config));
  return dir;
};

const baseConfig = {
  name: 'two-sum',
  problemId: 7,
  timeLimit: 1000,
  memoryLimit: 256,
  description: 'Add two numbers',
  tags: ['math'],
  solutions: [
    { name: 'main', source: './solutions/main.cpp', tag: 'MA' },
    { name: 'wa', source: './solutions/wa.cpp', tag: 'WA' },
  ],
  checker: { name: 'wcmp', source: 'wcmp.cpp', isStandard: true },
  validator: { name: 'val', source: './validator/val.cpp' },
};

describe('remote commands with --json', () => {
  beforeEach(() => {
    resetSdk();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polyman-remote-json-'));
    writeSpy = vi.spyOn(fs, 'writeSync').mockImplementation((() => 0) as never);
    exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    report.reset();
    vi.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('remote push', () => {
    it('lists one action per uploaded item and a failed one with its Polygon error', async () => {
      sdk['saveSolution'].mockImplementation((_id: number, name: string) =>
        name === 'wa.cpp'
          ? Promise.reject(
              new Error(`Polygon API Error: bad request apiKey=${API_KEY}`)
            )
          : Promise.resolve()
      );
      const dir = writeProblem(baseConfig);

      const error = await failure(
        actions.remotePushProblemAction(dir, {
          solutions: true,
          metadata: true,
          json: true,
        })
      );

      const doc = written();
      expect(doc).toMatchObject({
        schemaVersion: 1,
        command: 'remote push',
        ok: false,
        exitCode: 4,
        problemId: 7,
      });
      expect(doc.actions).toEqual([
        { component: 'solution', name: 'main', action: 'upload', ok: true },
        {
          component: 'solution',
          name: 'wa',
          action: 'upload',
          ok: false,
          error: 'Polygon API Error: bad request apiKey=[REDACTED]',
        },
        {
          component: 'metadata',
          name: 'description',
          action: 'upload',
          ok: true,
        },
        { component: 'metadata', name: 'tags', action: 'upload', ok: true },
      ]);
      expect(doc.errors).toEqual([
        'solution wa: Polygon API Error: bad request apiKey=[REDACTED]',
      ]);
      expect(exitCodeFor(error)).toBe(4);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('never prints the API key or secret', async () => {
      sdk['saveSolution'].mockRejectedValue(
        new Error(`rejected ${API_KEY} / ${SECRET}`)
      );
      sdk['updateProblemInfo'].mockRejectedValue(
        new Error(`info failed for ${SECRET}`)
      );
      const dir = writeProblem(baseConfig);

      await failure(
        actions.remotePushProblemAction(dir, {
          solutions: true,
          info: true,
          json: true,
        })
      );

      const text = String(
        writeSpy.mock.calls.find(c => c[0] === process.stdout.fd)![1]
      );
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain(SECRET);
      const doc = written();
      expect(doc.ok).toBe(false);
      expect(doc.errors).toEqual(['info failed for [REDACTED]']);
      expect(doc.actions).toEqual([
        {
          component: 'info',
          name: 'problem info',
          action: 'update',
          ok: false,
          error: 'info failed for [REDACTED]',
        },
      ]);
    });

    it('reports a successful push with ok true and exit code 0', async () => {
      const dir = writeProblem(baseConfig);

      await actions.remotePushProblemAction(dir, {
        checker: true,
        json: true,
      });

      expect(written()).toEqual({
        schemaVersion: 1,
        polymanVersion: expect.any(String),
        command: 'remote push',
        ok: true,
        exitCode: 0,
        durationMs: expect.any(Number),
        errors: [],
        problemId: 7,
        actions: [
          { component: 'checker', name: 'wcmp', action: 'upload', ok: true },
        ],
      });
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('includes the new problemId when push creates the problem', async () => {
      const dir = writeProblem({ ...baseConfig, problemId: undefined });

      await actions.remotePushProblemAction(dir, {
        solutions: true,
        yes: true,
        name: 'new-problem',
        json: true,
      });

      const doc = written();
      expect(doc.ok).toBe(true);
      expect(doc.problemId).toBe(99);
      expect(doc.actions.slice(0, 2)).toEqual([
        {
          component: 'problem',
          name: 'new-problem',
          action: 'create',
          ok: true,
        },
        {
          component: 'config',
          name: 'Config.json',
          action: 'update',
          ok: true,
        },
      ]);
      const saved = JSON.parse(
        fs.readFileSync(path.join(dir, 'Config.json'), 'utf-8')
      ) as { problemId: number };
      expect(saved.problemId).toBe(99);
    });

    it('reports a failed problem creation with a null problemId', async () => {
      sdk['createProblem'].mockRejectedValue(
        new Error('Polygon API Error: cannot create')
      );
      const dir = writeProblem({ ...baseConfig, problemId: undefined });

      const error = await failure(
        actions.remotePushProblemAction(dir, {
          solutions: true,
          yes: true,
          name: 'new-problem',
          json: true,
        })
      );

      const doc = written();
      expect(doc.ok).toBe(false);
      expect(doc.exitCode).toBe(exitCodeFor(error));
      expect(doc.problemId).toBeNull();
      expect(doc.errors).toEqual([
        'Failed to create problem on Polygon: Polygon API Error: cannot create',
      ]);
      expect(doc.actions).toEqual([
        {
          component: 'problem',
          name: 'new-problem',
          action: 'create',
          ok: false,
          error: 'Polygon API Error: cannot create',
        },
      ]);
    });

    it.each(['x', '7; $(id)', 1.5, -3])(
      'keeps problemId null when Config.json has problemId %j',
      async problemId => {
        const dir = writeProblem({ ...baseConfig, problemId });

        await actions.remotePushProblemAction(dir, {
          checker: true,
          json: true,
        });

        const doc = written();
        expect(doc.problemId).toBeNull();
      }
    );

    it('does not prompt with --json and exits 2 without --yes', async () => {
      const dir = writeProblem({ ...baseConfig, problemId: undefined });

      const error = await failure(
        actions.remotePushProblemAction(dir, { json: true })
      );

      const doc = written();
      expect(doc).toMatchObject({ ok: false, exitCode: 2, problemId: null });
      expect(doc.errors[0]).toContain('pass --yes');
      expect(exitCodeFor(error)).toBe(2);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(sdk['createProblem']).not.toHaveBeenCalled();
    });
  });

  describe('remote pull', () => {
    it('lists the downloaded files and the testsets that failed', async () => {
      const out = path.join(tmp, 'pulled');

      await actions.remotePullProblemAction('7', out, { json: true });

      const doc = written();
      expect(doc).toMatchObject({
        command: 'remote pull',
        ok: true,
        exitCode: 0,
        problemId: 7,
      });
      expect(doc.actions).toEqual([
        { component: 'info', name: 'problem info', action: 'fetch', ok: true },
        { component: 'solution', name: 'main', action: 'download', ok: true },
        { component: 'validator', name: 'val', action: 'download', ok: true },
        { component: 'generator', name: 'gen', action: 'download', ok: true },
        {
          component: 'statement',
          name: 'english',
          action: 'download',
          ok: true,
        },
        { component: 'config', name: 'Config.json', action: 'write', ok: true },
        {
          component: 'testset',
          name: 'tests',
          action: 'download',
          ok: false,
          error: 'no tests',
        },
      ]);
    });

    it('keeps problemId null when the ID cannot be resolved', async () => {
      const error = await failure(
        actions.remotePullProblemAction(
          path.join(tmp, 'missing'),
          path.join(tmp, 'out'),
          { json: true }
        )
      );

      const doc = written();
      expect(doc).toMatchObject({
        ok: false,
        exitCode: exitCodeFor(error),
        problemId: null,
      });
      expect(doc.errors).toHaveLength(1);
      expect(doc.actions).toEqual([]);
    });
  });

  describe('remote view', () => {
    it('lists what it fetched', async () => {
      sdk['getSolutions'].mockResolvedValue([{ name: 'main.cpp', tag: 'MA' }]);
      sdk['getStatements'].mockResolvedValue({ english: { name: 'Two Sum' } });
      sdk['getTests'].mockResolvedValue([]);

      await actions.remoteViewProblemAction('7', { json: true });

      const doc = written();
      expect(doc).toMatchObject({
        command: 'remote view',
        ok: true,
        problemId: 7,
      });
      expect(doc.actions).toEqual(
        expect.arrayContaining([
          {
            component: 'info',
            name: 'problem info',
            action: 'fetch',
            ok: true,
          },
          {
            component: 'statement',
            name: 'english',
            action: 'fetch',
            ok: true,
          },
          {
            component: 'solution',
            name: 'main.cpp',
            action: 'fetch',
            ok: true,
          },
          {
            component: 'checker',
            name: 'std::wcmp.cpp',
            action: 'fetch',
            ok: true,
          },
          {
            component: 'validator',
            name: 'val.cpp',
            action: 'fetch',
            ok: true,
          },
          {
            component: 'generator',
            name: 'gen.cpp',
            action: 'fetch',
            ok: true,
          },
        ])
      );
    });
  });

  describe('remote view failure', () => {
    it('reports a failed info fetch', async () => {
      sdk['getProblemInfo'].mockRejectedValue(
        new Error('Polygon API Error: problem not found')
      );

      const error = await failure(
        actions.remoteViewProblemAction('7', { json: true })
      );

      const doc = written();
      expect(doc.command).toBe('remote view');
      expect(doc.ok).toBe(false);
      expect(doc.exitCode).toBe(exitCodeFor(error));
      expect(doc.problemId).toBe(7);
      expect(doc.errors).toEqual(['Polygon API Error: problem not found']);
      expect(doc.actions).toEqual([
        {
          component: 'info',
          name: 'problem info',
          action: 'fetch',
          ok: false,
          error: 'Polygon API Error: problem not found',
        },
      ]);
    });
  });

  describe('remote commit', () => {
    it('reports the commit', async () => {
      await actions.remoteCommitProblemAction('7', 'msg', { json: true });

      expect(written()).toMatchObject({
        command: 'remote commit',
        ok: true,
        exitCode: 0,
        problemId: 7,
        errors: [],
        actions: [
          { component: 'problem', name: '7', action: 'commit', ok: true },
        ],
      });
      expect(sdk['commitChanges']).toHaveBeenCalledWith(7, { message: 'msg' });
    });

    it('puts the Polygon error in errors as plain text', async () => {
      sdk['commitChanges'].mockRejectedValue(
        new Error(`Polygon API Error: no changes (key ${API_KEY})`)
      );

      const error = await failure(
        actions.remoteCommitProblemAction('7', 'msg', { json: true })
      );

      const doc = written();
      expect(doc).toMatchObject({
        ok: false,
        exitCode: exitCodeFor(error),
        problemId: 7,
      });
      expect(doc.errors).toEqual([
        'Polygon API Error: no changes (key [REDACTED])',
      ]);
      expect(doc.actions).toEqual([
        {
          component: 'problem',
          name: '7',
          action: 'commit',
          ok: false,
          error: 'Polygon API Error: no changes (key [REDACTED])',
        },
      ]);
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe('remote package', () => {
    it('reports an invalid package type before any build', async () => {
      const error = await failure(
        actions.remotePackageProblemAction('7', 'zip', { json: true })
      );

      const doc = written();
      expect(doc).toMatchObject({
        command: 'remote package',
        ok: false,
        exitCode: exitCodeFor(error),
        problemId: 7,
        actions: [],
      });
      expect(doc.errors[0]).toContain('Invalid package type: zip');
      expect(sdk['buildPackage']).not.toHaveBeenCalled();
    });

    it('records a failed build', async () => {
      sdk['buildPackage'].mockRejectedValue(
        new Error('Polygon API Error: build already running')
      );

      await failure(
        actions.remotePackageProblemAction('7', 'standard', {
          json: true,
        })
      );

      const doc = written();
      expect(doc.ok).toBe(false);
      expect(doc.actions).toEqual([
        {
          component: 'package',
          name: 'standard',
          action: 'build',
          ok: false,
          error: 'Polygon API Error: build already running',
        },
      ]);
    });

    it('fails with exit code 4 when the build is still running after the poll limit', async () => {
      vi.useFakeTimers();
      let error: unknown;
      try {
        sdk['listPackages']
          .mockResolvedValueOnce([])
          .mockResolvedValue([{ id: 5, state: 'RUNNING', comment: '' }]);

        const run = failure(
          actions.remotePackageProblemAction('7', 'standard', { json: true })
        );
        await vi.advanceTimersByTimeAsync(31 * 30000);
        error = await run;
      } finally {
        vi.useRealTimers();
      }

      const message =
        'Package build did not finish within the polling limit of 30 minutes (package 5 is still RUNNING)';
      const doc = written();
      expect(doc.ok).toBe(false);
      expect(doc.exitCode).toBe(4);
      expect(exitCodeFor(error)).toBe(4);
      expect(doc.errors).toEqual([message]);
      expect(doc.actions).toEqual([
        {
          component: 'package',
          name: 'standard',
          action: 'build',
          ok: false,
          error: message,
        },
      ]);
    });

    it('records a build that ends FAILED', async () => {
      vi.useFakeTimers();
      let error: unknown;
      try {
        sdk['listPackages']
          .mockResolvedValueOnce([])
          .mockResolvedValue([
            { id: 5, state: 'FAILED', comment: 'bad tests' },
          ]);

        const run = failure(
          actions.remotePackageProblemAction('7', 'standard', { json: true })
        );
        await vi.advanceTimersByTimeAsync(30000);
        error = await run;
      } finally {
        vi.useRealTimers();
      }

      const doc = written();
      expect(doc.ok).toBe(false);
      expect(doc.exitCode).toBe(exitCodeFor(error));
      expect(doc.errors).toEqual(['Package build failed: bad tests']);
      expect(doc.actions).toEqual([
        {
          component: 'package',
          name: 'standard',
          action: 'build',
          ok: false,
          error: 'Package build failed: bad tests',
        },
      ]);
    });

    it('records a successful build', async () => {
      vi.useFakeTimers();
      try {
        sdk['listPackages']
          .mockResolvedValueOnce([])
          .mockResolvedValue([{ id: 5, state: 'READY', comment: '' }]);

        const run = actions.remotePackageProblemAction('7', 'full', {
          json: true,
        });
        await vi.advanceTimersByTimeAsync(30000);
        await run;
      } finally {
        vi.useRealTimers();
      }

      expect(written()).toMatchObject({
        ok: true,
        exitCode: 0,
        actions: [
          { component: 'package', name: 'full', action: 'build', ok: true },
        ],
      });
    });
  });

  it('prints nothing on stdout without --json', async () => {
    await actions.remoteCommitProblemAction('7', 'msg');
    expect(
      writeSpy.mock.calls.filter(c => c[0] === process.stdout.fd)
    ).toHaveLength(0);
  });
});
