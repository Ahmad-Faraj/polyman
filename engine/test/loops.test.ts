import { describe, expect, it } from 'vitest';
import type { Note } from '../src/goahead.ts';
import { type Ledger, type LedgerRecord, type OpenPush, GENESIS } from '../src/ledger.ts';
import { duration, renderLoops } from '../src/ledger-page.ts';
import { type Loop, type SessionFile, loopGrams, loopsOf, previousPush, refusedGoAheads, sessionsFrom, summarize, summaryLine } from '../src/loops.ts';
import { DEFAULT_SCI, sessionGrams } from '../src/sci.ts';

const WEB = 'https://gitlab.com/group/showcase';
const BUILDER = 'ai-issue-builder-group_e1c791';
const REVIEWER = 'ai-mr-reviewer-group_e50080';

const ref = (note: number, by: string, at: string, where = 'issues/31') => ({ note, url: `${WEB}/-/${where}#note_${note}`, by, at });

function record(over: Partial<LedgerRecord>): LedgerRecord {
  return {
    seq: 1,
    mr: 67,
    mr_url: `${WEB}/-/merge_requests/67`,
    merged_at: '2026-10-18T13:35:31Z',
    closes: [31],
    branch: 'fix',
    agent: BUILDER,
    flow: 'issue-builder',
    pushed_at: '2026-10-18T12:03:14Z',
    head: 'a'.repeat(40),
    commits: [],
    thread: { kind: 'issue', iid: 31 },
    proposal: ref(1, BUILDER, '2026-10-18T11:50:00Z'),
    go_ahead: ref(2, 'Mazen-Ghanaym', '2026-10-18T11:57:15Z'),
    requesters: ['Ahmad-Faraj'],
    approver_not_requester: true,
    tier: 'medium',
    rollback: false,
    allowed: 'anyone',
    allowed_approvers: ['Mazen-Ghanaym', 'HamzaHassanain'],
    accepted: true,
    reasons: [],
    guard: { pipeline: 1, job: 2, status: 'success' },
    prev: GENESIS,
    ...over,
  };
}

const ledger = (records: LedgerRecord[]): Ledger => ({ version: 1, rules: 3, project: 'group/showcase', since: { commit: 'c', at: '2026-10-17T20:11:08Z' }, head: GENESIS, records });

/** !67 moved to !83 after a refused reviewer push, and !50 merged on its own. */
const moved = ledger([
  record({ seq: 1, carried_by: { mr: 83, mr_url: `${WEB}/-/merge_requests/83` } }),
  record({
    seq: 2,
    agent: REVIEWER,
    flow: 'mr-reviewer',
    pushed_at: '2026-10-18T12:37:58Z',
    thread: { kind: 'merge_request', iid: 67 },
    go_ahead: ref(4, 'Mazen-Ghanaym', '2026-10-18T12:34:55Z', 'merge_requests/67'),
    carried_by: { mr: 83, mr_url: `${WEB}/-/merge_requests/83` },
  }),
  record({
    seq: 3,
    mr: 50,
    mr_url: `${WEB}/-/merge_requests/50`,
    merged_at: '2026-10-18T06:18:39Z',
    closes: [12],
    pushed_at: '2026-10-18T06:09:48Z',
    go_ahead: ref(6, 'Ahmad-Faraj', '2026-10-18T06:06:45Z', 'issues/12'),
    requesters: ['HamzaHassanain'],
  }),
]);
const refusedOn67: OpenPush = {
  mr: 67,
  mr_url: `${WEB}/-/merge_requests/67`,
  state: 'closed',
  agent: REVIEWER,
  flow: 'mr-reviewer',
  pushed_at: '2026-10-18T13:21:29Z',
  accepted: false,
  go_ahead: null,
  reasons: ['no go-ahead'],
};
const mergers: Record<number, string> = { 83: 'Ahmad-Faraj', 50: 'Ahmad-Faraj' };

