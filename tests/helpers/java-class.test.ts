import { describe, it, expect } from 'vitest';
import {
  isJavaIdentifier,
  renamePublicClass,
} from '../../src/helpers/java-class';

describe('renamePublicClass', () => {
  it('renames the declaration', () => {
    expect(
      renamePublicClass('public class Main {\n}\n', 'Main', 'Solution')
    ).toBe('public class Solution {\n}\n');
  });

  it('renames constructors, new expressions and static references', () => {
    const code = [
      'public class Main {',
      '  static int helper() { return 1; }',
      '  Main() {}',
      '  public static void main(String[] args) {',
      '    Main m = new Main();',
      '    int x = Main.helper();',
      '  }',
      '}',
    ].join('\n');
    const out = renamePublicClass(code, 'Main', 'ProblemA');
    expect(out).toBe(code.replace(/Main/g, 'ProblemA'));
  });

  it('works in the other direction (file name to Main)', () => {
    expect(
      renamePublicClass(
        'public final class ProblemA { ProblemA() {} }',
        'ProblemA',
        'Main'
      )
    ).toBe('public final class Main { Main() {} }');
  });

  it('leaves string literals and char literals alone', () => {
    const code = [
      'public class Main {',
      '  String s = "Main";',
      '  String t = "say \\"Main\\" twice";',
      "  char c = 'M';",
      '  Main self;',
      '}',
    ].join('\n');
    const out = renamePublicClass(code, 'Main', 'Sol');
    expect(out).toContain('String s = "Main";');
    expect(out).toContain('"say \\"Main\\" twice"');
    expect(out).toContain('Sol self;');
    expect(out).toContain('public class Sol {');
  });

  it('leaves line and block comments alone', () => {
    const code = [
      '// Main entry',
      '/* Main',
      '   still comment Main */',
      'public class Main {',
      '  int x; // Main again',
      '}',
    ].join('\n');
    const out = renamePublicClass(code, 'Main', 'Sol');
    expect(out).toContain('// Main entry');
    expect(out).toContain('/* Main\n   still comment Main */');
    expect(out).toContain('// Main again');
    expect(out).toContain('public class Sol {');
  });

  it('leaves text blocks alone', () => {
    const code = [
      'public class Main {',
      '  String t = """',
      '    class Main { "quoted" }',
      '    """;',
      '  Main self;',
      '}',
    ].join('\n');
    const out = renamePublicClass(code, 'Main', 'Sol');
    expect(out).toContain('    class Main { "quoted" }');
    expect(out).toContain('Sol self;');
    expect(out).toContain('public class Sol {');
  });

  it('does not match longer or embedded names', () => {
    const code = [
      'public class Main {',
      '  MainHelper h = new MainHelper();',
      '  Domain d;',
      '  int Main2 = 1;',
      '}',
    ].join('\n');
    const out = renamePublicClass(code, 'Main', 'Sol');
    expect(out).toContain('MainHelper h = new MainHelper();');
    expect(out).toContain('Domain d;');
    expect(out).toContain('int Main2 = 1;');
    expect(out).toContain('public class Sol {');
  });

  it('does not touch qualified names of other types', () => {
    const code = 'public class Main { Other.Main x; }';
    expect(renamePublicClass(code, 'Main', 'Sol')).toBe(
      'public class Sol { Other.Main x; }'
    );
  });

  it('handles interface, enum and record declarations', () => {
    expect(renamePublicClass('public interface Main {}', 'Main', 'S')).toBe(
      'public interface S {}'
    );
    expect(renamePublicClass('public enum Main { A }', 'Main', 'S')).toBe(
      'public enum S { A }'
    );
    expect(renamePublicClass('public record Main(int a) {}', 'Main', 'S')).toBe(
      'public record S(int a) {}'
    );
  });

  it('returns the code unchanged when there is no public class by that name', () => {
    const noPublic = 'class Main { Main() {} }';
    expect(renamePublicClass(noPublic, 'Main', 'Sol')).toBe(noPublic);
    const other = 'public class Other { Main m; }';
    expect(renamePublicClass(other, 'Main', 'Sol')).toBe(other);
  });

  it('ignores a public class named like `from` that is nested', () => {
    const code = 'public class Outer { public static class Main {} }';
    expect(renamePublicClass(code, 'Main', 'Sol')).toBe(code);
  });

  it('ignores a declaration that only appears in a comment or string', () => {
    const code =
      '// public class Main {}\nclass Other { String s = "public class Main"; }';
    expect(renamePublicClass(code, 'Main', 'Sol')).toBe(code);
  });

  it('returns the code unchanged when the new name is not an identifier', () => {
    const code = 'public class Main {}';
    expect(renamePublicClass(code, 'Main', 'my-solution')).toBe(code);
    expect(renamePublicClass(code, 'Main', '1abc')).toBe(code);
    expect(renamePublicClass(code, 'Main', 'class')).toBe(code);
    expect(renamePublicClass(code, 'Main', '')).toBe(code);
  });

  it('returns the code unchanged when both names are equal', () => {
    const code = 'public class Main {}';
    expect(renamePublicClass(code, 'Main', 'Main')).toBe(code);
  });

  it('keeps CRLF line endings', () => {
    expect(renamePublicClass('public class Main {\r\n}\r\n', 'Main', 'S')).toBe(
      'public class S {\r\n}\r\n'
    );
  });
});

describe('isJavaIdentifier', () => {
  it('accepts class-like names and rejects keywords and bad names', () => {
    expect(isJavaIdentifier('Main')).toBe(true);
    expect(isJavaIdentifier('_a1$')).toBe(true);
    expect(isJavaIdentifier('1a')).toBe(false);
    expect(isJavaIdentifier('a-b')).toBe(false);
    expect(isJavaIdentifier('int')).toBe(false);
    expect(isJavaIdentifier('')).toBe(false);
  });
});
