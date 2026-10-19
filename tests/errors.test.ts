import { describe, it, expect } from 'vitest';
import { LimitExceededError, PolymanError, exitCodeFor } from '../src/errors';

describe('PolymanError', () => {
  it('carries the message, the exit code and the hint', () => {
    const error = new PolymanError('bad config', 2, 'fix Config.json');
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('bad config');
    expect(error.exitCode).toBe(2);
    expect(error.hint).toBe('fix Config.json');
    expect(error.name).toBe('PolymanError');
  });

  it('has no hint when none is given', () => {
    expect(new PolymanError('failed', 1).hint).toBeUndefined();
  });
});

describe('LimitExceededError', () => {
  it('is a PolymanError with exit code 1', () => {
    const error = new LimitExceededError('too slow');
    expect(error).toBeInstanceOf(PolymanError);
    expect(error.exitCode).toBe(1);
    expect(error.name).toBe('LimitExceededError');
  });
});

describe('exitCodeFor', () => {
  it.each([1, 2, 3, 4] as const)('returns %i for a PolymanError', code => {
    expect(exitCodeFor(new PolymanError('x', code))).toBe(code);
  });

  it('returns 1 for a plain Error', () => {
    expect(exitCodeFor(new Error('boom'))).toBe(1);
  });

  it('returns 1 for a value that is not an Error', () => {
    expect(exitCodeFor('boom')).toBe(1);
    expect(exitCodeFor(undefined)).toBe(1);
  });
});