describe('loopsOf', () => {
  const loops = loopsOf(moved, [refusedOn67, { ...refusedOn67, mr: 90 }], (mr) => mergers[mr] ?? null);

  it('makes one loop per merged MR, oldest merge first, with the moved MR under the one that merged it', () => {
    expect(loops.map((l) => l.mr)).toEqual([50, 83]);
    expect(loops[1]).toMatchObject({ mr_url: `${WEB}/-/merge_requests/83`, moved_from: [67], issues: [31], flow: 'issue-builder', requesters: ['Ahmad-Faraj'] });
  });

  it('times the loop from the first go-ahead to the merge and counts the fix rounds', () => {
    expect(loops[1].go_ahead.by).toBe('Mazen-Ghanaym');
    expect(loops[1].minutes).toBe(98);
    expect(loops[1].fix_rounds).toBe(1);
    expect(loops[0].fix_rounds).toBe(0);
  });

  it("counts the refused pushes on the loop's own MRs only", () => {
    expect(loops[1].refused_pushes).toEqual([{ mr: 67, agent: REVIEWER, pushed_at: '2026-10-18T13:21:29Z' }]);
    expect(loops[0].refused_pushes).toEqual([]);
  });

  it('says when a go-ahead giver also merged', () => {
    expect(loops[0]).toMatchObject({ merged_by: 'Ahmad-Faraj', giver_merged: true });
    expect(loops[1]).toMatchObject({ merged_by: 'Ahmad-Faraj', giver_merged: false });
    expect(loopsOf(moved, [], () => null)[0]).toMatchObject({ merged_by: null, giver_merged: false });
  });

  it('marks a loop where a go-ahead came from the requester', () => {
    const broken = ledger([record({ approver_not_requester: false })]);
    expect(loopsOf(broken, [], () => null)[0].approver_not_requester).toBe(false);
  });

  it('leaves out a merged MR whose every push was refused: it has no go-ahead to time from', () => {
    expect(loopsOf(ledger([record({ accepted: false, go_ahead: null })]), [], () => null)).toEqual([]);
  });

  it('passes the accepted records to the refused go-ahead finder', () => {
    const seen: number[][] = [];
    loopsOf(moved, [], () => null, (records) => {
      seen.push(records.map((r) => r.seq));
      return [];
    });
    expect(seen).toEqual([[1, 2], [3]]);
  });

  it('lists a go-ahead that two pushes both saw once', () => {
    const twice = ref(9, 'Ahmad-Faraj', '2026-10-18T11:51:00Z');
    const loop = loopsOf(moved, [], () => null, (records) => records.map(() => twice)).find((l) => l.mr === 83)!;
    expect(loop.refused_go_aheads).toEqual([twice]);
  });
});

describe('previousPush', () => {
  it("gives the same agent's latest earlier push on the same thread", () => {
    const first = record({ seq: 1, pushed_at: '2026-10-18T10:00:00Z' });
    const second = record({ seq: 2, pushed_at: '2026-10-18T11:00:00Z', accepted: false });
    const third = record({ seq: 3, pushed_at: '2026-10-18T12:00:00Z' });
    const elsewhere = record({ seq: 4, pushed_at: '2026-10-18T11:30:00Z', thread: { kind: 'issue', iid: 99 } });
    const other = record({ seq: 5, pushed_at: '2026-10-18T11:40:00Z', agent: REVIEWER });
    const all = [first, second, third, elsewhere, other];
    expect(previousPush(all, third)).toBe('2026-10-18T11:00:00Z');
    expect(previousPush(all, first)).toBeUndefined();
  });
});

const note = (id: number, at: string, author: string, body: string): Note => ({ id, body, system: false, created_at: at, author: { username: author } });

