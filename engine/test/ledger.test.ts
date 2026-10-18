import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { Note, PushEvent } from '../src/goahead.ts';
import { type MrFacts, type Repo, checkMr } from '../src/goahead-mr.ts';
import { GENESIS, type Ledger, canonical, chain, compare, counters, recordHash, recordsFor, second, sha256, verifyChain } from '../src/ledger.ts';
import { renderLedgerPage } from '../src/ledger-page.ts';

// the first Assisted loop, #22 -> !26, as GitLab's API returned it
const loop = JSON.parse(readFileSync('test/fixtures/ledger/loop-22-26.json', 'utf8')) as {
  issue_notes: Note[];
  mr_notes: Note[];
  events: PushEvent[];
  mr: { iid: number; author: { username: string }; created_at: string; merged_at: string; source_branch: string; head_pipeline: { id: number } };
  closes: { iid: number; author: { username: string } }[];
};
const config = loadConfig('../.autonomy.yml');
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

describe('the counters and the page', () => {
  it('counts go-aheads by person, approver != requester and the pushes stopped', async () => {
    const { ledger, records } = await build();
    const refused = { ...records[0], mr: 60, accepted: false, go_ahead: null, approver_not_requester: null, reasons: ['no go-ahead'] };
    const both = chain(ledger.project, ledger.since, [...records, refused]);
    const open = [{ mr: 61, mr_url: '', state: 'opened', agent: BUILDER, flow: 'issue-builder', pushed_at: '', accepted: false, go_ahead: null, reasons: ['x'] }];
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
    });
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
