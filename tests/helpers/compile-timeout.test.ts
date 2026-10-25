import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUT, compileTimeoutFrom } from '../../src/helpers/utils';

describe('compileTimeoutFrom', () => {
  it('uses POLYMAN_COMPILE_TIMEOUT_MS when it is a positive whole number', () => {
    expect(compileTimeoutFrom('60000')).toBe(60000);
  });

  it.each([undefined, '', 'abc', '0', '-5', '1.5'])(
    'falls back to the default for %s',
    raw => {
      expect(compileTimeoutFrom(raw)).toBe(DEFAULT_TIMEOUT);
    }
  );
});
