/**
 * The SCI numbers as CI shows them: a summary of the counted agent sessions
 * (sustainability/agent-tokens.json) per flow and per review tier, checked
 * against the Impact Framework's own run of the committed manifest, plus the
 * runner footprint of CI itself. Rendered three ways: a GitLab metrics report
 * (the MR widget shows what changed), a static page for Pages, and Markdown
 * for the job log.
 */
import { type GitLab, finishedJobs, pipelineJobs } from './gitlab.ts';
import { INFERENCE_WH_PER_CALL, type Calls, type Footprint, type SciCoefficients, footprint, sessionGrams } from './sci.ts';
import { type CountedSession, countedRuns } from './manifest.ts';
import { type TokenClasses, NONE, add, median, totalTokens } from './tokens.ts';

/** One session as agent-tokens.ts saved it with --json (the fields used here). */
export interface SessionRecord extends CountedSession {
  mr: number | null;
  tier: string;
  total: TokenClasses;
}

export interface FlowRow {
  flow: string;
  sessions: number;
  skipped: number;
  calls: number;
  tokens: number;
  cacheReadShare: number;
}

export interface TierRow {
  tier: string;
  reviews: number;
  /** medians per review */
  calls: number;
  tokens: number;
  cacheRead: number;
  runnerGrams: number;
  grams: Calls;
  /** SCI for AI: all the tier's grams over all its tokens, per million */
  gramsPerMTokens: Calls;
}

export interface IfCheck {
  version: string | null;
  tiers: { tier: string; reviews: number; carbon: Calls }[];
  /** largest relative difference between if-run and sci.ts over every review and both ends */
  maxRelativeDiff: number;
  mismatches: string[];
}

export interface CiFootprint {
  /** what was measured, e.g. "this MR's 4 finished pipelines" */
  scope: string;
  pipelines: number;
  footprint: Footprint;
  /** median grams per pipeline */
  perPipelineGrams: number;
  /** median runner-minutes per pipeline */
  perPipelineMinutes: number;
}

export interface SciSummary {
  sessions: number;
  from: string | null;
  to: string | null;
  flows: FlowRow[];
  tiers: TierRow[];
  coefficients: SciCoefficients;
  inferenceWhPerCall: Calls;
  /** grid intensity the sessions file was written with, if it differs from the coefficients in use */
  dataGrid: number | null;
}

const TIERS = ['high', 'medium', 'low'] as const;
const TOKEN_FIELDS = ['calls', 'uncached', 'cacheWrite', 'cacheRead', 'output'] as const;
// a count, small enough that the arithmetic stays finite
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;

/**
 * Why these inputs can't give honest figures, or null if they can. Every
 * coefficient and every counted field must be a finite number: a string from
 * .autonomy.yml or the sessions file would otherwise turn into NaN on the page,
 * or into markup.
 */
export function invalidInput(sessions: unknown, c: SciCoefficients, dataGrid?: unknown): string | null {
  for (const [key, v] of Object.entries(c)) if (!isCount(v)) return `sustainability.${key} is ${JSON.stringify(v)}, not a number`;
  if (dataGrid !== undefined && !isCount(dataGrid)) return `the sessions file's coefficients.gridGramsPerKwh is ${JSON.stringify(dataGrid)}, not a number`;
  if (!Array.isArray(sessions)) return 'no "sessions" list (write it with agent-tokens.ts --json)';
  for (const [i, s] of sessions.entries()) {
    const where = `session ${i + 1} (pipeline ${JSON.stringify(s?.pipeline ?? null)})`;
    // only reviews have a tier; other flows' sessions have null
    if (typeof s?.flow !== 'string' || typeof s.at !== 'string' || !(typeof s.tier === 'string' || s.tier === null)) return `${where} has no flow, time or tier`;
    if (!isCount(s.seconds)) return `${where} has seconds ${JSON.stringify(s.seconds)}, not a number`;
    for (const f of TOKEN_FIELDS) if (!isCount(s.total?.[f])) return `${where} has total.${f} ${JSON.stringify(s.total?.[f])}, not a number`;
  }
  return null;
}

