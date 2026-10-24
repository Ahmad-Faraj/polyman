import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { Note, PushEvent } from '../src/goahead.ts';
import { type BranchFacts, type BranchMr, checkBranch, coveringMr, issueOfBranch } from '../src/goahead-branch.ts';
import type { Repo } from '../src/goahead-mr.ts';

const config = loadConfig('../.autonomy.yml');
const REVIEWER = 'ai-mr-reviewer-gitlab-ai-hackathon_e50080';
const BUILDER = 'ai-issue-builder-gitlab-ai-hackathon_e1c791';
const BRANCH = '24-java-source-types-approved';
// the approved head !86 merged, and the review agent's commit on top of it (#64)
const MERGED = '6c58148c00000000000000000000000000000000';
const AGENT = '561d61ce00000000000000000000000000000000';
const SECOND = '7777777700000000000000000000000000000000';

const at = (time: string) => `2026-10-18T${time}Z`;
const event = (time: string, by: string, from: string | null, to: string | null, ref = BRANCH): PushEvent => ({
  created_at: at(time),
  author: { username: by },
  push_data: { ref, ref_type: 'branch', action: to ? (from ? 'pushed' : 'created') : 'removed', commit_from: from, commit_to: to },
});
const note = (id: number, time: string, author: string, body: string): Note => ({ id, body, system: false, created_at: at(time), author: { username: author } });

// a line of commits: MERGED <- AGENT <- SECOND
const order = [MERGED, AGENT, SECOND];
const repo = (over: Partial<Repo> = {}): Repo => ({
  isAncestor: (c, of) => order.indexOf(c) <= order.indexOf(of),
  has: () => true,
  parents: () => 1,
  files: () => ['tests/helpers/java.test.ts'],
  ...over,
});

const merged86: BranchMr = { iid: 86, state: 'merged', created_at: at('14:10:58'), merged_at: at('14:20:46') };
// as GitLab recorded #64: Ahmed's push, the merge, the branch deleted, then re-created by the review agent
const incident = [event('14:10:44', 'Ahmad-Faraj', null, MERGED), event('14:20:48', 'Ahmad-Faraj', MERGED, null), event('14:22:28', REVIEWER, null, AGENT)];

const facts = (over: Partial<BranchFacts> = {}): BranchFacts => ({
  branch: BRANCH,
  events: incident,
  commits: [AGENT],
  mrs: [merged86],
  issue: { iid: 24, author: { username: 'Ahmad-Faraj' } },
  since: '2026-10-16',
  ...over,
});

const check = (over: Partial<BranchFacts> = {}, notes: Note[] = [], r = repo()) => checkBranch(facts(over), config, r, async () => notes);

