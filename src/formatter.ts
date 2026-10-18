/**
 * @fileoverview Terminal output formatter with Codeforces-themed styling.
 * Provides consistent, colorful CLI output using chalk library.
 * All methods use explicit icon placement for better indentation control.
 */

import chalk, { type ChalkInstance } from 'chalk';

/**
 * Stream that human-readable output is written to.
 * @typedef OutputTarget
 */
export type OutputTarget = 'stdout' | 'stderr';

/**
 * Listener that receives every message passed to `fmt.error`.
 * @typedef ErrorSink
 */
export type ErrorSink = (message: string) => void;

/**
 * Name of a theme known to a formatter (built-in or registered).
 * @typedef ThemeName
 */
export type ThemeName = string;

/**
 * Names of the themes that ship with polyman.
 * @typedef BuiltInThemeName
 */
export type BuiltInThemeName = 'dark' | 'light';

/**
 * Colour palette used by the formatter. Each entry is a chalk style, so a
 * theme can combine colours with modifiers (for example `chalk.bold.blue`).
 * @interface Theme
 */
export interface Theme {
  /** Success text, the checkmark icon and step completion lines. */
  success: ChalkInstance;
  /** Error text and the cross icon. */
  error: ChalkInstance;
  /** Warning text and the warning icon. */
  warning: ChalkInstance;
  /** Plain informational text. */
  info: ChalkInstance;
  /** De-emphasised log text. */
  log: ChalkInstance;
  /** The info icon. */
  infoIcon: ChalkInstance;
  /** Section headers and the "Step N:" prefix. */
  heading: ChalkInstance;
  /** The title that follows "Step N:". */
  stepTitle: ChalkInstance;
  /** Text returned by `highlight()`. */
  highlight: ChalkInstance;
  /** Text returned by `accent()`. */
  accent: ChalkInstance;
  /** Text returned by `primary()`. */
  primary: ChalkInstance;
  /** Border and text of the success box. */
  successBox: ChalkInstance;
  /** Border and text of the error box. */
  errorBox: ChalkInstance;
}

/**
 * The default theme: Codeforces-style colours for dark terminals.
 * @constant
 */
const darkTheme: Theme = {
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.white,
  log: chalk.gray,
  infoIcon: chalk.blue,
  heading: chalk.bold.blue,
  stepTitle: chalk.bold.white,
  highlight: chalk.bold.blue,
  accent: chalk.hex('#FF6B6B'), // Codeforces red accent
  primary: chalk.hex('#1E88E5'), // Codeforces blue
  successBox: chalk.bold.green,
  errorBox: chalk.bold.red,
};

/**
 * A theme for light terminals: no white or light gray text, and darker
 * shades of yellow, green, red and blue that stay readable on white.
 * @constant
 */
const lightTheme: Theme = {
  success: chalk.hex('#15803D'),
  error: chalk.hex('#B91C1C'),
  warning: chalk.hex('#B45309'),
  info: chalk.black,
  log: chalk.hex('#555555'),
  infoIcon: chalk.hex('#1565C0'),
  heading: chalk.bold.hex('#1565C0'),
  stepTitle: chalk.bold.black,
  highlight: chalk.bold.hex('#1565C0'),
  accent: chalk.hex('#C62828'),
  primary: chalk.hex('#1565C0'),
  successBox: chalk.bold.hex('#15803D'),
  errorBox: chalk.bold.hex('#B91C1C'),
};

/**
 * The built-in themes, by name.
 * @constant
 */
export const themes: Readonly<Record<BuiltInThemeName, Theme>> = {
  dark: darkTheme,
  light: lightTheme,
};

/**
 * Formatter class for creating styled terminal output with Codeforces theme.
 * Uses chalk library for coloring with custom hex colors (#1E88E5 blue, #FF6B6B red).
 *
 * @class Formatter
 * @example
 * import { fmt } from './formatter';
 *
 * fmt.section('📁 CREATE TEMPLATE');
 * fmt.step(1, 'Creating directory');
 * fmt.success('Directory created!');
 * fmt.stepComplete('Done');
 */
export class Formatter {
  private target: OutputTarget = 'stdout';
  private errorSink: ErrorSink | null = null;
  private theme: Theme = themes.dark;
  private registry = new Map<ThemeName, Theme>(Object.entries(themes));

