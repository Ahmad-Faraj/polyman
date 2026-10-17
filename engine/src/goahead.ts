import type { AutonomyConfig } from './config.ts';

/**
 * Assisted (wiki: Assisted): an agent may push only after a person gave it the
 * go-ahead for that step. This decides it from what GitLab recorded, never from
 * what the agent wrote: who wrote each note and when, and the "added N commits"
 * notes GitLab posts when a push reaches the MR. Commit dates and commit
 * trailers are the agent's own words, so they prove nothing here.
 */

export interface Note {
  id: number;
  body: string;
  system: boolean;
  created_at: string;
  author: { username: string };
}

export interface Push {
  /** when the push reached the MR (the system note's time) */
  at: string;
  /** who pushed: the account the system note is by */
  pusher: string;
  /** short SHAs GitLab listed for this push */
  shas: string[];
}

export type Tier = 'low' | 'medium' | 'high';

export interface Step {
  /** the issue's or MR's author: the person who asked, whose go-ahead never counts */
  requester: string;
  /** the tier the assess job computed for the MR (never the label an agent set) */
  tier: Tier;
  /** rollbacks always need a maintainer */
  rollback: boolean;
}

/** Service accounts, bots and GitLab's own Duo user are never a person's go-ahead. */
export function isPerson(username: string): boolean {
  return !/^ai-|^service_account|_bot(_|$)|^GitLabDuo$|^duo-/i.test(username);
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The comment mentions this account and has a line that, apart from @mentions,
 * says exactly "go-ahead" (a trailing full stop is fine). "No go-ahead yet" is
 * not one.
 */
export function saysGoAhead(body: string, account: string): boolean {
  const mention = new RegExp(`(^|[^\\w.-])@${escape(account)}(?![\\w.-])`, 'i');
  if (!mention.test(body)) return false;
  return body.split('\n').some((line) => line.replace(/@[\w.-]+/g, ' ').trim().replace(/[.!]$/, '').toLowerCase() === 'go-ahead');
}

/** Pushes from GitLab's "added N commits" notes, oldest first. */
export function pushesFrom(notes: Note[]): Push[] {
  return notes
    .filter((n) => n.system && /^added \d+ (new )?commits?\b/i.test(n.body.trim()))
    .map((n) => ({ at: n.created_at, pusher: n.author.username, shas: [...n.body.matchAll(/<li>([0-9a-f]{7,40}) - /g)].map((m) => m[1]) }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Why this person's go-ahead doesn't count for this step, or null if it does. */
export function notAllowed(username: string, step: Step, config: AutonomyConfig): string | null {
  if (!isPerson(username)) return `@${username} is not a person`;
  if (username.toLowerCase() === step.requester.toLowerCase()) return `@${username} asked for this work, so someone else has to say go-ahead`;
  const need = step.rollback ? 'maintainers' : config.goAhead.byTier[step.tier];
  if (need === 'maintainers' && !config.goAhead.maintainers.some((m) => m.toLowerCase() === username.toLowerCase())) {
    const who = config.goAhead.maintainers.map((m) => `@${m}`).join(', ') || 'a maintainer (none set in go_ahead.maintainers)';
    return `@${username} is not a maintainer; ${step.rollback ? 'a rollback' : `${step.tier} risk`} needs ${who}`;
  }
  return null;
}

export type Verdict = { ok: true; note: Note } | { ok: false; reason: string };

/**
 * A push by an agent counts as allowed when, after that agent's latest note
 * before the push (its proposal), and before the push itself, a person the step
 * allows wrote a go-ahead that mentions the agent.
 */
export function goAheadFor(push: Pick<Push, 'at' | 'pusher'>, notes: Note[], step: Step, config: AutonomyConfig): Verdict {
  const before = notes.filter((n) => !n.system && n.created_at < push.at);
  const proposal = before
    .filter((n) => n.author.username.toLowerCase() === push.pusher.toLowerCase())
    .map((n) => n.created_at)
    .sort()
    .pop();
  const candidates = before.filter((n) => (!proposal || n.created_at > proposal) && saysGoAhead(n.body, push.pusher));
  const valid = candidates.filter((n) => !notAllowed(n.author.username, step, config));
  if (valid.length) return { ok: true, note: valid[valid.length - 1] };
  if (candidates.length) {
    return { ok: false, reason: candidates.map((n) => `go-ahead in note ${n.id} doesn't count: ${notAllowed(n.author.username, step, config)}`).join('; ') };
  }
  return {
    ok: false,
    reason: `no go-ahead mentioning @${push.pusher} ${proposal ? `between its proposal at ${proposal} and` : 'before'} the push at ${push.at}`,
  };
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
