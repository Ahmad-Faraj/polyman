import { type Note, isPerson, mentionOf, ownLines, proposalTime, saysGoAhead } from './goahead.ts';
import type { Ledger, LedgerRecord, NoteRef, OpenPush } from './ledger.ts';
import { type SciCoefficients, sessionGrams } from './sci.ts';

/**
 * The ledger read one loop at a time: an agent-built change a person merged,
 * from the request to the merge. The chain has one record per agent push; a
 * loop is every record whose commits reached the default branch through the
 * same merged MR (the MR itself, or the MR a person moved the commits to).
 * Nothing here is chained: it is a view of the chain plus what GitLab says
 * about the merge (who merged it) and the notes around each go-ahead.
 */

export interface Loop {
  /** the merged MR */
  mr: number;
  mr_url: string;
  merged_at: string;
  /** who merged it, as GitLab recorded it (null: GitLab didn't say) */
  merged_by: string | null;
  /** closed MRs whose agent commits a person moved to `mr` */
  moved_from: number[];
  issues: number[];
  /** the agent of the first push: the build */
  flow: string;
  requesters: string[];
  /** the go-ahead for the first push */
  go_ahead: NoteRef;
  /** every go-ahead the loop's accepted pushes used, in push order */
  go_aheads: NoteRef[];
  /** minutes from the first go-ahead to the merge */
  minutes: number;
  /** accepted pushes by the reviewer after a person's go-ahead */
  fix_rounds: number;
  /** agent pushes the guard's rules refused on this loop's MRs */
  refused_pushes: { mr: number; agent: string; pushed_at: string }[];
  /** go-aheads a person wrote that didn't count (see refusedGoAheads) */
  refused_go_aheads: NoteRef[];
  /** no go-ahead that counted came from someone who asked for the work */
  approver_not_requester: boolean;
  /** someone who gave one of the loop's go-aheads also merged it */
  giver_merged: boolean;
}

export const minutesBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000);

/**
 * Groups the chain's records into loops, oldest merge first. `open` holds the
 * pushes of MRs that never merged (the refused push on a closed MR whose
 * earlier commits a person moved on is one); `mergedBy` is GitLab's merged_by
 * for each merged MR; `refusedNotes` finds a loop's go-aheads that didn't count.
 */
