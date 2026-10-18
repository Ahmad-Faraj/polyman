/**
 * Checks that a project is set up for the flows: the policy, the flow files,
 * the flows in the AI Catalog (and that what is published there is what the
 * repo says), the agents' accounts, the approval rule, "pipelines must
 * succeed", that no open MR is missing the review its green pipeline should
 * have started, and that no personal token sits in the CI variables.
 *
 * Run it from your machine with your own token; it only reads:
 *   GITLAB_TOKEN=... node engine/src/cli/doctor.ts [project path]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';
import { projectPathFrom } from '../project.ts';
import { loadConfig, type AutonomyConfig } from '../config.ts';
import { checkFlow } from '../flows.ts';
import { flowValues, renderFlow } from '../render.ts';
import { type OpenMr, missingReviews, reviewedShasFrom } from '../reviews.ts';

type Status = 'ok' | 'warn' | 'fail';
const results: { status: Status; what: string; detail?: string }[] = [];
const report = (status: Status, what: string, detail?: string) => results.push({ status, what, detail });

const args = process.argv.slice(2);
const projectPath = projectPathFrom(args.find((a) => !a.startsWith('--')));
const token = process.env.GITLAB_TOKEN;
if (!token) throw new Error('set GITLAB_TOKEN (a token with read_api) to run the checks');
const api = process.env.GITLAB_URL ?? 'https://gitlab.com';
if (!api.startsWith('https://')) throw new Error(`refusing to send your token to ${api}: use an https:// GITLAB_URL`);

async function rest<T>(path: string): Promise<T> {
  const res = await fetch(`${api}/api/v4${path}`, { redirect: 'error', headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${api}/api/graphql`, {
    redirect: 'error',
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
  if (!res.ok || body.errors?.length || !body.data) {
    throw new Error(body.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`);
  }
  return body.data;
}

const FLOWS = ['mr-reviewer', 'pipeline-fixer', 'incident-responder', 'issue-builder'];
const dir = '.gitlab/duo/flows';
const enc = encodeURIComponent(projectPath);

// --- local files ---
let config: AutonomyConfig | undefined;
try {
  config = loadConfig();
  report(existsSync('.autonomy.yml') ? 'ok' : 'warn', '.autonomy.yml', existsSync('.autonomy.yml') ? undefined : 'missing; using the defaults');
} catch (err) {
  report('fail', '.autonomy.yml', (err as Error).message);
}
if (config) {
  for (const key of ['reviewerAccount', 'fixerAccount'] as const) {
    if (!config.agents[key]) report('fail', `agents.${key === 'reviewerAccount' ? 'reviewer' : 'fixer'}_account`, 'not set: no review or fix note will be trusted');
  }
  if (!config.monitor.measuredRoutes.length) report('warn', 'monitor.measured_routes', 'empty: the reviewer cannot ask production to watch anything specific');
}
const ci = existsSync('.gitlab-ci.yml') ? readFileSync('.gitlab-ci.yml', 'utf8') : '';
report(ci.includes('engine/ci/autonomy.gitlab-ci.yml') ? 'ok' : 'fail', '.gitlab-ci.yml includes engine/ci/autonomy.gitlab-ci.yml');
report(existsSync('.gitlab/duo/agent-config.yml') ? 'ok' : 'warn', '.gitlab/duo/agent-config.yml', existsSync('.gitlab/duo/agent-config.yml') ? undefined : 'missing: agents get a default image without your tools');

const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)) : [];
const sources = new Map(files.map((f) => [basename(f).replace(/\.ya?ml$/, ''), readFileSync(join(dir, f), 'utf8')]));
for (const name of FLOWS) if (!sources.has(name)) report('fail', `${dir}/${name}.yaml`, 'missing');

// --- GitLab ---
const project = await rest<{ id: number; only_allow_merge_if_pipeline_succeeds: boolean; namespace: { full_path: string } }>(`/projects/${enc}`);

interface Node {
  id: string;
  enabled: boolean;
  item: { name: string; latestVersion?: { versionName?: string; definition?: string } };
}
const nodes: Node[] = [];
for (let after: string | null = null; ; ) {
  const data: { aiCatalogConfiguredItems: { nodes: Node[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } =
    await graphql(
      `query($p: ProjectID!, $after: String) {
        aiCatalogConfiguredItems(projectId: $p, first: 100, after: $after) {
          nodes { id enabled item { name latestVersion { versionName ... on AiCatalogFlowVersion { definition } } } }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { p: `gid://gitlab/Project/${project.id}`, after },
    );
  nodes.push(...data.aiCatalogConfiguredItems.nodes);
  const info = data.aiCatalogConfiguredItems.pageInfo;
  if (!info.hasNextPage || !info.endCursor) break;
  after = info.endCursor;
}
const byName = new Map(nodes.map((n) => [n.item.name, n]));
const consumerIds = Object.fromEntries(nodes.map((n) => [n.item.name, /\/(\d+)$/.exec(n.id)?.[1] ?? '']));

for (const name of FLOWS) {
  const node = byName.get(name);
  if (!node) {
    report('fail', `flow ${name}`, 'not in this project\'s AI Catalog; create it (node engine/src/cli/sync-flows.ts --print NAME)');
    continue;
  }
  if (!node.enabled) report('fail', `flow ${name}`, 'in the catalog but not enabled');
  const source = sources.get(name);
  if (!source || !config) continue;
  let rendered: string;
  try {
    rendered = renderFlow(source, flowValues(config, consumerIds));
  } catch (err) {
    report('fail', `flow ${name}`, (err as Error).message);
    continue;
  }
  const problems = checkFlow(rendered);
  if (problems.length) report('fail', `flow ${name}`, problems.join('; '));
  else if (!node.item.latestVersion?.definition) report('warn', `flow ${name}`, "couldn't read the published version");
  else if (!isDeepStrictEqual(parse(node.item.latestVersion.definition), parse(rendered))) {
    report('fail', `flow ${name}`, `published ${node.item.latestVersion.versionName} differs from the repo; run node engine/src/cli/sync-flows.ts`);
  } else report('ok', `flow ${name}`, `published ${node.item.latestVersion.versionName} matches the repo`);
}

const members = await rest<{ username: string }[]>(`/projects/${enc}/members/all?per_page=100&query=ai-`);
const usernames = new Set(members.map((m) => m.username));
for (const account of [config?.agents.reviewerAccount, config?.agents.fixerAccount].filter(Boolean) as string[]) {
  report(usernames.has(account) ? 'ok' : 'fail', `account ${account}`, usernames.has(account) ? 'is a project member' : 'no such member; check the name GitLab gave the flow\'s service account');
}

const rules = await rest<{ name: string; approvals_required: number }[]>(`/projects/${enc}/approval_rules`);
const rule = rules.find((r) => r.approvals_required >= 1);
report(rule ? 'ok' : 'fail', 'approval rule', rule ? `"${rule.name}" needs ${rule.approvals_required}` : 'no rule requires an approval');

// "Pipelines must succeed" can be set on the project or on any group above it.
let mustSucceed = project.only_allow_merge_if_pipeline_succeeds;
let where = 'project';
const parts = project.namespace.full_path.split('/');
for (let i = parts.length; i > 0 && !mustSucceed; i--) {
  const path = parts.slice(0, i).join('/');
  const group = await rest<{ only_allow_merge_if_pipeline_succeeds?: boolean }>(`/groups/${encodeURIComponent(path)}`).catch(() => ({}));
  if ((group as { only_allow_merge_if_pipeline_succeeds?: boolean }).only_allow_merge_if_pipeline_succeeds) {
    mustSucceed = true;
    where = `group ${path}`;
  }
}
report(mustSucceed ? 'ok' : 'fail', 'pipelines must succeed', mustSucceed ? `set on the ${where}` : 'off: a red pipeline could be merged');

// --- reviews: a reviewer session can end or crash without a note ---
try {
  const reviewer = config?.agents.reviewerAccount;
  const mrs = await rest<{ iid: number; sha: string; draft: boolean }[]>(`/projects/${enc}/merge_requests?state=opened&per_page=100`);
  const open: OpenMr[] = [];
  for (const mr of mrs) {
    const [p] = await rest<{ sha: string; status: string; updated_at: string }[]>(`/projects/${enc}/merge_requests/${mr.iid}/pipelines?per_page=1`);
    const notes = await rest<{ body: string; author: { username: string } }[]>(`/projects/${enc}/merge_requests/${mr.iid}/notes?per_page=100&sort=desc`);
    const reviewedShas = reviewedShasFrom(notes, reviewer);
    open.push({ iid: mr.iid, sha: mr.sha, draft: mr.draft, pipeline: p ? { sha: p.sha, status: p.status, finishedAt: p.updated_at } : null, reviewedShas });
  }
  const running = await rest<{ created_at: string }[]>(`/projects/${enc}/pipelines?source=duo_workflow&status=running&per_page=100`);
  const missing = missingReviews(open, new Date(), running.map((r) => r.created_at));
  if (!missing.length) {
    const waiting = running.length ? `; ${running.length} reviewer session(s) still running, so MRs whose pipeline finished before one started are assumed to be in it` : '';
    report('ok', 'reviews', `no open MR is missing a review of its head (${open.length} open${waiting})`);
  }
  for (const mr of missing) {
    report('warn', `review of !${mr.iid}`, `the pipeline for ${mr.sha.slice(0, 8)} passed at ${mr.pipeline?.finishedAt} and no review covers that head; the session may have ended without a note. Mention @${reviewer} on the MR to start one`);
  }
} catch (err) {
  report('warn', 'reviews', `couldn't check: ${(err as Error).message}`);
}

try {
  const vars = await rest<{ key: string }[]>(`/projects/${enc}/variables?per_page=100`);
  const personal = vars.filter((v) => /BOT_TOKEN|PRIVATE_TOKEN|GITLAB_TOKEN|_PAT$/i.test(v.key)).map((v) => v.key);
  report(personal.length ? 'warn' : 'ok', 'CI variables', personal.length ? `${personal.join(', ')} look like personal tokens; CI only needs its job token` : 'no personal tokens');
} catch {
  report('warn', 'CI variables', "couldn't read them (needs Maintainer or a custom role that can)");
}

// --- result ---
const mark = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
for (const r of results) console.log(`${mark[r.status]} ${r.what}${r.detail ? `: ${r.detail}` : ''}`);
const failed = results.filter((r) => r.status === 'fail').length;
console.log(failed ? `\n${failed} problem(s) to fix before the flows can be trusted` : '\nready');
if (failed) process.exit(1);
