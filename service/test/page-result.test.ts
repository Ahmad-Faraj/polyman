import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

// public/app.js's result-card pieces (legendFor, howChecked, settle), run from
// the page's own source with small DOM stand-ins.
const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const piece = (re: RegExp) => {
  const m = SRC.match(re);
  if (!m) throw new Error(`not found in app.js: ${re}`);
  return m[0];
};
const fn = (name: string) => piece(new RegExp(`^function ${name}\\([\\s\\S]*?^\\}$`, 'm'));
const table = (name: string) => piece(new RegExp(`^const ${name} = \\{[\\s\\S]*?^\\};$`, 'm'));
const line = (re: RegExp) => piece(re);

const CODE = [
  line(/^const verdictKind = .*$/m),
  line(/^const icon = .*$/m),
  line(/^const seconds = .*$/m),
  line(/^const stepIcon = .*$/m),
  table('STEP_WORDS'),
  line(/^const STEPS = .*$/m),
  table('STEP_TITLE'),
  table('STEP_INFO'),
  line(/^const STEP_CLASS = .*$/m),
  line(/^const STEP_ICON = .*$/m),
  piece(/^const STAGES = \[[\s\S]*?^\];$/m),
  fn('buildPipeline'),
  fn('paintStep'),
  fn('paintStages'),
  fn('finishPipeline'),
  fn('legendFor'),
  fn('howChecked'),
].join('\n');

type Q = Record<string, unknown>;
const el = (q: Q = {}) => ({ hidden: false, innerHTML: '', textContent: '', dataset: {} as Record<string, string>, className: '', q });

/** A result card with its ten steps built, the first one still under way. */
function card() {
  const titles = piece(/^const STEP_WORDS = \{[\s\S]*?^\};$/m).match(/^ {2}'([^']+)':/gm)!.map((l) => l.trim().slice(1, l.trim().indexOf("'", 1)));
  const lis = titles.map((title, i) => ({
    ...el({ '.step-icon': el(), small: el(), '.step-label': el() }),
    dataset: { title, state: i === 0 ? 'now' : 'pending' } as Record<string, string>,
  }));
  return {
    ...el({ '.pipeline': { children: lis }, '.legend': el() }),
    lis,
    querySelectorAll: (sel: string) => (sel === '.pipeline .step' ? lis : []),
  };
}

function page(over: Record<string, unknown> = {}) {
  const runLegend = { ...el(), hidden: true };
  const root = { q: { '#run-legend': runLegend } as Q };
  const $ = (sel: string, from: { q: Q } = root) => (from.q[sel] as unknown) ?? null;
  return {
    runLegend,
    ctx: {
      $,
      cards: new Map<string, unknown>(),
      stepAt: new Map(),
      matchMedia: () => ({ matches: true }),
      document: { createElement: () => el() },
      ...over,
    },
  };
}

const solution = (verdicts: string[], matchesTag = true) => ({
  matchesTag,
  tests: verdicts.map((verdict, i) => ({ index: i + 1, verdict })),
});

describe('legendFor', () => {
  it('hides the key when the report has no solutions', () => {
    const c = card();
    const { ctx, runLegend } = page();
    ctx.cards.set('p', c);
    runLegend.hidden = false;
    runInNewContext(`${CODE}\nlegendFor(c, [])`, { ...ctx, c });
    expect(runLegend.hidden).toBe(true);
    expect(runLegend.innerHTML).not.toContain('Each square');
  });

  it('shows the key with "passed" for one solution', () => {
    const c = card();
    const { ctx, runLegend } = page();
    ctx.cards.set('p', c);
    runInNewContext(`${CODE}\nlegendFor(c, [s])`, { ...ctx, c, s: solution(['OK', 'OK']) });
    expect(runLegend.hidden).toBe(false);
    expect(runLegend.innerHTML).toContain('passed');
    expect(runLegend.innerHTML).not.toContain('too slow');
    expect(c.q['.legend']).toMatchObject({ hidden: true });
  });

  it('writes a contest card its own legend and leaves the shared one alone', () => {
    const [a, b] = [card(), card()];
    const { ctx, runLegend } = page();
    ctx.cards.set('a', a).set('b', b);
    runInNewContext(`${CODE}\nlegendFor(a, [s])`, { ...ctx, a, s: solution(['OK', 'TLE'], false) });
    const own = a.q['.legend'] as ReturnType<typeof el>;
    expect(own.hidden).toBe(false);
    expect(own.innerHTML).toContain('passed');
    expect(own.innerHTML).toContain('too slow');
    expect(runLegend.hidden).toBe(true);
    expect(runLegend.innerHTML).toBe('');
  });
});

describe('howChecked with no steps', () => {
  it('ends the pipeline: no step is left spinning', () => {
    const c = card();
    const { ctx } = page();
    expect(c.lis[0].dataset.state).toBe('now');
    // "could not finish": no report and no step event was seen
    runInNewContext(`${CODE}\nhowChecked(c, { problem: 'p', error: 'boom' }, 1000)`, { ...ctx, c });
    expect(c.lis.filter((li) => li.dataset.state === 'now')).toEqual([]);
  });
});