describe('the go-ahead guard on a branch with no open MR (#64)', () => {
  it("fails the review agent's push that re-created a merged MR's branch with a commit nobody approved", async () => {
    const result = await check();
    expect(result.openMr).toBeNull();
    expect(result.agentPushes).toHaveLength(1);
    expect(result.problems.map((p) => p.text)).toEqual([
      `push at ${at('14:22:28')} by @${REVIEWER} (561d61ce) on #24: @${REVIEWER} wrote no proposal before the push at ${at('14:22:28')}, so there was nothing to give a go-ahead to`,
    ]);
  });

  it("leaves a branch with an open MR to that MR's pipeline", async () => {
    const result = await check({ mrs: [merged86, { iid: 90, state: 'opened', created_at: at('14:30:00') }] });
    expect(result).toEqual({ openMr: 90, agentPushes: [], covered: [], problems: [] });
  });

  it("leaves an agent push to the MR that was open then: that MR's guard judged it", async () => {
    const events = [event('14:00:00', BUILDER, null, MERGED), event('14:15:00', REVIEWER, MERGED, AGENT)];
    const result = await check({ events, commits: [MERGED, AGENT] });
    expect(result.covered.map((c) => [c.push.pusher, c.mr])).toEqual([
      [BUILDER, 86],
      [REVIEWER, 86],
    ]);
    expect(result.agentPushes).toEqual([]);
    expect(result.problems).toEqual([]);
  });

  it("judges a push made after the branch's MR was closed", async () => {
    const closed: BranchMr = { iid: 86, state: 'closed', created_at: at('14:10:58'), closed_at: at('14:20:00') };
    const result = await check({ mrs: [closed], events: [event('14:10:44', 'Ahmad-Faraj', null, MERGED), event('14:22:28', REVIEWER, MERGED, AGENT)] });
    expect(result.covered).toEqual([]);
    expect(result.problems).toHaveLength(1);
  });

  it('judges a push made while an MR was open that was then closed unmerged: its guard may have failed on it', async () => {
    const closed: BranchMr = { iid: 86, state: 'closed', created_at: at('14:10:58'), closed_at: at('14:30:00') };
    const events = [event('14:10:44', 'Ahmad-Faraj', null, MERGED), event('14:15:00', REVIEWER, MERGED, AGENT)];
    const result = await check({ mrs: [closed], events });
    expect(result.covered).toEqual([]);
    expect(result.problems.map((p) => p.text)).toEqual([
      `push at ${at('14:15:00')} by @${REVIEWER} (561d61ce) on #24: @${REVIEWER} wrote no proposal before the push at ${at('14:15:00')}, so there was nothing to give a go-ahead to`,
    ]);
  });

  it("passes the issue-builder's push before its MR, with a maintainer's go-ahead on the issue after the proposal", async () => {
    const notes = [note(1, '14:00:00', BUILDER, 'Proposal for #24: the change'), note(2, '14:05:00', 'Mazen-Ghanaym', `@${BUILDER} go-ahead`)];
    const result = await check({ mrs: [], events: [event('14:22:28', BUILDER, null, AGENT)] }, notes);
    expect(result.problems).toEqual([]);
    expect(result.agentPushes.map((c) => c.line)).toEqual([`push at ${at('14:22:28')} by @${BUILDER} (561d61ce): go-ahead in note 2 on #24 by @Mazen-Ghanaym`]);
  });

  it("doesn't count the go-ahead of the person who wrote the issue", async () => {
    const notes = [note(1, '14:00:00', BUILDER, 'Proposal for #24: the change'), note(2, '14:05:00', 'Ahmad-Faraj', `@${BUILDER} go-ahead`)];
    const result = await check({ mrs: [], events: [event('14:22:28', BUILDER, null, AGENT)] }, notes);
    expect(result.problems[0].text).toMatch(/@Ahmad-Faraj asked for this work/);
  });

  it('judges with no score as high risk: a go-ahead from a non-maintainer does not count', async () => {
    const strict = { ...config, goAhead: { ...config.goAhead, maintainers: ['HamzaHassanain'] } };
    const notes = [note(1, '14:00:00', BUILDER, 'Proposal for #24: the change'), note(2, '14:05:00', 'Mazen-Ghanaym', `@${BUILDER} go-ahead`)];
    const result = await checkBranch(facts({ mrs: [], events: [event('14:22:28', BUILDER, null, AGENT)] }), strict, repo(), async () => notes);
    expect(result.problems[0].text).toMatch(/not a maintainer; high risk needs @HamzaHassanain/);
  });

  it('needs a new go-ahead for a second push', async () => {
    const notes = [note(1, '14:00:00', BUILDER, 'Proposal for #24: the change'), note(2, '14:05:00', 'Mazen-Ghanaym', `@${BUILDER} go-ahead`)];
    const events = [event('14:22:28', BUILDER, null, AGENT), event('14:30:00', BUILDER, AGENT, SECOND)];
    const result = await check({ mrs: [], events, commits: [AGENT, SECOND] }, notes);
    expect(result.agentPushes.map((c) => c.verdict.ok)).toEqual([true, false]);
    expect(result.problems[0].text).toMatch(/between its previous push at 2026-10-18T14:22:28Z/);
  });

  it('needs a new go-ahead for each branch named after the same issue: one go-ahead clears one push', async () => {
    const notes = [note(1, '14:00:00', BUILDER, 'Proposal for #24: the change'), note(2, '14:05:00', 'Mazen-Ghanaym', `@${BUILDER} go-ahead`)];
    const events = [event('14:10:00', BUILDER, null, AGENT, '24-a'), event('14:11:00', BUILDER, null, AGENT, '24-b'), event('14:12:00', BUILDER, null, AGENT, '24-c')];
    const results = await Promise.all(['24-a', '24-b', '24-c'].map((branch) => check({ branch, mrs: [], events }, notes)));
    expect(results.map((r) => r.agentPushes.map((c) => c.verdict.ok))).toEqual([[true], [false], [false]]);
    expect(results[1].problems[0].text).toMatch(/between its previous push at 2026-10-18T14:10:00Z and the push at 2026-10-18T14:11:00Z/);
    expect(results[2].problems[0].text).toMatch(/between its previous push at 2026-10-18T14:11:00Z/);
  });

  it("doesn't count a push to a branch of another issue as using up the go-ahead", async () => {
    const notes = [note(1, '14:00:00', BUILDER, 'Proposal for #24: the change'), note(2, '14:05:00', 'Mazen-Ghanaym', `@${BUILDER} go-ahead`)];
    const events = [event('14:10:00', BUILDER, null, AGENT, '240-a'), event('14:11:00', BUILDER, null, AGENT, '24-b')];
    const result = await check({ branch: '24-b', mrs: [], events }, notes);
    expect(result.problems).toEqual([]);
  });

  it('judges an agent push that brought no commits (a rewind)', async () => {
    const events = [event('14:10:44', 'Ahmad-Faraj', null, AGENT), event('14:22:28', REVIEWER, AGENT, MERGED)];
    const result = await check({ mrs: [], events, commits: [] });
    expect(result.problems[0].text).toMatch(/by @ai-mr-reviewer.*\(no new commits, head 6c58148c\) on #24: .*wrote no proposal/);
  });

  it('fails an agent push to a branch that names no issue', async () => {
    const result = await check({ branch: 'review-leftovers', events: [event('14:22:28', REVIEWER, null, AGENT, 'review-leftovers')], issue: null });
    expect(result.problems[0].text).toMatch(/went to review-leftovers, which has no MR, and the branch names no issue written by a person/);
  });

  it("doesn't take an issue an agent wrote as someone asking", async () => {
    const result = await check({ issue: { iid: 24, author: { username: REVIEWER } } });
    expect(result.problems[0].text).toMatch(/names no issue written by a person/);
  });

  it('passes a branch only people pushed to', async () => {
    const result = await check({ mrs: [], events: [event('14:22:28', 'HamzaHassanain', null, AGENT)] });
    expect(result).toEqual({ openMr: null, agentPushes: [], covered: [], problems: [] });
  });

  it('fails a commit no recorded push accounts for', async () => {
    const result = await check({ mrs: [], events: [] });
    expect(result.problems[0].text).toMatch(/commit 561d61ce is in no push GitLab recorded for 24-java-source-types-approved/);
  });

  it('fails an agent commit that changes a governance path, even with a go-ahead', async () => {
    const notes = [note(1, '14:00:00', BUILDER, 'Proposal for #24: the change'), note(2, '14:05:00', 'Mazen-Ghanaym', `@${BUILDER} go-ahead`)];
    const result = await check({ mrs: [], events: [event('14:22:28', BUILDER, null, AGENT)] }, notes, repo({ files: () => ['engine/src/goahead.ts'] }));
    expect(result.problems.map((p) => p.text)).toEqual([`commit 561d61ce pushed by @${BUILDER} changes files only people may change: engine/src/goahead.ts`]);
  });

  it('fails an agent merge commit', async () => {
    const notes = [note(1, '14:00:00', BUILDER, 'Proposal for #24: the change'), note(2, '14:05:00', 'Mazen-Ghanaym', `@${BUILDER} go-ahead`)];
    const result = await check({ mrs: [], events: [event('14:22:28', BUILDER, null, AGENT)] }, notes, repo({ parents: () => 2 }));
    expect(result.problems[0].text).toMatch(/is a merge commit; agents may not push merges/);
  });
});

describe('issueOfBranch', () => {
  it('reads the issue from a branch named "<iid>-..."', () => {
    expect(issueOfBranch('24-java-source-types-approved')).toBe(24);
    expect(issueOfBranch('102-linear-script-parsing-v2')).toBe(102);
  });

  it('finds none in other names', () => {
    expect(issueOfBranch('fix/64-guard')).toBeNull();
    expect(issueOfBranch('24')).toBeNull();
    expect(issueOfBranch('0-zero')).toBeNull();
    expect(issueOfBranch('v24-x')).toBeNull();
  });
});

describe('coveringMr', () => {
  const push = { at: at('14:22:28'), pusher: REVIEWER, from: null, to: AGENT };

  it('an MR still open, or opened after the push, covers it', () => {
    expect(coveringMr(push, [{ iid: 1, state: 'opened', created_at: at('10:00:00') }])?.iid).toBe(1);
    expect(coveringMr(push, [{ iid: 2, state: 'merged', created_at: at('15:00:00'), merged_at: at('16:00:00') }])?.iid).toBe(2);
  });

  it('an MR that ended before the push does not', () => {
    expect(coveringMr(push, [merged86])).toBeUndefined();
  });

  it('a closed MR never does, whenever it opened', () => {
    expect(coveringMr(push, [{ iid: 3, state: 'closed', created_at: at('10:00:00'), closed_at: at('16:00:00') }])).toBeUndefined();
    expect(coveringMr(push, [{ iid: 5, state: 'closed', created_at: at('15:00:00'), closed_at: at('16:00:00') }])).toBeUndefined();
    expect(coveringMr(push, [{ iid: 7, state: 'closed', created_at: at('15:00:00') }])).toBeUndefined();
  });

  it('a merged MR with no merge time on record covers only pushes before it opened', () => {
    expect(coveringMr(push, [{ iid: 4, state: 'merged', created_at: at('10:00:00'), merged_at: null }])).toBeUndefined();
    expect(coveringMr(push, [{ iid: 6, state: 'merged', created_at: at('15:00:00'), merged_at: null }])?.iid).toBe(6);
  });
});
