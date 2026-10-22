/**
 * @fileoverview Renames a Java public top-level type, for the mismatch between
 * the local executor (public class name must equal the file name) and Polygon
 * (entry point must be `Main`).
 */

const IDENT_START = /[\p{L}\p{Nl}_$]/u;
const IDENT_PART = /[\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}_$]/u;
const VALID_IDENTIFIER =
  /^[\p{L}\p{Nl}_$][\p{L}\p{Nl}\p{Nd}\p{Mn}\p{Mc}\p{Pc}_$]*$/u;
const TYPE_KEYWORDS = new Set(['class', 'interface', 'enum', 'record']);

/** Words that can never name a class, so renaming to them can't compile. */
const RESERVED_WORDS = new Set([
  'abstract',
  'assert',
  'boolean',
  'break',
  'byte',
  'case',
  'catch',
  'char',
  'class',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extends',
  'false',
  'final',
  'finally',
  'float',
  'for',
  'goto',
  'if',
  'implements',
  'import',
  'instanceof',
  'int',
  'interface',
  'long',
  'native',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'short',
  'static',
  'strictfp',
  'super',
  'switch',
  'synchronized',
  'this',
  'throw',
  'throws',
  'transient',
  'true',
  'try',
  'void',
  'volatile',
  'while',
  '_',
]);

interface Token {
  /** Identifier text, or the punctuation character; `"` stands for a literal. */
  text: string;
  start: number;
  end: number;
  ident: boolean;
}

/**
 * True when `name` can name a Java class.
 *
 * @param {string} name - Candidate class name
 * @returns {boolean}
 */
export function isJavaIdentifier(name: string): boolean {
  return VALID_IDENTIFIER.test(name) && !RESERVED_WORDS.has(name);
}

/**
 * Splits Java source into identifier and punctuation tokens. Comments, string
 * literals, char literals and text blocks are skipped, so a name inside them
 * is never seen as a token.
 */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  const n = code.length;
  let i = 0;

  const skipQuoted = (quote: string): void => {
    i++; // opening quote
    while (i < n) {
      const c = code[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      i++;
      if (c === quote || c === '\n') return;
    }
  };

  while (i < n) {
    const c = code[i];

    if (c === '/' && code[i + 1] === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && code[i + 1] === '*') {
      const close = code.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      continue;
    }
    if (c === '"') {
      const start = i;
      if (code.startsWith('"""', i)) {
        i += 3;
        while (i < n && !code.startsWith('"""', i)) {
          i += code[i] === '\\' ? 2 : 1;
        }
        i = Math.min(n, i + 3);
      } else {
        skipQuoted('"');
      }
      tokens.push({ text: '"', start, end: i, ident: false });
      continue;
    }
    if (c === "'") {
      const start = i;
      skipQuoted("'");
      tokens.push({ text: '"', start, end: i, ident: false });
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c >= '0' && c <= '9') {
      // Number literal, including suffixes such as 1L or 0x1F.
      while (i < n && /[\w.]/.test(code[i])) i++;
      tokens.push({ text: '0', start: i - 1, end: i, ident: false });
      continue;
    }

    const point = code.codePointAt(i) as number;
    const char = String.fromCodePoint(point);
    if (IDENT_START.test(char)) {
      const start = i;
      i += char.length;
      while (i < n) {
        const next = String.fromCodePoint(code.codePointAt(i) as number);
        if (!IDENT_PART.test(next)) break;
        i += next.length;
      }
      tokens.push({ text: code.slice(start, i), start, end: i, ident: true });
      continue;
    }

    tokens.push({ text: char, start: i, end: i + char.length, ident: false });
    i += char.length;
  }

  return tokens;
}

/**
 * True when the file declares `public class|interface|enum|record <name>` at
 * the top level.
 */
function declaresPublicType(tokens: Token[], name: string): boolean {
  let depth = 0;
  for (const [index, token] of tokens.entries()) {
    if (!token.ident) {
      if (token.text === '{') depth++;
      else if (token.text === '}') depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || token.text !== name || index === 0) continue;
    const before = tokens[index - 1];
    if (!before.ident || !TYPE_KEYWORDS.has(before.text)) continue;
    // Walk back over the modifiers (and annotation names) to find `public`.
    for (let k = index - 2; k >= 0 && tokens[k].ident; k--) {
      if (tokens[k].text === 'public') return true;
    }
  }
  return false;
}

/**
 * Renames the public top-level type `from` to `to`: its declaration, its
 * constructors and every other reference in the file. Names inside comments,
 * string literals, char literals and text blocks are left alone, as are
 * longer names such as `MainHelper` and qualified names such as `Other.Main`.
 *
 * The code is returned unchanged when `from` or `to` is not a valid class
 * name, when both are equal, or when the file declares no public top-level
 * type called `from`.
 *
 * @param {string} code - Java source
 * @param {string} from - Current public type name
 * @param {string} to - New public type name
 * @returns {string} The renamed source
 *
 * @example
 * renamePublicClass('public class Main { Main() {} }', 'Main', 'Sol');
 * // 'public class Sol { Sol() {} }'
 */
export function renamePublicClass(
  code: string,
  from: string,
  to: string
): string {
  if (from === to || !isJavaIdentifier(from) || !isJavaIdentifier(to)) {
    return code;
  }

  const tokens = tokenize(code);
  if (!declaresPublicType(tokens, from)) return code;

  let result = '';
  let last = 0;
  for (const [index, token] of tokens.entries()) {
    if (!token.ident || token.text !== from) continue;
    if (index > 0 && tokens[index - 1].text === '.') continue;
    result += code.slice(last, token.start) + to;
    last = token.end;
  }
  return result + code.slice(last);
}
