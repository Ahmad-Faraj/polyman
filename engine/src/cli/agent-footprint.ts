/**
 * Measures what the Duo agents themselves cost to run. Every flow session runs
 * as a CI job on a runner (a "duo_workflow" pipeline), so its runner time can
 * be turned into energy and carbon with the same SCI coefficients as the CI.
 * Model inference happens on GitLab's side: its energy isn't visible here, but
 * the agent graph's checkpoints are, which bound its model calls, so each
 * session also gets an inference estimate as a low/high range (see sci.ts).
 *
 * Reads job logs, which needs a token with read access (run it locally):
 *   GITLAB_TOKEN=... node engine/src/cli/agent-footprint.ts [project] [--json] [--manifest file.yml]
 * (The committed sustainability/agent-reviews.yml comes from counted calls,
 * review-manifest.ts; --manifest here writes the older, log-bounded kind.)
 * --manifest also writes the reviews as an Impact Framework manifest, which
 * `npx -y -p @grnsft/if@1.1.1 if-run -m file.yml` recomputes without a token.
 */
import { loadConfig } from '../config.ts';
import { gitlabUrl, projectPathFrom, tokenFetch } from '../project.ts';
import { writeFileSync } from 'node:fs';
import { footprintArgs, ifManifest } from '../manifest.ts';
import { INFERENCE_WH_PER_CALL, callsOf, checkpointsMissing, footprint, modelCalls, sessionGrams } from '../sci.ts';

const api = gitlabUrl(process.env.GITLAB_URL);
// read before any network call, so a bad option fails at once
const args = footprintArgs(process.argv.slice(2));
const project = encodeURIComponent(projectPathFrom(args.project));
const token = process.env.GITLAB_TOKEN;
if (!token) throw new Error('set GITLAB_TOKEN to read the agent job logs');