describe('refusedGoAheads', () => {
  const r = record({});
  const at = (hhmm: string) => `2026-10-18T${hhmm}:00Z`;

  it("finds the requester's go-ahead and one not in the guard's words, and nothing else", () => {
    const notes = [
      note(10, at('11:40'), 'HamzaHassanain', `@${BUILDER} go-ahead`), // before the proposal
      note(11, at('11:51'), 'Ahmad-Faraj', `@${BUILDER} go-ahead`), // the requester
      note(12, at('11:52'), 'HamzaHassanain', `@${BUILDER} Go Ahead!`), // not the guard's words
      note(13, at('11:53'), 'HamzaHassanain', `@${BUILDER} go-ahead`), // would have counted, only not the latest
      note(14, at('11:54'), 'HamzaHassanain', 'go-ahead'), // mentions no agent
      note(15, at('11:55'), 'HamzaHassanain', `@${BUILDER} no go-ahead yet`),
      note(16, at('11:56'), 'ai-mr-reviewer-group_e50080', `@${BUILDER} go ahead`), // not a person
      note(2, at('11:57'), 'Mazen-Ghanaym', `@${BUILDER} go-ahead`), // the one that counted
      note(17, at('11:58'), 'Ahmad-Faraj', `@${BUILDER} go-ahead`), // after it
    ];
    expect(refusedGoAheads(notes, r).map((n) => n.id)).toEqual([11, 12]);
  });

  it('leaves out go-ahead lines that are quoted, in code or inside an address', () => {
    const notes = [
      note(11, at('11:51'), 'HamzaHassanain', `> @${BUILDER} go-ahead`),
      note(12, at('11:52'), 'HamzaHassanain', `As asked:\n\n\`\`\`\n@${BUILDER} Go Ahead!\n\`\`\``),
      note(13, at('11:53'), 'Ahmad-Faraj', `Write \`@${BUILDER} go-ahead\` to let it push`),
      note(14, at('11:54'), 'Ahmad-Faraj', `me@${BUILDER} go ahead`),
      note(15, at('11:55'), 'Ahmad-Faraj', `> quoting\n\n@${BUILDER} go ahead`), // its own line after the quote: refused
    ];
    expect(refusedGoAheads(notes, r).map((n) => n.id)).toEqual([15]);
  });

  it('starts after the previous push on the thread when that is later than the proposal', () => {
    const notes = [note(11, at('11:51'), 'Ahmad-Faraj', `@${BUILDER} go-ahead`), note(12, at('11:55'), 'Ahmad-Faraj', `@${BUILDER} go-ahead`)];
    expect(refusedGoAheads(notes, r, at('11:52')).map((n) => n.id)).toEqual([12]);
    expect(refusedGoAheads(notes, r, at('11:00')).map((n) => n.id)).toEqual([11, 12]);
  });

  it("starts after the proposal's last edit before the push, as the guard does", () => {
    const proposal = (updated_at: string): Note => ({ ...note(1, at('11:50'), BUILDER, 'Proposal: fix it'), updated_at });
    const goAheads = [note(11, at('11:51'), 'Ahmad-Faraj', `@${BUILDER} go-ahead`), note(12, at('11:55'), 'Ahmad-Faraj', `@${BUILDER} go-ahead`)];
    // edited at 11:52, before the push at 12:03: the note at 11:51 was not a go-ahead for it
    expect(refusedGoAheads([proposal(at('11:52')), ...goAheads], r).map((n) => n.id)).toEqual([12]);
    // edited after the push: the guard counts from when it was written
    expect(refusedGoAheads([proposal(at('12:10')), ...goAheads], r).map((n) => n.id)).toEqual([11, 12]);
  });

  it('finds nothing for a push without a go-ahead', () => {
    expect(refusedGoAheads([note(11, at('11:51'), 'Ahmad-Faraj', `@${BUILDER} go-ahead`)], record({ go_ahead: null }))).toEqual([]);
  });
});

const session = (over: Partial<SessionFile['sessions'][number]>) => ({ workflow: 1, pipeline: 1, at: '2026-10-18T12:00:00Z', flow: 'mr-reviewer', mr: null, issue: null, seconds: 100, calls: 10, ...over });

describe('loopGrams', () => {
  const loops = loopsOf(moved, [], () => null);
  const file: SessionFile = {
    counted_up_to: '2026-10-19T20:03:22Z',
    source: 'test',
    sessions: [
      session({ workflow: 1, flow: 'issue-builder', issue: 31, at: '2026-10-18T11:00:00Z' }), // the proposal
      session({ workflow: 2, mr: 67 }), // a review on the moved MR
      session({ workflow: 3, mr: 83, calls: null }), // no checkpoint
      session({ workflow: 4, mr: 83, at: '2026-10-18T14:00:00Z' }), // after the merge
      session({ workflow: 5, mr: 50, at: '2026-10-18T06:00:00Z' }), // the other loop
      session({ workflow: 5, mr: 50, at: '2026-10-18T06:00:00Z' }), // the same session listed twice
    ],
  };
  const one = sessionGrams(100, { low: 10, high: 10 }, DEFAULT_SCI);

  it("adds up the runner and the counted calls of the loop's sessions up to the merge", () => {
    const g = loopGrams(loops, file, DEFAULT_SCI).get(83)!;
    expect(g).toMatchObject({ sessions: 2, uncounted: 1, byFlow: { 'issue-builder': 1, 'mr-reviewer': 1 }, partial: false });
    expect(g.low).toBeCloseTo(2 * one.low, 1);
    expect(g.high).toBeCloseTo(2 * one.high, 1);
    // 10 calls at 0.24 and 2.5 Wh, 579 g/kWh, plus the runner
    expect(one.high - one.low).toBeCloseTo((10 * (2.5 - 0.24) * 579) / 1000, 6);
  });

  it('counts a session listed twice once', () => {
    expect(loopGrams(loops, file, DEFAULT_SCI).get(50)).toMatchObject({ sessions: 1, uncounted: 0 });
  });

  it('counts a session on an issue two merged MRs closed in the first to merge after it started, and only there', () => {
    // !50 closes #31 too, and merged before !83
    const both = loopsOf(ledger([...moved.records.slice(0, 2), { ...moved.records[2], closes: [12, 31] }]), [], () => null);
    const early = { ...file, sessions: [session({ workflow: 1, flow: 'issue-builder', issue: 31, at: '2026-10-18T05:00:00Z' })] };
    const g = loopGrams(both, early, DEFAULT_SCI);
    expect([g.get(50)!.sessions, g.get(83)!.sessions]).toEqual([1, 0]);
    // started after !50 merged: the next loop on the issue
    const late = { ...file, sessions: [session({ workflow: 1, flow: 'issue-builder', issue: 31, at: '2026-10-18T11:00:00Z' })] };
    const h = loopGrams(both, late, DEFAULT_SCI);
    expect([h.get(50)!.sessions, h.get(83)!.sessions]).toEqual([0, 1]);
    // so the total is the sessions' grams, once each
    expect(summarize(both, g).grams).toMatchObject({ low: Math.round(one.low * 10) / 10, loops: 1 });
  });

  it('says when the loop merged after the last counted session', () => {
    expect(loopGrams(loops, { ...file, counted_up_to: '2026-10-18T13:00:00Z' }, DEFAULT_SCI).get(83)!.partial).toBe(true);
  });
});

