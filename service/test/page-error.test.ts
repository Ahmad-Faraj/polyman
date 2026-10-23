import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/app.js's showError, run from the page's own source with small DOM
// stand-ins: a refusal after an earlier result leaves none of that result.
const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const piece = (re: RegExp) => {
  const m = SRC.match(re);
  if (!m) throw new Error(`not found in app.js: ${re}`);
  return m[0];
};
const CODE = [
  piece(/^const cap = .*$/m),
  piece(/^const BROKEN_ZIP = .*$/m),
  piece(/^function plainReason\([\s\S]*?^\}$/m),
  piece(/^function showError\([\s\S]*?^\}$/m),
].join('\n');

class El {
  classList: Set<string> & { add(...c: string[]): void; remove(...c: string[]): void; contains(c: string): boolean };
  hidden = false;
  textContent = '';
  innerHTML = '';
  className = '';
  constructor(...classes: string[]) {
    const set = new Set(classes) as El['classList'];
    const add = set.add.bind(set);
    const del = set.delete.bind(set);
    set.add = ((...c: string[]) => c.forEach((x) => add(x))) as never;
    set.remove = (...c: string[]) => c.forEach((x) => del(x));
    set.contains = (c: string) => set.has(c);
    this.classList = set;
  }
  remove() {}
  append() {}
  focus() {}
  removeAttribute() {}
}

/** A page after a passing run that also found something, then showError(...args). */
function refuseAfterPass(args: unknown[], times = 1) {
  const els = {
    run: new El('is-good', 'has-found'),
    title: new El('own-line'),
    facts: new El(),
    instead: new El(),
    again: new El(),
    download: new El(),
    verdict: new El(),
  };
  const noop = () => {};
  const ctx = {
    els,
    label: 'even-sum',
    pending: 'even-sum',
    $: () => new El(),
    document: { createElement: () => new El() },
    settle: () => els.run.classList.remove('is-running'),
    heroParts: noop,
    setHead: noop,
    setStatus: noop,
    markSample: noop,
    clearProblems: noop,
    showActions: noop,
    setBusy: noop,
    showCard: noop,
    say: noop,
  };
  runInNewContext(`${CODE}\nshowError(...args)`, { ...ctx, args });
  return els;
}

describe('showError after a passing result', () => {
  it.each([
    ['local', ['notes.txt isn\'t a .zip.', null, 'local', 'Nothing was sent.']],
    ['offline', ['Failed to fetch', null, 'offline']],
    ['refused', ['the zip was refused: no Config.json', ['Config.json not found']]],
  ])('%s: drops the pass look, the facts and the title layout, also when refused twice', (_kind, args) => {
    for (const times of [1, 2]) {
      const els = refuseAfterPass(args, times);
      expect(els.run.classList.contains('is-good')).toBe(false);
      expect(els.run.classList.contains('has-found')).toBe(false);
      expect(els.run.classList.contains('is-bad')).toBe(true);
      expect(els.title.classList.contains('own-line')).toBe(false);
      expect(els.facts.hidden).toBe(true);
    }
  });
});
