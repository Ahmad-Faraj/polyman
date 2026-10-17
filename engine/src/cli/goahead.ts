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
import { matchesAny } from '../glob.ts';
import { GitLab, required } from '../gitlab.ts';
import { type Note, type PushEvent, type Step, attribute, branchPushes, goAheadFor, isProjectPerson, tierFrom } from '../goahead.ts';

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
  const isAncestor = (commit: string, of: string) => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', commit, of], { stdio: 'ignore' });
      return true;
    } catch (err) {
      // exit 1 means "no"; anything else (an unknown commit, say) is an error, not a no
      if ((err as { status?: number }).status === 1) return false;
      throw new Error(`git can't compare ${commit.slice(0, 8)} with ${of.slice(0, 8)} (is the history fetched?)`);
    }
  };
  const inRepo = (sha: string) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const commits = execFileSync('git', ['rev-list', `${base}..HEAD`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  const isPerson = (username: string) => isProjectPerson(username, config);

  const gl = new GitLab();
  const all = async <T>(path: string, pages = 20) => {
    const out: T[] = [];
    for (let page = 1; page <= pages; page++) {
      const batch = await gl.get<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) return out;
    }
    throw new Error(`more than ${pages * 100} records at ${path}; can't be sure every push was read`);
  };

  const mr = await gl.get<{ author: { username: string }; created_at: string; source_branch: string }>(`/:project/merge_requests/${iid}`);
  const notes = await all<Note>(`/:project/merge_requests/${iid}/notes?sort=asc&order_by=created_at`);
  // Pushes from two days before the oldest commit on the MR (or before the MR,
  // if that's earlier) on: no push to this branch can be older than what it
  // brought. Commit dates are the pusher's own word, but one set late can't
  // push the window past the MR's creation, and one set early only widens it.
  // `after` leaves out the day it names, hence two days.
  const oldest = Math.min(
    Date.parse(mr.created_at),
    ...commits.map((sha) => Number(execFileSync('git', ['show', '-s', '--format=%ct', sha], { encoding: 'utf8' }).trim()) * 1000),
  );
  const since = new Date(oldest - 2 * 86_400_000).toISOString().slice(0, 10);
  const events = await all<PushEvent>(`/:project/events?action=pushed&after=${since}&sort=asc`, 100);
  // A push whose head a later force-push threw away brought nothing that's still
  // here. A push whose old head is gone (a rebase or force-push) is read as if
  // it created the branch: it brought whatever earlier pushes didn't.
  const pushes = branchPushes(events, mr.source_branch)
    .filter((p) => inRepo(p.to))
    .map((p) => (p.from && !inRepo(p.from) ? { ...p, from: null } : p));
  const { by, unaccounted } = attribute(commits, pushes, isAncestor);

  const problems: string[] = [];
  for (const sha of unaccounted) problems.push(`commit ${sha.slice(0, 8)} is in no push GitLab recorded for ${mr.source_branch}, so who pushed it and on whose go-ahead can't be told`);

  const rollback = (account: string) => /incident-responder/i.test(account);
  // the issues GitLab says this MR closes, parsed from a description the agent may
  // write, so only an issue a person wrote shows someone asked
  const closes = await gl.get<{ iid: number; author: { username: string } }[]>(`/:project/merge_requests/${iid}/closes_issues`);
  // ...or, for a rollback, the incident the responder opened: its push still
  // needs a maintainer's go-ahead on that issue
  const asked = closes.filter((i) => isPerson(i.author.username) || (rollback(i.author.username) && rollback(mr.author.username)));
  const issue = asked[0]?.iid ?? null;
  // whoever asked: the MR's author if a person opened it, and the issues' authors
  const requesters = [...(isPerson(mr.author.username) ? [mr.author.username] : []), ...closes.map((i) => i.author.username)];
  // an agent's MR with no person's issue has nobody on record who asked, so anyone could approve their own idea
  if (!isPerson(mr.author.username) && !asked.length) {
    problems.push(
      `an agent (@${mr.author.username}) opened this MR and GitLab lists no issue it closes that a person wrote, so who asked for the work isn't on record; link the issue ("Closes #N")`,
    );
  }
  // the agent's previous push to this branch: an older go-ahead was used up by it
  // (the agent accounts are shared, so a push to another MR spends nothing here)
  const allBranchPushes = branchPushes(events, mr.source_branch);
  const previousPush = (pusher: string, at: string) =>
    allBranchPushes
      .filter((p) => p.pusher.toLowerCase() === pusher.toLowerCase() && Date.parse(p.at) < Date.parse(at))
      .map((p) => p.at)
      .pop();

  // the agent pushes that brought commits, and every agent push since the MR
  // opened even if it brought none: a rewind or a force-push back is a step too
  const agentPushes = [...new Set([...by.values(), ...pushes.filter((p) => Date.parse(p.at) >= Date.parse(mr.created_at))])]
    .filter((p) => !isPerson(p.pusher))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // Agents may not change the pipeline, the policy or the engine. autonomy:guard
  // checks this by commit email, which an agent can set; this checks it by who
  // pushed. Only the incident responder may add to the incidents file.
  for (const [sha, p] of by) {
    if (isPerson(p.pusher)) continue;
    // a merge commit's diff hides what it brings in, so agents push none
    const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', sha], { encoding: 'utf8' }).trim().split(' ').length - 1;
    if (parents > 1) {
      problems.push(`commit ${sha.slice(0, 8)} pushed by @${p.pusher} is a merge commit; agents may not push merges (a person merges the default branch in)`);
      continue;
    }
    // -z: paths come out as they are, not quoted (a quoted "engine/\303\251.ts" wouldn't match engine/**)
    const files = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-z', sha], { encoding: 'utf8' }).split('\0').filter(Boolean);
    const touched = files.filter((f) => matchesAny(f, config.governance) && !(f === config.incidentsFile && rollback(p.pusher)));
    if (touched.length) problems.push(`commit ${sha.slice(0, 8)} pushed by @${p.pusher} changes files only people may change: ${touched.join(', ')}`);
  }
  let issueNotes: Note[] | null = null;
  for (const push of agentPushes) {
    const shas = [...by].filter(([, p]) => p === push).map(([sha]) => sha.slice(0, 8)).join(', ') || `no new commits, head ${push.to.slice(0, 8)}`;
    const step: Step = { requesters, tier, rollback: rollback(push.pusher) };
    const beforeMr = Date.parse(push.at) < Date.parse(mr.created_at);
    if (beforeMr && !issue) {
      problems.push(`push at ${push.at} by @${push.pusher} (${shas}) came before the MR, and GitLab lists no issue this MR closes, written by a person, to hold its go-ahead`);
      continue;
    }
    if (beforeMr) issueNotes ??= await all<Note>(`/:project/issues/${issue}/notes?sort=asc&order_by=created_at`);
    const where = beforeMr ? issueNotes! : notes;
    const verdict = goAheadFor(push, where, step, config, previousPush(push.pusher, push.at));
    const place = beforeMr ? ` on #${issue}` : '';
    if (verdict.ok) console.log(`push at ${push.at} by @${push.pusher} (${shas}): go-ahead in note ${verdict.note.id}${place} by @${verdict.note.author.username}`);
    else problems.push(`push at ${push.at} by @${push.pusher} (${shas})${place}: ${verdict.reason}`);
  }

  if (!problems.length) {
    console.log(`${commits.length} commit(s) in ${new Set(by.values()).size} push(es), ${agentPushes.length} by agents, risk ${tier}: each agent push had its own go-ahead`);
    return;
  }
  for (const p of problems) console.error(p);
  console.error(
    `Assisted: an agent acts only on a person's go-ahead (a line that mentions it and says "go-ahead"), one per push, from someone who didn't ask for the work${tier === 'high' ? `, and for ${tier} risk only from ${config.goAhead.maintainers.map((m) => `@${m}`).join(', ') || 'a maintainer'}` : ''}.`,
  );
  process.exit(1);
}
