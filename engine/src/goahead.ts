import type { AutonomyConfig } from './config.ts';

/**
 * Assisted (wiki: Assisted): an agent may push only after a person gave it the
 * go-ahead for that step. This decides it from what GitLab recorded, never from
 * what the agent wrote: who wrote each note and when, and who pushed what and
 * when in the project's push events. Commit emails, commit dates and commit
 * trailers are the agent's own words, so they prove nothing here.
 *
 * One go-ahead covers one push: it has to come after the agent's latest
 * proposal and after its previous push to the branch.
 */

export interface Note {
  id: number;
  body: string;
  system: boolean;
  created_at: string;
  updated_at?: string;
  author: { username: string };
}

export type Tier = 'low' | 'medium' | 'high';

export interface Step {
  /** the people who asked (the MR's and the issue's authors): their go-ahead never counts */
  requesters: string[];
  /** the tier the assess job computed for the MR (never the label an agent set) */
  tier: Tier;
  /** rollbacks always need a maintainer */
  rollback: boolean;
}

const time = (iso: string) => Date.parse(iso);

/** Service accounts, bots, GitLab's Duo users and deleted users are never a person's go-ahead. */
export function isPerson(username: string): boolean {
  return !/^ai-|^service_account|^duo-|^GitLabDuo$|^ghost$|(^|[-_])bot($|[-_])/i.test(username);
}

/**
 * A person on this project: one of go_ahead.people when that list is set
 * (anyone else, a new bot or a stranger on a public project, is not), and a
 * name that doesn't look like an agent otherwise.
 */
export function isProjectPerson(username: string, config: AutonomyConfig): boolean {
  const people = config.goAhead.people;
  if (people.length) return people.some((p) => p.toLowerCase() === username.toLowerCase());
  return isPerson(username);
}

/**
 * How each flow's proposal note starts. Other notes under an agent's account
 * aren't proposals: GitLab itself posts "✅ <flow> has started" under it when a
 * mention starts the flow, and counting that would cancel the go-ahead that
 * started it.
 */
const PROPOSALS = ['Proposal for #', 'Pipeline fix proposal for', 'Review of ', 'Rollback proposal for'];

