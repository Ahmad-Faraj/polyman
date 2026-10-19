/**
 * Fails the MR pipeline if an agent pushed a step nobody gave it the go-ahead
 * for (Assisted, wiki: Assisted).
 *
 * Who pushed which commit comes from the project's push events, which GitLab
 * writes: never from commit emails, dates or trailers, which the agent writes.
 * Every push an agent account made to this MR's branch must come after a
 * go-ahead from a person the risk tier allows: never someone who asked for the
 * work (the MR's or the issue's author), never an agent or GitLabDuo, and only
 * a maintainer for high risk and rollbacks. One go-ahead covers one push: it
 * has to be newer than the agent's latest proposal and than its previous push
 * to the branch. A push that brings no new commits (a rewind, a force-push back)
 * needs one too. A push made before the MR existed (an issue-builder branch)
 * needs that go-ahead on the issue the MR closes. A commit no push accounts
 * for fails the job.
 *
 * CI runs this file from the target branch, not from the MR, so an MR can't
 * change the check it is checked by.
 *
 * Runs after autonomy:assess, whose AUTONOMY_TIER it reads; without one it
 * assumes high risk.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { GitLab, required } from '../gitlab.ts';
import { type Note, type PushEvent, tierFrom } from '../goahead.ts';
import { allPages, checkMr, eventsSince, gitRepo, notesOf, relatedIncident } from '../goahead-mr.ts';

const env = process.env;

try {
  await main();
} catch (err) {
  console.error(`autonomy:goahead could not finish, so it fails: ${(err as Error).message}`);
  process.exit(1);
}

async function main() {
  const iid = required(env, 'CI_MERGE_REQUEST_IID');
  // agents are members of this project only, so they can't push to a fork
  if (env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID && env.CI_MERGE_REQUEST_SOURCE_PROJECT_ID !== env.CI_MERGE_REQUEST_PROJECT_ID) {
    console.log('this MR comes from a fork, where no agent of this project can push: nothing needs a go-ahead');
    return;
  }
  const base = env.CI_MERGE_REQUEST_DIFF_BASE_SHA || `origin/${env.CI_DEFAULT_BRANCH ?? 'main'}`;
  // the policy is the target branch's as it is now (CI fetches its head), not as
  // it was when the MR branched off
  const policyRef = env.AUTONOMY_POLICY_REF || base;
  // The policy (who counts as a person, who may give a go-ahead, the protected
  // paths) comes from the target branch, never from this MR: an MR could add
  // its own author to the people list.
  const file = env.AUTONOMY_CONFIG ?? '.autonomy.yml';
  let policy: string | null = null;
  try {
    policy = execFileSync('git', ['show', `${policyRef}:${file}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    // no policy on the target branch: without a people list a guard can't tell
    // a person from an agent, so it fails rather than guess by name
  }
  if (policy === null) {
    throw new Error(`the target branch has no ${file}, so nobody is listed in go_ahead.people`);
  }
  const configPath = join(mkdtempSync(join(tmpdir(), 'goahead-')), '.autonomy.yml');
  writeFileSync(configPath, policy);
  const config = loadConfig(configPath);
  if (!config.goAhead.people.length) {
    throw new Error(`the target branch's ${file} lists no go_ahead.people, so nobody can give a go-ahead`);
  }
  const tier = tierFrom(env.AUTONOMY_TIER);
  const repo = gitRepo();
  const commits = execFileSync('git', ['rev-list', `${base}..HEAD`], { encoding: 'utf8' }).split('\n').filter(Boolean);

  const gl = new GitLab();
  const mr = await gl.get<{ author: { username: string }; created_at: string; source_branch: string; description?: string | null }>(`/:project/merge_requests/${iid}`);
  const notes = await allPages<Note>(gl, `/:project/merge_requests/${iid}/notes?sort=asc&order_by=created_at`);
  // Pushes from two days before the MR's base commit on. That date comes from
  // the target branch, so unlike the MR's own commit dates no pusher sets it. A
  // push older than the window shows up as a commit in no recorded push, and
  // the job fails.
  const baseTime = Number(execFileSync('git', ['show', '-s', '--format=%ct', base], { encoding: 'utf8' }).trim()) * 1000;
  if (!Number.isFinite(baseTime) || baseTime <= 0) throw new Error(`can't read the date of the base commit ${base}`);
  const since = eventsSince(mr.created_at, baseTime);
  const events = await allPages<PushEvent>(gl, `/:project/events?action=pushed&after=${since}&sort=asc`, 100);
  const closes = await gl.get<{ iid: number; author: { username: string } }[]>(`/:project/merge_requests/${iid}/closes_issues`);

  const related = closes.length ? [] : await relatedIncident(gl, mr.description);
  const check = await checkMr({ mr, notes, closes, related, events, commits, since, tier }, config, repo, (issue) => notesOf(gl, 'issue', issue));
  for (const c of check.agentPushes) if (c.verdict.ok) console.log(c.line);

  if (!check.problems.length) {
    console.log(`${commits.length} commit(s) in ${check.pushes} push(es), ${check.agentPushes.length} by agents, risk ${tier}: each agent push had its own go-ahead`);
    return;
  }
  for (const p of check.problems) console.error(p.text);
  console.error(
    `Assisted: an agent acts only on a person's go-ahead (a line that mentions it and says "go-ahead"), one per push, from someone who didn't ask for the work${tier === 'high' ? `, and for ${tier} risk only from ${config.goAhead.maintainers.map((m) => `@${m}`).join(', ') || 'a maintainer'}` : ''}.`,
  );
  const maintainers = config.goAhead.maintainers.map((m) => `@${m}`).join(', ');
  console.error(
    `Next: a go-ahead can't be given after the push. ${maintainers ? `One of ${maintainers}` : 'A maintainer'} moves the commits that had one, unchanged, to a new MR and closes this one; for anything still missing, the agent proposes again there and waits for a new go-ahead.`,
  );
  process.exit(1);
}