export function loopsOf(
  ledger: Ledger,
  open: OpenPush[],
  mergedBy: (mr: number) => string | null,
  refusedNotes: (records: LedgerRecord[]) => NoteRef[] = () => [],
): Loop[] {
  const groups = new Map<number, LedgerRecord[]>();
  for (const r of ledger.records) {
    const key = r.carried_by?.mr ?? r.mr;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const loops: Loop[] = [];
  for (const [mr, records] of groups) {
    const pushes = [...records].sort((a, b) => a.pushed_at.localeCompare(b.pushed_at));
    const accepted = pushes.filter((r) => r.accepted && r.go_ahead);
    const first = accepted[0];
    // a loop whose every push was refused has no go-ahead to time from: the chain shows it as refused, not as a loop
    if (!first?.go_ahead) continue;
    const ownMrs = new Set(records.map((r) => r.mr));
    const carrier = records.find((r) => r.carried_by)?.carried_by;
    const go_aheads = accepted.map((r) => r.go_ahead!);
    const by = mergedBy(mr);
    const lower = (s: string) => s.toLowerCase();
    loops.push({
      mr,
      mr_url: carrier?.mr_url ?? records[0].mr_url,
      merged_at: records[0].merged_at,
      merged_by: by,
      moved_from: [...ownMrs].filter((m) => m !== mr).sort((a, b) => a - b),
      issues: [...new Set(records.flatMap((r) => r.closes))].sort((a, b) => a - b),
      flow: first.flow,
      requesters: [...new Set(records.flatMap((r) => r.requesters))],
      go_ahead: first.go_ahead,
      go_aheads,
      minutes: minutesBetween(first.go_ahead.at, records[0].merged_at),
      fix_rounds: accepted.filter((r) => r.flow === 'mr-reviewer').length,
      refused_pushes: [
        ...records.filter((r) => !r.accepted).map((r) => ({ mr: r.mr, agent: r.agent, pushed_at: r.pushed_at })),
        ...open.filter((p) => !p.accepted && ownMrs.has(p.mr)).map((p) => ({ mr: p.mr, agent: p.agent, pushed_at: p.pushed_at })),
      ].sort((a, b) => a.pushed_at.localeCompare(b.pushed_at)),
      // two pushes that share a proposal can both see the same note: it counts once
      refused_go_aheads: [...new Map(refusedNotes(accepted).map((n) => [n.note, n])).values()],
      approver_not_requester: records.every((r) => r.approver_not_requester !== false),
      giver_merged: by !== null && go_aheads.some((g) => lower(g.by) === lower(by)),
    });
  }
  return loops.sort((a, b) => a.merged_at.localeCompare(b.merged_at) || a.mr - b.mr);
}

/** "go-ahead", "Go Ahead!", "go ahead." with the @mentions and inline code taken out: someone meant to give one. */
const meantAsGoAhead = (line: string) =>
  line
    .replace(/(`+)[^`]*?\1/g, ' ')
    .replace(/@[\w.-]+/g, ' ')
    .toLowerCase()
    .replace(/[^a-z]/g, '') === 'goahead';

/**
 * The go-aheads a person wrote for this push that didn't count: notes after
 * the agent's proposal (its last edit before the push, as the guard reads it,
 * and after its previous push on the same thread,
 * `after`, as the guard reads it) and before the go-ahead that did count,
 * mentioning the agent, with a line of their own (not quoted, not in code)
 * that means "go ahead", but either not in the words the guard takes ("Go
 * Ahead!") or from someone the step doesn't allow (the requester). The agent
 * waited for another one; the ledger shows both.
 */
export function refusedGoAheads(notes: Note[], record: LedgerRecord, after?: string): Note[] {
  if (!record.go_ahead || !record.proposal) return [];
  // the guard counts from the proposal's last edit before the push, not from when it was written
  const proposal = notes.find((n) => n.id === record.proposal!.note);
  const proposed = proposal ? proposalTime(proposal, Date.parse(record.pushed_at)) : Date.parse(record.proposal.at);
  const from = Math.max(proposed, after ? Date.parse(after) : -Infinity);
  const to = Date.parse(record.go_ahead.at);
  const lower = (s: string) => s.toLowerCase();
  const allowed = new Set(record.allowed_approvers.map(lower));
  const requesters = new Set(record.requesters.map(lower));
  const mention = mentionOf(record.agent);
  return notes.filter((n) => {
    const at = Date.parse(n.created_at);
    if (n.system || n.id === record.go_ahead!.note || at <= from || at >= to || !isPerson(n.author.username)) return false;
    if (!ownLines(n.body).some((line) => mention.test(line.replace(/(`+)[^`]*?\1/g, ' ')) && meantAsGoAhead(line))) return false;
    const who = lower(n.author.username);
    // a go-ahead that would have counted, given earlier: not refused, only not the latest
    return !(saysGoAhead(n.body, record.agent) && allowed.has(who) && !requesters.has(who));
  });
}

/** When the same agent last pushed on the record's thread before it (the guard's other lower bound for a go-ahead), or undefined. */
export function previousPush(records: LedgerRecord[], record: LedgerRecord): string | undefined {
  return records
    .filter((r) => r.agent === record.agent && r.thread.kind === record.thread.kind && r.thread.iid === record.thread.iid && r.pushed_at < record.pushed_at)
    .map((r) => r.pushed_at)
    .sort()
    .pop();
}

/** One agent session, as counted from its checkpoint (calls null: no checkpoint to count). */
export interface Session {
  workflow: number;
  pipeline: number;
  at: string;
  flow: string;
  mr: number | null;
  issue: number | null;
  seconds: number;
  calls: number | null;
}

export interface SessionFile {
  /** the newest session the file counts: later sessions aren't in it */
  counted_up_to: string;
  source: string;
  sessions: Session[];
}

export interface LoopGrams {
  low: number;
  high: number;
  /** sessions counted */
  sessions: number;
  /** sessions of the loop with no checkpoint, so no grams (they lean the total low) */
  uncounted: number;
  /** sessions by flow */
  byFlow: Record<string, number>;
  /** the loop merged after the file's last session, so its later sessions are missing */
  partial: boolean;
}

/**
 * The agent sessions of each loop, each session in one loop only, so the
 * loops' grams add up: a session on one of a loop's MRs is that loop's; a
 * session on an issue alone is the first loop on that issue to merge after the
 * session started (an issue two merged MRs closed gives its proposal to the
 * first). A session after the merge isn't the loop's. Each loop's sessions are
 * turned into grams the way SUSTAINABILITY.md does: the runner's measured time,
 * plus the counted model calls at 0.24-2.5 Wh each, at the grid intensity in `c`.
 */
export function loopGrams(loops: Loop[], file: SessionFile, c: SciCoefficients): Map<number, LoopGrams> {
  const byMerge = [...loops].sort((a, b) => a.merged_at.localeCompare(b.merged_at) || a.mr - b.mr);
  const mine = new Map<number, Session[]>(loops.map((l) => [l.mr, []]));
  const seen = new Set<number>();
  for (const s of file.sessions) {
    // a session listed twice is still one session
    if (seen.has(s.workflow)) continue;
    seen.add(s.workflow);
    const byMr = s.mr !== null ? byMerge.find((l) => l.mr === s.mr || l.moved_from.includes(s.mr!)) : undefined;
    const owner = byMr ?? (s.issue !== null ? byMerge.find((l) => l.issues.includes(s.issue!) && Date.parse(s.at) <= Date.parse(l.merged_at)) : undefined);
    if (owner && Date.parse(s.at) <= Date.parse(owner.merged_at)) mine.get(owner.mr)!.push(s);
  }
  const out = new Map<number, LoopGrams>();
  for (const l of loops) out.set(l.mr, gramsOf(mine.get(l.mr)!, Date.parse(l.merged_at) > Date.parse(file.counted_up_to), c));
  return out;
}

function gramsOf(sessions: Session[], partial: boolean, c: SciCoefficients): LoopGrams {
  const counted = sessions.filter((s) => s.calls !== null);
  const byFlow: Record<string, number> = {};
  let low = 0;
  let high = 0;
  for (const s of counted) {
    const g = sessionGrams(s.seconds, { low: s.calls!, high: s.calls! }, c);
    low += g.low;
    high += g.high;
    byFlow[s.flow] = (byFlow[s.flow] ?? 0) + 1;
  }
  return { low: tenth(low), high: tenth(high), sessions: counted.length, uncounted: sessions.length - counted.length, byFlow, partial };
}

const tenth = (n: number) => Math.round(n * 10) / 10;

export interface LoopSummary {
  loops: number;
  approverNotRequester: number;
  giverMerged: number;
  /** loops whose merger GitLab gave */
  mergerKnown: number;
  fixRounds: number;
  refusedPushes: number;
  refusedGoAheads: number;
  medianMinutes: number | null;
  grams: { low: number; high: number; loops: number } | null;
}

export const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function summarize(loops: Loop[], grams?: Map<number, LoopGrams>): LoopSummary {
  const g = grams ? loops.map((l) => grams.get(l.mr)).filter((x): x is LoopGrams => !!x && x.sessions > 0) : [];
  return {
    loops: loops.length,
    approverNotRequester: loops.filter((l) => l.approver_not_requester).length,
    giverMerged: loops.filter((l) => l.giver_merged).length,
    mergerKnown: loops.filter((l) => l.merged_by !== null).length,
    fixRounds: loops.reduce((n, l) => n + l.fix_rounds, 0),
    refusedPushes: loops.reduce((n, l) => n + l.refused_pushes.length, 0),
    refusedGoAheads: loops.reduce((n, l) => n + l.refused_go_aheads.length, 0),
    medianMinutes: median(loops.map((l) => l.minutes)),
    grams: g.length ? { low: tenth(g.reduce((n, x) => n + x.low, 0)), high: tenth(g.reduce((n, x) => n + x.high, 0)), loops: g.length } : null,
  };
}

const grams = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1));
export const gramsRange = (low: number, high: number) => `${grams(low)}-${grams(high)} g`;