export function isProposal(body: string): boolean {
  return PROPOSALS.some((p) => body.trimStart().startsWith(p));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One line of the comment mentions this account and, apart from @mentions,
 * says exactly "go-ahead" (a trailing full stop is fine). "No go-ahead yet" is
 * not one, and neither is a go-ahead to another agent with this one mentioned
 * elsewhere in the comment. Lines in code blocks, quotes and HTML comments
 * don't count: they show or cite a go-ahead, they don't give one.
 */
export function saysGoAhead(body: string, account: string): boolean {
  const mention = new RegExp(`(^|[^\\w.-])@${escape(account)}(?![\\w.-])`, 'i');
  // the open fence (``` or ~~~, three or more): only a line of the same
  // character, at least as many times, closes it
  let fence: string | null = null;
  // the previous line ended a block (blank, a fence, a heading, a rule), so an
  // indented line here starts code
  let boundary = true;
  let indented = false;
  let quoted = false;
  const text = body.replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/<(pre|details)\b[\s\S]*?(<\/\1>|$)/gi, '');
  for (const line of text.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      const close = line.match(/^ {0,3}(`+|~+)\s*$/)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      boundary = true;
      indented = false;
      continue;
    }
    if (marker) {
      fence = marker;
      quoted = false;
      continue;
    }
    const blank = !line.trim();
    // an indented code block (4 columns, a tab counting to the next multiple of
    // 4) starts after a block boundary and runs while lines stay indented
    indented = /^( {0,3}\t| {4})/.test(line) && (boundary || indented);
    // a quote runs on over the lines that follow it until a blank line
    quoted = /^\s*>/.test(line) || (quoted && !blank);
    boundary = blank || /^ {0,3}(#{1,6}(\s|$)|([-*_])( *\3){2,} *$)/.test(line);
    if (indented || quoted) continue;
    if (mention.test(line) && line.replace(/@[\w.-]+/g, ' ').trim().replace(/[.!]$/, '').toLowerCase() === 'go-ahead') return true;
  }
  return false;
}

/** A push as GitLab's project events record it: who pushed, when, and what it moved the branch from and to. */
export interface PushEvent {
  created_at: string;
  author: { username: string };
  push_data: { ref: string; ref_type: string; action: string; commit_from: string | null; commit_to: string | null };
}

export interface BranchPush {
  at: string;
  pusher: string;
  /** the branch head before the push (null when the push created the branch) */
  from: string | null;
  to: string;
}

/** Pushes that moved this branch forward, oldest first. */
export function branchPushes(events: PushEvent[], branch: string): BranchPush[] {
  return events
    .filter((e) => e.push_data?.ref_type === 'branch' && e.push_data.ref === branch && e.push_data.commit_to)
    .map((e) => ({ at: e.created_at, pusher: e.author.username, from: e.push_data.commit_from, to: e.push_data.commit_to! }))
    .sort((a, b) => time(a.at) - time(b.at));
}

/**
 * Which push brought each commit: the first push whose new head contains it and
 * whose old head didn't. A commit no push accounts for is returned separately.
 */
export function attribute(
  commits: string[],
  pushes: BranchPush[],
  isAncestor: (commit: string, of: string) => boolean,
): { by: Map<string, BranchPush>; unaccounted: string[] } {
  const by = new Map<string, BranchPush>();
  const unaccounted: string[] = [];
  for (const sha of commits) {
    const push = pushes.find((p) => isAncestor(sha, p.to) && !(p.from && isAncestor(sha, p.from)));
    if (push) by.set(sha, push);
    else unaccounted.push(sha);
  }
  return { by, unaccounted };
}

/** Why this person's go-ahead doesn't count for this step, or null if it does. */
export function notAllowed(username: string, step: Step, config: AutonomyConfig): string | null {
  if (!isProjectPerson(username, config)) return `@${username} is not one of the people who may give a go-ahead`;
  if (step.requesters.some((r) => r.toLowerCase() === username.toLowerCase())) {
    return `@${username} asked for this work, so someone else has to say go-ahead`;
  }
  const need = step.rollback ? 'maintainers' : config.goAhead.byTier[step.tier];
  if (need === 'maintainers' && !config.goAhead.maintainers.some((m) => m.toLowerCase() === username.toLowerCase())) {
    const who = config.goAhead.maintainers.map((m) => `@${m}`).join(', ') || 'a maintainer (none set in go_ahead.maintainers)';
    return `@${username} is not a maintainer; ${step.rollback ? 'a rollback' : `${step.tier} risk`} needs ${who}`;
  }
  return null;
}

/** The go-ahead that counts and the proposal it answers (the ledger records both), or why there is none. */
/**
 * Who may give the go-ahead for this step: what the tier asks for, and the
 * people on the list whose go-ahead would count (the rule above, applied to each).
 */
export function allowedApprovers(step: Step, config: AutonomyConfig): { from: 'anyone' | 'maintainers'; people: string[] } {
  return {
    from: step.rollback ? 'maintainers' : config.goAhead.byTier[step.tier],
    people: config.goAhead.people.filter((p) => !notAllowed(p, step, config)),
  };
}

export type Verdict = { ok: true; note: Note; proposal: Note } | { ok: false; reason: string; proposal?: Note };

/**
 * A push by an agent is allowed when a person the step allows wrote a go-ahead
 * that mentions the agent, after the agent's latest proposal before the push
 * (counting edits made before the push), after the agent's previous push to the
 * branch, and before this push, and didn't edit it after the push.
 */
export function goAheadFor(
  push: { at: string; pusher: string },
  notes: Note[],
  step: Step,
  config: AutonomyConfig,
  previousPush?: string,
): Verdict {
  const at = time(push.at);
  const touched = (n: Note) => (n.updated_at && time(n.updated_at) < at ? Math.max(time(n.created_at), time(n.updated_at)) : time(n.created_at));
  const own = notes.filter(
    (n) => !n.system && time(n.created_at) < at && n.author.username.toLowerCase() === push.pusher.toLowerCase() && isProposal(n.body),
  );
  if (!own.length) return { ok: false, reason: `@${push.pusher} wrote no proposal before the push at ${push.at}, so there was nothing to give a go-ahead to` };
  const proposal = Math.max(...own.map(touched));
  const latest = own.filter((n) => touched(n) === proposal).pop()!;
  const floor = Math.max(proposal, previousPush ? time(previousPush) : -Infinity);
  const candidates = notes.filter(
    (n) =>
      !n.system &&
      time(n.created_at) > floor &&
      time(n.created_at) < at &&
      time(n.updated_at ?? n.created_at) <= at &&
      saysGoAhead(n.body, push.pusher),
  );
  const valid = candidates.filter((n) => !notAllowed(n.author.username, step, config));
  if (valid.length) return { ok: true, note: valid[valid.length - 1], proposal: latest };
  if (candidates.length) {
    return {
      ok: false,
      reason: candidates.map((n) => `go-ahead in note ${n.id} doesn't count: ${notAllowed(n.author.username, step, config)}`).join('; '),
      proposal: latest,
    };
  }
  const since = floor === proposal ? `its proposal at ${new Date(proposal).toISOString()}` : `its previous push at ${previousPush}`;
  return { ok: false, reason: `no go-ahead mentioning @${push.pusher} between ${since} and the push at ${push.at}`, proposal: latest };
}

/** The assess job's tier; anything else is treated as high, so a missing tier needs a maintainer. */
export function tierFrom(value: string | undefined): Tier {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'high';
}
