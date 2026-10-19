import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { countedRuns, ifManifest } from '../src/manifest.ts';
import { DEFAULT_SCI, footprint, sessionGrams } from '../src/sci.ts';
import { type SessionRecord, checkIfRun, markdownSummary, metricsText, renderSciPage, summarize } from '../src/sci-report.ts';

const session = (over: Partial<SessionRecord>): SessionRecord => ({
  at: '2026-10-17T10:00:00Z',
  flow: 'mr-reviewer',
  tier: 'high',
  skipped: false,
  seconds: 600,
  mr: 1,
  total: { calls: 10, uncached: 100, cacheWrite: 1000, cacheRead: 8000, output: 900 },
  ...over,
});

const sessions = [
  session({ at: '2026-10-17T10:00:00Z', seconds: 600, total: { calls: 40, uncached: 0, cacheWrite: 100_000, cacheRead: 800_000, output: 100_000 } }),
  session({ at: '2026-10-17T11:00:00Z', seconds: 1200, total: { calls: 20, uncached: 0, cacheWrite: 50_000, cacheRead: 400_000, output: 50_000 } }),
  session({ at: '2026-10-17T12:00:00Z', seconds: 60, tier: 'low', total: { calls: 6, uncached: 0, cacheWrite: 10_000, cacheRead: 80_000, output: 10_000 } }),
  // stopped early and a builder: in the flows, not in the tiers
  session({ at: '2026-10-17T13:00:00Z', skipped: true, total: { calls: 2, uncached: 0, cacheWrite: 1000, cacheRead: 0, output: 0 } }),
  session({ at: '2026-10-16T09:00:00Z', flow: 'issue-builder', tier: 'unknown', total: { calls: 9, uncached: 0, cacheWrite: 5000, cacheRead: 5000, output: 0 } }),
];

describe('summarize', () => {
  const s = summarize(sessions, DEFAULT_SCI, 560);

  it('counts every session per flow, and only reviews that reviewed per tier', () => {
    expect(s.sessions).toBe(5);
    expect(s.from).toBe('2026-10-16T09:00:00Z');
    expect(s.flows.find((f) => f.flow === 'mr-reviewer')).toMatchObject({ sessions: 4, skipped: 1, calls: 68 });
    expect(s.tiers.map((t) => [t.tier, t.reviews])).toEqual([
      ['high', 2],
      ['low', 1],
    ]);
  });

  it("takes medians per review and sci.ts's grams, the range coming from the energy per call", () => {
    const high = s.tiers[0];
    expect(high.calls).toBe(30);
    expect(high.tokens).toBe(750_000);
    const a = sessionGrams(600, { low: 40, high: 40 }, DEFAULT_SCI);
    const b = sessionGrams(1200, { low: 20, high: 20 }, DEFAULT_SCI);
    expect(high.grams.low).toBeCloseTo((a.low + b.low) / 2, 12);
    expect(high.grams.high).toBeCloseTo((a.high + b.high) / 2, 12);
    expect(high.runnerGrams).toBeCloseTo((footprint([{ name: 'a', duration: 600 }]).totalGrams + footprint([{ name: 'b', duration: 1200 }]).totalGrams) / 2, 12);
    // SCI for AI: all the grams over all the tokens
    expect(high.gramsPerMTokens.high).toBeCloseTo(((a.high + b.high) / 1_500_000) * 1e6, 9);
  });

  it('says when the sessions file was written at another grid intensity', () => {
    expect(s.dataGrid).toBe(560);
    expect(summarize(sessions, DEFAULT_SCI, DEFAULT_SCI.gridGramsPerKwh).dataGrid).toBeNull();
    expect(summarize(sessions, DEFAULT_SCI).dataGrid).toBeNull();
  });
});

