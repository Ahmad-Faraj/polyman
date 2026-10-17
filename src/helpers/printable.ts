/**
 * @fileoverview Escaping of text received from Polygon before it is printed.
 * Kept in its own module so both the pull helpers and the steps can use it.
 */

export const UNPRINTABLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/**
 * Escapes control characters (newlines, ANSI escapes, C1 controls, bidi
 * overrides) so text received from Polygon cannot forge log lines or drive
 * the terminal when it is printed.
 *
 * @param {string} text - Text received from Polygon, such as an error message
 * @returns {string} The text with control characters written as \uXXXX
 */
export function printable(text: string): string {
  return String(text).replace(
    new RegExp(UNPRINTABLE.source, 'g'),
    c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  );
}