  /**
   * Selects the colour theme. Accepts the name of a built-in or registered
   * theme, or a theme object. The default is `dark`.
   * @param {ThemeName | Theme} theme - Theme name or palette
   * @throws {Error} If the name is not a known theme
   * @example
   * fmt.setTheme('light');
   */
  setTheme(theme: ThemeName | Theme): void {
    if (typeof theme !== 'string') {
      this.theme = theme;
      return;
    }
    const found = this.registry.get(theme);
    if (!found) {
      const known = [...this.registry.keys()].join(', ');
      throw new Error(`Unknown theme "${theme}". Available themes: ${known}`);
    }
    this.theme = found;
  }

  /**
   * Returns the active theme.
   * @returns {Theme} The palette in use
   */
  getTheme(): Theme {
    return this.theme;
  }

  /**
   * Registers a named theme on this formatter so `setTheme(name)` can select
   * it. The built-in `dark` and `light` themes can't be replaced.
   * @param {ThemeName} name - Name to register the theme under
   * @param {Theme} theme - The palette
   * @throws {Error} If the name belongs to a built-in theme
   */
  registerTheme(name: ThemeName, theme: Theme): void {
    if (Object.hasOwn(themes, name)) {
      throw new Error(`Cannot replace built-in theme "${name}"`);
    }
    this.registry.set(name, theme);
  }

  /**
   * Routes all printed output to stdout (default) or stderr.
   * `--json` commands switch to stderr so stdout carries only the JSON report.
   * @param {OutputTarget} target - Stream to print to
   */
  setOutput(target: OutputTarget): void {
    this.target = target;
  }

  /**
   * Returns the stream human output currently goes to.
   * @returns {OutputTarget} 'stdout' or 'stderr'
   */
  getOutput(): OutputTarget {
    return this.target;
  }

  /**
   * Registers a listener that receives every `error()` message, or null to
   * remove it. Used by the JSON report collector to capture failure text.
   * @param {ErrorSink | null} sink - Listener for error messages
   */
  setErrorSink(sink: ErrorSink | null): void {
    this.errorSink = sink;
  }

  private print(...parts: string[]): void {
    if (this.target === 'stderr') {
      console.error(...parts);
    } else {
      console.log(...parts);
    }
  }

  /**
   * Prints a success message in green.
   * @param {string} message - The message to display
   * @example
   * fmt.success('Template created successfully!');
   */
  success(message: string) {
    this.print(this.theme.success(message));
  }

  /**
   * Prints an error message in red.
   * @param {string} message - The error message to display
   * @example
   * fmt.error('Failed to compile validator');
   */
  error(message: string) {
    this.print(this.theme.error(message));
    this.errorSink?.(message);
  }

  /**
   * Prints a warning message in yellow.
   * @param {string} message - The warning message to display
   * @example
   * fmt.warning('testlib.h already exists');
   */
  warning(message: string) {
    this.print(this.theme.warning(message));
  }

  /**
   * Prints an informational message in white.
   * @param {string} message - The info message to display
   * @example
   * fmt.info(`Target: ${generatorName}`);
   */
  info(message: string) {
    this.print(this.theme.info(message));
  }

  /**
   * Prints a dimmed/gray log message.
   * Used for less important information.
   * @param {string} message - The message to display
   * @example
   * fmt.log('Additional details...');
   */
  log(message: string) {
    this.print(this.theme.log(message));
  }

  /**
   * Returns a green checkmark icon (✓).
   * Use explicitly in messages for better indentation control.
   * @returns {string} Styled checkmark
   * @example
   * fmt.success(`${fmt.checkmark()} Test passed`);
   */
  checkmark(): string {
    return this.theme.success('✓');
  }

  /**
   * Returns a red cross icon (✖).
   * Use explicitly in messages for better indentation control.
   * @returns {string} Styled cross
   * @example
   * fmt.error(`${fmt.cross()} Test failed`);
   */
  cross(): string {
    return this.theme.error('✖');
  }

  /**
   * Returns a yellow warning icon (⚠).
   * Use explicitly in messages for better indentation control.
   * @returns {string} Styled warning icon
   * @example
   * fmt.warning(`${fmt.warningIcon()} Memory limit not supported on Windows`);
   */
  warningIcon(): string {
    return this.theme.warning('⚠');
  }

  /**
   * Returns a blue info icon (ℹ).
   * Use explicitly in messages for better indentation control.
   * @returns {string} Styled info icon
   * @example
   * fmt.info(`${fmt.infoIcon()} Found 5 generators`);
   */
  infoIcon(): string {
    return this.theme.infoIcon('ℹ');
  }

