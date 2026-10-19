import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fmt, Formatter } from '../src/formatter';
import chalk from 'chalk';

describe('Formatter', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn<Console, 'log'>>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should be a singleton instance', () => {
    expect(fmt).toBeInstanceOf(Formatter);
  });

  describe('logging methods', () => {
    it('should log success message in green', () => {
      fmt.success('Success message');
      expect(consoleSpy).toHaveBeenCalledWith(chalk.green('Success message'));
    });

    it('should log error message in red', () => {
      fmt.error('Error message');
      expect(consoleSpy).toHaveBeenCalledWith(chalk.red('Error message'));
    });

    it('should log warning message in yellow', () => {
      fmt.warning('Warning message');
      expect(consoleSpy).toHaveBeenCalledWith(chalk.yellow('Warning message'));
    });

    it('should log info message in white', () => {
      fmt.info('Info message');
      expect(consoleSpy).toHaveBeenCalledWith(chalk.white('Info message'));
    });

    it('should log gray message', () => {
      fmt.log('Log message');
      expect(consoleSpy).toHaveBeenCalledWith(chalk.gray('Log message'));
    });
  });

  describe('icon methods', () => {
    it('should return green checkmark', () => {
      expect(fmt.checkmark()).toBe(chalk.green('✓'));
    });

    it('should return red cross', () => {
      expect(fmt.cross()).toBe(chalk.red('✖'));
    });

    it('should return yellow warning icon', () => {
      expect(fmt.warningIcon()).toBe(chalk.yellow('⚠'));
    });

    it('should return blue info icon', () => {
      expect(fmt.infoIcon()).toBe(chalk.blue('ℹ'));
    });
  });

  describe('style methods', () => {
    it('should return highlighted text', () => {
      expect(fmt.highlight('text')).toBe(chalk.bold.blue('text'));
    });

    it('should return dimmed text', () => {
      expect(fmt.dim('text')).toBe(chalk.dim('text'));
    });

    it('should return bold text', () => {
      expect(fmt.bold('text')).toBe(chalk.bold('text'));
    });

    it('should return accent text', () => {
      expect(fmt.accent('text')).toBe(chalk.hex('#FF6B6B')('text'));
    });

    it('should return primary text', () => {
      expect(fmt.primary('text')).toBe(chalk.hex('#1E88E5')('text'));
    });
  });

  describe('output target', () => {
    it('defaults to stdout', () => {
      expect(fmt.getOutput()).toBe('stdout');
    });

    it('routes every print method to stderr after setOutput("stderr")', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const local = new Formatter();
      local.setOutput('stderr');
      expect(local.getOutput()).toBe('stderr');

      local.success('s');
      local.error('e');
      local.warning('w');
      local.info('i');
      local.log('l');
      local.newLine();
      local.section('T');
      local.step(1, 'S');
      local.stepComplete();
      local.successBox('ok');
      local.errorBox('no');

      expect(consoleSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(chalk.green('s'));
      expect(errorSpy).toHaveBeenCalledWith(chalk.red('e'));
      expect(errorSpy).toHaveBeenCalledWith(chalk.yellow('w'));
      expect(errorSpy).toHaveBeenCalledWith(chalk.white('i'));
      expect(errorSpy).toHaveBeenCalledWith(chalk.gray('l'));
      // newLine(1) + section(5) + step(2) + stepComplete(1) + boxes(10) + 5
      expect(errorSpy).toHaveBeenCalledTimes(24);
    });

    it('switches back to stdout', () => {
      const local = new Formatter();
      local.setOutput('stderr');
      local.setOutput('stdout');
      local.info('back');
      expect(consoleSpy).toHaveBeenCalledWith(chalk.white('back'));
    });
  });

  describe('error sink', () => {
    it('forwards the raw error message to the sink', () => {
      const local = new Formatter();
      const sink = vi.fn();
      local.setErrorSink(sink);
      local.error('bad thing');
      expect(sink).toHaveBeenCalledWith('bad thing');
      expect(consoleSpy).toHaveBeenCalledWith(chalk.red('bad thing'));
    });

    it('does not forward other message kinds', () => {
      const local = new Formatter();
      const sink = vi.fn();
      local.setErrorSink(sink);
      local.warning('w');
      local.info('i');
      local.errorBox('box');
      expect(sink).not.toHaveBeenCalled();
    });

    it('stops forwarding after the sink is cleared', () => {
      const local = new Formatter();
      const sink = vi.fn();
      local.setErrorSink(sink);
      local.setErrorSink(null);
      local.error('x');
      expect(sink).not.toHaveBeenCalled();
    });
  });

  describe('complex output methods', () => {
    it('should print section header', () => {
      fmt.section('Title');
      expect(consoleSpy).toHaveBeenCalledTimes(5); // empty, line, title, line, empty
    });

    it('should print step', () => {
      fmt.step(1, 'Step Title');
      expect(consoleSpy).toHaveBeenCalledTimes(2); // empty, step line
    });

    it('should print step complete', () => {
      fmt.stepComplete('Done');
      expect(consoleSpy).toHaveBeenCalledWith(chalk.green(`└─ ✓ Done`));
    });

    it('should print step complete default', () => {
      fmt.stepComplete();
      expect(consoleSpy).toHaveBeenCalledWith(chalk.green(`└─ ✓ Complete`));
    });

    it('should print success box', () => {
      fmt.successBox('Yay');
      expect(consoleSpy).toHaveBeenCalledTimes(5);
    });

    it('should print error box', () => {
      fmt.errorBox('Nay');
      expect(consoleSpy).toHaveBeenCalledTimes(5);
    });
  });
});
