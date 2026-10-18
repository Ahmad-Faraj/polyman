/**
 * @fileoverview Color themes for terminal output.
 * The dark theme (default) keeps the original Codeforces colors; the light
 * theme swaps colors that are hard to read on light backgrounds.
 * Select with POLYMAN_THEME=light. Set NO_COLOR (https://no-color.org) to
 * disable colors entirely.
 */

import chalk, { Chalk, type ChalkInstance } from 'chalk';

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
 * Picks the theme name from POLYMAN_THEME. Unknown values fall back to dark.
 * @param {NodeJS.ProcessEnv} env - Environment to read
 * @returns {ThemeName} Selected theme name
 */
export function resolveThemeName(env: NodeJS.ProcessEnv): ThemeName {
  return env['POLYMAN_THEME']?.trim().toLowerCase() === 'light'
    ? 'light'
    : 'dark';
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

  if (name === 'light') {
    return {
      ...shared,
      name,
      warning: c.hex('#B35C00'),
      info: (text: string) => text,
      muted: c.hex('#5F6368'),
      stepTitle: c.bold,
      accent: c.hex('#C62828'),
      primary: c.hex('#0D47A1'),
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
 * Returns the theme selected by the environment.
 * A non-empty NO_COLOR disables all colors.
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
