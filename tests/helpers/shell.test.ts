import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { quoteShellArgument } from '../../src/helpers/shell';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform });
}

describe('quoteShellArgument', () => {
  afterEach(() => {
    setPlatform(originalPlatform);
  });

  describe('POSIX', () => {
    beforeEach(() => {
      setPlatform('linux');
    });

    it('wraps the value in single quotes', () => {
      expect(quoteShellArgument('/tmp/polyman path 3)test')).toBe(
        "'/tmp/polyman path 3)test'"
      );
    });

    it('escapes embedded single quotes', () => {
      expect(quoteShellArgument("/tmp/O'Brien/main.cpp")).toBe(
        "'/tmp/O'\\''Brien/main.cpp'"
      );
    });

    it('keeps other shell metacharacters literal', () => {
      expect(quoteShellArgument('$HOME `id` "x" ; rm')).toBe(
        '\'$HOME `id` "x" ; rm\''
      );
    });

    it('quotes an empty string', () => {
      expect(quoteShellArgument('')).toBe("''");
    });
  });

  describe('Windows', () => {
    beforeEach(() => {
      setPlatform('win32');
    });

    it('wraps the value in double quotes', () => {
      expect(quoteShellArgument('C:\\polyman path 3)test\\main')).toBe(
        '"C:\\polyman path 3)test\\main"'
      );
    });

    it('doubles embedded double quotes', () => {
      expect(quoteShellArgument('say "hi"')).toBe('"say ""hi"""');
    });

    it('quotes an empty string', () => {
      expect(quoteShellArgument('')).toBe('""');
    });
  });
});