async function get<T>(path: string, raw = false): Promise<T> {
  const res = await tokenFetch(`${api}/api/v4/projects/${project}${path}`, { headers: { 'PRIVATE-TOKEN': token! } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return (raw ? await res.text() : await res.json()) as T;
}

interface Session {
  pipeline: number;
  at: string;
  flow: string;
  mr: number | null;
  skipped: boolean;
  seconds: number;
  /** model calls, bounded from the log's checkpoints */
  calls: { low: number; high: number };
}

const FLOWS: [RegExp, string][] = [
  [/"prompt_id":"lead_reviewer"/, 'mr-reviewer'],
  [/"prompt_id":"pipeline_fixer"/, 'pipeline-fixer'],
  [/"prompt_id":"incident_responder"/, 'incident-responder'],
  [/"prompt_id":"issue_builder"/, 'issue-builder'],
  [/code_review\/v1/, 'gitlab-code-review'],
];

const sessions: Session[] = [];
for (let page = 1; ; page++) {
  const pipelines = await get<{ id: number; created_at: string }[]>(`/pipelines?source=duo_workflow&per_page=100&page=${page}`);
  if (!pipelines.length) break;
  for (const p of pipelines) {
    const [job] = await get<{ id: number; duration: number | null }[]>(`/pipelines/${p.id}/jobs`);
    if (!job?.duration) continue;
    const log = (await get<string>(`/jobs/${job.id}/trace`, true)).replace(/\x1b\[[0-9;]*m/g, '');
    const flow = FLOWS.find(([re]) => re.test(log))?.[1] ?? 'other';
    const mr =
      Number(log.match(/"merge_request":\{"id":\d+,"iid":(\d+)/)?.[1] ?? log.match(/MergeRequest IID: (\d+)/)?.[1] ?? log.match(/merge request !(\d+)/i)?.[1]) || null;
    const skipped = /skipped: /.test(log.split('Starting Workflow').pop() ?? '');
    const calls = modelCalls(log);
    if (checkpointsMissing(job.duration, calls)) console.error(`warning: no checkpoint lines in pipeline ${p.id}'s log; its model calls count as 0`);
    sessions.push({ pipeline: p.id, at: p.created_at, flow, mr, skipped, seconds: job.duration, calls });
  }
}

const tiers = new Map<number, string>();
for (const mr of new Set(sessions.map((s) => s.mr).filter((m): m is number => !!m))) {
  // the MR number is read from free text in a log, so it may not exist here
  const labels = await get<{ labels: string[] }>(`/merge_requests/${mr}`).then(
    (m) => m.labels,
    () => [] as string[],
  );
  tiers.set(mr, labels.find((l) => l.startsWith('risk::'))?.slice(6) ?? 'unknown');
}

const coefficients = loadConfig().sustainability;
const grams = (seconds: number) => footprint([{ name: 'agent', duration: seconds }], coefficients).totalGrams;
const minutes = (seconds: number) => (seconds / 60).toFixed(1);
const calls = (c: { low: number; high: number }) => `${c.low.toFixed(0)}-${c.high.toFixed(0)}`;
const range = (seconds: number, c: { low: number; high: number }) => {
  const g = sessionGrams(seconds, c, coefficients);
  return `${g.low.toFixed(1)}-${g.high.toFixed(1)}`;
};
const byFlow = new Map<string, Session[]>();
for (const s of sessions) byFlow.set(s.flow, [...(byFlow.get(s.flow) ?? []), s]);

const reviews = sessions.filter((s) => s.flow === 'mr-reviewer' && !s.skipped && s.mr);
const byTier = new Map<string, Session[]>();
for (const s of reviews) byTier.set(tiers.get(s.mr!) ?? 'unknown', [...(byTier.get(tiers.get(s.mr!) ?? 'unknown') ?? []), s]);
const avg = (xs: Session[]) => xs.reduce((n, s) => n + s.seconds, 0) / Math.max(1, xs.length);

if (args.manifest) {
  writeFileSync(args.manifest, ifManifest(new Map([...byTier].map(([tier, xs]) => [tier, xs.map(({ at, seconds, calls }) => ({ at, seconds, calls }))])), coefficients));
  console.error(`wrote ${args.manifest}: recompute it with npx -y -p @grnsft/if@1.1.1 if-run -m ${args.manifest}`);
}

if (args.json) {
  console.log(JSON.stringify({ coefficients, inferenceWhPerCall: INFERENCE_WH_PER_CALL, sessions, tiers: Object.fromEntries(tiers) }, null, 2));
} else {
  console.log(`${sessions.length} agent sessions\n`);
  console.log('| Flow | Sessions | Skipped early | Runner min | Runner gCO2e | Model calls (low-high) | Total gCO2e (low-high) |\n|---|---|---|---|---|---|---|');
  for (const [flow, xs] of byFlow) {
    const total = xs.reduce((n, s) => n + s.seconds, 0);
    console.log(`| ${flow} | ${xs.length} | ${xs.filter((s) => s.skipped).length} | ${minutes(total)} | ${grams(total).toFixed(2)} | ${calls(callsOf(xs))} | ${range(total, callsOf(xs))} |`);
  }
  console.log('\nFull reviews by risk tier (mr-reviewer sessions that did a review):\n');
  console.log('| Tier | Reviews | Avg runner min | Avg runner gCO2e | Avg model calls (low-high) | Avg total gCO2e (low-high) |\n|---|---|---|---|---|---|');
  for (const [tier, xs] of byTier) {
    const c = callsOf(xs, Math.max(1, xs.length));
    console.log(`| ${tier} | ${xs.length} | ${minutes(avg(xs))} | ${grams(avg(xs)).toFixed(2)} | ${calls(c)} | ${range(avg(xs), c)} |`);
  }
  console.log(`\nModel calls are bounded from each session's checkpoints; ${INFERENCE_WH_PER_CALL.low}-${INFERENCE_WH_PER_CALL.high} Wh per call is a cited range (engine/src/sci.ts).`);
}
