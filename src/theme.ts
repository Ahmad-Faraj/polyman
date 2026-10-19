/**
 * @fileoverview Color themes for terminal output.
 * The dark theme (default) keeps the original Codeforces colors; the light
 * theme swaps colors that are hard to read on light backgrounds.
 * By default the theme follows the terminal background; POLYMAN_THEME=dark or
 * POLYMAN_THEME=light forces one. Set NO_COLOR (https://no-color.org) to
 * disable colors entirely.
 */

import chalk, { Chalk, type ChalkInstance } from 'chalk';
import {
  detectBackground,
  type DetectOptions,
} from './helpers/terminal-background';

/**
 * Available theme names.
 * @typedef ThemeName
 */
export type ThemeName = 'dark' | 'light';

/**
 * Function that applies a style to a piece of text.
 * @typedef Style
 */
export type Style = (text: string) => string;

/**
 * Semantic styles used by the formatter and the help renderer.
 * @interface Theme
 */
export interface Theme {
  name: ThemeName;
  success: Style;
  successBold: Style;
  error: Style;
  errorBold: Style;
  warning: Style;
  info: Style;
  infoIcon: Style;
  muted: Style;
  heading: Style;
  stepTitle: Style;
  dim: Style;
  bold: Style;
  underline: Style;
  accent: Style;
  primary: Style;
}

/**
 * Reads POLYMAN_THEME. `dark` and `light` force a theme, unset, empty or
 * `auto` mean "follow the terminal", and unknown values fall back to dark.
 * @param {NodeJS.ProcessEnv} env - Environment to read
 * @returns {ThemeName | 'auto'} The theme setting
 */
export function readThemeSetting(env: NodeJS.ProcessEnv): ThemeName | 'auto' {
  const value = env['POLYMAN_THEME']?.trim().toLowerCase() ?? '';
  if (value === 'light') return 'light';
  if (value === '' || value === 'auto') return 'auto';
  return 'dark';
}

/**
 * Picks the theme name from POLYMAN_THEME without asking the terminal.
 * `auto` and unknown values give dark.
 * @param {NodeJS.ProcessEnv} env - Environment to read
 * @returns {ThemeName} Selected theme name
 */
export function resolveThemeName(env: NodeJS.ProcessEnv): ThemeName {
  return readThemeSetting(env) === 'light' ? 'light' : 'dark';
}

/**
 * Builds a theme on top of a chalk instance.
 * @param {ThemeName} name - Theme to build
 * @param {ChalkInstance} c - Chalk instance that controls the color level
 * @returns {Theme} The theme
 */
export function createTheme(name: ThemeName, c: ChalkInstance): Theme {
  const shared = {
    success: c.green,
    successBold: c.bold.green,
    error: c.red,
    errorBold: c.bold.red,
    infoIcon: c.blue,
    heading: c.bold.blue,
    dim: c.dim,
    bold: c.bold,
    underline: c.underline,
  };

  // chalk turns hex colors into xterm-256 colors on 256-color terminals and
  // into the 16 basic colors on older ones. These values keep at least 4.5:1
  // contrast on white after that conversion, and the warning color becomes
  // black, not red, on 16-color terminals so it does not look like an error.
  if (name === 'light') {
    return {
      ...shared,
      name,
      warning: c.hex('#7F4C00'), // 256-color: 94 (#875F00)
      info: (text: string) => text,
      muted: c.hex('#6C6C6C'), // 256-color: 242 (same value)
      stepTitle: c.bold,
      accent: c.hex('#D70000'), // 256-color: 160 (same value)
      primary: c.hex('#0D47A1'), // 256-color: 25 (#005FAF)
    };
  }

  return {
    ...shared,
    name,
    warning: c.yellow,
    info: c.white,
    muted: c.gray,
    stepTitle: c.bold.white,
    accent: c.hex('#FF6B6B'), // Codeforces red accent
    primary: c.hex('#1E88E5'), // Codeforces blue
  };
}

/**
 * Returns the theme selected by the environment, without detection (an unset
 * POLYMAN_THEME gives dark). A non-empty NO_COLOR disables all colors.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment to read
 * @param {ChalkInstance} [base=chalk] - Chalk instance used when colors are on
 * @returns {Theme} The active theme
 */
export function getTheme(
  env: NodeJS.ProcessEnv = process.env,
  base: ChalkInstance = chalk
): Theme {
  const noColor = Boolean(env['NO_COLOR']);
  return createTheme(
    resolveThemeName(env),
    noColor ? new Chalk({ level: 0 }) : base
  );
}

/**
 * Returns the theme for this run. Like {@link getTheme}, but when
 * POLYMAN_THEME is unset or `auto` it detects the terminal background and
 * picks the light theme on a light terminal. Never rejects.
 * @param {NodeJS.ProcessEnv} [env=process.env] - Environment to read
 * @param {ChalkInstance} [base=chalk] - Chalk instance used when colors are on
 * @param {DetectOptions} [options={}] - Overrides for detection (tests)
 * @returns {Promise<Theme>} The active theme
 */
export async function resolveTheme(
  env: NodeJS.ProcessEnv = process.env,
  base: ChalkInstance = chalk,
  options: DetectOptions = {}
): Promise<Theme> {
  if (env['NO_COLOR'] || readThemeSetting(env) !== 'auto') {
    return getTheme(env, base);
  }
  try {
    const detected = await detectBackground(env, {
      colorLevel: base.level,
      ...options,
    });
    return createTheme(detected ?? 'dark', base);
  } catch {
    return createTheme('dark', base);
  }
}
