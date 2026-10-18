import { describe, it, expect, vi, afterEach } from 'vitest';
import { Chalk } from 'chalk';
import { Command } from 'commander';
import { createTheme, getTheme, resolveThemeName } from '../src/theme';
import { Formatter } from '../src/formatter';
import { printComprehensiveHelp } from '../src/help';

const colorChalk = new Chalk({ level: 3 });
const ESC = '\u001b[';

describe('resolveThemeName', () => {
  it('defaults to dark when POLYMAN_THEME is unset', () => {
    expect(resolveThemeName({})).toBe('dark');
  });

  it('selects light when POLYMAN_THEME=light', () => {
    expect(resolveThemeName({ POLYMAN_THEME: 'light' })).toBe('light');
  });

  it('ignores case and surrounding whitespace', () => {
    expect(resolveThemeName({ POLYMAN_THEME: ' Light ' })).toBe('light');
  });

  it('falls back to dark for unknown values', () => {
    expect(resolveThemeName({ POLYMAN_THEME: 'solarized' })).toBe('dark');
    expect(resolveThemeName({ POLYMAN_THEME: '' })).toBe('dark');
  });
});

describe('getTheme', () => {
  it('returns the dark theme by default', () => {
    const theme = getTheme({}, colorChalk);
    expect(theme.name).toBe('dark');
    expect(theme.info('x')).toBe(colorChalk.white('x'));
  });

  it('returns the light theme when POLYMAN_THEME=light', () => {
    const theme = getTheme({ POLYMAN_THEME: 'light' }, colorChalk);
    expect(theme.name).toBe('light');
    expect(theme.warning('x')).not.toBe(colorChalk.yellow('x'));
    expect(theme.warning('x')).toContain(ESC);
  });

  it('returns the dark theme for an unknown POLYMAN_THEME', () => {
    const theme = getTheme({ POLYMAN_THEME: 'neon' }, colorChalk);
    expect(theme.name).toBe('dark');
    expect(theme.error('x')).toBe(colorChalk.red('x'));
  });

  it('disables colors when NO_COLOR is set and non-empty', () => {
    for (const POLYMAN_THEME of ['dark', 'light']) {
      const theme = getTheme({ NO_COLOR: '1', POLYMAN_THEME }, colorChalk);
      expect(theme.error('x')).toBe('x');
      expect(theme.primary('x')).toBe('x');
      expect(theme.heading('x')).toBe('x');
    }
  });

  it('keeps colors when NO_COLOR is empty', () => {
    const theme = getTheme({ NO_COLOR: '' }, colorChalk);
    expect(theme.error('x')).toBe(colorChalk.red('x'));
  });
});

describe('createTheme', () => {
  it('dark theme keeps the original Codeforces colors', () => {
    const dark = createTheme('dark', colorChalk);
    expect(dark.success('x')).toBe(colorChalk.green('x'));
    expect(dark.muted('x')).toBe(colorChalk.gray('x'));
    expect(dark.stepTitle('x')).toBe(colorChalk.bold.white('x'));
    expect(dark.accent('x')).toBe(colorChalk.hex('#FF6B6B')('x'));
    expect(dark.primary('x')).toBe(colorChalk.hex('#1E88E5')('x'));
  });

  it('light theme replaces colors that are hard to read on light backgrounds', () => {
    const light = createTheme('light', colorChalk);
    expect(light.info('x')).toBe('x');
    expect(light.stepTitle('x')).toBe(colorChalk.bold('x'));
    expect(light.muted('x')).not.toBe(colorChalk.gray('x'));
    expect(light.warning('x')).not.toBe(colorChalk.yellow('x'));
    expect(light.accent('x')).not.toBe(colorChalk.hex('#FF6B6B')('x'));
    expect(light.primary('x')).not.toBe(colorChalk.hex('#1E88E5')('x'));
  });
});

describe('theme consumers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Formatter uses the injected theme', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const light = createTheme('light', colorChalk);
    const formatter = new Formatter(light);
    formatter.warning('w');
    expect(spy).toHaveBeenCalledWith(light.warning('w'));
    expect(formatter.primary('p')).toBe(light.primary('p'));
  });

  it('printComprehensiveHelp uses the injected theme', () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      lines.push(
        args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')
      );
    });
    const light = createTheme('light', colorChalk);
    const program = new Command();
    program.name('polyman').description('CLI').version('1.0.0');
    program.command('new').option('-f, --force', 'force');

    printComprehensiveHelp(program, light);

    const out = lines.join('\n');
    expect(out).toContain(light.warning('Options:'));
    expect(out).toContain(light.muted('-'.repeat(50)));
  });
});
