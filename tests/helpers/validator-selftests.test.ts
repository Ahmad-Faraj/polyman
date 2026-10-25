import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  NO_INVALID_SELFTESTS_WARNING,
  validatorSelfTestWarning,
} from '../../src/helpers/validator-selftests';
import type { LocalValidator } from '../../src/types';

describe('validator-selftests.ts', () => {
  let dir: string;

  const validatorWith = (content: string | null): LocalValidator => {
    const validator: LocalValidator = {
      name: 'validator',
      source: 'validator/validator.cpp',
    };
    if (content === null) return validator;
    fs.writeFileSync(path.join(dir, 'validator_tests.json'), content);
    return { ...validator, testsFilePath: 'validator_tests.json' };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'polyman-selftests-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const warningFor = (validator: LocalValidator | undefined) => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      return validatorSelfTestWarning(validator);
    } finally {
      process.chdir(cwd);
    }
  };

  it('warns when no tests file is configured', () => {
    expect(warningFor(validatorWith(null))).toBe(NO_INVALID_SELFTESTS_WARNING);
    expect(warningFor(undefined)).toBe(NO_INVALID_SELFTESTS_WARNING);
  });

  it('warns when the tests list is empty', () => {
    expect(warningFor(validatorWith('{"tests": []}'))).toBe(
      NO_INVALID_SELFTESTS_WARNING
    );
  });

  it('warns when every self-test is VALID', () => {
    const content = JSON.stringify({
      tests: [
        { index: 1, input: '1\n', expectedVerdict: 'VALID' },
        { index: 2, input: '2\n', expectedVerdict: 'VALID' },
      ],
    });
    expect(warningFor(validatorWith(content))).toBe(
      NO_INVALID_SELFTESTS_WARNING
    );
  });

  it('warns when the tests file is missing or unreadable', () => {
    expect(
      warningFor({
        name: 'validator',
        source: 'validator.cpp',
        testsFilePath: 'missing.json',
      })
    ).toBe(NO_INVALID_SELFTESTS_WARNING);
    expect(warningFor(validatorWith('not json'))).toBe(
      NO_INVALID_SELFTESTS_WARNING
    );
  });

  it('returns null when at least one self-test is INVALID', () => {
    const content = JSON.stringify({
      tests: [
        { index: 1, input: '1\n', expectedVerdict: 'VALID' },
        { index: 2, input: '-1\n', expectedVerdict: 'INVALID' },
      ],
    });
    expect(warningFor(validatorWith(content))).toBeNull();
  });
});
