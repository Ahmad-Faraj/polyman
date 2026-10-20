import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { Note, PushEvent } from '../src/goahead.ts';
import { type MrFacts, type Repo, checkMr } from '../src/goahead-mr.ts';
import { GENESIS, type Ledger, type OpenPush, byMerge, canonical, carriedRecords, chain, compare, counters, openPush, recordHash, recordsFor, refusalKinds, second, sha256, verifyChain } from '../src/ledger.ts';
import { renderLedgerPage } from '../src/ledger-page.ts';

// the first Assisted loop, #22 -> !26, as GitLab's API returned it
const loop = JSON.parse(readFileSync('test/fixtures/ledger/loop-22-26.json', 'utf8')) as {
  issue_notes: Note[];
  mr_notes: Note[];
  events: PushEvent[];
  mr: { iid: number; author: { username: string }; created_at: string; merged_at: string; source_branch: string; head_pipeline: { id: number } };
  closes: { iid: number; author: { username: string } }[];
};
// the policy when !26 merged: Hamza was the only maintainer (Mazen joined on
// Oct 18). The ledger judges each MR by the policy of its own merge, as here.
const current = loadConfig('../.autonomy.yml');
const config = { ...current, goAhead: { ...current.goAhead, maintainers: ['HamzaHassanain'] } };
const WEB = 'https://gitlab.com/group/showcase';
const BUILDER = 'ai-issue-builder-gitlab-ai-hackathon_e1c791';
const AGENT_COMMIT = '83d78ea8f145e005b6ca06a9907bfe5deb30c72b';
const MERGE_MAIN = 'fbf244eef027030c9e3b0116fb22bec172211919';

// the agent's commit, then Ahmed's merge of main on top of it
const repo: Repo = {
  isAncestor: (c, of) => c === of || (c === AGENT_COMMIT && of === MERGE_MAIN),
  has: () => true,
  parents: (sha) => (sha === MERGE_MAIN ? 2 : 1),
  files: () => ['src/helpers/utils.ts', 'tests/helpers/utils.test.ts'],
};

const facts = (over: Partial<MrFacts> = {}): MrFacts => ({
  mr: loop.mr,
  notes: loop.mr_notes,
  closes: loop.closes,
  events: loop.events,
  commits: [MERGE_MAIN, AGENT_COMMIT],
  since: '2026-10-15',
  tier: 'low',
  ...over,
});

async function build(over: Partial<MrFacts> = {}, issueNotes = loop.issue_notes) {
  const check = await checkMr(facts(over), config, repo, async () => issueNotes);
  const guard = { pipeline: loop.mr.head_pipeline.id, job: 17259651990, status: 'success' };
  const records = recordsFor(WEB, { iid: 26, merged_at: loop.mr.merged_at, source_branch: loop.mr.source_branch, closes: [22], guard }, check, config);
  return { check, records, ledger: chain('group/showcase', { commit: '06a116ff', at: '2026-10-17T20:11:08Z' }, records) };
}

