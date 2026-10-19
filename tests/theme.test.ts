import { describe, it, expect, vi, afterEach } from 'vitest';
import chalk, { Chalk } from 'chalk';
import { Command } from 'commander';
import { createTheme, getTheme, resolveThemeName } from '../src/theme';
import { Formatter } from '../src/formatter';
import { printComprehensiveHelp } from '../src/help';

const colorChalk = new Chalk({ level: 3 });
const ESC = '\u001b[';

/** Returns the SGR parameters of the first escape code, e.g. '38;5;94'. */
function sgr(styled: string): string {
  const start = styled.indexOf(ESC);
  if (start === -1) return '';
  return styled.slice(start + ESC.length, styled.indexOf('m', start));
}

/** Turns a 256-color index into RGB the same way xterm does. */
function xterm256ToRgb(index: number): number[] {
  if (index >= 232) {
    const v = 8 + (index - 232) * 10;
    return [v, v, v];
  }
  const steps = [0, 95, 135, 175, 215, 255];
  const n = index - 16;
  return [
    steps[Math.floor(n / 36)] ?? 0,
    steps[Math.floor((n % 36) / 6)] ?? 0,
    steps[n % 6] ?? 0,
  ];
}

/** Reads the foreground RGB from a 38;2;r;g;b or 38;5;n code. */
function foregroundRgb(code: string): number[] {
  const parts = code.split(';').map(Number);
  if (parts[1] === 2) return parts.slice(2, 5);
  return xterm256ToRgb(parts[2] ?? 0);
}

/** WCAG contrast ratio between an RGB color and white. */
function contrastOnWhite(rgb: number[]): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r = 0, g = 0, b = 0] = rgb.map(channel);
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

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

describe('light theme on different color levels', () => {
  const lightColors = ['warning', 'muted', 'accent', 'primary'] as const;

  for (const level of [3, 2] as const) {
    it(`keeps 4.5:1 contrast on white at level ${level}`, () => {
      const light = createTheme('light', new Chalk({ level }));
      for (const key of lightColors) {
        const ratio = contrastOnWhite(foregroundRgb(sgr(light[key]('x'))));
        expect(ratio, key).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('uses the expected 256-color codes at level 2', () => {
    const light = createTheme('light', new Chalk({ level: 2 }));
    expect(sgr(light.warning('x'))).toBe('38;5;94');
    expect(sgr(light.muted('x'))).toBe('38;5;242');
    expect(sgr(light.accent('x'))).toBe('38;5;160');
  });

  it('does not show warnings in the error color at level 1', () => {
    const light = createTheme('light', new Chalk({ level: 1 }));
    expect(sgr(light.warning('x'))).not.toBe(sgr(light.error('x')));
    expect(sgr(light.warning('x'))).not.toBe(sgr(light.errorBold('x')));
  });
});

describe('Formatter default theme', () => {
  const originalLevel = chalk.level;

  afterEach(() => {
    chalk.level = originalLevel;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('turns colors off when NO_COLOR is set', () => {
    chalk.level = 3;
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('POLYMAN_THEME', 'light');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const formatter = new Formatter();
    formatter.warning('w');
    formatter.error('e');
    expect(spy).toHaveBeenCalledWith('w');
    expect(spy).toHaveBeenCalledWith('e');
    expect(formatter.primary('p')).toBe('p');
    expect(formatter.highlight('h')).toBe('h');
  });

  it('uses the light theme when POLYMAN_THEME=light', () => {
    chalk.level = 3;
    vi.stubEnv('NO_COLOR', '');
    vi.stubEnv('POLYMAN_THEME', 'light');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const light = createTheme('light', colorChalk);
    const formatter = new Formatter();
    formatter.warning('w');
    expect(spy).toHaveBeenCalledWith(light.warning('w'));
    expect(formatter.primary('p')).toBe(light.primary('p'));
    expect(formatter.accent('a')).toBe(light.accent('a'));
  });

  it('uses the dark theme when POLYMAN_THEME is not set', () => {
    chalk.level = 3;
    vi.stubEnv('NO_COLOR', '');
    vi.stubEnv('POLYMAN_THEME', '');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const formatter = new Formatter();
    formatter.warning('w');
    expect(spy).toHaveBeenCalledWith(colorChalk.yellow('w'));
    expect(formatter.primary('p')).toBe(colorChalk.hex('#1E88E5')('p'));
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
