import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { countedRuns, ifManifest } from '../src/manifest.ts';
import { DEFAULT_SCI, footprint, sessionGrams } from '../src/sci.ts';
import { type SessionRecord, checkIfRun, ciFootprint, invalidInput, markdownSummary, metricsText, renderSciPage, summarize } from '../src/sci-report.ts';

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
      children[`${tier}-risk-reviews`] = { outputs, aggregated: {} };
    }
    mutate?.(children);
    // if-run's Sum, over the reviews as they now are
    for (const child of Object.values(children)) for (const side of ['carbon-low', 'carbon-high']) child.aggregated[side] = child.outputs.reduce((n, o) => n + o[side], 0);
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
    const { sessions: committed } = JSON.parse(readFileSync(new URL('../../sustainability/agent-tokens.json', import.meta.url), 'utf8'));
    const m = parse(ifManifest(countedRuns(committed), DEFAULT_SCI, 'counted'));
    const children: Record<string, { outputs: Record<string, number>[]; aggregated: Record<string, number> }> = {};
    for (const [name, child] of Object.entries(m.tree.children) as [string, { defaults: Record<string, number>; inputs: Record<string, number>[] }][]) {
      const d = child.defaults;
      const outputs = child.inputs.map((i) => {
        const runner = i['runner-hours'] * d['runner-kw'] * d['grid-g-per-kwh'] + i['runner-hours'] * d['embodied-g-per-hour'];
        return { 'carbon-low': runner + i['model-calls-low'] * d['kwh-per-call-low'] * d['grid-g-per-kwh'], 'carbon-high': runner + i['model-calls-high'] * d['kwh-per-call-high'] * d['grid-g-per-kwh'] };
      });
      children[name] = { outputs, aggregated: { 'carbon-low': outputs.reduce((n, o) => n + o['carbon-low'], 0), 'carbon-high': outputs.reduce((n, o) => n + o['carbon-high'], 0) } };
    }
    const c = checkIfRun({ execution: { status: 'success' }, tree: { children } }, committed, DEFAULT_SCI);
    expect(c.mismatches).toEqual([]);
    const counted = [...countedRuns(committed).values()].reduce((n, r) => n + r.length, 0);
    expect(counted).toBeGreaterThan(0);
    expect(c.tiers.reduce((n, t) => n + t.reviews, 0)).toBe(counted);
  });
});

