import type { AutonomyConfig } from './config.ts';
import { type BranchPush, type Note, type PushEvent, type Step, type Tier, attribute, branchPushes, goAheadFor, isProjectPerson } from './goahead.ts';
import { type PushCheck, type Repo, agentCommitProblems, isRollback } from './goahead-mr.ts';

/**
 * The go-ahead guard for a branch with no open MR (#64). autonomy:goahead
 * judges agent pushes in MR pipelines, but a push to a branch no MR covers
 * gets only a branch pipeline: on Oct 18 a review agent re-created the branch
 * of an MR a person had just merged, with a commit nobody approved, and
 * nothing judged it. This judges such pushes there, by the same rules
 * (goAheadFor): with no MR, the go-ahead has to be on the issue the branch is
 * named after, as for an issue-builder branch before its MR exists.
 */

/** An MR from the judged branch, in this project, in any state. */
export interface BranchMr {
  iid: number;
  state: string;
  created_at: string;
  merged_at?: string | null;
  closed_at?: string | null;
}

export interface BranchFacts {
  branch: string;
  events: PushEvent[];
  /** the branch's commits that aren't on the default branch */
  commits: string[];
  mrs: BranchMr[];
  /** the issue the branch name points at (issueOfBranch), as GitLab has it, or null */
  issue: { iid: number; author: { username: string } } | null;
  /** the day push events are read from, for the messages */
  since: string;
  tier: Tier;
}

export interface BranchCheck {
  /** an open MR from this branch: its pipeline judges every push, so this judged none */
  openMr: number | null;
  agentPushes: PushCheck[];
  /** agent pushes an MR's own guard judged */
  covered: { push: BranchPush; mr: number }[];
  problems: { text: string; push?: BranchPush }[];
}

/**
 * The issue a branch is named after: "<iid>-...", as GitLab names a branch made
 * from an issue, and as issue-builder names its own. The agent picks the name,
 * but it only says where to look: the go-ahead still has to be on that issue,
 * after the agent's proposal there, from someone the rules allow.
 */
export function issueOfBranch(branch: string): number | null {
  const iid = /^([1-9]\d*)-/.exec(branch)?.[1];
  return iid ? Number(iid) : null;
}

const isOpen = (mr: BranchMr) => mr.state !== 'merged' && mr.state !== 'closed';

/**
 * The MR whose guard judged this push: one from the branch that was still
 * open when the push came, or opened after it (its guard judges a push from
 * before it on the issue it closes). Once it ended, only a merged MR counts:
 * it merged with that guard passing, while a closed one may have been closed
 * with the guard failing on this very push. A merged MR with no merge time on
 * record covers only the pushes before it opened.
 */
export function coveringMr(push: BranchPush, mrs: BranchMr[]): BranchMr | undefined {
  const at = Date.parse(push.at);
  return mrs.find((mr) => {
    if (isOpen(mr)) return true;
    if (mr.state !== 'merged') return false;
    return Date.parse(mr.merged_at ?? mr.created_at) > at;
  });
}

export async function checkBranch(
  facts: BranchFacts,
  config: AutonomyConfig,
  repo: Repo,
  issueNotesOf: (iid: number) => Promise<Note[]>,
): Promise<BranchCheck> {
  const { branch, events, commits, mrs, issue, since, tier } = facts;
  const open = mrs.find(isOpen);
  if (open) return { openMr: open.iid, agentPushes: [], covered: [], problems: [] };

  const isPerson = (username: string) => isProjectPerson(username, config);
  const all = branchPushes(events, branch);
  // as in checkMr: a head a later force-push threw away brought nothing still
  // here, and a push whose old head is gone is read as creating the branch
  const pushes = all.filter((p) => repo.has(p.to)).map((p) => (p.from && !repo.has(p.from) ? { ...p, from: null } : p));
  const { by, unaccounted } = attribute(commits, pushes, (c, of) => repo.isAncestor(c, of));

  const problems: BranchCheck['problems'] = [];
  for (const sha of unaccounted) problems.push({ text: `commit ${sha.slice(0, 8)} is in no push GitLab recorded for ${branch}, so who pushed it and on whose go-ahead can't be told (pushes are read from ${since} on)` });

  // the agent pushes that brought the branch's commits, and every agent push
  // since the branch was last created even if it brought none (a rewind is a step too)
  const created = all.filter((p) => p.from === null).pop()?.at;
  const candidates = [...new Set([...by.values(), ...pushes.filter((p) => !created || Date.parse(p.at) >= Date.parse(created))])]
    .filter((p) => !isPerson(p.pusher))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const covered: BranchCheck['covered'] = [];
  const judged: BranchPush[] = [];
  for (const push of candidates) {
    const mr = coveringMr(push, mrs);
    if (mr) covered.push({ push, mr: mr.iid });
    else judged.push(push);
  }

  const mine = new Map([...by].filter(([, p]) => judged.includes(p)));
  problems.push(...agentCommitProblems(mine, config, repo));

  // the agent's previous push to any branch named after the same issue: the
  // go-ahead is on the issue, so a push to 24-a uses it up for 24-b too
  const iid = issueOfBranch(branch);
  const refs = new Set(events.map((e) => e.push_data?.ref).filter((ref): ref is string => typeof ref === 'string'));
  const issuePushes = [...refs]
    .filter((ref) => ref === branch || (iid !== null && issueOfBranch(ref) === iid))
    .flatMap((ref) => branchPushes(events, ref))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const previousPush = (pusher: string, at: string) =>
    issuePushes
      .filter((p) => p.pusher.toLowerCase() === pusher.toLowerCase() && Date.parse(p.at) < Date.parse(at))
      .map((p) => p.at)
      .pop();

  let issueNotes: Note[] | null = null;
  const checks: PushCheck[] = [];
  for (const push of judged) {
    const brought = [...mine].filter(([, p]) => p === push).map(([sha]) => sha);
    const shas = brought.map((sha) => sha.slice(0, 8)).join(', ') || `no new commits, head ${push.to.slice(0, 8)}`;
    const rollback = isRollback(push.pusher);
    // as in checkMr: a person's issue shows someone asked; an incident only counts for the responder's own push
    const asked = issue && (isPerson(issue.author.username) || (rollback && isRollback(issue.author.username))) ? issue : null;
    const step: Step = { requesters: asked ? [asked.author.username] : [], tier, rollback };
    if (!asked) {
      const reason = `went to ${branch}, which has no MR, and the branch names no issue written by a person to hold its go-ahead`;
      const line = `push at ${push.at} by @${push.pusher} (${shas}) ${reason}`;
      checks.push({ push, commits: brought, step, issue: null, verdict: { ok: false, reason }, line });
      problems.push({ text: line, push });
      continue;
    }
    issueNotes ??= await issueNotesOf(asked.iid);
    const verdict = goAheadFor(push, issueNotes, step, config, previousPush(push.pusher, push.at));
    const line = verdict.ok
      ? `push at ${push.at} by @${push.pusher} (${shas}): go-ahead in note ${verdict.note.id} on #${asked.iid} by @${verdict.note.author.username}`
      : `push at ${push.at} by @${push.pusher} (${shas}) on #${asked.iid}: ${verdict.reason}`;
    checks.push({ push, commits: brought, step, issue: asked.iid, verdict, line });
    if (!verdict.ok) problems.push({ text: line, push });
  }
  return { openMr: null, agentPushes: checks, covered, problems };
}