describe('summarize and summaryLine', () => {
  it('gives the counts the page leads with', () => {
    const loops = loopsOf(moved, [refusedOn67], (mr) => mergers[mr] ?? null);
    const grams = new Map(loops.map((l) => [l.mr, { low: 1.04, high: 10, sessions: 2, uncounted: 0, byFlow: {}, partial: false }]));
    const s = summarize(loops, grams);
    expect(s).toMatchObject({ loops: 2, approverNotRequester: 2, giverMerged: 1, mergerKnown: 2, fixRounds: 1, refusedPushes: 1, medianMinutes: 55, grams: { low: 2.1, high: 20, loops: 2 } });
    expect(summaryLine(s)).toBe('2 loops; go-ahead never from the requester (2/2); in 1 of 2 the go-ahead giver also merged; 2.1-20.0 g CO2e in all');
    expect(summaryLine(summarize(loops))).toBe('2 loops; go-ahead never from the requester (2/2); in 1 of 2 the go-ahead giver also merged');
  });
});

describe('sessionsFrom', () => {
  it('keeps what the loops need, oldest first, and counts up to the newest session', () => {
    const file = sessionsFrom(
      [
        { workflow_id: 2, pipeline_id: 20, created_at: '2026-10-19T10:00:00Z', flow: 'mr-reviewer', mr: 5, issue: null, duration_s: 60, usage_available: true, total: { calls: 7 } },
        { workflow_id: 1, pipeline_id: 10, created_at: '2026-10-18T10:00:00Z', flow: 'issue-builder', mr: null, issue: 3, duration_s: null, usage_available: false, total: null },
      ],
      'test',
    );
    expect(file.counted_up_to).toBe('2026-10-19T10:00:00Z');
    expect(file.sessions).toEqual([
      { workflow: 1, pipeline: 10, at: '2026-10-18T10:00:00Z', flow: 'issue-builder', mr: null, issue: 3, seconds: 0, calls: null },
      { workflow: 2, pipeline: 20, at: '2026-10-19T10:00:00Z', flow: 'mr-reviewer', mr: 5, issue: null, seconds: 60, calls: 7 },
    ]);
    expect(() => sessionsFrom([], 'test')).toThrow('no sessions');
  });
});

describe('renderLoops', () => {
  const loops = loopsOf(moved, [refusedOn67], (mr) => mergers[mr] ?? null);
  const rows = loops.map((l: Loop) => ({ ...l, grams: l.mr === 83 ? { low: 25.2, high: 212.3, sessions: 9, uncounted: 0, byFlow: { 'issue-builder': 2, 'mr-reviewer': 7 }, partial: false } : null }));

  it('shows the summary and a row per loop', () => {
    const html = renderLoops({ rows, summary: summarize(loops), sessions: { countedUpTo: '2026-10-19T20:03:22.070Z', source: 'test' }, grid: 579 }, WEB);
    expect(html).toContain('<p class="summary">2 loops; go-ahead never from the requester (2/2); in 1 of 2 the go-ahead giver also merged.</p>');
    expect(html).toContain(`moved from <a href="${WEB}/-/merge_requests/67">!67</a>`);
    expect(html).toContain('1 h 38 min');
    expect(html).toContain('25.2-212 g');
    expect(html).toContain('9 sessions: 2 issue-builder, 7 mr-reviewer');
    expect(html).toContain('counted up to <strong>2026-10-19 20:03:22 UTC</strong>');
    expect(html).toContain('also gave a go-ahead');
  });

  it('says when there are no session counts', () => {
    const html = renderLoops({ rows, summary: summarize(loops), sessions: null, grid: 579 }, WEB);
    expect(html).toContain('shown without grams');
    expect(html).toContain('not counted');
  });

  it('writes durations in minutes, then hours', () => {
    expect(duration(12)).toBe('12 min');
    expect(duration(445)).toBe('7 h 25 min');
  });
});