export function summarize(sessions: SessionRecord[], c: SciCoefficients, dataGrid?: number): SciSummary {
  const times = sessions.map((s) => s.at).sort();
  const flows = [...new Set(sessions.map((s) => s.flow))].map((flow) => {
    const xs = sessions.filter((s) => s.flow === flow);
    const t = xs.reduce<TokenClasses>((n, s) => add(n, s.total), NONE);
    return { flow, sessions: xs.length, skipped: xs.filter((s) => s.skipped).length, calls: t.calls, tokens: totalTokens(t), cacheReadShare: totalTokens(t) ? t.cacheRead / totalTokens(t) : 0 };
  });
  flows.sort((a, b) => b.tokens - a.tokens);

  // the same reviews the manifest holds: mr-reviewer sessions that reviewed, with a known tier
  const reviews = sessions.filter((s) => s.flow === 'mr-reviewer' && !s.skipped);
  const tiers: TierRow[] = [];
  for (const tier of TIERS) {
    const xs = reviews.filter((s) => s.tier === tier);
    if (!xs.length) continue;
    const g = xs.map((s) => sessionGrams(s.seconds, { low: s.total.calls, high: s.total.calls }, c));
    const runner = xs.map((s) => sessionGrams(s.seconds, { low: 0, high: 0 }, c).low);
    const tokens = xs.reduce((n, s) => n + totalTokens(s.total), 0);
    const perM = (side: 'low' | 'high') => (tokens ? (g.reduce((n, x) => n + x[side], 0) / tokens) * 1e6 : 0);
    tiers.push({
      tier,
      reviews: xs.length,
      calls: median(xs.map((s) => s.total.calls)),
      tokens: median(xs.map((s) => totalTokens(s.total))),
      cacheRead: median(xs.map((s) => s.total.cacheRead)),
      runnerGrams: median(runner),
      grams: { low: median(g.map((x) => x.low)), high: median(g.map((x) => x.high)) },
      gramsPerMTokens: { low: perM('low'), high: perM('high') },
    });
  }
  return {
    sessions: sessions.length,
    from: times[0] ?? null,
    to: times.at(-1) ?? null,
    flows,
    tiers,
    coefficients: c,
    inferenceWhPerCall: { ...INFERENCE_WH_PER_CALL },
    dataGrid: dataGrid !== undefined && dataGrid !== c.gridGramsPerKwh ? dataGrid : null,
  };
}

interface IfOutput {
  'carbon-low'?: number;
  'carbon-high'?: number;
}

interface IfRun {
  execution?: { environment?: { 'if-version'?: string }; status?: string };
  tree?: { children?: Record<string, { outputs?: IfOutput[]; aggregated?: IfOutput }> };
}

/**
 * Compares the Impact Framework's run of the manifest (if-run's output, parsed)
 * with sci.ts on the same sessions, review by review: two implementations of
 * the same arithmetic, one of them the Green Software Foundation's.
 */
