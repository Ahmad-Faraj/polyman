import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as actions from '../src/actions';
import * as help from '../src/help';
import { setCacheEnabled } from '../src/helpers/compile-cache';

vi.mock('../src/actions');
vi.mock('../src/helpers/compile-cache');
vi.mock('../src/help', () => ({
  printComprehensiveHelp: vi.fn(),
}));

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

const loadCli = async (argv: string[]) => {
  process.argv = ['node', 'polyman', ...argv];
  vi.resetModules();
  await import('../src/cli');
  await tick();
};

describe('cli.ts', () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    process.argv = [...originalArgv];
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('should register new command', async () => {
    await loadCli(['new', 'prob']);
    expect(actions.createTemplateAction).toHaveBeenCalledWith(
      'prob',
      expect.anything(),
      expect.anything()
    );
  });

  it('should register generate command', async () => {
    await loadCli(['generate', '--all']);
    expect(actions.generateTestsAction).toHaveBeenCalledWith('all', undefined);
  });

  it('should register list checkers command', async () => {
    await loadCli(['list', 'checkers']);
    expect(actions.listAvailableCheckersAction).toHaveBeenCalled();
  });

  it('should register download-testlib command', async () => {
    await loadCli(['download-testlib']);
    expect(actions.downloadTestlibAction).toHaveBeenCalled();
  });

  it('should register list testsets command', async () => {
    await loadCli(['list', 'testsets']);
    expect(actions.listTestsetsAction).toHaveBeenCalled();
  });

  it('should register list solutions command', async () => {
    await loadCli(['list', 'solutions']);
    expect(actions.listSolutionsAction).toHaveBeenCalled();
  });

  it('should register list generators command', async () => {
    await loadCli(['list', 'generators']);
    expect(actions.listGeneratorsAction).toHaveBeenCalled();
  });

  it('should pass testset and group to generate', async () => {
    await loadCli(['generate', '--testset', 'main', '--group', 'samples']);
    expect(actions.generateTestsAction).toHaveBeenCalledWith('main', 'samples');
  });

  it('should pass testset and index to generate', async () => {
    await loadCli(['generate', '--testset', 'main', '--index', '5']);
    expect(actions.generateTestsAction).toHaveBeenCalledWith('main', '5');
  });

  it('should pass only testset to generate when no modifier', async () => {
    await loadCli(['generate', '--testset', 'main']);
    expect(actions.generateTestsAction).toHaveBeenCalledWith('main', undefined);
  });

  it('should default generate target to all when nothing provided', async () => {
    await loadCli(['generate']);
    expect(actions.generateTestsAction).toHaveBeenCalledWith('all', undefined);
  });

  it('should register validate --all command', async () => {
    await loadCli(['validate', '--all']);
    expect(actions.validateTestsAction).toHaveBeenCalledWith('all', undefined);
  });

  it('should pass testset and group to validate', async () => {
    await loadCli(['validate', '--testset', 'pretest', '--group', 'g1']);
    expect(actions.validateTestsAction).toHaveBeenCalledWith('pretest', 'g1');
  });

  it('should pass testset and index to validate', async () => {
    await loadCli(['validate', '--testset', 'pretest', '--index', '3']);
    expect(actions.validateTestsAction).toHaveBeenCalledWith('pretest', '3');
  });

  it('should pass only testset to validate when no modifier', async () => {
    await loadCli(['validate', '--testset', 'pretest']);
    expect(actions.validateTestsAction).toHaveBeenCalledWith(
      'pretest',
      undefined
    );
  });

  it('should register run command with --all', async () => {
    await loadCli(['run', 'main', '--all']);
    expect(actions.runSolutionAction).toHaveBeenCalledWith(
      'main',
      'all',
      undefined,
      { json: false }
    );
  });

  it('should pass testset and group to run', async () => {
    await loadCli(['run', 'sol', '--testset', 'ts', '--group', 'gp']);
    expect(actions.runSolutionAction).toHaveBeenCalledWith('sol', 'ts', 'gp', {
      json: false,
    });
  });

  it('should pass testset and index to run', async () => {
    await loadCli(['run', 'sol', '--testset', 'ts', '--index', '7']);
    expect(actions.runSolutionAction).toHaveBeenCalledWith('sol', 'ts', '7', {
      json: false,
    });
  });

  it('should pass only testset to run when no modifier', async () => {
    await loadCli(['run', 'sol', '--testset', 'ts']);
    expect(actions.runSolutionAction).toHaveBeenCalledWith(
      'sol',
      'ts',
      undefined,
      { json: false }
    );
  });

  it('should default run target to all when nothing provided', async () => {
    await loadCli(['run', 'sol']);
    expect(actions.runSolutionAction).toHaveBeenCalledWith(
      'sol',
      'all',
      undefined,
      { json: false }
    );
  });

  it('should pass --json through to run', async () => {
    await loadCli(['run', 'sol', '--all', '--json']);
    expect(actions.runSolutionAction).toHaveBeenCalledWith(
      'sol',
      'all',
      undefined,
      { json: true }
    );
  });

  it('should register test command', async () => {
    await loadCli(['test', 'validator']);
    expect(actions.testWhatAction).toHaveBeenCalledWith(
      'validator',
      expect.anything(),
      expect.anything()
    );
  });

  it('should register verify command', async () => {
    await loadCli(['verify']);
    expect(actions.fullVerificationAction).toHaveBeenCalledWith({
      json: false,
    });
  });

  it('should pass --json through to verify', async () => {
    await loadCli(['verify', '--json']);
    expect(actions.fullVerificationAction).toHaveBeenCalledWith({
      json: true,
    });
  });

  it('should register cache status command', async () => {
    await loadCli(['cache', 'status']);
    expect(actions.cacheStatusAction).toHaveBeenCalled();
  });

  it('should register cache clear command', async () => {
    await loadCli(['cache', 'clear']);
    expect(actions.cacheClearAction).toHaveBeenCalled();
  });

  it('should enable the compilation cache by default', async () => {
    await loadCli(['verify']);
    expect(setCacheEnabled).toHaveBeenCalledWith(true);
  });

  it.each([
    ['verify'],
    ['generate', '--all'],
    ['validate', '--all'],
    ['run', 'main', '--all'],
    ['test', 'checker'],
  ])(
    'should disable the compilation cache for %s --no-cache',
    async (...argv) => {
      await loadCli([...argv, '--no-cache']);
      expect(setCacheEnabled).toHaveBeenCalledWith(false);
    }
  );

  it('should still pass --json to verify alongside --no-cache', async () => {
    await loadCli(['verify', '--json', '--no-cache']);
    expect(actions.fullVerificationAction).toHaveBeenCalledWith({
      json: true,
    });
  });

  it('should print a completion script for the given shell', async () => {
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      await loadCli(['completion', 'bash']);
      const output = write.mock.calls.map(call => String(call[0])).join('');
      expect(output).toContain('complete -o default -F _polyman_complete');
      expect(output).toContain('generate');
      expect(output).toContain('--testset');
      expect(output).toContain('--solutions');
      expect(output).not.toContain("'__complete'");
    } finally {
      write.mockRestore();
    }
  });

  it('should reject an unsupported shell for completion', async () => {
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    try {
      try {
        await loadCli(['completion', 'tcsh']);
      } catch {
        // commander may throw when exit is stubbed
      }
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(write.mock.calls.map(call => String(call[0])).join('')).toContain(
        'tcsh'
      );
    } finally {
      write.mockRestore();
      exitSpy.mockRestore();
    }
  });

  it('should print names from Config.json for __complete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polyman-cli-complete-'));
    writeFileSync(
      join(dir, 'Config.json'),
      JSON.stringify({ solutions: [{ name: 'main' }, { name: 'wa' }] })
    );
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      await loadCli(['__complete', 'solutions']);
      expect(write.mock.calls.map(call => String(call[0])).join('')).toBe(
        'main\nwa\n'
      );
    } finally {
      write.mockRestore();
      cwd.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([
    [['groups', 'tests'], 'samples\nmain\n'],
    [['groups', '--', 'tests'], 'samples\nmain\n'],
    [['groups', '--', '-t'], 'dash\n'],
    [['groups', '--', '--help'], 'help-group\n'],
  ])('should print the groups for __complete %j', async (argv, expected) => {
    const dir = mkdtempSync(join(tmpdir(), 'polyman-cli-complete-'));
    writeFileSync(
      join(dir, 'Config.json'),
      JSON.stringify({
        testsets: [
          { name: 'tests', groups: [{ name: 'samples' }, { name: 'main' }] },
          { name: '-t', groups: [{ name: 'dash' }] },
          { name: '--help', groups: [{ name: 'help-group' }] },
        ],
      })
    );
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      await loadCli(['__complete', ...argv]);
      expect(write.mock.calls.map(call => String(call[0])).join('')).toBe(
        expected
      );
    } finally {
      write.mockRestore();
      cwd.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should print nothing for __complete without a Config.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'polyman-cli-complete-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    const write = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    try {
      await loadCli(['__complete', 'testsets']);
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      cwd.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should register remote register command', async () => {
    await loadCli(['remote', 'register', 'KEY', 'SECRET']);
    expect(actions.registerApiKeyAndSecretAction).toHaveBeenCalledWith(
      'KEY',
      'SECRET',
      expect.anything(),
      expect.anything()
    );
  });

  it('should register remote list command without owner', async () => {
    await loadCli(['remote', 'list']);
    expect(actions.remoteListProblemsAction).toHaveBeenCalledWith(undefined);
  });

  it('should register remote list command with owner', async () => {
    await loadCli(['remote', 'list', '--owner', 'tourist']);
    expect(actions.remoteListProblemsAction).toHaveBeenCalledWith('tourist');
  });

  it('should register remote pull command with options', async () => {
    await loadCli([
      'remote',
      'pull',
      '123',
      './out',
      '--solutions',
      '--checker',
    ]);
    expect(actions.remotePullProblemAction).toHaveBeenCalledWith(
      '123',
      './out',
      expect.objectContaining({ solutions: true, checker: true })
    );
  });

  it('should register remote pull command with --all', async () => {
    await loadCli(['remote', 'pull', '999', './dir', '--all']);
    expect(actions.remotePullProblemAction).toHaveBeenCalledWith(
      '999',
      './dir',
      expect.objectContaining({ all: true })
    );
  });

  it('should register remote pull with tests value', async () => {
    await loadCli(['remote', 'pull', '1', './x', '--tests', 'pretests,main']);
    expect(actions.remotePullProblemAction).toHaveBeenCalledWith(
      '1',
      './x',
      expect.objectContaining({ tests: 'pretests,main' })
    );
  });

  it('should register remote push command with options', async () => {
    await loadCli([
      'remote',
      'push',
      './prob',
      '--solutions',
      '--validator',
      '--metadata',
    ]);
    expect(actions.remotePushProblemAction).toHaveBeenCalledWith(
      './prob',
      expect.objectContaining({
        solutions: true,
        validator: true,
        metadata: true,
      })
    );
  });

  it('should register remote push command with --all', async () => {
    await loadCli(['remote', 'push', './p', '--all']);
    expect(actions.remotePushProblemAction).toHaveBeenCalledWith(
      './p',
      expect.objectContaining({ all: true })
    );
  });

  it('should pass --yes and --name through to remote push', async () => {
    await loadCli(['remote', 'push', './p', '--yes', '--name', 'two-sum']);
    expect(actions.remotePushProblemAction).toHaveBeenCalledWith(
      './p',
      expect.objectContaining({ yes: true, name: 'two-sum' })
    );
  });

  it('should accept the short -y and -n push flags', async () => {
    await loadCli(['remote', 'push', './p', '-y', '-n', 'max-flow']);
    expect(actions.remotePushProblemAction).toHaveBeenCalledWith(
      './p',
      expect.objectContaining({ yes: true, name: 'max-flow' })
    );
  });

  it('should accept the documented push form with -s -c', async () => {
    await loadCli(['remote', 'push', './my-problem', '-s', '-c']);
    expect(actions.remotePushProblemAction).toHaveBeenCalledWith(
      './my-problem',
      expect.objectContaining({ solutions: true, checker: true })
    );
  });

  it('should reject push with a problem id and a directory', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const errSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as never);
    try {
      await loadCli(['remote', 'push', '123456', './my-problem']);
    } catch {
      // commander may throw when exit is stubbed
    }
    const stderr = errSpy.mock.calls.map(c => String(c[0])).join('');
    expect(stderr).toContain('too many arguments');
    // exit is stubbed, so commander carries on after reporting the error
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('should register remote view command', async () => {
    await loadCli(['remote', 'view', '42']);
    expect(actions.remoteViewProblemAction).toHaveBeenCalledWith(
      '42',
      expect.anything(),
      expect.anything()
    );
  });

  it('should register remote commit command', async () => {
    await loadCli(['remote', 'commit', '42', 'msg']);
    expect(actions.remoteCommitProblemAction).toHaveBeenCalledWith(
      '42',
      'msg',
      expect.anything(),
      expect.anything()
    );
  });

  it('should register remote package command', async () => {
    await loadCli(['remote', 'package', '42', 'standard']);
    expect(actions.remotePackageProblemAction).toHaveBeenCalledWith(
      '42',
      'standard',
      expect.anything(),
      expect.anything()
    );
  });

  it('should invoke custom help when --help is passed', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    try {
      await loadCli(['--help']);
    } catch {
      // commander may throw when exit is stubbed
    }
    expect(help.printComprehensiveHelp).toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('should invoke custom help when -h is passed', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    try {
      await loadCli(['-h']);
    } catch {
      // commander may throw when exit is stubbed
    }
    expect(help.printComprehensiveHelp).toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
