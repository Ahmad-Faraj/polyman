import { createHash } from 'node:crypto';
import type { AutonomyConfig } from './config.ts';
import { type Note, type Tier, allowedApprovers } from './goahead.ts';
import type { MrCheck, PushCheck } from './goahead-mr.ts';

/**
 * The go-ahead ledger (#46): one record per agent push the go-ahead guard
 * judged on a merged MR, rebuilt from GitLab by running the guard's own check
 * again (goahead-mr.ts). Each record carries the SHA-256 of the record before
 * it, so a published ledger can be rebuilt and compared: if a note, a push or
 * a policy behind any record changed, the rebuilt chain differs from the
 * published one and CI fails.
 */

export const GENESIS = '0'.repeat(64);

export interface NoteRef {
  note: number;
  url: string;
  by: string;
  at: string;
}

export interface LedgerRecord {
  seq: number;
  mr: number;
  mr_url: string;
  merged_at: string;
  /** the issues GitLab says the MR closes */
  closes: number[];
  branch: string;
  agent: string;
  flow: string;
  pushed_at: string;
  /** the branch head after the push */
  head: string;
  /** the commits the push brought */
  commits: string[];
  /** where the go-ahead had to be: the issue (a push before the MR existed) or the MR */
  thread: { kind: 'issue' | 'merge_request'; iid: number };
  /** the agent's latest proposal before the push */
  proposal: NoteRef | null;
  /** the go-ahead that counted, or null */
  go_ahead: NoteRef | null;
  /** who asked for the work: their go-ahead never counts */
  requesters: string[];
  /** checked again here, apart from the guard: the go-ahead's author is none of the requesters (null: no go-ahead) */
  approver_not_requester: boolean | null;
  tier: Tier;
  rollback: boolean;
  /** what the tier asks for, and who on go_ahead.people that allows */
  allowed: 'anyone' | 'maintainers';
  allowed_approvers: string[];
  /** the guard's rules let this push through */
  accepted: boolean;
  /** why not, in the guard's words */
  reasons: string[];
  /** the autonomy:goahead job on the MR's last pipeline, as GitLab recorded it (job null, status 'none': it never ran) */
  guard: { pipeline: number | null; job: number | null; status: string };
  /**
   * the merged MR that brought this push's commits to the default branch, when
   * it isn't `mr`: `mr` was closed after a later push on it was refused, and a
   * person moved the accepted commits to a new MR. `merged_at` is that MR's.
   */
  carried_by?: { mr: number; mr_url: string };
  /** SHA-256 of the previous record's canonical JSON (GENESIS for the first) */
  prev: string;
}

/**
 * The rules the records are judged by: the guard's check and this record
 * format. A change to either that judges past pushes differently would make
 * every rebuild differ from the published ledger, so it bumps this number in
 * the same MR (a person's MR: engine/ is a governance path). The next ledger
 * then starts a new chain and names the head of the one it replaces.
 *
 * 2: a problem the guard finds with the whole MR (a commit no push brought,
 * an agent's MR with no issue a person wrote) refuses every push of that MR,
 * and so does a merged MR the guard never ran on.
 *
 * 3: a push on a closed MR whose commits reached the default branch through
 * another merged MR is recorded (carried_by), accepted or refused, judged by
 * the default branch's policy when that MR was closed. Records are ordered by
 * when they joined the chain: the merge, or for a carried push the later of
 * its carrier's merge and its MR's close.
 */
export const LEDGER_RULES = 3;

export interface Ledger {
  version: 1;
  rules: number;
  project: string;
  /** where the chain starts: the merge that put the go-ahead guard on the default branch */
  since: { commit: string; at: string };
  /** SHA-256 of the last record (GENESIS when empty) */
  head: string;
  /** the chain this one replaced when the rules changed */
  replaces?: { rules: number; head: string; records: number };
  records: LedgerRecord[];
}

/** JSON with keys sorted at every level and no spaces: the same record always gives the same text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const recordHash = (r: LedgerRecord) => sha256(canonical(r));

/** Times to the second: REST gives milliseconds, GraphQL doesn't, and a record must read the same from both. */
export const second = (iso: string) => new Date(Date.parse(iso)).toISOString().replace(/\.\d{3}Z$/, 'Z');

const FLOWS = ['issue-builder', 'mr-reviewer', 'pipeline-fixer', 'incident-responder'];
export const flowOf = (account: string) => FLOWS.find((f) => account.toLowerCase().includes(f)) ?? account;