describe('checkIfRun', () => {
  // what if-run writes, simulated with sci.ts's own grams per review
  const ifOutput = (mutate?: (tree: Record<string, { outputs: Record<string, number>[] }>) => void) => {
    const children: Record<string, { outputs: Record<string, number>[]; aggregated: Record<string, number> }> = {};
    for (const [tier, runs] of countedRuns(sessions)) {
      const outputs = runs.map((r) => {
        const g = sessionGrams(r.seconds, r.calls, DEFAULT_SCI);
        return { 'carbon-low': g.low, 'carbon-high': g.high };
      });
      children[`${tier}-risk-reviews`] = { outputs, aggregated: { 'carbon-low': outputs.reduce((n, o) => n + o['carbon-low'], 0), 'carbon-high': outputs.reduce((n, o) => n + o['carbon-high'], 0) } };
    }
    mutate?.(children);
    return { execution: { status: 'success', environment: { 'if-version': '1.1.1' } }, tree: { children } };
  };

  it('agrees when every review has the same grams', () => {
    const c = checkIfRun(ifOutput(), sessions, DEFAULT_SCI);
    expect(c.mismatches).toEqual([]);
    expect(c.version).toBe('1.1.1');
    expect(c.tiers.map((t) => [t.tier, t.reviews])).toEqual([
      ['high', 2],
      ['low', 1],
    ]);
  });

  it('names the review that differs, a missing review and a missing tier', () => {
    expect(checkIfRun(ifOutput((t) => (t['high-risk-reviews'].outputs[1]['carbon-high'] *= 1.01)), sessions, DEFAULT_SCI).mismatches).toEqual([
      expect.stringMatching(/^high review 2 \(2026-10-17T11:00:00Z\): if-run carbon-high/),
    ]);
    expect(checkIfRun(ifOutput((t) => t['high-risk-reviews'].outputs.pop()), sessions, DEFAULT_SCI).mismatches[0]).toBe('high: if-run has 1 reviews, the sessions 2');
    expect(checkIfRun(ifOutput((t) => delete t['low-risk-reviews']), sessions, DEFAULT_SCI).mismatches).toEqual(['if-run has no low-risk-reviews']);
  });

  it('fails on a failed run', () => {
    expect(checkIfRun({ execution: { status: 'fail' } }, [], DEFAULT_SCI).mismatches).toEqual(["if-run's status is fail"]);
  });

  it("matches the committed manifest's arithmetic, as built for if-run", () => {
    // the manifest's own Multiply and Sum steps, done here, for the committed sessions
    const { sessions: committed } = JSON.parse(readFileSync('../sustainability/agent-tokens.json', 'utf8'));
    const m = parse(ifManifest(countedRuns(committed), DEFAULT_SCI, 'counted'));
    const children: Record<string, { outputs: Record<string, number>[] }> = {};
    for (const [name, child] of Object.entries(m.tree.children) as [string, { defaults: Record<string, number>; inputs: Record<string, number>[] }][]) {
      const d = child.defaults;
      children[name] = {
        outputs: child.inputs.map((i) => {
          const runner = i['runner-hours'] * d['runner-kw'] * d['grid-g-per-kwh'] + i['runner-hours'] * d['embodied-g-per-hour'];
          return { 'carbon-low': runner + i['model-calls-low'] * d['kwh-per-call-low'] * d['grid-g-per-kwh'], 'carbon-high': runner + i['model-calls-high'] * d['kwh-per-call-high'] * d['grid-g-per-kwh'] };
        }),
      };
    }
    const c = checkIfRun({ tree: { children } }, committed, DEFAULT_SCI);
    expect(c.mismatches).toEqual([]);
    expect(c.tiers.reduce((n, t) => n + t.reviews, 0)).toBeGreaterThan(100);
  });
});

describe('what CI shows', () => {
  const s = summarize(sessions, DEFAULT_SCI, 560);
  const ci = { scope: "!7's 2 finished pipelines before this one", pipelines: 2, footprint: footprint([{ name: 'test', duration: 1200 }]), perPipelineGrams: 0.5 };

  it('writes a metrics report: one "name value" per line, one set per tier, and the CI footprint', () => {
    const text = metricsText(s, ci, 'sci_ci_mr_runner_gco2e');
    for (const line of text.trim().split('\n')) expect(line).toMatch(/^[a-z][a-z0-9_]* -?\d+(\.\d+)?$/);
    expect(text).toContain('sci_review_high_reviews 2\n');
    expect(text).toContain('sci_review_low_model_calls_median 6\n');
    expect(text).toContain(`sci_grid_gco2e_per_kwh ${DEFAULT_SCI.gridGramsPerKwh}\n`);
    expect(text).toMatch(/^sci_ci_mr_runner_gco2e \d/m);
    expect(text).toContain('sci_ci_mr_runner_minutes 20\n');
    expect(metricsText(s)).not.toMatch(/sci_ci_/);
  });

  it('summarizes in the job log, saying where the Impact Framework disagrees', () => {
    const md = markdownSummary(s, { version: '1.1.1', tiers: [], maxRelativeDiff: 0.5, mismatches: ['high review 1: off'] }, ci);
    expect(md).toMatch(/\| high \| 2 \| 30 \| 750k \|/);
    expect(md).toContain('written at 560 gCO2e/kWh');
    expect(md).toContain('DISAGREES');
    expect(md).toContain("!7's 2 finished pipelines");
  });

  it('renders the page with escaped text, the tiers and the check', () => {
    const html = renderSciPage({ summary: s, check: null, ci: { ...ci, scope: '<b>x</b>' }, web: 'https://gitlab.example/p', generatedAt: '2026-10-19T12:00:00.000Z', commit: 'abcdef1234567890' });
    expect(html).toContain('<title>Agent carbon (SCI)</title>');
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toMatch(/<td>high<\/td><td>2<\/td><td>30<\/td>/);
    expect(html).toContain('was not run in this pipeline');
    expect(html).toContain('2026-10-19 12:00:00 UTC');
    expect(html).toContain('https://gitlab.example/p/-/commit/abcdef1234567890');
  });
});