describe('what CI shows', () => {
  const s = summarize(sessions, DEFAULT_SCI, 560);
  const ci = { scope: "!7's 2 finished pipelines before this one", pipelines: 2, footprint: footprint([{ name: 'test', duration: 1200 }]), perPipelineGrams: 0.5, perPipelineMinutes: 10 };

  it('writes a metrics report: one "name value" per line, one set per tier, and the CI footprint', () => {
    const text = metricsText(s, ci);
    for (const line of text.trim().split('\n')) expect(line).toMatch(/^[a-z][a-z0-9_]* -?\d+(\.\d+)?$/);
    expect(text).toContain('sci_review_high_reviews 2\n');
    expect(text).toContain('sci_review_low_model_calls_median 6\n');
    expect(text).toContain(`sci_grid_gco2e_per_kwh ${DEFAULT_SCI.gridGramsPerKwh}\n`);
    // one name on MRs and on main, per pipeline, so the widget can compare them
    expect(text).toContain('sci_ci_runner_gco2e_per_pipeline_median 0.5\n');
    expect(text).toContain('sci_ci_runner_minutes_per_pipeline_median 10\n');
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

describe('invalidInput', () => {
  it('accepts counted sessions and numeric coefficients', () => {
    expect(invalidInput(sessions, DEFAULT_SCI, 560)).toBeNull();
    expect(invalidInput([], DEFAULT_SCI)).toBeNull();
  });

  it('names the first value that is not a number, so nothing reaches the page as NaN or markup', () => {
    expect(invalidInput(sessions, { ...DEFAULT_SCI, vcpus: '<script>' as unknown as number })).toMatch(/^sustainability\.vcpus is "<script>"/);
    expect(invalidInput(sessions, DEFAULT_SCI, '560')).toMatch(/gridGramsPerKwh is "560", not a number/);
    expect(invalidInput({}, DEFAULT_SCI)).toMatch(/no "sessions" list/);
    expect(invalidInput([{ ...session({}), pipeline: 7, seconds: 'a' }], DEFAULT_SCI)).toBe('session 1 (pipeline 7) has seconds "a", not a number');
    expect(invalidInput([session({ total: { calls: 1, uncached: 0, cacheWrite: 0, cacheRead: 0 } as SessionRecord['total'] })], DEFAULT_SCI)).toMatch(/total\.output undefined/);
    expect(invalidInput([{ ...session({}), flow: 3 }], DEFAULT_SCI)).toMatch(/no flow, time or tier/);
    expect(invalidInput([{ ...session({}), tier: 2 }], DEFAULT_SCI)).toMatch(/no flow, time or tier/);
    // a builder's session has no tier
    expect(invalidInput([{ ...session({ flow: 'issue-builder' }), tier: null }], DEFAULT_SCI)).toBeNull();
  });
});

describe('summarize, edge cases', () => {
  it('gives no tiers and no dates for no sessions', () => {
    const s = summarize([], DEFAULT_SCI);
    expect(s).toMatchObject({ sessions: 0, from: null, to: null, flows: [], tiers: [] });
  });

  it('leaves a review with an unknown tier out of the tiers, and a tier with no tokens has 0 per 1M tokens', () => {
    const zero = { calls: 0, uncached: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    const s = summarize([session({ tier: 'unknown' }), session({ tier: 'medium', total: zero })], DEFAULT_SCI);
    expect(s.tiers.map((t) => t.tier)).toEqual(['medium']);
    expect(s.tiers[0].gramsPerMTokens).toEqual({ low: 0, high: 0 });
    expect(s.flows[0]).toMatchObject({ sessions: 2, cacheReadShare: 8000 / 10_000 });
  });
});

describe('checkIfRun, what it refuses', () => {
  const agreeing = () => {
    const children: Record<string, { outputs: Record<string, number>[]; aggregated: Record<string, number> }> = {};
    for (const [tier, runs] of countedRuns(sessions)) {
      const outputs = runs.map((r) => {
        const g = sessionGrams(r.seconds, r.calls, DEFAULT_SCI);
        return { 'carbon-low': g.low, 'carbon-high': g.high };
      });
      children[`${tier}-risk-reviews`] = { outputs, aggregated: { 'carbon-low': outputs.reduce((n, o) => n + o['carbon-low'], 0), 'carbon-high': outputs.reduce((n, o) => n + o['carbon-high'], 0) } };
    }
    return { execution: { status: 'success' }, tree: { children } };
  };

  it('needs a status of success, not just no failure', () => {
    const out = agreeing() as { execution?: unknown };
    delete out.execution;
    expect(checkIfRun(out, sessions, DEFAULT_SCI).mismatches).toEqual(["if-run's status is missing"]);
  });

  it('reports output that is not a manifest as one mismatch, without throwing', () => {
    for (const out of [null, undefined, '', 'text']) {
      const c = checkIfRun(out, sessions, DEFAULT_SCI);
      expect(c.mismatches).toHaveLength(1);
      expect(c.mismatches[0]).toMatch(/^if-run's output isn't a manifest/);
    }
  });

  it("compares if-run's sum per tier with its reviews", () => {
    const out = agreeing();
    out.tree.children['high-risk-reviews'].aggregated['carbon-low'] += 1;
    expect(checkIfRun(out, sessions, DEFAULT_SCI).mismatches).toEqual([expect.stringMatching(/^high: if-run's sum carbon-low is [\d.]+, its reviews add up to/)]);
    delete (out.tree.children['low-risk-reviews'] as { aggregated?: unknown }).aggregated;
    expect(checkIfRun(out, sessions, DEFAULT_SCI).mismatches).toContain(`low: if-run's sum carbon-high is undefined, its reviews add up to ${out.tree.children['low-risk-reviews'].outputs[0]['carbon-high']}`);
  });

  it('names a tier if-run has and the sessions do not, and a missing value', () => {
    const out = agreeing();
    out.tree.children['medium-risk-reviews'] = { outputs: [], aggregated: { 'carbon-low': 0, 'carbon-high': 0 } };
    delete out.tree.children['high-risk-reviews'].outputs[0]['carbon-low'];
    const c = checkIfRun(out, sessions, DEFAULT_SCI);
    expect(c.mismatches).toContain('if-run has medium-risk-reviews, the sessions have no such tier');
    expect(c.mismatches).toContainEqual(expect.stringMatching(/^high review 1 \(.*\): if-run carbon-low undefined/));
    expect(c.maxRelativeDiff).toBe(Infinity);
  });

  it('lists at most 20 review differences and counts the rest', () => {
    const many = Array.from({ length: 15 }, (_, i) => session({ at: `2026-10-17T10:${String(i).padStart(2, '0')}:00Z` }));
    const outputs = many.map(() => ({ 'carbon-low': 1, 'carbon-high': 1 }));
    const out = { execution: { status: 'success' }, tree: { children: { 'high-risk-reviews': { outputs, aggregated: { 'carbon-low': 15, 'carbon-high': 15 } } } } };
    const c = checkIfRun(out, many, DEFAULT_SCI);
    expect(c.mismatches.filter((m) => m.startsWith('high review'))).toHaveLength(20);
    expect(c.mismatches.at(-1)).toBe('and 10 more review difference(s)');
  });
});

describe('what CI shows, edge cases', () => {
  const s = summarize(sessions, DEFAULT_SCI);

  it('writes only the totals when there are no tiers, and refuses a NaN instead of writing 0', () => {
    expect(metricsText(summarize([], DEFAULT_SCI))).toBe(`sci_sessions_counted 0\nsci_grid_gco2e_per_kwh ${DEFAULT_SCI.gridGramsPerKwh}\n`);
    const broken = { ...s, tiers: [{ ...s.tiers[0], calls: NaN }] };
    expect(() => metricsText(broken)).toThrow(/came out as NaN/);
  });

  it('says in the job log when the Impact Framework agrees, with its sums', () => {
    const md = markdownSummary(s, { version: '1.1.1', tiers: [{ tier: 'high', reviews: 2, carbon: { low: 1, high: 2 } }], maxRelativeDiff: 1e-16, mismatches: [] });
    expect(md).toContain('Impact Framework 1.1.1 agrees with sci.ts on every review (largest relative difference 1.0e-16). Its sums: high 1.0-2.0 g over 2.');
    expect(md).not.toContain('written at');
  });

  const page = (over: Partial<Parameters<typeof renderSciPage>[0]>) =>
    renderSciPage({ summary: s, check: null, web: 'https://gitlab.example/p', generatedAt: '2026-10-19T12:00:00Z', commit: 'abcdef12', ...over });

  it('escapes every value it prints, coefficients included', () => {
    const hostile = { ...s, coefficients: { ...s.coefficients, vcpus: '<script>alert(1)</script>' as unknown as number }, dataGrid: '<img src=x onerror=alert(2)>' as unknown as number };
    const html = page({ summary: hostile, check: { version: '<i>v</i>', tiers: [{ tier: '<u>t</u>', reviews: 1, carbon: { low: 1, high: 1 } }], maxRelativeDiff: 0, mismatches: [] } });
    expect(html).not.toMatch(/<script>alert|<img src=x|<i>v<\/i>|<u>t<\/u>/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; vCPU');
  });

  it('links only http(s) URLs', () => {
    const html = page({ web: 'javascript:alert(1)', pipelineUrl: 'javascript:alert(2)' });
    expect(html).not.toContain('javascript:');
    expect(page({ pipelineUrl: 'https://gitlab.example/p/-/pipelines/9' })).toContain('in <a href="https://gitlab.example/p/-/pipelines/9">this pipeline</a>');
  });

  it('lists the differences when the check fails, and shows no ratio when the high tier made no calls', () => {
    const html = page({ check: { version: '1.1.1', tiers: [], maxRelativeDiff: 1, mismatches: ['high review 1: <off>'] } });
    expect(html).toContain('<p class="bad">The Impact Framework (1.1.1) disagrees');
    expect(html).toContain('<li><code>high review 1: &lt;off&gt;</code></li>');
    const noCalls = { ...s, tiers: s.tiers.map((t) => (t.tier === 'high' ? { ...t, calls: 0 } : t)) };
    expect(page({ summary: noCalls })).not.toMatch(/Infinity|NaN/);
  });
});

describe('ciFootprint', () => {
  const jobs = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `j${i}`, status: 'success', duration: 60 }));
  /** answers GETs from a table of path prefixes, and records them */
  const fake = (routes: Record<string, unknown[] | ((path: string) => unknown[])>) => {
    const seen: string[] = [];
    return {
      seen,
      get: async <T>(path: string) => {
        seen.push(path);
        const key = Object.keys(routes).find((k) => path.startsWith(k));
        if (!key) throw new Error(`unexpected ${path}`);
        const r = routes[key];
        return (typeof r === 'function' ? r(path) : r) as T;
      },
    };
  };

  it("measures an MR's finished pipelines, not this one or a running one", async () => {
    const gl = fake({
      '/:project/merge_requests/7/pipelines': [
        { id: 3, status: 'running' },
        { id: 2, status: 'success' },
        { id: 1, status: 'failed' },
        { id: 9, status: 'success' },
      ],
      '/:project/pipelines/2/jobs': jobs(2),
      '/:project/pipelines/1/jobs': jobs(4),
    });
    const ci = await ciFootprint(gl, { CI_MERGE_REQUEST_IID: '7', CI_PIPELINE_ID: '9' }, DEFAULT_SCI);
    expect(ci).toMatchObject({ pipelines: 2, scope: "!7's 2 finished pipelines before this one", perPipelineMinutes: 3 });
    expect(ci!.footprint.runnerSeconds).toBe(360);
    expect(gl.seen.some((p) => p.includes('/pipelines/9/') || p.includes('/pipelines/3/'))).toBe(false);
  });

  it('gives null when there is no earlier pipeline, or neither an MR nor a branch', async () => {
    expect(await ciFootprint(fake({ '/:project/merge_requests/7/pipelines': [{ id: 9, status: 'success' }] }), { CI_MERGE_REQUEST_IID: '7', CI_PIPELINE_ID: '9' }, DEFAULT_SCI)).toBeNull();
    expect(await ciFootprint(fake({}), {}, DEFAULT_SCI)).toBeNull();
  });

  it('counts a canceled pipeline and takes the median per pipeline, not the mean', async () => {
    const gl = fake({
      '/:project/merge_requests/7/pipelines': [
        { id: 1, status: 'canceled' },
        { id: 2, status: 'success' },
        { id: 3, status: 'failed' },
      ],
      '/:project/pipelines/1/jobs': jobs(1),
      '/:project/pipelines/2/jobs': jobs(2),
      '/:project/pipelines/3/jobs': jobs(9),
    });
    const ci = await ciFootprint(gl, { CI_MERGE_REQUEST_IID: '7', CI_PIPELINE_ID: '9' }, DEFAULT_SCI);
    expect(ci!.pipelines).toBe(3);
    expect(gl.seen[0]).toBe('/:project/merge_requests/7/pipelines?per_page=100');
    // 1, 2 and 9 minutes: the median is 2, the mean would be 4
    expect(ci!.perPipelineMinutes).toBe(2);
    expect(ci!.perPipelineGrams).toBeCloseTo(footprint([{ name: 'a', duration: 120 }]).totalGrams, 12);
  });

  it("asks only for a branch's successful push pipelines, with the name encoded, and measures at most 10", async () => {
    const gl = fake({
      '/:project/pipelines?': Array.from({ length: 12 }, (_, i) => ({ id: 100 - i })),
      '/:project/pipelines/': jobs(1),
    });
    const ci = await ciFootprint(gl, { CI_COMMIT_BRANCH: 'feat/x y', CI_PIPELINE_ID: '1' }, DEFAULT_SCI);
    expect(gl.seen[0]).toBe('/:project/pipelines?ref=feat%2Fx%20y&status=success&source=push&per_page=11');
    expect(ci).toMatchObject({ pipelines: 10, scope: 'the last 10 successful push pipelines on feat/x y' });
  });

  it("on a branch, takes the last 10 successful push pipelines other than this one, and every page of their jobs", async () => {
    const gl = fake({
      '/:project/pipelines?ref=main': Array.from({ length: 11 }, (_, i) => ({ id: 100 - i })),
      '/:project/pipelines/': (path) => (path.includes('/pipelines/99/') ? (path.endsWith('page=1') ? jobs(100) : jobs(1)) : jobs(1)),
    });
    const ci = await ciFootprint(gl, { CI_COMMIT_BRANCH: 'main', CI_PIPELINE_ID: '100' }, DEFAULT_SCI);
    expect(ci).toMatchObject({ pipelines: 10, scope: 'the last 10 successful push pipelines on main' });
    expect(gl.seen).not.toContainEqual(expect.stringContaining('/pipelines/100/'));
    expect(gl.seen).toContain('/:project/pipelines/99/jobs?per_page=100&include_retried=true&page=2');
    // 101 jobs in pipeline 99, one in each of the other nine
    expect(ci!.footprint.runnerSeconds).toBe((101 + 9) * 60);
  });
});

describe('the page escapes every field', () => {
  it('leaves no raw markup from any string it is given', () => {
    const evil = '<x\'">';
    const s = summarize([session({ flow: evil }), session({ tier: 'high' })], DEFAULT_SCI);
    const html = renderSciPage({
      summary: { ...s, from: evil, to: evil },
      check: { version: evil, tiers: [{ tier: evil, reviews: 1, carbon: { low: 1, high: 1 } }], maxRelativeDiff: 0, mismatches: [] },
      ci: { scope: evil, pipelines: 1, footprint: footprint([{ name: 'a', duration: 60 }]), perPipelineGrams: 1, perPipelineMinutes: 1 },
      web: 'https://x/" onmouseover="a',
      generatedAt: '2026-10-19T12:00:00Z',
      commit: evil,
      pipelineUrl: 'HTTPS://x/p',
    });
    expect(html).not.toContain('<x');
    expect(html).not.toMatch(/" onmouseover="/);
    expect(html).toContain('&lt;x&#39;&quot;&gt;');
    expect(html).toContain('href="HTTPS://x/p"');
  });

  it('refuses counts too big for the arithmetic', () => {
    expect(invalidInput([session({ seconds: 1e308 })], DEFAULT_SCI)).toMatch(/seconds 1e\+308, not a number/);
  });
});
