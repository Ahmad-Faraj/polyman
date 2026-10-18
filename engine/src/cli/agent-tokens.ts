/**
 * What the Duo agents' model calls carried, by token class, per session: the
 * counts behind SUSTAINABILITY.md's per-token numbers (SCI for AI). Each flow
 * session runs as a CI job (a "duo_workflow" pipeline). Its log names the
 * workflow, and the workflow's checkpoint (GraphQL duoWorkflowEvents) holds
 * every model reply with its usage (tokens.ts).
 *
 * The runner time is measured; the model calls are counted, not bounded as
 * agent-footprint.ts does from the log; their energy is the same cited range
 * per call (sci.ts).
 *
 *   GITLAB_TOKEN=... node engine/src/cli/agent-tokens.ts [project] [--since YYYY-MM-DD] [--json out.json]
 *
 * Needs a token that can read the project's job logs and agent sessions.
 */
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { gitlabUrl, projectPathFrom, tokenFetch } from '../project.ts';
import { INFERENCE_WH_PER_CALL, sessionGrams } from '../sci.ts';
import { type TokenClasses, NONE, add, flowOf, median, roleOf, tokensOf, totalTokens } from '../tokens.ts';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  argv.splice(i, 2);
  return value;
};
const since = opt('--since');
const jsonOut = opt('--json');
if (since && !/^\d{4}-\d\d-\d\d$/.test(since)) throw new Error(`--since takes a date like 2026-10-16, not ${since}`);
const projectPath = projectPathFrom(argv[0]);
const api = gitlabUrl(process.env.GITLAB_URL);
const token = process.env.GITLAB_TOKEN;
if (!token) throw new Error('set GITLAB_TOKEN to read the agent job logs and sessions');
const auth = { Authorization: `Bearer ${token}` };
const project = encodeURIComponent(projectPath);

/**
 * fetch with a token, trying again after a rate limit, a server error (GitLab
 * answers 503 now and then on a large checkpoint) or a dropped connection.
 */
async function retrying(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await tokenFetch(url, init);
      if ((res.status === 429 || res.status >= 500) && attempt < 4) throw new Error(`${res.status}`);
      // the body is read here too: a connection can drop halfway through a large one
      return { status: res.status, text: await res.text() };
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, (attempt + 1) * 15_000));
    }
  }
}

async function rest<T>(path: string, raw = false): Promise<T> {
  const res = await retrying(`${api}/api/v4/projects/${project}${path}`, { headers: auth });
  if (res.status >= 400) throw new Error(`GET ${path} -> ${res.status}`);
  return (raw ? res.text : JSON.parse(res.text)) as T;
}

/** The session's checkpoint, or null when GitLab has none or won't give it (counted and reported, not guessed). */
async function checkpoint(workflow: number): Promise<string | null> {
  const query = `query { duoWorkflowEvents(workflowId: "gid://gitlab/Ai::DuoWorkflows::Workflow/${workflow}") { nodes { checkpoint } } }`;
  let res: { status: number; text: string };
  try {
    res = await retrying(`${api}/api/graphql`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  } catch (err) {
    res = { status: 0, text: String(err) };
  }
  if (res.status !== 200) {
    console.error(`warning: GraphQL duoWorkflowEvents(${workflow}) -> ${res.status || res.text}; counted as a session without a checkpoint`);
    return null;
  }
  const body = JSON.parse(res.text) as { data?: { duoWorkflowEvents?: { nodes?: { checkpoint: string }[] } } };
  return body.data?.duoWorkflowEvents?.nodes?.[0]?.checkpoint ?? null;
}

interface Session {
  pipeline: number;
  workflow: number;
  at: string;
  flow: string;
  mr: number | null;
  tier: string | null;
  skipped: boolean;
  seconds: number;
  models: string[];
  total: TokenClasses;
  byRole: Record<string, TokenClasses>;
}

const sessions: Session[] = [];
const noCheckpoint: number[] = [];
for (let page = 1; ; page++) {
  const pipelines = await rest<{ id: number; created_at: string }[]>(`/pipelines?source=duo_workflow&per_page=100&page=${page}${since ? `&updated_after=${since}T00:00:00Z` : ''}`);
  if (!pipelines.length) break;
  for (const p of pipelines) {
    if (since && p.created_at < since) continue;
    const [job] = await rest<{ id: number; duration: number | null }[]>(`/pipelines/${p.id}/jobs`);
    if (!job?.duration) continue;
    const log = await rest<string>(`/jobs/${job.id}/trace`, true);
    const workflow = Number(log.match(/workflow_id=(\d+)/)?.[1]);
    if (!workflow) continue;
    const raw = await checkpoint(workflow);
    if (!raw) {
      noCheckpoint.push(workflow);
      continue;
    }
    const t = tokensOf(raw);
    if (!t.agents.length) continue;
    const byRole: Record<string, TokenClasses> = {};
    for (const a of t.agents) byRole[roleOf(a.agent)] = add(byRole[roleOf(a.agent)] ?? NONE, a);
    sessions.push({
      pipeline: p.id,
      workflow,
      at: p.created_at,
      flow: flowOf(t.agents),
      mr: t.mr,
      tier: null,
      skipped: /^skipped:/i.test(t.lastText),
      seconds: job.duration,
      models: [...new Set(t.agents.flatMap((a) => a.models))],
      total: t.agents.reduce<TokenClasses>((n, a) => add(n, a), NONE),
      byRole,
    });
  }
}

// the tier the risk score gave the MR, as its label says now (agent-footprint.ts reads it the same way)
const tiers = new Map<number, string>();
for (const mr of new Set(sessions.map((s) => s.mr).filter((m): m is number => !!m))) {
  const labels = await rest<{ labels: string[] }>(`/merge_requests/${mr}`).then(
    (m) => m.labels,
    () => [] as string[],
  );
  tiers.set(mr, labels.find((l) => l.startsWith('risk::'))?.slice(6) ?? 'unknown');
}
for (const s of sessions) s.tier = s.mr ? (tiers.get(s.mr) ?? null) : null;

const coefficients = loadConfig().sustainability;
const grams = (s: Session) => sessionGrams(s.seconds, { low: s.total.calls, high: s.total.calls }, coefficients);
const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : n.toFixed(0));
const pct = (part: number, whole: number) => `${whole ? Math.round((100 * part) / whole) : 0}%`;
const sum = (xs: Session[]) => xs.reduce<TokenClasses>((n, s) => add(n, s.total), NONE);

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ project: projectPath, since: since ?? null, inferenceWhPerCall: INFERENCE_WH_PER_CALL, coefficients, sessions }, null, 2) + '\n');
  console.error(`wrote ${jsonOut} (${sessions.length} sessions)`);
}