describe('a ledger record, from the guard\'s own check of #22 -> !26', () => {
  it("records the issue-builder's push with Mazen's go-ahead on #22, and Ahmed as the one who asked", async () => {
    const { records } = await build();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      mr: 26,
      closes: [22],
      agent: BUILDER,
      flow: 'issue-builder',
      pushed_at: '2026-10-17T22:13:04Z',
      commits: [AGENT_COMMIT],
      thread: { kind: 'issue', iid: 22 },
      proposal: { note: 4035973201, by: BUILDER, url: `${WEB}/-/issues/22#note_4035973201` },
      go_ahead: { note: 4036138042, by: 'Mazen-Ghanaym', at: '2026-10-17T22:09:49Z', url: `${WEB}/-/issues/22#note_4036138042` },
      requesters: ['Ahmad-Faraj'],
      approver_not_requester: true,
      tier: 'low',
      allowed: 'anyone',
      allowed_approvers: ['HamzaHassanain', 'Mazen-Ghanaym'],
      accepted: true,
      reasons: [],
    });
  });

  it("leaves out Ahmed's own push (merging main in): only agent pushes need a go-ahead", async () => {
    const { check } = await build();
    expect(check.pushes).toBe(2);
    expect(check.agentPushes.map((c) => c.push.pusher)).toEqual([BUILDER]);
  });

  it('refuses the push if the go-ahead came from the person who asked', async () => {
    const own = loop.issue_notes.map((n) => (n.id === 4036138042 ? { ...n, author: { username: 'Ahmad-Faraj' } } : n));
    const { records } = await build({}, own);
    expect(records[0]).toMatchObject({ accepted: false, go_ahead: null, approver_not_requester: null });
    expect(records[0].reasons.join()).toMatch(/Ahmad-Faraj asked for this work/);
  });

  it('at high risk lists only the maintainer, and refuses a teammate who is not one', async () => {
    const { records } = await build({ tier: 'high' });
    expect(records[0]).toMatchObject({ allowed: 'maintainers', allowed_approvers: ['HamzaHassanain'], accepted: false });
    expect(records[0].reasons.join()).toMatch(/not a maintainer; high risk needs @HamzaHassanain/);
  });

  it('refuses every push of an MR the guard fails for a reason about the whole MR (a commit no push brought)', async () => {
    const { check, records } = await build({ commits: [MERGE_MAIN, AGENT_COMMIT, 'deadbeef'.padEnd(40, '0')] });
    expect(check.problems.some((p) => !p.push)).toBe(true);
    expect(records[0].accepted).toBe(false);
    expect(records[0].reasons.join()).toMatch(/commit deadbeef is in no push GitLab recorded/);
  });

  it('refuses the pushes of an MR the guard never ran on', async () => {
    const check = await checkMr(facts(), config, repo, async () => loop.issue_notes);
    const records = recordsFor(WEB, { iid: 26, merged_at: loop.mr.merged_at, source_branch: loop.mr.source_branch, closes: [22], guard: { pipeline: null, job: null, status: 'none' } }, check, config);
    expect(records[0]).toMatchObject({ accepted: false, guard: { pipeline: null, job: null, status: 'none' } });
    expect(records[0].reasons.join()).toMatch(/autonomy:goahead never ran on this MR/);
  });

  it('times are kept to the second, so REST (milliseconds) and GraphQL (seconds) give the same record', async () => {
    const graphql = loop.issue_notes.map((n) => ({ ...n, created_at: second(n.created_at), updated_at: n.updated_at && second(n.updated_at) }));
    const rest = await build();
    const gql = await build({}, graphql);
    expect(canonical(gql.records)).toBe(canonical(rest.records));
  });
});