export interface MergedMr {
  iid: number;
  merged_at: string;
  source_branch: string;
  closes: number[];
  guard: LedgerRecord['guard'];
}

/** The records for one MR's agent pushes, without seq and prev (chain() sets those). */
export function recordsFor(web: string, mr: MergedMr, check: MrCheck, config: AutonomyConfig): Omit<LedgerRecord, 'seq' | 'prev'>[] {
  const mrUrl = `${web}/-/merge_requests/${mr.iid}`;
  // the guard fails the MR for these whichever push it looks at
  const mrProblems = check.problems.filter((p) => !p.push).map((p) => p.text);
  if (mr.guard.job === null) mrProblems.push(`autonomy:goahead never ran on this MR (${mr.guard.pipeline === null ? 'no pipeline' : `pipeline ${mr.guard.pipeline}`}), so no guard judged its pushes`);
  return check.agentPushes.map((c: PushCheck) => {
    const thread = c.issue ? { kind: 'issue' as const, iid: c.issue } : { kind: 'merge_request' as const, iid: mr.iid };
    const link = (n: Note): NoteRef => ({
      note: n.id,
      url: `${web}/-/${thread.kind === 'issue' ? 'issues' : 'merge_requests'}/${thread.iid}#note_${n.id}`,
      by: n.author.username,
      at: second(n.created_at),
    });
    const goAhead = c.verdict.ok ? link(c.verdict.note) : null;
    const reasons = [...check.problems.filter((p) => p.push === c.push).map((p) => p.text), ...mrProblems];
    const allowed = allowedApprovers(c.step, config);
    return {
      mr: mr.iid,
      mr_url: mrUrl,
      merged_at: second(mr.merged_at),
      closes: mr.closes,
      branch: mr.source_branch,
      agent: c.push.pusher,
      flow: flowOf(c.push.pusher),
      pushed_at: second(c.push.at),
      head: c.push.to,
      commits: c.commits,
      thread,
      proposal: c.verdict.proposal ? link(c.verdict.proposal) : null,
      go_ahead: goAhead,
      requesters: c.step.requesters.filter((r, i, all) => all.findIndex((x) => x.toLowerCase() === r.toLowerCase()) === i),
      approver_not_requester: goAhead ? !c.step.requesters.some((r) => r.toLowerCase() === goAhead.by.toLowerCase()) : null,
      tier: c.step.tier,
      rollback: c.step.rollback,
      allowed: allowed.from,
      allowed_approvers: allowed.people,
      accepted: c.verdict.ok && !reasons.length,
      reasons,
      guard: mr.guard,
    };
  });
}

/** The merged MR that brought a commit to the default branch. */
export interface Carrier {
  iid: number;
  mr_url: string;
  merged_at: string;
}

/**
 * The records of a closed MR that still reached the default branch: when the
 * guard refuses a push, it refuses that branch for good, so a person moves the
 * accepted commits to a new MR (!67 -> !83). Each push whose head `carrierOf`
 * finds on the default branch is recorded as the guard judged it on the
 * closed MR, with the go-ahead given there (if any), and with the carrier's
 * merge time. A refused push that reached the default branch this way is
 * recorded as refused: the chain shows it instead of letting it in unseen.
 * Pushes that never reached the default branch stay off the chain.
 */
export function carriedRecords(records: Omit<LedgerRecord, 'seq' | 'prev'>[], carrierOf: (head: string) => Carrier | null): Omit<LedgerRecord, 'seq' | 'prev'>[] {
  return records.flatMap((r) => {
    const by = carrierOf(r.head);
    return by ? [{ ...r, merged_at: second(by.merged_at), carried_by: { mr: by.iid, mr_url: by.mr_url } }] : [];
  });
}

/**
 * Items in the order they joined the chain (`at`), oldest first; items with
 * the same time keep their order. The chain must only grow at its end, so `at`
 * has to be no earlier than any run that could have published what precedes it.
 */
export function byMerge<T>(items: T[], at: (item: T) => string): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => Date.parse(at(a.item)) - Date.parse(at(b.item)) || a.i - b.i)
    .map(({ item }) => item);
}