export function checkIfRun(output: unknown, sessions: SessionRecord[], c: SciCoefficients, tolerance = 1e-9): IfCheck {
  const mismatches: string[] = [];
  const tiers: IfCheck['tiers'] = [];
  let maxRelativeDiff = 0;
  let more = 0;
  const relative = (got: unknown, want: number) => (typeof got === 'number' ? Math.abs(got - want) / Math.max(Math.abs(want), 1e-12) : Infinity);
  if (!output || typeof output !== 'object') return { version: null, tiers, maxRelativeDiff: Infinity, mismatches: [`if-run's output isn't a manifest (got ${JSON.stringify(output ?? null)})`] };
  const out = output as IfRun;
  if (out.execution?.status !== 'success') mismatches.push(`if-run's status is ${out.execution?.status ?? 'missing'}`);
  const children = out.tree?.children ?? {};
  const expected = countedRuns(sessions);
  for (const name of Object.keys(children)) {
    if (!expected.has(name.replace(/-risk-reviews$/, ''))) mismatches.push(`if-run has ${name}, the sessions have no such tier`);
  }
  for (const [tier, runs] of expected) {
    const child = children[`${tier}-risk-reviews`];
    if (!child) {
      mismatches.push(`if-run has no ${tier}-risk-reviews`);
      continue;
    }
    const outputs = child.outputs ?? [];
    if (outputs.length !== runs.length) mismatches.push(`${tier}: if-run has ${outputs.length} reviews, the sessions ${runs.length}`);
    runs.forEach((r, i) => {
      const want = sessionGrams(r.seconds, r.calls, c);
      for (const side of ['low', 'high'] as const) {
        const got = outputs[i]?.[`carbon-${side}`];
        const diff = relative(got, want[side]);
        maxRelativeDiff = Math.max(maxRelativeDiff, diff);
        if (diff <= tolerance) continue;
        if (mismatches.length < 20) mismatches.push(`${tier} review ${i + 1} (${r.at}): if-run carbon-${side} ${got}, sci.ts ${want[side]}`);
        else more++;
      }
    });
    // if-run's own Sum over the tier must be what its reviews add up to
    for (const side of ['low', 'high'] as const) {
      const sum = child.aggregated?.[`carbon-${side}`];
      const added = outputs.reduce((n, o) => n + (o?.[`carbon-${side}`] ?? NaN), 0);
      if (!(relative(sum, added) <= tolerance)) mismatches.push(`${tier}: if-run's sum carbon-${side} is ${sum}, its reviews add up to ${added}`);
    }
    tiers.push({ tier, reviews: outputs.length, carbon: { low: child.aggregated?.['carbon-low'] ?? NaN, high: child.aggregated?.['carbon-high'] ?? NaN } });
  }
  if (more) mismatches.push(`and ${more} more review difference(s)`);
  return { version: out.execution?.environment?.['if-version'] ?? null, tiers, maxRelativeDiff, mismatches };
}

const num = (n: number, digits = 2) => {
  if (!Number.isFinite(n)) throw new Error(`a metric came out as ${n}; the inputs are wrong`);
  return Number(n.toFixed(digits));
};

/**
 * A GitLab metrics report (OpenMetrics names, one "name value" per line). The
 * MR widget lists each metric with its value on the target branch, so a change
 * to the data or the coefficients shows up as a difference. The CI footprint
 * stays out: an MR's median of its earlier, smaller pipelines against main's
 * median of full pipelines is not a real difference (!238 showed -91%). It is
 * still in sci-report.json, on the page and in the log.
 */
