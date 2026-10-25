/**
 * @fileoverview Checks that a validator's self-tests can tell good input from
 * bad. A validator with no INVALID self-test could accept every input and
 * still pass `verify`, so `verify` warns about it.
 */

import fs from 'fs';
import path from 'path';
import type { LocalValidator, ValidatorTest } from '../types';

/** Warning text shown when a validator has no INVALID self-test. */
export const NO_INVALID_SELFTESTS_WARNING =
  'the validator has no INVALID self-tests, so nothing checks that it rejects bad input';

/**
 * Returns a warning when the validator's self-tests contain no test with the
 * INVALID verdict (no tests file configured, an empty or unreadable file, or
 * VALID-only tests). Returns null when at least one INVALID test exists.
 * Never throws: a broken tests file already fails the `test-validator` step.
 *
 * @param {LocalValidator | undefined} validator - Validator configuration
 * @returns {string | null} The warning text, or null when there is none
 *
 * @example
 * const warning = validatorSelfTestWarning(config.validator);
 * if (warning) fmt.warning(warning);
 */
export function validatorSelfTestWarning(
  validator: LocalValidator | undefined
): string | null {
  const testsFilePath = validator?.testsFilePath;
  if (!testsFilePath) return NO_INVALID_SELFTESTS_WARNING;
  try {
    const raw = fs.readFileSync(
      path.resolve(process.cwd(), testsFilePath),
      'utf-8'
    );
    const parsed = JSON.parse(raw) as { tests?: ValidatorTest[] };
    const hasInvalid =
      Array.isArray(parsed.tests) &&
      parsed.tests.some(test => test.expectedVerdict === 'INVALID');
    return hasInvalid ? null : NO_INVALID_SELFTESTS_WARNING;
  } catch {
    return NO_INVALID_SELFTESTS_WARNING;
  }
}