describe('the chain', () => {
  it('starts from the genesis hash and links each record to the hash of the one before', async () => {
    const { records } = await build();
    const ledger = chain('group/showcase', { commit: 'c', at: 't' }, [...records, { ...records[0], mr: 50 }]);
    expect(ledger.records.map((r) => r.seq)).toEqual([1, 2]);
    expect(ledger.records[0].prev).toBe(GENESIS);
    expect(ledger.records[1].prev).toBe(sha256(canonical(ledger.records[0])));
    expect(ledger.head).toBe(recordHash(ledger.records[1]));
    expect(verifyChain(ledger)).toEqual([]);
  });

  it('canonical JSON does not depend on key order', () => {
    expect(canonical({ b: 1, a: { d: [1, { f: 2, e: 3 }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"e":3,"f":2}]},"b":1}');
  });

  it('catches a record edited in the published file: the next record no longer names its hash', async () => {
    const { ledger } = await build();
    const two = chain(ledger.project, ledger.since, [ledger.records[0], { ...ledger.records[0], mr: 50 }].map(({ seq: _s, prev: _p, ...r }) => r));
    const edited: Ledger = structuredClone(two);
    edited.records[0].go_ahead!.by = 'HamzaHassanain';
    expect(verifyChain(edited).join()).toMatch(/record 2 \(!50.*names .* as the record before it, but that record hashes to/);
  });
});

describe('comparing the rebuilt ledger with the published one', () => {
  it('passes when the published records come back unchanged and new ones follow', async () => {
    const { ledger, records } = await build();
    const longer = chain(ledger.project, ledger.since, [...records, { ...records[0], mr: 50, pushed_at: '2026-10-18T06:09:48Z' }]);
    expect(compare(ledger, longer)).toEqual([]);
  });

  it('fails when the go-ahead was edited after the push: the guard no longer counts it', async () => {
    const { ledger } = await build();
    const edited = loop.issue_notes.map((n) => (n.id === 4036138042 ? { ...n, body: `${n.body}\n(edited)`, updated_at: '2026-10-18T08:00:00.000Z' } : n));
    const rebuilt = (await build({}, edited)).ledger;
    const problems = compare(ledger, rebuilt);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/record 1 \(!26, push at 2026-10-17T22:13:04Z by @ai-issue-builder\S*\) changed: accepted was true, now false; approver_not_requester was true, now null; go_ahead was \{.*4036138042.*\}, now null/);
  });

  it('fails when the go-ahead note was deleted', async () => {
    const { ledger } = await build();
    const rebuilt = (await build({}, loop.issue_notes.filter((n) => n.id !== 4036138042))).ledger;
    expect(compare(ledger, rebuilt).join()).toMatch(/record 1 .* changed: accepted was true, now false/);
  });

  it('fails when a record lands between published ones, even though every published record still comes back', async () => {
    const { ledger, records } = await build();
    const mr = (iid: number) => ({ ...records[0], mr: iid, mr_url: `${WEB}/-/merge_requests/${iid}` });
    const published = chain(ledger.project, ledger.since, [mr(7), mr(9)]);
    // a carried push of !8 sorted before !9, which a run had already published
    const rebuilt = chain(ledger.project, ledger.since, [mr(7), { ...mr(8), carried_by: { mr: 83, mr_url: `${WEB}/-/merge_requests/83` } }, mr(9)]);
    const problems = compare(published, rebuilt);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^record 2 \(!9, push at 2026-10-17T22:13:04Z by @ai-issue-builder\S*\) changed: carried_by was .*; mr was 9, now 8; mr_url was/);
  });

  it('fails when a published record is gone', async () => {
    const { ledger } = await build();
    const empty = chain(ledger.project, ledger.since, []);
    expect(compare(ledger, empty).join()).toMatch(/record 1 \(!26.*is published but GitLab no longer gives it/);
  });

  it('fails when the published file itself was edited, even if GitLab still gives the original', async () => {
    const { ledger } = await build();
    const edited: Ledger = structuredClone(ledger);
    edited.records[0].requesters = ['HamzaHassanain'];
    const problems = compare(edited, ledger);
    expect(problems.join()).toMatch(/published ledger: the ledger's head is/);
    expect(problems.join()).toMatch(/requesters was \["HamzaHassanain"\], now \["Ahmad-Faraj"\]/);
  });
});

describe('a closed MR whose accepted commits a person moved to a merged MR (!67 -> !83)', () => {
  const CARRIER = { iid: 83, mr_url: `${WEB}/-/merge_requests/83`, merged_at: '2026-10-18T13:35:37.123Z' };
  const closed = async () => {
    const { records } = await build();
    const accepted = { ...records[0], mr: 67, mr_url: `${WEB}/-/merge_requests/67`, merged_at: '2026-10-18T11:00:00Z', head: 'a'.repeat(40) };
    const later = { ...accepted, head: 'b'.repeat(40), pushed_at: '2026-10-18T12:37:58Z' };
    const refused = { ...accepted, head: 'c'.repeat(40), accepted: false, go_ahead: null, approver_not_requester: null, reasons: ['no go-ahead'] };
    return [accepted, later, refused];
  };

  it('records each accepted push found on the default branch, with the go-ahead given on the closed MR and the merge that brought it', async () => {
    const [accepted, later, refused] = await closed();
    const carried = carriedRecords([accepted, later, refused], (head) => (head === accepted.head ? CARRIER : null));
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatchObject({ mr: 67, merged_at: '2026-10-18T13:35:37Z', carried_by: { mr: 83, mr_url: CARRIER.mr_url }, go_ahead: { by: 'Mazen-Ghanaym' }, accepted: true });
  });

  it('records a refused push whose commit reached the default branch, as refused, so it never gets in unseen', async () => {
    const [, , refused] = await closed();
    const [record] = carriedRecords([refused], () => CARRIER);
    expect(record).toMatchObject({ mr: 67, accepted: false, go_ahead: null, reasons: ['no go-ahead'], carried_by: { mr: 83 } });
    const ledger = chain('group/showcase', { commit: '06a116ff', at: '2026-10-17T20:11:08Z' }, [record]);
    expect(counters(ledger, [], [])).toMatchObject({ records: 1, accepted: 0, refused: 1, goAheads: 0 });
  });

  it('leaves out a push whose commit never reached the default branch', async () => {
    const [accepted, later, refused] = await closed();
    expect(carriedRecords([accepted, later, refused], () => null)).toEqual([]);
  });

  it('counts the carried go-ahead for the person who gave it', async () => {
    const [accepted] = await closed();
    const ledger = chain('group/showcase', { commit: '06a116ff', at: '2026-10-17T20:11:08Z' }, carriedRecords([accepted], () => CARRIER));
    expect(counters(ledger, [], []).byWhom).toEqual({ 'Mazen-Ghanaym': 1 });
  });

  it('orders records by when they joined the chain, and keeps the order within one time', () => {
    const r = (mr: number, at: string) => ({ mr, at });
    expect(byMerge([r(95, '2026-10-18T15:30:00Z'), r(59, '2026-10-18T13:50:00Z'), r(83, '2026-10-18T13:35:37Z'), r(831, '2026-10-18T13:35:37Z')], (x) => x.at).map((x) => x.mr)).toEqual([
      83, 831, 59, 95,
    ]);
  });

  it('shows on the page where the moved commits merged', async () => {
    const [accepted] = await closed();
    const ledger = chain('group/showcase', { commit: '06a116ff', at: '2026-10-17T20:11:08Z' }, carriedRecords([accepted], () => CARRIER));
    const html = renderLedgerPage({ ledger, open: [], runs: [], counters: counters(ledger, [], []), web: WEB, generatedAt: '2026-10-18T16:00:00Z', commit: 'abcdef12' });
    expect(html).toContain(`<span class="muted">merged in</span> <a href="${CARRIER.mr_url}">!83</a>`);
  });
});

describe('the counters and the page', () => {
  it('counts go-aheads by person, approver != requester and the pushes stopped', async () => {
    const { ledger, records } = await build();
    const refused = { ...records[0], mr: 60, accepted: false, go_ahead: null, approver_not_requester: null, reasons: ['no go-ahead'] };
    const both = chain(ledger.project, ledger.since, [...records, refused]);
    const open = [{ mr: 61, mr_url: '', state: 'opened', agent: BUILDER, flow: 'issue-builder', pushed_at: '2026-10-18T10:00:00Z', head: 'd', accepted: false, go_ahead: null, reasons: ['x'] }];
    const runs = [{ mr: 26, pipeline: 1, url: '', sha: 'a', status: 'failed', at: '' }, { mr: 26, pipeline: 2, url: '', sha: 'b', status: 'success', at: '' }];
    expect(counters(both, open, runs)).toEqual({
      records: 2,
      accepted: 1,
      refused: 1,
      goAheads: 1,
      byWhom: { 'Mazen-Ghanaym': 1 },
      approverNotRequester: { holds: 1, of: 1 },
      stopped: 2,
      failedRuns: 1,
      refusals: { mrs: [60, 61], days: ['2026-10-17', '2026-10-18'], byKind: { 'no go-ahead': 0, 'go-ahead not counted': 0, 'protected files': 0, other: 2 }, refusingRuns: 0, laterRuns: [], otherRuns: [runs[0]] },
    });
  });

  // 18 Oct: reviewer pushes with no go-ahead; 20 Oct (!177): one with a go-ahead
  // that changed corpus/; and !26's run that failed on a token error
  it('counts each refused push once, says why, and keeps the failed runs apart', async () => {
    const { ledger } = await build();
    const push = (mr: number, day: string, head: string, reason: string): OpenPush => ({
      mr,
      mr_url: `${WEB}/-/merge_requests/${mr}`,
      state: 'closed',
      agent: 'ai-mr-reviewer',
      flow: 'mr-reviewer',
      pushed_at: `2026-10-${day}T14:00:00Z`,
      head,
      accepted: false,
      go_ahead: null,
      reasons: [reason],
    });
    const noGoAhead = (mr: number, head: string) => push(mr, '18', head, `push at 2026-10-18T14:00:00Z by @ai-mr-reviewer (${head}): no go-ahead mentioning @ai-mr-reviewer`);
    const open = [
      noGoAhead(85, 'a1'),
      noGoAhead(85, 'a2'),
      noGoAhead(90, 'b1'),
      {
        ...push(177, '20', 'c1', 'commit c1 pushed by @ai-mr-reviewer changes files only people may change: corpus/survivors.mjs'),
        state: 'opened',
      },
    ];
    const run = (mr: number, pipeline: number, sha: string) => ({ mr, pipeline, url: `${WEB}/-/pipelines/${pipeline}`, sha, status: 'failed', at: '2026-10-18T14:00:00Z' });
    const runs = [run(85, 1, 'a1'), run(85, 2, 'a2'), run(90, 3, 'b1'), run(177, 4, 'c1'), run(26, 5, 'e1'), { ...run(26, 6, 'e2'), status: 'success' }];
    const c = counters(ledger, open, runs);
    expect(c.stopped).toBe(4);
    expect(c.failedRuns).toBe(5);
    expect(c.refusals).toEqual({
      mrs: [85, 90, 177],
      days: ['2026-10-18', '2026-10-20'],
      byKind: { 'no go-ahead': 3, 'go-ahead not counted': 0, 'protected files': 1, other: 0 },
      refusingRuns: 4,
      laterRuns: [],
      otherRuns: [runs[4]],
    });
    const html = renderLedgerPage({ ledger, open, runs, counters: c, web: WEB, generatedAt: '2026-10-20T11:00:00Z', commit: 'abcdef12' });
    expect(html).toContain('<div class="label">Agent pushes refused</div><div class="value">4</div>');
    expect(html).toContain(
      `on 3 MRs (<a href="${WEB}/-/merge_requests/85">!85</a>, <a href="${WEB}/-/merge_requests/90">!90</a>, <a href="${WEB}/-/merge_requests/177">!177</a>), 18 Oct, 20 Oct: 3 for no go-ahead from a person, 1 for changing files only people may change; counted from when the guard reached main, 2026-10-17 20:11 UTC`,
    );
    expect(html).toContain('5 failed runs: 4 are the runs that refused the pushes counted above; 1 other failed run on !26, which refused no push counted above');
    expect(html).toContain(`<code>e1</code>) <span class="muted">refused no push counted above; the job log says why</span></li>`);
    expect(html).toContain(`<code>a1</code>)</li>`);
    expect(html).not.toContain('also failed');
  });

  const refusedOn = (mr: number, head: string, reasons: string[], pushed_at = '2026-10-18T14:00:00Z'): OpenPush => ({
    mr,
    mr_url: `${WEB}/-/merge_requests/${mr}`,
    state: 'opened',
    agent: 'ai-mr-reviewer',
    flow: 'mr-reviewer',
    pushed_at,
    head,
    accepted: false,
    go_ahead: null,
    reasons,
  });
  const failedRun = (mr: number, pipeline: number, sha: string) => ({ mr, pipeline, url: `${WEB}/-/pipelines/${pipeline}`, sha, status: 'failed', at: '2026-10-18T15:00:00Z' });
  const NO_GO_AHEAD = 'push at 2026-10-18T14:00:00Z by @ai-mr-reviewer (h1): no go-ahead mentioning @ai-mr-reviewer between its proposal at 2026-10-18T13:00:00.000Z and the push at 2026-10-18T14:00:00Z';

  // the guard fails every later pipeline of an MR while a refused push is on it,
  // e.g. a person's fix commit: those runs are not "an error" or a reversed verdict
  it('groups a failed run on a later head of an MR with a refused push under that MR, not with the other failed runs', async () => {
    const { ledger } = await build();
    const open = [refusedOn(5, 'h1', [NO_GO_AHEAD])];
    const runs = [failedRun(5, 1, 'h1'), failedRun(5, 2, 'h1'), failedRun(5, 3, 'h2'), failedRun(26, 4, 'e1')];
    const c = counters(ledger, open, runs);
    expect(c.refusals).toMatchObject({ refusingRuns: 2, laterRuns: [runs[2]], otherRuns: [runs[3]] });
    const html = renderLedgerPage({ ledger, open, runs, counters: c, web: WEB, generatedAt: '2026-10-20T11:00:00Z', commit: 'abcdef12' });
    expect(html).toContain(
      '4 failed runs: 2 are the runs that refused the pushes counted above; 1 run on later heads of !5, where the refused push is still on the MR and the guard judges every push on an MR (the job log says why); 1 other failed run on !26, which refused no push counted above',
    );
    expect(html).toContain('<code>h2</code>) <span class="muted">a later head of an MR with a refused push, which the guard still judges; the job log says why</span></li>');
    expect(html).not.toContain('other failed run on !5');
    expect(html).not.toContain('<code>h2</code>) <span class="muted">refused no push');
  });

  it('says none when no push was refused, and keeps every failed run apart as another failed run', async () => {
    const { ledger } = await build();
    const runs = [failedRun(26, 1, 'e1')];
    const c = counters(ledger, [], runs);
    const html = renderLedgerPage({ ledger, open: [], runs, counters: c, web: WEB, generatedAt: '2026-10-20T11:00:00Z', commit: 'abcdef12' });
    expect(html).toContain('<div class="label">Agent pushes refused</div><div class="value">0</div><div class="sub">none; counted from when the guard reached main, 2026-10-17 20:11 UTC</div>');
    expect(html).toContain('1 failed run: 1 other failed run on !26, which refused no push counted above');
    expect(html).not.toContain('0 are the runs');
  });

  it('uses the singular for one MR, one failed run and one refusing run, and names another rule', async () => {
    const { ledger } = await build();
    const open = [refusedOn(7, 'h1', ['commit 1234abcd pushed by @ai-mr-reviewer is a merge commit; agents may not push merges (a person merges the default branch in)'])];
    const runs = [failedRun(7, 1, 'h1')];
    const html = renderLedgerPage({ ledger, open, runs, counters: counters(ledger, open, runs), web: WEB, generatedAt: '2026-10-20T11:00:00Z', commit: 'abcdef12' });
    expect(html).toContain(`on 1 MR (<a href="${WEB}/-/merge_requests/7">!7</a>), 18 Oct: 1 for another rule; counted from`);
    expect(html).toContain('1 failed run: 1 is the run that refused the pushes counted above. These are runs');
  });

  it("names a go-ahead that doesn't count apart from no go-ahead", async () => {
    const { ledger } = await build();
    const open = [
      refusedOn(8, 'h1', [NO_GO_AHEAD]),
      refusedOn(9, 'h2', ["push at 2026-10-18T14:00:00Z by @ai-mr-reviewer (h2): go-ahead in note 1 doesn't count: @Ahmad-Faraj asked for this work, so someone else has to say go-ahead"]),
    ];
    const html = renderLedgerPage({ ledger, open, runs: [], counters: counters(ledger, open, []), web: WEB, generatedAt: '2026-10-20T11:00:00Z', commit: 'abcdef12' });
    expect(html).toContain(
      "18 Oct: 1 for no go-ahead from a person, 1 for a go-ahead that doesn't count (from the person who asked, or someone not allowed) or a push before the MR with no issue to hold one; counted from",
    );
  });

  // the CLI builds the open list with openPush: without the head, no run could
  // be matched to its push and every failed run would land under "other"
  it("keeps the push's head on an open push, so the run that refused it is matched to it", async () => {
    const own = loop.issue_notes.map((n) => (n.id === 4036138042 ? { ...n, author: { username: 'Ahmad-Faraj' } } : n));
    const { records, ledger } = await build({}, own);
    const open = [openPush(records[0], 'closed')];
    expect(open[0]).toEqual({
      mr: 26,
      mr_url: `${WEB}/-/merge_requests/26`,
      state: 'closed',
      agent: BUILDER,
      flow: 'issue-builder',
      pushed_at: '2026-10-17T22:13:04Z',
      head: AGENT_COMMIT,
      accepted: false,
      go_ahead: null,
      reasons: records[0].reasons,
    });
    const empty = chain(ledger.project, ledger.since, []);
    expect(counters(empty, open, [failedRun(26, 1, AGENT_COMMIT)]).refusals).toMatchObject({ refusingRuns: 1, laterRuns: [], otherRuns: [] });
  });

  it('renders the table and escapes what people and agents wrote', async () => {
    const { records } = await build();
    const ledger = chain('group/showcase', { commit: '06a116ff', at: '2026-10-17T20:11:08Z' }, [{ ...records[0], accepted: false, reasons: ['<script>alert(1)</script>'] }]);
    const html = renderLedgerPage({ ledger, open: [], runs: [], counters: counters(ledger, [], []), web: WEB, generatedAt: '2026-10-18T09:00:00Z', commit: 'abcdef12' });
    expect(html).toContain('<title>Go-ahead ledger</title>');
    expect(html).toContain(`href="${WEB}/-/issues/22#note_4036138042"`);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it("links the guard's pipeline, and says none when there was no pipeline", async () => {
    const { records } = await build();
    const since = { commit: '06a116ff', at: '2026-10-17T20:11:08Z' };
    const page = (guard: (typeof records)[0]['guard']) => {
      const ledger = chain('group/showcase', since, [{ ...records[0], guard }]);
      return renderLedgerPage({ ledger, open: [], runs: [], counters: counters(ledger, [], []), web: WEB, generatedAt: '2026-10-18T09:00:00Z', commit: 'abcdef12' });
    };
    const none = page({ pipeline: null, job: null, status: 'none' });
    expect(none).toContain('<span class="muted">guard: none</span>');
    expect(none).not.toContain('/-/pipelines/null');
    expect(page({ pipeline: 100, job: 6, status: 'success' })).toContain(`<a class="muted" href="${WEB}/-/pipelines/100">guard: success</a>`);
  });
});

// the reasons as checkMr and goAheadFor write them, from the #22 -> !26 loop
describe("what the guard refused a push for, from its own reasons", () => {
  const PROPOSAL = 4035973201;
  const GO_AHEAD = 4036138042;
  const pushReasons = async (over: Partial<MrFacts> = {}, issueNotes = loop.issue_notes, r: Repo = repo) => {
    const check = await checkMr(facts(over), config, r, async () => issueNotes);
    return check.problems.map((p) => p.text);
  };
  const only = (reasons: string[], start: RegExp) => {
    const found = reasons.filter((t) => start.test(t));
    expect(found).toHaveLength(1);
    return found;
  };

  it('no go-ahead: none mentioning the agent', async () => {
    const reasons = only(await pushReasons({}, loop.issue_notes.filter((n) => n.id !== GO_AHEAD)), /^push at /);
    expect(reasons[0]).toMatch(/: no go-ahead mentioning @/);
    expect(refusalKinds(reasons)).toEqual(['no go-ahead']);
  });

  it('no go-ahead: the agent wrote no proposal to give one to', async () => {
    const reasons = only(await pushReasons({}, loop.issue_notes.filter((n) => n.id !== PROPOSAL)), /^push at /);
    expect(reasons[0]).toMatch(/wrote no proposal before the push at/);
    expect(refusalKinds(reasons)).toEqual(['no go-ahead']);
  });

  it("a go-ahead that doesn't count: from the person who asked", async () => {
    const own = loop.issue_notes.map((n) => (n.id === GO_AHEAD ? { ...n, author: { username: 'Ahmad-Faraj' } } : n));
    const reasons = only(await pushReasons({}, own), /^push at /);
    expect(reasons[0]).toMatch(/go-ahead in note \d+ doesn't count: @Ahmad-Faraj asked for this work/);
    expect(refusalKinds(reasons)).toEqual(['go-ahead not counted']);
  });

  it("a go-ahead that doesn't count: not a maintainer at high risk", async () => {
    const reasons = only(await pushReasons({ tier: 'high' }), /^push at /);
    expect(reasons[0]).toMatch(/doesn't count: @Mazen-Ghanaym is not a maintainer/);
    expect(refusalKinds(reasons)).toEqual(['go-ahead not counted']);
  });

  it("a go-ahead that doesn't count: a push before the MR with no person's issue to hold it", async () => {
    const reasons = only(await pushReasons({ closes: [] }), /^push at /);
    expect(reasons[0]).toMatch(/ came before the MR, and GitLab lists no issue/);
    expect(refusalKinds(reasons)).toEqual(['go-ahead not counted']);
  });

  it('files only people may change', async () => {
    const reasons = only(await pushReasons({}, loop.issue_notes, { ...repo, files: () => ['engine/src/ledger.ts'] }), /^commit /);
    expect(reasons[0]).toMatch(/changes files only people may change: engine\/src\/ledger.ts/);
    expect(refusalKinds(reasons)).toEqual(['protected files']);
  });

  it('another rule: a merge commit, or a commit no push brought', async () => {
    const merge = only(await pushReasons({}, loop.issue_notes, { ...repo, parents: () => 2 }), /is a merge commit/);
    expect(refusalKinds(merge)).toEqual(['other']);
    const lost = only(await pushReasons({ commits: [MERGE_MAIN, AGENT_COMMIT, 'deadbeef'.padEnd(40, '0')] }), /is in no push GitLab recorded/);
    expect(refusalKinds(lost)).toEqual(['other']);
  });

  it('no reason at all is another rule, and a push with two reasons counts under both', async () => {
    expect(refusalKinds([])).toEqual(['other']);
    const noGoAhead = only(await pushReasons({}, loop.issue_notes.filter((n) => n.id !== GO_AHEAD)), /^push at /);
    const files = only(await pushReasons({}, loop.issue_notes, { ...repo, files: () => ['corpus/x.json'] }), /^commit /);
    expect(refusalKinds([...noGoAhead, ...files]).sort()).toEqual(['no go-ahead', 'protected files']);
  });

  it("the short reasons older tests use aren't the guard's words, so they count as another rule", () => {
    expect(refusalKinds(['no go-ahead'])).toEqual(['other']);
  });
});
