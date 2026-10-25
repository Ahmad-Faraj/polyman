import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

// A WA-tagged solution passes when it gets WA or PE on at least one test, as
// on Polygon (validateExpectedVerdicts in src/helpers/solution.ts). These
// docs once said "WA" only (#121), so every WA rule there must name PE too.
const docs = ['GUIDE.md', 'CLAUDE.md', 'DOCUMENTATION.md'];

// From a WA mention to the nearest "at least one test" / "some tests" on the
// same line and in the same sentence: that span is the WA rule.
const waRule = /\bWA\b[^.\n]*?\b(?:at least one test|some tests)\b/g;
const mentionsPE = /\bPE\b|Presentation Error/i;

function waRules(file: string): string[] {
  const text = readFileSync(path.join(__dirname, '..', file), 'utf-8');
  return text.match(waRule) ?? [];
}

describe('docs: WA tag rule', () => {
  for (const file of docs) {
    it(`${file} says a WA tag passes on WA or PE`, () => {
      const rules = waRules(file);
      expect(rules.length).toBeGreaterThan(0);
      const withoutPE = rules.filter(rule => !mentionsPE.test(rule));
      expect(withoutPE).toEqual([]);
    });
  }

  it('flags a WA rule that does not mention PE', () => {
    const text = '| `WA` | Wrong answer | Fail at least one test with WA. |';
    const rules = text.match(waRule) ?? [];
    expect(rules).toHaveLength(1);
    expect(mentionsPE.test(rules[0] ?? '')).toBe(false);
  });
});
