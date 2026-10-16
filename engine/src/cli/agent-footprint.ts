/**
 * Measures what the Duo agents themselves cost to run. Every flow session runs
 * as a CI job on a runner (a "duo_workflow" pipeline), so its runner time can
 * be turned into energy and carbon with the same SCI coefficients as the CI.
 * Model inference happens on GitLab's side and isn't visible here; this covers
 * the runner the agent works on.
 *
 * Reads job logs, which needs a token with read access (run it locally):
 *   GITLAB_TOKEN=... node engine/src/cli/agent-footprint.ts [--json]
 */
import { loadConfig } from '../config.ts';
import { projectPathFrom } from '../project.ts';
import { footprint } from '../sci.ts';

const api = process.env.GITLAB_URL ?? 'https://gitlab.com';
if (!api.startsWith('https://')) throw new Error(`refusing to send your token to ${api}: use an https:// GITLAB_URL`);
const project = encodeURIComponent(projectPathFrom(process.argv.slice(2).find((a) => !a.startsWith('--'))));
const token = process.env.GITLAB_TOKEN;
if (!token) throw new Error('set GITLAB_TOKEN to read the agent job logs');

async function get<T>(path: string, raw = false): Promise<T> {
  const res = await fetch(`${api}/api/v4/projects/${project}${path}`, { headers: { 'PRIVATE-TOKEN': token! } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return (raw ? await res.text() : await res.json()) as T;
}

interface Session {
  pipeline: number;
  flow: string;
  mr: number | null;
  skipped: boolean;
  seconds: number;
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
  const pipelines = await get<{ id: number }[]>(`/pipelines?source=duo_workflow&per_page=100&page=${page}`);
  if (!pipelines.length) break;
  for (const p of pipelines) {
    const [job] = await get<{ id: number; duration: number | null }[]>(`/pipelines/${p.id}/jobs`);
    if (!job?.duration) continue;
    const log = (await get<string>(`/jobs/${job.id}/trace`, true)).replace(/\x1b\[[0-9;]*m/g, '');
    const flow = FLOWS.find(([re]) => re.test(log))?.[1] ?? 'other';
    const mr =
      Number(log.match(/"merge_request":\{"id":\d+,"iid":(\d+)/)?.[1] ?? log.match(/MergeRequest IID: (\d+)/)?.[1] ?? log.match(/merge request !(\d+)/i)?.[1]) || null;
    const skipped = /skipped: /.test(log.split('Starting Workflow').pop() ?? '');
    sessions.push({ pipeline: p.id, flow, mr, skipped, seconds: job.duration });
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

const byFlow = new Map<string, Session[]>();
for (const s of sessions) byFlow.set(s.flow, [...(byFlow.get(s.flow) ?? []), s]);

const reviews = sessions.filter((s) => s.flow === 'mr-reviewer' && !s.skipped && s.mr);
const byTier = new Map<string, Session[]>();
for (const s of reviews) byTier.set(tiers.get(s.mr!) ?? 'unknown', [...(byTier.get(tiers.get(s.mr!) ?? 'unknown') ?? []), s]);
const avg = (xs: Session[]) => xs.reduce((n, s) => n + s.seconds, 0) / Math.max(1, xs.length);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ coefficients, sessions, tiers: Object.fromEntries(tiers) }, null, 2));
} else {
  console.log(`${sessions.length} agent sessions\n`);
  console.log('| Flow | Sessions | Skipped early | Runner min | gCO2e |\n|---|---|---|---|---|');
  for (const [flow, xs] of byFlow) {
    const total = xs.reduce((n, s) => n + s.seconds, 0);
    console.log(`| ${flow} | ${xs.length} | ${xs.filter((s) => s.skipped).length} | ${minutes(total)} | ${grams(total).toFixed(2)} |`);
  }
  console.log('\nFull reviews by risk tier (mr-reviewer sessions that did a review):\n');
  console.log('| Tier | Reviews | Avg runner min | Avg gCO2e |\n|---|---|---|---|');
  for (const [tier, xs] of byTier) console.log(`| ${tier} | ${xs.length} | ${minutes(avg(xs))} | ${grams(avg(xs)).toFixed(2)} |`);
}