/** Numbers the records and links each to the one before it. */
export function chain(project: string, since: Ledger['since'], records: Omit<LedgerRecord, 'seq' | 'prev'>[]): Ledger {
  const out: LedgerRecord[] = [];
  let prev = GENESIS;
  for (const r of records) {
    const record = { ...r, seq: out.length + 1, prev } as LedgerRecord;
    out.push(record);
    prev = recordHash(record);
  }
  return { version: 1, rules: LEDGER_RULES, project, since, head: prev, records: out };
}

/** What's wrong with a ledger's own links: each record must name the hash of the one before it. */
export function verifyChain(ledger: Ledger): string[] {
  const problems: string[] = [];
  let prev = GENESIS;
  ledger.records.forEach((r, i) => {
    if (r.seq !== i + 1) problems.push(`record ${i + 1} is numbered ${r.seq}`);
    if (r.prev !== prev) problems.push(`record ${i + 1} (!${r.mr}, push at ${r.pushed_at}) names ${r.prev.slice(0, 12)} as the record before it, but that record hashes to ${prev.slice(0, 12)}`);
    prev = recordHash(r);
  });
  if (ledger.head !== prev) problems.push(`the ledger's head is ${ledger.head.slice(0, 12)}, but its last record hashes to ${prev.slice(0, 12)}`);
  return problems;
}

/**
 * Why the rebuilt ledger doesn't continue the published one: every published
 * record must come back exactly as it was, in the same place. New records may
 * only be added after them.
 */
export function compare(published: Ledger, rebuilt: Ledger): string[] {
  const problems = verifyChain(published).map((p) => `published ledger: ${p}`);
  published.records.forEach((old, i) => {
    const now = rebuilt.records[i];
    if (!now) {
      problems.push(`record ${old.seq} (!${old.mr}, push at ${old.pushed_at} by @${old.agent}) is published but GitLab no longer gives it`);
      return;
    }
    if (canonical(old) === canonical(now)) return;
    const keys = [...new Set([...Object.keys(old), ...Object.keys(now)])].sort();
    const changed = keys.filter((k) => canonical((old as unknown as Record<string, unknown>)[k]) !== canonical((now as unknown as Record<string, unknown>)[k]));
    problems.push(
      `record ${old.seq} (!${old.mr}, push at ${old.pushed_at} by @${old.agent}) changed: ` +
        changed.map((k) => `${k} was ${canonical((old as unknown as Record<string, unknown>)[k])}, now ${canonical((now as unknown as Record<string, unknown>)[k])}`).join('; '),
    );
  });
  return problems;
}

/** An agent push on an MR that isn't merged yet: shown, not chained, since its MR can still change. */
export interface OpenPush {
  mr: number;
  mr_url: string;
  state: string;
  agent: string;
  flow: string;
  pushed_at: string;
  /** the branch head after the push */
  head: string;
  accepted: boolean;
  go_ahead: NoteRef | null;
  reasons: string[];
}

/** One autonomy:goahead job on a pipeline of an MR an agent pushed to. */
export interface GuardRun {
  mr: number;
  pipeline: number;
  url: string;
  sha: string;
  status: string;
  at: string;
}

export interface Counters {
  records: number;
  accepted: number;
  refused: number;
  /** distinct go-ahead notes behind accepted pushes */
  goAheads: number;
  byWhom: Record<string, number>;
  /** pushes with a go-ahead, and how many of those came from someone who didn't ask for the work */
  approverNotRequester: { holds: number; of: number };
  /** agent pushes the guard's rules refuse, in the chain and on open MRs */
  stopped: number;
  /** autonomy:goahead jobs that failed an agent MR's pipeline */
  failedRuns: number;
  /** the refused pushes counted once, with why, and the failed runs that refused none of them */
  refusals: Refusals;
}

/** Why the guard refused a push, from its own words. */
export type RefusalKind = 'no go-ahead' | 'go-ahead not counted' | 'protected files' | 'other';

export interface Refusals {
  /** the MRs the refused pushes were on, each once */
  mrs: number[];
  /** the UTC days they were pushed on */
  days: string[];
  /** pushes refused for each kind; a push refused for two reasons counts under both */
  byKind: Record<RefusalKind, number>;
  /** failed autonomy:goahead runs on the head of a refused push: the run that refused it */
  refusingRuns: number;
  /**
   * failed runs after a refused push on the same MR, on a later head: the guard
   * judges every push on the MR, so the earlier refused push still fails them
   */
  laterRuns: GuardRun[];
  /** the other failed runs, on no refused push's head and after none on their MR (an error, or a verdict a later rule change reversed) */
  otherRuns: GuardRun[];
}

