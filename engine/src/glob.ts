/**
 * Minimal glob matcher: `**` matches across directories, `*` within one
 * segment, `?` a single character. Patterns without a slash match the basename
 * anywhere in the tree (gitignore-style), so `*.md` matches `docs/a/b.md`.
 */
const cache = new Map<string, RegExp>();

function toRegExp(pattern: string): RegExp {
  let src = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const slashAfter = pattern[i + 2] === '/';
        // [\s\S] rather than . so a path with a newline in it still matches
        src += slashAfter ? '(?:[\\s\\S]*/)?' : '[\\s\\S]*';
        i += slashAfter ? 2 : 1;
      } else {
        src += '[^/]*';
      }
    } else if (c === '?') {
      src += '[^/]';
    } else {
      src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const anchored = pattern.includes('/') ? `^${src}$` : `^(?:[\\s\\S]*/)?${src}$`;
  return new RegExp(anchored);
}

export function matches(path: string, pattern: string): boolean {
  let re = cache.get(pattern);
  if (!re) {
    re = toRegExp(pattern);
    cache.set(pattern, re);
  }
  return re.test(path);
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matches(path, p));
}