/** The summary as one line, for the job log and the page. */
export function summaryLine(s: LoopSummary): string {
  const parts = [
    `${s.loops} loop${s.loops === 1 ? '' : 's'}`,
    `go-ahead never from the requester (${s.approverNotRequester}/${s.loops})`,
    `in ${s.giverMerged} of ${s.loops} the go-ahead giver also merged`,
  ];
  if (s.grams) parts.push(`${gramsRange(s.grams.low, s.grams.high)} CO2e in all${s.grams.loops < s.loops ? ` (${s.grams.loops} loops counted)` : ''}`);
  return parts.join('; ');
}

/** A session as the usage counter writes it (one row per duo_workflow pipeline, usage from its checkpoint). */
export interface CountedSession {
  workflow_id: number;
  pipeline_id: number;
  created_at: string;
  flow: string;
  mr: number | null;
  issue: number | null;
  duration_s: number | null;
  usage_available: boolean;
  total?: { calls: number } | null;
}

/** The sessions the ledger needs, newest last, and the newest session's start as the time they're counted up to. */
export function sessionsFrom(rows: CountedSession[], source: string): SessionFile {
  const sessions = rows
    .map((r) => ({
      workflow: r.workflow_id,
      pipeline: r.pipeline_id,
      at: r.created_at,
      flow: r.flow,
      mr: r.mr ?? null,
      issue: r.issue ?? null,
      seconds: r.duration_s ?? 0,
      calls: r.usage_available && r.total ? r.total.calls : null,
    }))
    .sort((a, b) => a.at.localeCompare(b.at) || a.pipeline - b.pipeline);
  if (!sessions.length) throw new Error('no sessions to write');
  return { counted_up_to: sessions[sessions.length - 1].at, source, sessions };
}