/**
 * The kinds of the guard's reasons, matched on the lines checkMr and goAheadFor
 * write: "push at T by @agent (shas)[ on #N]: <verdict>", "push at ... came
 * before the MR, ...", and "commit S pushed by @agent changes files only people
 * may change: ...". Anything else (a merge commit, a commit no push brought, no
 * issue on an agent's MR, no guard run) is another rule.
 */
export function refusalKinds(reasons: string[]): RefusalKind[] {
  const kinds = new Set<RefusalKind>();
  for (const r of reasons) {
    if (/^commit \S+ pushed by @\S+ changes files only people may change: /.test(r)) kinds.add('protected files');
    else if (/^push at \S+ by @\S+ \([^)]*\)(?: on #\d+)?: (?:no go-ahead mentioning @|@\S+ wrote no proposal before the push )/.test(r)) kinds.add('no go-ahead');
    else if (/^push at \S+ by @\S+ \([^)]*\)(?: on #\d+)?: go-ahead in note \d+ doesn't count: /.test(r)) kinds.add('go-ahead not counted');
    else if (/^push at \S+ by @\S+ \([^)]*\) came before the MR, /.test(r)) kinds.add('go-ahead not counted');
    else kinds.add('other');
  }
  return kinds.size ? [...kinds] : ['other'];
}

export function refusals(ledger: Ledger, open: OpenPush[], runs: GuardRun[]): Refusals {
  const refused = [...ledger.records, ...open].filter((p) => !p.accepted);
  const byKind: Record<RefusalKind, number> = { 'no go-ahead': 0, 'go-ahead not counted': 0, 'protected files': 0, other: 0 };
  for (const p of refused) for (const k of refusalKinds(p.reasons)) byKind[k]++;
  const heads = new Set(refused.map((p) => `${p.mr} ${p.head}`));
  const mrs = new Set(refused.map((p) => p.mr));
  const failed = runs.filter((r) => r.status === 'failed');
  const refusing = failed.filter((r) => heads.has(`${r.mr} ${r.sha}`));
  const rest = failed.filter((r) => !refusing.includes(r));
  // a run after a refused push on its MR still judges that push; a run before it can't have failed for it
  const later = rest.filter((r) => refused.some((p) => p.mr === r.mr && Date.parse(r.at) > Date.parse(p.pushed_at)));
  return {
    mrs: [...mrs].sort((a, b) => a - b),
    days: [...new Set(refused.map((p) => p.pushed_at.slice(0, 10)))].sort(),
    byKind,
    refusingRuns: refusing.length,
    laterRuns: later,
    otherRuns: rest.filter((r) => !later.includes(r)),
  };
}

/** A push on an MR that isn't merged, as the page lists it; head lets a guard run be matched to it. */
export function openPush(r: Omit<LedgerRecord, 'seq' | 'prev'>, state: string): OpenPush {
  return {
    mr: r.mr,
    mr_url: r.mr_url,
    state,
    agent: r.agent,
    flow: flowOf(r.agent),
    pushed_at: r.pushed_at,
    head: r.head,
    accepted: r.accepted,
    go_ahead: r.go_ahead,
    reasons: r.reasons,
  };
}

export function counters(ledger: Ledger, open: OpenPush[], runs: GuardRun[]): Counters {
  const accepted = ledger.records.filter((r) => r.accepted);
  const notes = new Map<number, string>();
  for (const r of accepted) if (r.go_ahead) notes.set(r.go_ahead.note, r.go_ahead.by);
  const byWhom: Record<string, number> = {};
  for (const by of notes.values()) byWhom[by] = (byWhom[by] ?? 0) + 1;
  const withGoAhead = ledger.records.filter((r) => r.approver_not_requester !== null);
  return {
    records: ledger.records.length,
    accepted: accepted.length,
    refused: ledger.records.length - accepted.length,
    goAheads: notes.size,
    byWhom,
    approverNotRequester: { holds: withGoAhead.filter((r) => r.approver_not_requester).length, of: withGoAhead.length },
    stopped: ledger.records.filter((r) => !r.accepted).length + open.filter((p) => !p.accepted).length,
    failedRuns: runs.filter((r) => r.status === 'failed').length,
    refusals: refusals(ledger, open, runs),
  };
}
