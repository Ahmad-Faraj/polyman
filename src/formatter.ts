/**
 * @fileoverview Terminal output formatter with Codeforces-themed styling.
 * Provides consistent, colorful CLI output; colors come from the active theme.
 * All methods use explicit icon placement for better indentation control.
 */

import { getTheme, type Theme } from './theme';

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
 * Formatter class for creating styled terminal output with Codeforces theme.
 * Colors come from a {@link Theme} (see src/theme.ts). The CLI detects the
 * theme once at startup and applies it with {@link Formatter.setTheme}.
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

  /**
   * @param {Theme} [theme=getTheme()] - Color theme to style output with
   */
  constructor(private theme: Theme = getTheme()) {}

  /**
   * Replaces the color theme. The CLI calls it after detecting the terminal
   * background, because `fmt` is created before detection finishes.
   * @param {Theme} theme - Color theme to style output with
   */
  setTheme(theme: Theme): void {
    this.theme = theme;
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
    this.print(this.theme.muted(message));
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
    return this.theme.heading(text);
  }

  /**
   * Returns dimmed/grayed text.
   * @param {string} text - Text to dim
   * @returns {string} Styled text
   * @example
   * fmt.info(`${fmt.dim('(optional)')}`);
   */
  dim(text: string): string {
    return this.theme.dim(text);
  }

  /**
   * Returns bold text.
   * @param {string} text - Text to make bold
   * @returns {string} Styled text
   * @example
   * this.print(fmt.bold('Important:'));
   */
  bold(text: string): string {
    return this.theme.bold(text);
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
      this.theme.successBold(
        '  ╔═══════════════════════════════════════════════╗'
      )
    );
    this.print(this.theme.successBold(`    🎉  ${message.padEnd(41)}  `));
    this.print(
      this.theme.successBold(
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
      this.theme.errorBold('  ╔═══════════════════════════════════════════╗')
    );
    this.print(this.theme.errorBold(`   ❌  ${message.padEnd(35)}  `));
    this.print(
      this.theme.errorBold('  ╚═══════════════════════════════════════════╝')
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
