import { describe, it, expect } from 'vitest';
import {
  EXIT_CANCELLED,
  EXIT_TERMINATED,
  LimitExceededError,
  PolymanError,
  exitCodeFor,
} from '../src/errors';
import {
  EXIT_NON_INTERACTIVE,
  NonInteractiveError,
} from '../src/helpers/errors';

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

  it('keeps the cause when one is given', () => {
    const cause = new Error('ECONNRESET');
    const error = new PolymanError('Polygon failed', 4, undefined, { cause });
    expect(error.cause).toBe(cause);
  });
});

describe('NonInteractiveError', () => {
  it('is a PolymanError with exit code 2', () => {
    const error = new NonInteractiveError('pass --yes');
    expect(error).toBeInstanceOf(PolymanError);
    expect(error.exitCode).toBe(EXIT_NON_INTERACTIVE);
    expect(exitCodeFor(error)).toBe(2);
    expect(error.name).toBe('NonInteractiveError');
  });
});

describe('signal exit codes', () => {
  it('are 128 plus the signal number', () => {
    expect(EXIT_CANCELLED).toBe(130);
    expect(EXIT_TERMINATED).toBe(143);
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
