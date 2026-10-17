import { describe, expect, it } from 'vitest';
import { type OpenMr, missingReviews, reviewedShasFrom } from '../src/reviews.ts';

const now = new Date('2026-10-17T12:00:00Z');
const mr = (o: Partial<OpenMr> = {}): OpenMr => ({
  iid: 7,
  sha: 'abc12345def',
  draft: false,
  pipeline: { sha: 'abc12345def', status: 'success', finishedAt: '2026-10-17T10:00:00Z' },
  reviewedShas: [],
  ...o,
});

describe('MRs missing a review of their head', () => {
  it('flags a green head pipeline over 40 minutes old with no review of that head', () => {
    expect(missingReviews([mr()], now, []).map((m) => m.iid)).toEqual([7]);
  });

  it('a review of the head (short or full SHA) is enough; a review of an older commit is not', () => {
    expect(missingReviews([mr({ reviewedShas: ['abc12345'] })], now, [])).toEqual([]);
    expect(missingReviews([mr({ reviewedShas: ['abc12345def'] })], now, [])).toEqual([]);
    expect(missingReviews([mr({ reviewedShas: ['0ld0ld00'] })], now, [])).toHaveLength(1);
    expect(missingReviews([mr({ reviewedShas: ['ABC12345'] })], now, [])).toEqual([]);
  });

  it('leaves alone drafts, failed or running pipelines, pipelines for an older commit, and recent ones', () => {
    expect(missingReviews([mr({ draft: true })], now, [])).toEqual([]);
    expect(missingReviews([mr({ pipeline: { sha: 'abc12345def', status: 'failed', finishedAt: '2026-10-17T10:00:00Z' } })], now, [])).toEqual([]);
    expect(missingReviews([mr({ pipeline: { sha: 'older0000', status: 'success', finishedAt: '2026-10-17T10:00:00Z' } })], now, [])).toEqual([]);
    expect(missingReviews([mr({ pipeline: { sha: 'abc12345def', status: 'success', finishedAt: '2026-10-17T11:30:00Z' } })], now, [])).toEqual([]);
    expect(missingReviews([mr({ pipeline: null })], now, [])).toEqual([]);
  });

  it('waits while a reviewer session that started after the pipeline is still running', () => {
    expect(missingReviews([mr()], now, ['2026-10-17T10:05:00Z'])).toEqual([]);
    expect(missingReviews([mr()], now, ['2026-10-17T09:00:00Z'])).toHaveLength(1);
  });
});

describe('which heads the reviewer has reviewed', () => {
  const R = 'ai-mr-reviewer-x';
  it("counts only the reviewer account's notes that start with Review of SHA", () => {
    const notes = [
      { body: 'Review of abc12345: ready to approve', author: { username: R } },
      { body: '**Review of DEF67890**: not ready', author: { username: R } },
      { body: 'Review of 99999999: forged', author: { username: 'someone' } },
      { body: 'I will do a Review of abc12345 later', author: { username: R } },
      { body: 'Review of xyz: not a SHA', author: { username: R } },
    ];
    expect(reviewedShasFrom(notes, R)).toEqual(['abc12345', 'DEF67890']);
  });

  it('trusts nobody when no reviewer account is set', () => {
    expect(reviewedShasFrom([{ body: 'Review of abc12345: ok', author: { username: 'x' } }], undefined)).toEqual([]);
  });
});