console.log(`${sessions.length} agent sessions with a checkpoint${since ? ` since ${since}` : ''}${noCheckpoint.length ? ` (${noCheckpoint.length} more had none)` : ''}\n`);
console.log('| Flow | Sessions | Skipped | Model calls | Uncached in | Cache write | Cache read | Output | Total tokens |\n|---|---|---|---|---|---|---|---|---|');
const flows = [...new Set(sessions.map((s) => s.flow))];
for (const flow of flows) {
  const xs = sessions.filter((s) => s.flow === flow);
  const t = sum(xs);
  console.log(`| ${flow} | ${xs.length} | ${xs.filter((s) => s.skipped).length} | ${t.calls} | ${k(t.uncached)} | ${k(t.cacheWrite)} | ${k(t.cacheRead)} | ${k(t.output)} | ${k(totalTokens(t))} |`);
}

console.log('\nFull reviews by risk tier (mr-reviewer sessions that reviewed), median per review, and the SCI for AI per token:\n');
console.log('| Tier | Reviews | Calls | Uncached in | Cache write | Cache read | Output | Total tokens | gCO2e per review (low-high) | gCO2e per 1M tokens (low-high) |\n|---|---|---|---|---|---|---|---|---|---|');
const reviews = sessions.filter((s) => s.flow === 'mr-reviewer' && !s.skipped);
for (const tier of ['high', 'medium', 'low', 'unknown']) {
  const xs = reviews.filter((s) => (s.tier ?? 'unknown') === tier);
  if (!xs.length) continue;
  const m = (f: (t: TokenClasses) => number) => median(xs.map((s) => f(s.total)));
  const g = xs.map(grams);
  const tokens = xs.reduce((n, s) => n + totalTokens(s.total), 0);
  const perM = (side: 'low' | 'high') => (g.reduce((n, x) => n + x[side], 0) / tokens) * 1e6;
  console.log(
    `| ${tier} | ${xs.length} | ${m((t) => t.calls)} | ${k(m((t) => t.uncached))} | ${k(m((t) => t.cacheWrite))} | ${k(m((t) => t.cacheRead))} | ${k(m((t) => t.output))} | ${k(m(totalTokens))} | ${median(g.map((x) => x.low)).toFixed(1)}-${median(g.map((x) => x.high)).toFixed(1)} | ${perM('low').toFixed(1)}-${perM('high').toFixed(1)} |`,
  );
}

const high = reviews.filter((s) => s.tier === 'high');
if (high.length) {
  console.log(`\nWho in a high review makes the calls and carries the tokens (${high.length} reviews):\n`);
  console.log('| Role | Calls | Share of calls | Tokens | Share of tokens |\n|---|---|---|---|---|');
  const all = sum(high);
  const roles = [...new Set(high.flatMap((s) => Object.keys(s.byRole)))];
  for (const role of roles) {
    const t = high.reduce<TokenClasses>((n, s) => add(n, s.byRole[role] ?? NONE), NONE);
    console.log(`| ${role} | ${t.calls} | ${pct(t.calls, all.calls)} | ${k(totalTokens(t))} | ${pct(totalTokens(t), totalTokens(all))} |`);
  }
}

const models = new Map<string, number>();
for (const s of sessions) for (const m of s.models) models.set(m, (models.get(m) ?? 0) + 1);
console.log(`\nModels seen (sessions): ${[...models].map(([m, n]) => `${m} ${n}`).join(', ') || 'none'}`);
console.log(`Energy per model call: ${INFERENCE_WH_PER_CALL.low}-${INFERENCE_WH_PER_CALL.high} Wh, a cited range (engine/src/sci.ts); the calls are counted from the checkpoints.`);