  /**
   * Prints a section header with blue double-line border.
   * Used to separate major sections in command output.
   * @param {string} title - The section title
   * @example
   * fmt.section('📁 CREATE NEW PROBLEM TEMPLATE');
   */
  section(title: string) {
    this.print();
    this.print(this.theme.heading(`${'═'.repeat(50)}`));
    this.print(this.theme.heading(`  ${title}`));
    this.print(this.theme.heading(`${'═'.repeat(50)}`));
    this.print();
  }

  /**
   * Prints a numbered step header with a top corner bracket.
   * @param {number} stepNumber - The step number
   * @param {string} title - The step description
   * @example
   * fmt.step(1, 'Creating Directory Structure');
   */
  step(stepNumber: number, title: string) {
    this.print();
    this.print(
      this.theme.heading(`┌─ Step ${stepNumber}: `) +
        this.theme.stepTitle(title)
    );
  }
  /**
   * Prints a newLine.
   * @example
   * fmt.newLine();
   */
  newLine() {
    this.print();
  }

  /**
   * Prints a step completion message with a bottom corner bracket and checkmark.
   * @param {string} [message] - Optional completion message (defaults to 'Complete')
   * @example
   * fmt.stepComplete('Directory created');
   */
  stepComplete(message?: string) {
    if (message) {
      this.print(this.theme.success(`└─ ✓ ${message}`));
    } else {
      this.print(this.theme.success(`└─ ✓ Complete`));
    }
  }

  /**
   * Returns highlighted text in Codeforces blue color.
   * @param {string} text - Text to highlight
   * @returns {string} Styled text
   * @example
   * fmt.info(`Target: ${fmt.highlight('all')}`);
   */
  highlight(text: string): string {
    return this.theme.highlight(text);
  }

  /**
   * Returns dimmed/grayed text.
   * @param {string} text - Text to dim
   * @returns {string} Styled text
   * @example
   * fmt.info(`${fmt.dim('(optional)')}`);
   */
  dim(text: string): string {
    return chalk.dim(text);
  }

  /**
   * Returns bold text.
   * @param {string} text - Text to make bold
   * @returns {string} Styled text
   * @example
   * this.print(fmt.bold('Important:'));
   */
  bold(text: string): string {
    return chalk.bold(text);
  }

  /**
   * Returns text in Codeforces red accent color (#FF6B6B).
   * @param {string} text - Text to style
   * @returns {string} Styled text
   * @example
   * fmt.log(`Error: ${fmt.accent('Failed')}`);
   */
  accent(text: string): string {
    return this.theme.accent(text);
  }

  /**
   * Returns text in Codeforces primary blue color (#1E88E5).
   * @param {string} text - Text to style
   * @returns {string} Styled text
   * @example
   * fmt.info(`Main solution: ${fmt.primary(mainSolution.name)}`);
   */
  primary(text: string): string {
    return this.theme.primary(text);
  }

  /**
   * Prints a success box with green border and celebration emoji.
   * Used for final success messages.
   * @param {string} message - Success message to display
   * @example
   * fmt.successBox('TEMPLATE CREATED SUCCESSFULLY!');
   */
  successBox(message: string) {
    this.print();
    this.print(
      this.theme.successBox(
        '  ╔═══════════════════════════════════════════════╗'
      )
    );
    this.print(this.theme.successBox(`    🎉  ${message.padEnd(41)}  `));
    this.print(
      this.theme.successBox(
        '  ╚═══════════════════════════════════════════════╝'
      )
    );
    this.print();
  }

  /**
   * Prints an error box with red border and cross emoji.
   * Used for final error messages.
   * @param {string} message - Error message to display
   * @example
   * fmt.errorBox('VALIDATION FAILED!');
   */
  errorBox(message: string) {
    this.print();
    this.print(
      this.theme.errorBox('  ╔═══════════════════════════════════════════╗')
    );
    this.print(this.theme.errorBox(`   ❌  ${message.padEnd(35)}  `));
    this.print(
      this.theme.errorBox('  ╚═══════════════════════════════════════════╝')
    );
    this.print();
  }
}

/**
 * Singleton instance of the Formatter class.
 * Import and use this instance throughout the application for consistent styling.
 *
 * @constant
 * @type {Formatter}
 * @example
 * import { fmt } from './formatter';
 * fmt.success('Operation completed!');
 */
export const fmt = new Formatter();
