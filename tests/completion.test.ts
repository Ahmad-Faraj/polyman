import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  generateCompletionScript,
  isCompletionKind,
  isShell,
  readCompletionNames,
} from '../src/completion';

/** A small program shaped like polyman's real command tree. */
const buildProgram = (): Command => {
  const program = new Command();
  program.name('polyman').description('root');
  program
    .command('generate')
    .description('Generate tests for testsets')
    .option('-a, --all', 'Generate all testsets')
    .option('-t, --testset <name>', 'Generate specific testset')
    .option('-g, --group <name>', 'Generate specific group')
    .option('-i, --index <number>', 'Generate specific test');
  program.command('run <solution-name>').description('Run solution on tests');
  program.command('test <what>').description('Test a component');
  program.command('completion <shell>').description('Print a script');
  program.command('__complete <kind>', { hidden: true });
  const remote = program.command('remote').description('Polygon operations');
  remote
    .command('push <directory>')
    .description("Push local problem to Polygon (it's remote)")
    .option('-s, --solutions', 'Push solutions')
    .option('-c, --checker', 'Push checker');
  return program;
};

describe('completion.ts', () => {
  describe('isShell / isCompletionKind', () => {
    it('accepts the three supported shells only', () => {
      expect(isShell('bash')).toBe(true);
      expect(isShell('zsh')).toBe(true);
      expect(isShell('fish')).toBe(true);
      expect(isShell('powershell')).toBe(false);
      expect(isShell('')).toBe(false);
    });

    it('accepts the known kinds only', () => {
      expect(isCompletionKind('testsets')).toBe(true);
      expect(isCompletionKind('groups')).toBe(true);
      expect(isCompletionKind('checkers')).toBe(false);
    });
  });

  describe('generateCompletionScript', () => {
    it('rejects an unknown shell', () => {
      expect(() => generateCompletionScript(buildProgram(), 'tcsh')).toThrow(
        /Unsupported shell "tcsh".*bash, zsh, fish/
      );
    });

    it.each(['bash', 'zsh', 'fish'])(
      'lists the commands, options and subcommands for %s',
      shell => {
        const script = generateCompletionScript(buildProgram(), shell);
        expect(script).toContain('generate');
        expect(script).toContain('remote');
        expect(script).toContain('push');
        expect(script).toContain('testset');
        expect(script).toContain('solutions');
        expect(script).toContain('checker');
      }
    );

    it.each(['bash', 'zsh', 'fish'])(
      'leaves hidden commands out of the %s script',
      shell => {
        const script = generateCompletionScript(buildProgram(), shell);
        expect(script).not.toContain("'__complete'");
        expect(script).not.toMatch(/-a '__complete'/);
        expect(script).not.toMatch(/\|__complete'/);
      }
    );

    it.each(['bash', 'zsh', 'fish'])(
      'asks `__complete` for names in the %s script',
      shell => {
        const script = generateCompletionScript(buildProgram(), shell);
        expect(script).toContain('__complete');
        expect(script).toContain('testsets');
        expect(script).toContain('groups');
        expect(script).toContain('solutions');
      }
    );

    it.each(['bash', 'zsh', 'fish'])(
      'reads --testset=value and --group=value in the %s script',
      shell => {
        const script = generateCompletionScript(buildProgram(), shell);
        expect(script).toContain('--*=*');
        expect(script).toMatch(/hasval/);
      }
    );

    it.each(['bash', 'zsh', 'fish'])(
      'ends options before the testset in the %s groups call',
      shell => {
        const script = generateCompletionScript(buildProgram(), shell);
        expect(script).toMatch(/groups -- /);
        expect(script).not.toMatch(
          /groups "?\$testset|groups \(__polyman_scan/
        );
      }
    );

    it('follows the program: a command added later shows up', () => {
      const program = buildProgram();
      program.command('frobnicate').description('A new command');
      expect(generateCompletionScript(program, 'bash')).toContain('frobnicate');
      expect(generateCompletionScript(program, 'fish')).toContain('frobnicate');
    });

    it('escapes quotes in descriptions for fish', () => {
      const script = generateCompletionScript(buildProgram(), 'fish');
      expect(script).toContain("(it\\'s remote)");
    });

    it('ends every script with a newline', () => {
      for (const shell of ['bash', 'zsh', 'fish']) {
        expect(generateCompletionScript(buildProgram(), shell)).toMatch(/\n$/);
      }
    });
  });

  describe('readCompletionNames', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'polyman-completion-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const writeConfig = (config: unknown) =>
      writeFileSync(join(dir, 'Config.json'), JSON.stringify(config));

    const config = {
      solutions: [{ name: 'main' }, { name: 'wa' }, { name: 'main' }],
      generators: [{ name: 'gen' }],
      testsets: [
        { name: 'tests', groups: [{ name: 'samples' }, { name: 'main' }] },
        { name: 'pretests' },
      ],
    };

    it('reads solution, generator and testset names', () => {
      writeConfig(config);
      expect(readCompletionNames('solutions', undefined, dir)).toEqual([
        'main',
        'wa',
      ]);
      expect(readCompletionNames('generators', undefined, dir)).toEqual([
        'gen',
      ]);
      expect(readCompletionNames('testsets', undefined, dir)).toEqual([
        'tests',
        'pretests',
      ]);
    });

    it('reads the groups of the given testset', () => {
      writeConfig(config);
      expect(readCompletionNames('groups', 'tests', dir)).toEqual([
        'samples',
        'main',
      ]);
      expect(readCompletionNames('groups', 'pretests', dir)).toEqual([]);
      expect(readCompletionNames('groups', 'missing', dir)).toEqual([]);
      expect(readCompletionNames('groups', undefined, dir)).toEqual([]);
    });

    it('returns [] when Config.json is missing', () => {
      expect(readCompletionNames('solutions', undefined, dir)).toEqual([]);
    });

    it('returns [] when Config.json is not valid JSON', () => {
      writeFileSync(join(dir, 'Config.json'), '{ nope');
      expect(readCompletionNames('testsets', undefined, dir)).toEqual([]);
    });

    it('returns [] for an unexpected shape', () => {
      writeConfig([1, 2]);
      expect(readCompletionNames('solutions', undefined, dir)).toEqual([]);
      writeConfig({ solutions: 'x', testsets: [null, 3, { name: 7 }] });
      expect(readCompletionNames('solutions', undefined, dir)).toEqual([]);
      expect(readCompletionNames('testsets', undefined, dir)).toEqual([]);
      expect(readCompletionNames('groups', 'tests', dir)).toEqual([]);
    });
  });
});