export function metricsText(s: SciSummary): string {
  const lines = [`sci_sessions_counted ${s.sessions}`, `sci_grid_gco2e_per_kwh ${s.coefficients.gridGramsPerKwh}`];
  for (const t of s.tiers) {
    const p = `sci_review_${t.tier}`;
    lines.push(
      `${p}_reviews ${t.reviews}`,
      `${p}_model_calls_median ${num(t.calls, 1)}`,
      `${p}_tokens_median ${Math.round(t.tokens)}`,
      `${p}_gco2e_low_median ${num(t.grams.low)}`,
      `${p}_gco2e_high_median ${num(t.grams.high)}`,
      `${p}_gco2e_per_mtok_low ${num(t.gramsPerMTokens.low)}`,
      `${p}_gco2e_per_mtok_high ${num(t.gramsPerMTokens.high)}`,
    );
  }
  return lines.join('\n') + '\n';
}

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : n.toFixed(0));
const g1 = (x: Calls) => `${x.low.toFixed(1)}-${x.high.toFixed(1)}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;
const day = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '?');

/** The same numbers as Markdown, for the job log. */
export function markdownSummary(s: SciSummary, check: IfCheck | null, ci?: CiFootprint | null): string {
  const out = [
    `SCI, functional unit one merge request review: ${s.sessions} counted agent sessions, ${day(s.from)} to ${day(s.to)} UTC`,
    '',
    '| Tier | Reviews | Model calls | Tokens | Runner gCO2e | gCO2e per review, low-high | gCO2e per 1M tokens, low-high |',
    '|---|---|---|---|---|---|---|',
    ...s.tiers.map((t) => `| ${t.tier} | ${t.reviews} | ${t.calls} | ${k(t.tokens)} | ${t.runnerGrams.toFixed(1)} | ${g1(t.grams)} | ${g1(t.gramsPerMTokens)} |`),
    '',
    `Medians per review. Grid ${s.coefficients.gridGramsPerKwh} gCO2e/kWh, ${s.inferenceWhPerCall.low}-${s.inferenceWhPerCall.high} Wh per model call (cited, not measured).`,
  ];
  if (s.dataGrid !== null) out.push(`The sessions file was written at ${s.dataGrid} gCO2e/kWh; these figures use .autonomy.yml's ${s.coefficients.gridGramsPerKwh}.`);
  if (check) {
    out.push(
      '',
      check.mismatches.length
        ? `Impact Framework ${check.version ?? '?'} DISAGREES with sci.ts:\n${check.mismatches.map((m) => `  - ${m}`).join('\n')}`
        : `Impact Framework ${check.version ?? '?'} agrees with sci.ts on every review (largest relative difference ${check.maxRelativeDiff.toExponential(1)}). Its sums: ${check.tiers.map((t) => `${t.tier} ${g1(t.carbon)} g over ${t.reviews}`).join(', ')}.`,
    );
  }
  if (ci) out.push('', `CI runner footprint, ${ci.scope}: ${(ci.footprint.runnerSeconds / 60).toFixed(1)} runner-min, ${(ci.footprint.energyKwh * 1000).toFixed(1)} Wh, ${ci.footprint.totalGrams.toFixed(1)} gCO2e (median ${ci.perPipelineGrams.toFixed(1)} g per pipeline).`);
  return out.join('\n');
}

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** an http(s) link, escaped for an attribute; anything else (javascript:, data:) links nowhere */
const href = (url: string) => (/^https?:\/\//i.test(url) ? esc(url) : '#');

export interface PageInput {
  summary: SciSummary;
  check: IfCheck | null;
  ci?: CiFootprint | null;
  web: string;
  generatedAt: string;
  commit: string;
  pipelineUrl?: string;
}

/** The SCI dashboard for Pages (/sci/), in the ledger page's style. */
export function renderSciPage({ summary: s, check, ci, web, generatedAt, commit, pipelineUrl }: PageInput): string {
  const high = s.tiers.find((t) => t.tier === 'high');
  const low = s.tiers.find((t) => t.tier === 'low');
  const c = s.coefficients;
  const tiles = [
    high ? ['High-risk review', `${g1(high.grams)} g`, `gCO2e, median of ${high.reviews} reviews; the runner is ${high.runnerGrams.toFixed(1)} g of it`] : null,
    low ? ['Low-risk review', `${g1(low.grams)} g`, `gCO2e, median of ${low.reviews}${high?.calls ? `; about ${Math.round((low.calls / high.calls) * 100)}% of a high review's calls` : ''}`] : null,
    high ? ['SCI for AI', `${g1(high.gramsPerMTokens)} g`, 'gCO2e per million tokens, high-risk reviews'] : null,
    ci ? ['CI runners', `${ci.perPipelineGrams.toFixed(1)} g`, `gCO2e per pipeline, median of ${ci.scope}`] : null,
    check ? ['Impact Framework check', check.mismatches.length ? 'disagrees' : 'agrees', check.mismatches.length ? `${check.mismatches.length} difference(s), see below` : `if-run ${check.version ?? '?'} and sci.ts, every review`] : null,
  ]
    .filter((t): t is string[] => !!t)
    .map(([label, value, sub]) => `<div class="tile"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`)
    .join('\n');

  const tierRows = s.tiers
    .map((t) => `<tr><td>${esc(t.tier)}</td><td>${esc(t.reviews)}</td><td>${esc(t.calls)}</td><td>${esc(k(t.tokens))}</td><td>${esc(k(t.cacheRead))}</td><td>${esc(t.runnerGrams.toFixed(1))}</td><td><b>${esc(g1(t.grams))}</b></td><td>${esc(g1(t.gramsPerMTokens))}</td></tr>`)
    .join('\n');
  const flowRows = s.flows
    .map((f) => `<tr><td>${esc(f.flow)}</td><td>${esc(f.sessions)}${f.skipped ? ` <span class="muted">(${esc(f.skipped)} skipped)</span>` : ''}</td><td>${esc(f.calls.toLocaleString('en'))}</td><td>${esc(k(f.tokens))}</td><td>${esc(pct(f.cacheReadShare))}</td></tr>`)
    .join('\n');
  const coeff = [
    ['Runner', `${c.vcpus} vCPU, ${c.memoryGb} GB (GitLab.com small Linux runner)`],
    ['Power per vCPU', `${c.minWattsPerVcpu}-${c.maxWattsPerVcpu} W at ${pct(c.utilization)} utilisation (Cloud Carbon Footprint)`],
    ['Memory', `${c.memoryKwhPerGbHour} kWh per GB-hour`],
    ['PUE', String(c.pue)],
    ['Grid intensity (I)', `${c.gridGramsPerKwh} gCO2e/kWh`, s.dataGrid !== null ? `(the sessions file was written at ${s.dataGrid})` : ''],
    ['Embodied (M)', `${c.embodiedGramsPerVcpuHour} gCO2e per vCPU-hour`],
    ['Energy per model call', `${s.inferenceWhPerCall.low}-${s.inferenceWhPerCall.high} Wh, a cited range, not measured for our model`],
  ]
    .map(([a, b, note]) => `<tr><th>${esc(a)}</th><td>${esc(b)}${note ? ` <span class="muted">${esc(note)}</span>` : ''}</td></tr>`)
    .join('\n');
  const checkBlock = check
    ? check.mismatches.length
      ? `<p class="bad">The Impact Framework (${esc(check.version ?? '?')}) disagrees with <code>engine/src/sci.ts</code>:</p><ul>${check.mismatches.map((m) => `<li><code>${esc(m)}</code></li>`).join('')}</ul>`
      : `<p><span class="ok">Agrees.</span> CI ran the Green Software Foundation's Impact Framework (<code>if-run</code> ${esc(check.version ?? '?')}) on the committed manifest and compared every review's carbon with <code>engine/src/sci.ts</code>: largest relative difference ${esc(check.maxRelativeDiff.toExponential(1))}. Its sums per tier: ${esc(check.tiers.map((t) => `${t.tier} ${g1(t.carbon)} g over ${t.reviews} reviews`).join(', '))}. Its output: <a href="if-output.yaml">if-output.yaml</a>.</p>`
    : '<p class="muted">The Impact Framework was not run in this pipeline.</p>';
  const ciBlock = ci
    ? `<h2>CI itself</h2><p>${esc(`Measured job times from the GitLab API, ${ci.scope}: ${(ci.footprint.runnerSeconds / 60).toFixed(1)} runner-minutes, ${(ci.footprint.energyKwh * 1000).toFixed(1)} Wh,`)} <b>${esc(ci.footprint.totalGrams.toFixed(1))} gCO2e</b> ${esc(`(${ci.footprint.operationalGrams.toFixed(1)} g operational, ${ci.footprint.embodiedGrams.toFixed(1)} g embodied); median ${ci.perPipelineGrams.toFixed(1)} g per pipeline.`)} Same coefficients as the runner part above.</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agent carbon (SCI)</title>
<style>
:root { --bg: #fbfbfa; --fg: #1d1d1b; --muted: #6b6b66; --line: #e2e1dc; --tile: #ffffff; --ok: #1a7f37; --bad: #b42318; --link: #1f5fbf; }
@media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ecebe6; --muted: #a09f98; --line: #34332f; --tile: #1f1f1d; --ok: #4ac26b; --bad: #ff7b72; --link: #7cacf8; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 28px; margin: 0 0 8px; }
h2 { font-size: 18px; margin: 40px 0 12px; }
p { max-width: 75ch; }
a { color: var(--link); }
code { font: 13px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
.muted { color: var(--muted); font-size: 13px; }
.ok { color: var(--ok); font-weight: 600; }
.bad { color: var(--bad); font-weight: 600; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin: 24px 0; }
.tile { background: var(--tile); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
.tile .label { color: var(--muted); font-size: 13px; }
.tile .value { font-size: 28px; font-weight: 650; font-variant-numeric: tabular-nums; margin: 4px 0; }
.tile .sub { color: var(--muted); font-size: 13px; }
.scroll { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--tile); }
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: 10px 12px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
thead th { font-size: 13px; color: var(--muted); font-weight: 600; white-space: nowrap; }
tbody th { font-weight: 600; white-space: nowrap; }
tr:last-child td, tr:last-child th { border-bottom: 0; }
</style>
</head>
<body>
<main>
<h1>Agent carbon (SCI)</h1>
<p>What our Duo agents emit per merge request review, as Software Carbon Intensity (ISO/IEC 21031:2024): <code>(E × I + M) per R</code>, R = one review. The runner time and every model call are counted from ${esc(s.sessions)} agent sessions (${esc(day(s.from))} to ${esc(day(s.to))} UTC); energy per call is a cited range, so each figure has a low and a high end. Method and limits: <a href="${href(`${web}/-/blob/main/SUSTAINABILITY.md`)}">SUSTAINABILITY.md</a>.</p>
<div class="tiles">
${tiles}
</div>
<h2>Per review, by risk tier</h2>
<div class="scroll"><table style="min-width: 760px">
<thead><tr><th>Tier</th><th>Reviews</th><th>Model calls</th><th>Tokens</th><th>Cache reads</th><th>Runner gCO2e</th><th>gCO2e per review</th><th>gCO2e per 1M tokens</th></tr></thead>
<tbody>
${tierRows || '<tr><td colspan="8" class="muted">No reviews.</td></tr>'}
</tbody>
</table></div>
<p class="muted">Medians per review, low-high. The risk score decides the tier, so a low-risk change gets one light review instead of three specialists.</p>
<h2>Is the arithmetic right?</h2>
${checkBlock}
<h2>All agent sessions, by flow</h2>
<div class="scroll"><table style="min-width: 560px">
<thead><tr><th>Flow</th><th>Sessions</th><th>Model calls</th><th>Tokens</th><th>Cache reads</th></tr></thead>
<tbody>
${flowRows}
</tbody>
</table></div>
${ciBlock}
<h2>Coefficients</h2>
<div class="scroll"><table>
<tbody>
${coeff}
</tbody>
</table></div>
<p class="muted">From <code>.autonomy.yml</code> (<code>sustainability</code>) and <code>engine/src/sci.ts</code>. The numbers as JSON: <a href="sci-report.json">sci-report.json</a>; the manifest: <a href="${href(`${web}/-/blob/main/sustainability/agent-reviews.yml`)}">sustainability/agent-reviews.yml</a>.</p>
<p class="muted">Built ${esc(generatedAt.replace('T', ' ').replace(/\.\d+Z$|Z$/, ' UTC'))} from <a href="${href(`${web}/-/commit/${commit}`)}"><code>${esc(commit.slice(0, 8))}</code></a>${pipelineUrl ? ` in <a href="${href(pipelineUrl)}">this pipeline</a>` : ''} by <code>engine/src/cli/sci-report.ts</code>.</p>
</main>
</body>
</html>
`;
}

/**
 * CI's own runner footprint, from job times. In an MR: the MR's finished
 * pipelines before this one; on a branch: its last 10 successful push
 * pipelines. Null when there is nothing to measure.
 */
export async function ciFootprint(gl: Pick<GitLab, 'get'>, env: NodeJS.ProcessEnv, c: SciCoefficients): Promise<CiFootprint | null> {
  const current = Number(env.CI_PIPELINE_ID);
  // an answer of the wrong shape is a bug to see, not an outage to skip
  const list = async <T>(path: string) => {
    const got = await gl.get<T[]>(path);
    if (!Array.isArray(got)) throw new Error(`GET ${path} did not return a list: ${JSON.stringify(got).slice(0, 100)}`);
    return got;
  };
  let ids: number[];
  let scope: string;
  if (env.CI_MERGE_REQUEST_IID) {
    const all = await list<{ id: number; status: string }>(`/:project/merge_requests/${env.CI_MERGE_REQUEST_IID}/pipelines?per_page=100`);
    ids = all.filter((p) => p.id !== current && ['success', 'failed', 'canceled'].includes(p.status)).map((p) => p.id);
    scope = `!${env.CI_MERGE_REQUEST_IID}'s ${ids.length} finished pipeline${ids.length === 1 ? '' : 's'} before this one`;
  } else if (env.CI_COMMIT_BRANCH) {
    const all = await list<{ id: number }>(`/:project/pipelines?ref=${encodeURIComponent(env.CI_COMMIT_BRANCH)}&status=success&source=push&per_page=11`);
    ids = all.map((p) => p.id).filter((id) => id !== current).slice(0, 10);
    scope = `the last ${ids.length} successful push pipelines on ${env.CI_COMMIT_BRANCH}`;
  } else return null;
  if (!ids.length) return null;
  const grams: number[] = [];
  const minutes: number[] = [];
  const jobs = [];
  for (const id of ids) {
    const js = await finishedJobs(gl, [id]);
    jobs.push(...js);
    const fp = footprint(js, c);
    grams.push(fp.totalGrams);
    minutes.push(fp.runnerSeconds / 60);
  }
  return { scope, pipelines: ids.length, footprint: footprint(jobs, c), perPipelineGrams: median(grams), perPipelineMinutes: median(minutes) };
}

export interface PipelineFootprint {
  pipelineId: number;
  /** finished jobs with runner time, retries included */
  jobs: { name: string; seconds: number }[];
  /** what wasn't counted and why: this job, or a job with no runner time (running, manual, skipped...) */
  leftOut: { name: string; status: string }[];
  footprint: Footprint;
}

const FINISHED = ['success', 'failed', 'canceled'];

/**
 * The runner footprint of this pipeline, read by a job in its last stage
 * (.post): every finished job, retries included since they cost what they
 * cost, without the job that reads it. MR and main pipelines give the same
 * quantity, so the MR widget compares one pipeline with one pipeline.
 */
export async function pipelineFootprint(gl: Pick<GitLab, 'get'>, env: NodeJS.ProcessEnv, c: SciCoefficients): Promise<PipelineFootprint> {
  const pipelineId = Number(env.CI_PIPELINE_ID);
  if (!pipelineId) throw new Error('CI_PIPELINE_ID is not set');
  const self = Number(env.CI_JOB_ID);
  const jobs: PipelineFootprint['jobs'] = [];
  const leftOut: PipelineFootprint['leftOut'] = [];
  for (const j of await pipelineJobs(gl, pipelineId)) {
    if (j.id === self) leftOut.push({ name: j.name, status: 'this job' });
    else if (FINISHED.includes(j.status) && j.duration) jobs.push({ name: j.name, seconds: j.duration });
    else leftOut.push({ name: j.name, status: j.status === 'manual' ? 'manual, not run' : FINISHED.includes(j.status) ? `${j.status}, no runner time` : j.status });
  }
  return { pipelineId, jobs, leftOut, footprint: footprint(jobs.map((j) => ({ name: j.name, duration: j.seconds })), c) };
}

/** The metrics report of autonomy:sci:pipeline: one pipeline's figures, never a median. */
export function pipelineMetricsText(p: PipelineFootprint): string {
  return [
    `sci_ci_runner_minutes_this_pipeline ${num(p.footprint.runnerSeconds / 60, 1)}`,
    `sci_ci_runner_gco2e_this_pipeline ${num(p.footprint.totalGrams)}`,
    `sci_ci_jobs_counted_this_pipeline ${p.jobs.length}`,
  ].join('\n') + '\n';
}

/** The same figures for the job log, with what was left out. */
export function pipelineSummary(p: PipelineFootprint): string {
  const f = p.footprint;
  return [
    `CI runner footprint of this pipeline (${p.pipelineId}): ${p.jobs.length} finished job${p.jobs.length === 1 ? '' : 's'}, retries included, ${(f.runnerSeconds / 60).toFixed(1)} runner-min, ${(f.energyKwh * 1000).toFixed(1)} Wh, ${f.totalGrams.toFixed(2)} gCO2e (${f.operationalGrams.toFixed(2)} g operational, ${f.embodiedGrams.toFixed(2)} g embodied).`,
    `left out: ${p.leftOut.length ? p.leftOut.map((j) => `${j.name} (${j.status})`).join(', ') : 'nothing'}`,
  ].join('\n');
}

export interface MainComparison {
  branch: string;
  pipelines: number;
  /** this pipeline's 5 costliest jobs by name (retries summed), with main's median for the same name, or null */
  top: { name: string; minutes: number; mainMinutes: number | null }[];
  /** jobs in at least half of main's pipelines that this one didn't count */
  mainOnly: { jobs: number; minutes: number };
}

const minutesByName = (jobs: { name: string; seconds: number }[]) => {
  const by = new Map<string, number>();
  for (const j of jobs) by.set(j.name, (by.get(j.name) ?? 0) + j.seconds / 60);
  return by;
};

/**
 * Why this pipeline costs what it does: its costliest jobs against the same
 * job names on the target branch's last 10 successful push pipelines. Job
 * times only; nothing from it goes into the metrics report.
 */
export async function compareWithMain(gl: Pick<GitLab, 'get'>, branch: string, p: PipelineFootprint): Promise<MainComparison> {
  const path = `/:project/pipelines?ref=${encodeURIComponent(branch)}&status=success&source=push&per_page=10`;
  const list = await gl.get<{ id: number }[]>(path);
  if (!Array.isArray(list)) throw new Error(`GET ${path} did not return a list: ${JSON.stringify(list).slice(0, 100)}`);
  const ids = list.map((x) => x.id).filter((id) => id !== p.pipelineId);
  const runs = new Map<string, number[]>();
  for (const id of ids) {
    const jobs = (await finishedJobs(gl, [id])).map((j) => ({ name: j.name, seconds: j.duration }));
    for (const [name, minutes] of minutesByName(jobs)) runs.set(name, [...(runs.get(name) ?? []), minutes]);
  }
  const here = minutesByName(p.jobs);
  const top = [...here]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, minutes]) => ({ name, minutes, mainMinutes: runs.has(name) ? median(runs.get(name)!) : null }));
  const usual = [...runs].filter(([name, ms]) => !here.has(name) && ms.length * 2 >= ids.length);
  return { branch, pipelines: ids.length, top, mainOnly: { jobs: usual.length, minutes: usual.reduce((n, [, ms]) => n + median(ms), 0) } };
}

export function comparisonSummary(m: MainComparison): string {
  const diff = (here: number, main: number) => `${here >= main ? '+' : ''}${(here - main).toFixed(1)} min, ${here >= main ? '+' : ''}${main ? Math.round(((here - main) / main) * 100) : 0}%`;
  return [
    `Top ${m.top.length} jobs here by runner-min, against the median of the same job on ${m.branch}'s last ${m.pipelines} successful push pipelines:`,
    ...m.top.map((j) => `  ${j.name}: ${j.minutes.toFixed(1)} min, ${j.mainMinutes === null ? `not on ${m.branch}` : `${m.branch} ${j.mainMinutes.toFixed(1)} min (${diff(j.minutes, j.mainMinutes)})`}`),
    `${m.branch}'s usual jobs not run here: ${m.mainOnly.jobs}, ${m.mainOnly.minutes.toFixed(1)} runner-min at ${m.branch}'s median.`,
  ].join('\n');
}
