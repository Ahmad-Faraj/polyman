/**
 * Runs on main after a merge.
 *   check  - make sure the commit came from an approved MR and note who approved it
 *   report - once production is verified: publish a GitLab release whose notes are
 *            the evidence for this change (approval, risk, agent review, fixes,
 *            what production showed against the watch list, carbon). The MR
 *            links to it through the production deployment.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { finishedJobs, GitLab, required } from '../gitlab.ts';
import { describe, type WatchResult } from '../watch.ts';
import { isPipelineFixNote, isReviewNote } from '../review.ts';
import { footprint, formatFootprint } from '../sci.ts';

interface MergeRequest {
  iid: number;
  title: string;
  state: string;
  labels: string[];
  web_url: string;
  author: { username: string };
}

interface Note {
  body: string;
  author: { username: string };
}

const env = process.env;
const gl = new GitLab();
const sha = required(env, 'CI_COMMIT_SHA');

async function sourceMergeRequest(): Promise<MergeRequest | undefined> {
  const mrs = await gl.get<MergeRequest[]>(`/:project/repository/commits/${sha}/merge_requests`);
  return mrs.find((m) => m.state === 'merged');
}

async function approvers(iid: number): Promise<string[]> {
  const state = await gl.get<{ approved_by: { user: { username: string } }[] }>(
    `/:project/merge_requests/${iid}/approvals`,
  );
  return state.approved_by.map((a) => a.user.username);
}

const mode = process.argv[2];
const mr = await sourceMergeRequest();

if (mode === 'check') {
  const approvedBy = mr ? await approvers(mr.iid) : [];
  if (!mr || !approvedBy.length) {
    // direct pushes and unapproved merges don't get deployed automatically
    console.error(`commit ${sha.slice(0, 8)} has no approved MR; production must be released manually`);
    process.exit(1);
  }
  const tier = mr.labels.find((l) => l.startsWith('risk::'))?.slice('risk::'.length) ?? 'unknown';
  writeFileSync('release.env', `RELEASE_MR_IID=${mr.iid}\nRELEASE_APPROVED_BY=${approvedBy.join(',')}\nRELEASE_TIER=${tier}\n`);
  console.log(`!${mr.iid} (${tier} risk) approved by ${approvedBy.join(', ')}`);
} else if (mode === 'report') {
  if (!mr) process.exit(0);
  const config = loadConfig(env.AUTONOMY_CONFIG ?? '.autonomy.yml');
  const mrPath = `/:project/merge_requests/${mr.iid}`;

  // carbon for the whole change: every MR pipeline plus this release pipeline
  const mrPipelines = await gl.get<{ id: number }[]>(`${mrPath}/pipelines?per_page=50`);
  const pipelineIds = [...mrPipelines.map((p) => p.id), Number(required(env, 'CI_PIPELINE_ID'))];
  const fp = footprint(await finishedJobs(gl, pipelineIds), config.sustainability);

  const notes = await gl.get<Note[]>(`${mrPath}/notes?per_page=100&sort=desc`);
  const agentReview = notes.find(isReviewNote);
  const fixes = notes.filter(isPipelineFixNote).length;
  const approvedBy = (env.RELEASE_APPROVED_BY ?? '').split(',').filter(Boolean);
  const url = env.CI_ENVIRONMENT_URL ?? env.PRODUCTION_URL;

  const tag = `release-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${sha.slice(0, 8)}`;
  const evidence = [
    `## ${mr.title}`,
    `Shipped from !${mr.iid} by @${mr.author.username}.`,
    '| Check | Result |',
    '|---|---|',
    `| Approved by | ${approvedBy.map((u) => `@${u}`).join(', ') || 'nobody'} |`,
    `| Risk | ${env.RELEASE_TIER ?? 'unknown'} |`,
    `| Agent review | ${agentReview ? `yes, by @${agentReview.author.username}` : 'no review note found'} |`,
    `| Pipeline fixes by agents | ${fixes} |`,
    `| MR pipelines | ${mrPipelines.length} |`,
    `| Production smoke test | passed${url ? ` (${url})` : ''} |`,
    `| Carbon for this change | ${formatFootprint(fp)} |`,
    '',
    watchSection(),
    '',
    `Release pipeline: ${env.CI_PIPELINE_URL}`,
  ].join('\n');

  await gl.post('/:project/releases', { tag_name: tag, ref: sha, name: tag, description: evidence });
  writeFileSync(
    'sci-report.json',
    JSON.stringify({ mr: mr.iid, tag, functionalUnit: 'one merged change', coefficients: config.sustainability, ...fp }, null, 2),
  );

  console.log(`released ${tag}: ${formatFootprint(fp)}`);
} else {
  throw new Error('usage: release.ts check|report');
}

function watchSection(): string {
  let results: WatchResult[];
  let unreadable = false;
  try {
    const health = JSON.parse(readFileSync('health-report.json', 'utf8'));
    results = Array.isArray(health.results) ? health.results : [];
    if (health.planSource === 'unreadable') unreadable = true;
  } catch {
    // a missing or broken report must not stop the release notes
    return 'No production check results were found.';
  }
  if (!results.length) return 'No traffic was recorded, so nothing was checked.';
  const watched = results.filter((r) => r.source === 'review');
  return [
    unreadable ? "The review couldn't be read after the release, so only the default checks ran." : '',
    watched.length ? '**What the review asked us to watch, and what production did:**' : 'The review had no watch list; default checks only:',
    ...(watched.length ? watched : results).map(
      (r) => `- ${r.unconfirmed ? 'not measured' : r.ok ? 'ok' : 'over the limit'}: ${describe(r)}`,
    ),
  ]
    .filter(Boolean)
    .join('\n');
}
