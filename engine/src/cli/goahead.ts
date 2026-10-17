/**
 * Fails the MR pipeline if an agent pushed a step nobody gave it the go-ahead
 * for (Assisted, wiki: Assisted). Every push an agent account made to this MR
 * must come after a go-ahead from a person the risk tier allows: never someone
 * who asked for the work (the MR's or the issue's author), never an agent or
 * GitLabDuo, and only a maintainer for high risk and rollbacks. One go-ahead
 * covers one push. Commits that were already there when an agent opened the MR
 * need the go-ahead on the issue the MR closes, from the agent that wrote them.
 *
 * Runs after autonomy:assess, whose AUTONOMY_TIER it reads; without one it
 * assumes high risk.
 */
import { execFileSync } from 'node:child_process';
import { isAgentEmail, parseGitLog } from '../agents.ts';
import { loadConfig } from '../config.ts';
import { GitLab, required } from '../gitlab.ts';
import { type Note, type Push, type Step, accountFor, goAheadFor, isPerson, linkedIssue, pushesFrom, tierFrom } from '../goahead.ts';

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
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const isAncestor = (a: string, b: string) => {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', a, b], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };

  const commits = parseGitLog(git('log', '--format=%x00%H%x09%an%x09%ae', '--no-renames', `${base}..HEAD`));
  const gl = new GitLab();
  const allNotes = async (path: string) => {
    const out: Note[] = [];
    for (let page = 1; ; page++) {
      const batch = await gl.get<Note[]>(`${path}?per_page=100&sort=asc&order_by=created_at&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) return out;
    }
  };

  const mr = await gl.get<{ author: { username: string }; created_at: string; description: string | null }>(`/:project/merge_requests/${iid}`);
  const notes = await allNotes(`/:project/merge_requests/${iid}/notes`);
  const pushes = pushesFrom(notes);
  const agentPushes = pushes.filter((p) => !isPerson(p.pusher));
  if (!agentPushes.length && !commits.some((c) => isAgentEmail(c.authorEmail))) {
    console.log('no agent pushes or agent commits on this MR: nothing needs a go-ahead');
    return;
  }

  const issue = linkedIssue(mr.description);
  const issueData = issue ? await gl.get<{ author: { username: string } }>(`/:project/issues/${issue}`) : null;
  // whoever asked: the MR's author if a person opened it, and the issue's author
  const requesters = [...(isPerson(mr.author.username) ? [mr.author.username] : []), ...(issueData ? [issueData.author.username] : [])];
  const rollback = (account: string) => /incident-responder/i.test(account);

  // the full SHAs each push brought, a long push being listed as "first...last"
  const fullShas = (p: Push) =>
    p.shas.flatMap((s) => {
      const [first, last] = s.split('...');
      if (!last) return commits.filter((c) => c.sha.startsWith(first)).map((c) => c.sha);
      return commits.filter((c) => isAncestor(c.sha, last) && (c.sha.startsWith(first) || !isAncestor(c.sha, first))).map((c) => c.sha);
    });
  const pushedIn = new Map<string, Push>();
  for (const p of pushes) for (const sha of fullShas(p)) if (!pushedIn.has(sha)) pushedIn.set(sha, p);

  const problems: string[] = [];
  let checked = 0;

  // every push by an agent account, whatever email its commits carry
  agentPushes.forEach((push, i) => {
    const previous = agentPushes
      .slice(0, i)
      .filter((p) => p.pusher.toLowerCase() === push.pusher.toLowerCase())
      .pop()?.at;
    const step: Step = { requesters, tier, rollback: rollback(push.pusher) };
    const verdict = goAheadFor(push, notes, step, config, previous);
    checked++;
    if (verdict.ok) console.log(`push at ${push.at} by @${push.pusher}: go-ahead in note ${verdict.note.id} by @${verdict.note.author.username}`);
    else problems.push(`push at ${push.at} by @${push.pusher} (${push.shas.join(', ')}): ${verdict.reason}`);
  });

  // agent commits GitLab didn't list in any push note
  const unlisted = commits.filter((c) => isAgentEmail(c.authorEmail) && !pushedIn.has(c.sha));
  const listed = [...pushedIn.keys()];
  // were they on the branch before every recorded push (so when the MR opened), or pushed at a time we can't see?
  const late = unlisted.filter((c) => listed.some((sha) => sha !== c.sha && isAncestor(sha, c.sha)));
  for (const c of late) problems.push(`agent commit ${c.sha.slice(0, 8)} came after a recorded push, but no push note lists it, so when it was pushed and on whose go-ahead can't be told`);
  const initial = unlisted.filter((c) => !late.includes(c));

  if (initial.length) {
    const shas = initial.map((c) => c.sha.slice(0, 8)).join(', ');
    if (!issue || !issueData) {
      problems.push(`agent commits ${shas} were there when the MR opened, and the MR closes no issue to hold their go-ahead`);
    } else {
      const issueNotes = await allNotes(`/:project/issues/${issue}/notes`);
      const agents = [...new Set(issueNotes.filter((n) => !n.system && !isPerson(n.author.username)).map((n) => n.author.username))];
      for (const author of [...new Set(initial.map((c) => c.authorName))]) {
        const mine = initial.filter((c) => c.authorName === author).map((c) => c.sha.slice(0, 8)).join(', ');
        const agent = accountFor(author, agents);
        checked++;
        if (!agent) {
          problems.push(`commits ${mine} by "${author}": no agent account on #${issue} matches that author, so no go-ahead there can be for them`);
          continue;
        }
        const verdict = goAheadFor({ at: mr.created_at, pusher: agent }, issueNotes, { requesters, tier, rollback: rollback(agent) }, config);
        if (verdict.ok) console.log(`commits ${mine} (MR opened ${mr.created_at}): go-ahead in note ${verdict.note.id} on #${issue} by @${verdict.note.author.username}`);
        else problems.push(`commits ${mine} (MR opened ${mr.created_at}): ${verdict.reason}`);
      }
    }
  }

  if (!problems.length) {
    console.log(`${checked} agent step(s) on this MR, risk ${tier}: each had its own go-ahead`);
    return;
  }
  for (const p of problems) console.error(p);
  console.error(
    `Assisted: an agent acts only on a person's go-ahead (a line that mentions it and says "go-ahead"), one per push, from someone who didn't ask for the work${tier === 'high' ? `, and for ${tier} risk only from ${config.goAhead.maintainers.map((m) => `@${m}`).join(', ') || 'a maintainer'}` : ''}.`,
  );
  process.exit(1);
}
