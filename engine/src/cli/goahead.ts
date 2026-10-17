/**
 * Fails the MR pipeline if an agent pushed a step nobody gave it the go-ahead
 * for (Assisted, wiki: Assisted). Every push an agent made to this MR must come
 * after a go-ahead from a person the risk tier allows: never the requester,
 * never an agent or GitLabDuo, and only a maintainer for high risk and
 * rollbacks. Commits that were already there when an agent opened the MR need
 * the go-ahead on the issue the MR closes.
 *
 * Runs after autonomy:assess, whose AUTONOMY_TIER it reads; without one it
 * assumes high risk.
 */
import { execFileSync } from 'node:child_process';
import { isAgentEmail, parseGitLog } from '../agents.ts';
import { loadConfig } from '../config.ts';
import { GitLab, required } from '../gitlab.ts';
import { type Note, type Step, goAheadFor, isPerson, linkedIssue, pushesFrom, tierFrom } from '../goahead.ts';

const env = process.env;
const config = loadConfig(env.AUTONOMY_CONFIG ?? '.autonomy.yml');
const iid = required(env, 'CI_MERGE_REQUEST_IID');
const base = env.CI_MERGE_REQUEST_DIFF_BASE_SHA || `origin/${env.CI_DEFAULT_BRANCH ?? 'main'}`;
const tier = tierFrom(env.AUTONOMY_TIER);

const log = execFileSync('git', ['log', '--format=%x00%H%x09%an%x09%ae', '--no-renames', `${base}..HEAD`], { encoding: 'utf8' });
const agentCommits = parseGitLog(log).filter((c) => isAgentEmail(c.authorEmail));
if (!agentCommits.length) {
  console.log('no agent commits on this MR: nothing needs a go-ahead');
  process.exit(0);
}

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
const pushOf = (sha: string) => pushes.find((p) => p.shas.some((s) => sha.startsWith(s)));
const rollback = (account: string) => /incident-responder/i.test(account);

const problems: string[] = [];
let checked = 0;

// Pushes GitLab recorded on the MR, made by an agent account.
for (const push of pushes.filter((p) => !isPerson(p.pusher) && p.shas.some((s) => agentCommits.some((c) => c.sha.startsWith(s))))) {
  const step: Step = { requester: mr.author.username, tier, rollback: rollback(push.pusher) };
  const verdict = goAheadFor(push, notes, step, config);
  checked++;
  if (verdict.ok) console.log(`push at ${push.at} by @${push.pusher}: go-ahead in note ${verdict.note.id} by @${verdict.note.author.username}`);
  else problems.push(`push at ${push.at} by @${push.pusher} (${push.shas.join(', ')}): ${verdict.reason}`);
}

// Agent commits that were on the branch when the MR was opened (issue-builder):
// the go-ahead belongs on the issue the MR closes, before the MR existed.
const initial = agentCommits.filter((c) => !pushOf(c.sha));
if (initial.length) {
  const issue = linkedIssue(mr.description);
  const shas = initial.map((c) => c.sha.slice(0, 8)).join(', ');
  if (!issue) {
    problems.push(`agent commits ${shas} were there when the MR opened, and the MR closes no issue to hold their go-ahead`);
  } else {
    const issueData = await gl.get<{ author: { username: string } }>(`/:project/issues/${issue}`);
    const issueNotes = await allNotes(`/:project/issues/${issue}/notes`);
    const agents = [...new Set(issueNotes.filter((n) => !n.system && !isPerson(n.author.username) && n.created_at < mr.created_at).map((n) => n.author.username))];
    const verdicts = agents.map((a) =>
      goAheadFor({ at: mr.created_at, pusher: a }, issueNotes, { requester: issueData.author.username, tier, rollback: rollback(a) }, config),
    );
    const ok = verdicts.find((v) => v.ok);
    checked++;
    if (ok?.ok) console.log(`commits ${shas} (MR opened ${mr.created_at}): go-ahead in note ${ok.note.id} on #${issue} by @${ok.note.author.username}`);
    else problems.push(`commits ${shas} (MR opened ${mr.created_at}): ${verdicts.map((v) => (v.ok ? '' : v.reason)).join('; ') || `no agent proposed anything on #${issue} before the MR opened`}`);
  }
}

if (!problems.length) {
  console.log(`${agentCommits.length} agent commits in ${checked} step(s), risk ${tier}: each had a go-ahead`);
} else {
  for (const p of problems) console.error(p);
  console.error(
    `Assisted: an agent acts only on a person's go-ahead (a comment that mentions it with a line "go-ahead"), from someone other than the requester${tier === 'high' ? `, and for ${tier} risk only from ${config.goAhead.maintainers.map((m) => `@${m}`).join(', ') || 'a maintainer'}` : ''}.`,
  );
  process.exit(1);
}
