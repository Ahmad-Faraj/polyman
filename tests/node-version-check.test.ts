import { describe, it, expect } from 'vitest';
import { isSupportedNodeVersion } from '../src/node-version-check';

describe('isSupportedNodeVersion', () => {
  it.each([
    ['20.18.0', false],
    ['20.19.0', true],
    ['21.7.0', false],
    ['22.11.0', false],
    ['22.12.0', true],
    ['24.0.0', true],
    ['18.20.4', false],
    ['20.20.1', true],
    ['22.23.3', true],
  ])('%s -> %s', (version, expected) => {
    expect(isSupportedNodeVersion(version)).toBe(expected);
  });
});
