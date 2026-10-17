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
 * anywhere in the project. A push made before the MR existed (an issue-builder
 * branch) needs that go-ahead on the issue the MR closes. A commit no push
 * accounts for fails the job.
 *
 * Runs after autonomy:assess, whose AUTONOMY_TIER it reads; without one it
 * assumes high risk.
 */
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../config.ts';
import { matchesAny } from '../glob.ts';
import { GitLab, required } from '../gitlab.ts';
import { type Note, type PushEvent, type Step, attribute, branchPushes, goAheadFor, isPerson, linkedIssue, tierFrom } from '../goahead.ts';

const env = process.env;

try {
  await main();
} catch (err) {
  console.error(`autonomy:goahead could not finish, so it fails: ${(err as Error).message}`);
  process.exit(1);
}

async function main() {
  const config = loadConfig(env.AUTONOMY_CONFIG ?? '.autonomy.yml');
  const iid = required(env, 'CI_MERGE_REQUEST_IID');
  const base = env.CI_MERGE_REQUEST_DIFF_BASE_SHA || `origin/${env.CI_DEFAULT_BRANCH ?? 'main'}`;
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
  const commits = execFileSync('git', ['rev-list', `${base}..HEAD`], { encoding: 'utf8' }).split('\n').filter(Boolean);
  if (!commits.length) {
    console.log('no commits on this MR: nothing needs a go-ahead');
    return;
  }

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

  const mr = await gl.get<{ author: { username: string }; created_at: string; description: string | null; source_branch: string }>(`/:project/merge_requests/${iid}`);
  const notes = await all<Note>(`/:project/merge_requests/${iid}/notes?sort=asc&order_by=created_at`);
  // pushes from two weeks before the MR on: enough for its branch, and for each agent's previous push
  const since = new Date(Date.parse(mr.created_at) - 14 * 86_400_000).toISOString().slice(0, 10);
  const events = await all<PushEvent>(`/:project/events?action=pushed&after=${since}&sort=asc`);
  const pushes = branchPushes(events, mr.source_branch);
  const { by, unaccounted } = attribute(commits, pushes, isAncestor);

  const problems: string[] = [];
  for (const sha of unaccounted) problems.push(`commit ${sha.slice(0, 8)} is in no push GitLab recorded for ${mr.source_branch}, so who pushed it and on whose go-ahead can't be told`);

  const issue = linkedIssue(mr.description);
  const issueData = issue ? await gl.get<{ author: { username: string } }>(`/:project/issues/${issue}`) : null;
  // whoever asked: the MR's author if a person opened it, and the issue's author
  const requesters = [...(isPerson(mr.author.username) ? [mr.author.username] : []), ...(issueData ? [issueData.author.username] : [])];
  const rollback = (account: string) => /incident-responder/i.test(account);
  // the agent's previous push anywhere in the project: an older go-ahead was used up by it
  const previousPush = (pusher: string, at: string) =>
    events
      .filter((e) => e.author.username.toLowerCase() === pusher.toLowerCase() && Date.parse(e.created_at) < Date.parse(at))
      .map((e) => e.created_at)
      .sort((a, b) => Date.parse(a) - Date.parse(b))
      .pop();

  const agentPushes = [...new Set(by.values())].filter((p) => !isPerson(p.pusher));

  // Agents may not change the pipeline, the policy or the engine. autonomy:guard
  // checks this by commit email, which an agent can set; this checks it by who
  // pushed. Only the incident responder may add to the incidents file.
  for (const [sha, p] of by) {
    if (isPerson(p.pusher)) continue;
    const files = execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha], { encoding: 'utf8' }).split('\n').filter(Boolean);
    const touched = files.filter((f) => matchesAny(f, config.governance) && !(f === config.incidentsFile && rollback(p.pusher)));
    if (touched.length) problems.push(`commit ${sha.slice(0, 8)} pushed by @${p.pusher} changes files only people may change: ${touched.join(', ')}`);
  }
  let issueNotes: Note[] | null = null;
  for (const push of agentPushes) {
    const shas = [...by].filter(([, p]) => p === push).map(([sha]) => sha.slice(0, 8)).join(', ');
    const step: Step = { requesters, tier, rollback: rollback(push.pusher) };
    const beforeMr = Date.parse(push.at) < Date.parse(mr.created_at);
    if (beforeMr && !issue) {
      problems.push(`push at ${push.at} by @${push.pusher} (${shas}) came before the MR, which closes no issue to hold its go-ahead`);
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
