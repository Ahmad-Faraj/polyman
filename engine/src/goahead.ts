import type { AutonomyConfig } from './config.ts';

/**
 * Assisted (wiki: Assisted): an agent may push only after a person gave it the
 * go-ahead for that step. This decides it from what GitLab recorded, never from
 * what the agent wrote: who wrote each note and when, and the "added N commits"
 * notes GitLab posts when a push reaches the MR. Commit dates and commit
 * trailers are the agent's own words, so they prove nothing here.
 *
 * One go-ahead covers one push: it has to come after the agent's latest note
 * (its proposal) and after its previous push.
 */

export interface Note {
  id: number;
  body: string;
  system: boolean;
  created_at: string;
  updated_at?: string;
  author: { username: string };
}

export interface Push {
  /** when the push reached the MR (the system note's time) */
  at: string;
  /** who pushed: the account the system note is by */
  pusher: string;
  /** what GitLab listed: single short SHAs, or "first...last" for a long push */
  shas: string[];
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

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * One line of the comment mentions this account and, apart from @mentions,
 * says exactly "go-ahead" (a trailing full stop is fine). "No go-ahead yet" is
 * not one, and neither is a go-ahead to another agent with this one mentioned
 * elsewhere in the comment.
 */
export function saysGoAhead(body: string, account: string): boolean {
  const mention = new RegExp(`(^|[^\\w.-])@${escape(account)}(?![\\w.-])`, 'i');
  return body
    .split('\n')
    .some((line) => mention.test(line) && line.replace(/@[\w.-]+/g, ' ').trim().replace(/[.!]$/, '').toLowerCase() === 'go-ahead');
}

/** Pushes from GitLab's "added N commits" notes, oldest first. */
export function pushesFrom(notes: Note[]): Push[] {
  return notes
    .filter((n) => n.system && /^added \d+ (new )?commits?\b/i.test(n.body.trim()))
    .map((n) => ({
      at: n.created_at,
      pusher: n.author.username,
      shas: [...n.body.matchAll(/<li>([0-9a-f]{7,40}(?:\.\.\.[0-9a-f]{7,40})?) - /g)].map((m) => m[1]),
    }))
    .sort((a, b) => time(a.at) - time(b.at));
}

/** Why this person's go-ahead doesn't count for this step, or null if it does. */
export function notAllowed(username: string, step: Step, config: AutonomyConfig): string | null {
  if (!isPerson(username)) return `@${username} is not a person`;
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

export type Verdict = { ok: true; note: Note } | { ok: false; reason: string };

/**
 * A push by an agent is allowed when a person the step allows wrote a go-ahead
 * that mentions the agent, after the agent's latest note before the push (its
 * proposal, counting edits made before the push), after the agent's previous
 * push, and before this push, and didn't edit it after the push.
 */
export function goAheadFor(
  push: Pick<Push, 'at' | 'pusher'>,
  notes: Note[],
  step: Step,
  config: AutonomyConfig,
  previousPush?: string,
): Verdict {
  const at = time(push.at);
  const touched = (n: Note) => (n.updated_at && time(n.updated_at) < at ? Math.max(time(n.created_at), time(n.updated_at)) : time(n.created_at));
  const own = notes.filter((n) => !n.system && time(n.created_at) < at && n.author.username.toLowerCase() === push.pusher.toLowerCase());
  if (!own.length) return { ok: false, reason: `@${push.pusher} wrote no proposal before the push at ${push.at}, so there was nothing to give a go-ahead to` };
  const proposal = Math.max(...own.map(touched));
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
  if (valid.length) return { ok: true, note: valid[valid.length - 1] };
  if (candidates.length) {
    return { ok: false, reason: candidates.map((n) => `go-ahead in note ${n.id} doesn't count: ${notAllowed(n.author.username, step, config)}`).join('; ') };
  }
  const since = floor === proposal ? `its proposal at ${new Date(proposal).toISOString()}` : `its previous push at ${previousPush}`;
  return { ok: false, reason: `no go-ahead mentioning @${push.pusher} between ${since} and the push at ${push.at}` };
}

/** Which agent account wrote a commit: the account whose name contains the commit's author name. */
export function accountFor(authorName: string, accounts: string[]): string | undefined {
  const slug = authorName.trim().toLowerCase().replace(/\s+/g, '-');
  return slug ? accounts.find((a) => a.toLowerCase().includes(slug)) : undefined;
}

/** The issue an MR says it closes ("Closes #12"), if any. */
export function linkedIssue(description: string | null | undefined): number | null {
  const m = (description ?? '').match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i);
  return m ? Number(m[1]) : null;
}

/** The assess job's tier; anything else is treated as high, so a missing tier needs a maintainer. */
export function tierFrom(value: string | undefined): Tier {
  return value === 'low' || value === 'medium' || value === 'high' ? value : 'high';
}
