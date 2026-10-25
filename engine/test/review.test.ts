import { afterEach, describe, expect, it, vi } from 'vitest';

// review.ts reads its env overrides once, at module load, so each case sets the
// env and imports a fresh copy.
const saved = { ...process.env };

async function load(env: { reviewer?: string; fixer?: string } = {}) {
  delete process.env.AUTONOMY_REVIEWER_ACCOUNT;
  delete process.env.AUTONOMY_FIXER_ACCOUNT;
  if (env.reviewer !== undefined) process.env.AUTONOMY_REVIEWER_ACCOUNT = env.reviewer;
  if (env.fixer !== undefined) process.env.AUTONOMY_FIXER_ACCOUNT = env.fixer;
  vi.resetModules();
  return import('../src/review.ts');
}

const review = (username?: string, body = 'Review of abc1234: ready.') => ({ body, author: username ? { username } : undefined });
const fix = (username?: string, body = 'Pipeline fix: done') => ({ body, author: username ? { username } : undefined });

afterEach(() => {
  process.env = { ...saved };
});

describe('review notes: default account patterns', () => {
  it('accepts the default reviewer and fixer accounts only', async () => {
    const { isReviewNote, isPipelineFixNote } = await load();
    expect(isReviewNote(review('ai-mr-reviewer-gitlab-ai-hackathon_dc1918'))).toBe(true);
    expect(isPipelineFixNote(fix('ai-pipeline-fixer-gitlab-ai-hackathon'))).toBe(true);
    expect(isReviewNote(review('someone'))).toBe(false);
    expect(isPipelineFixNote(fix('someone'))).toBe(false);
  });

  // a review that lost a specialist starts "Incomplete review of", so the head still counts as not reviewed
  it('does not take an incomplete review for a review of the head', async () => {
    const { isReviewNote } = await load();
    expect(isReviewNote(review('ai-mr-reviewer-gitlab-ai-hackathon_dc1918', 'Incomplete review of abc1234: security_reviewer failed'))).toBe(false);
  });

  it('does not let one agent write the other agent\'s notes', async () => {
    const { isReviewNote, isPipelineFixNote } = await load();
    expect(isReviewNote(review('ai-pipeline-fixer-gitlab-ai-hackathon'))).toBe(false);
    expect(isPipelineFixNote(fix('ai-mr-reviewer-gitlab-ai-hackathon_dc1918'))).toBe(false);
  });

  it('needs the exact account, not just the prefix', async () => {
    const { isReviewNote, isPipelineFixNote } = await load();
    expect(isReviewNote(review('ai-mr-reviewer-x'))).toBe(false);
    expect(isReviewNote(review('evil-ai-mr-reviewer-gitlab-ai-hackathon_dc1918'))).toBe(false);
    expect(isPipelineFixNote(fix('ai-pipeline-fixer-gitlab-ai-hackathon2'))).toBe(false);
  });

  it('a blank variable keeps the default accounts', async () => {
    const { isReviewNote, isPipelineFixNote } = await load({ reviewer: '', fixer: ' ' });
    expect(isReviewNote(review('someone'))).toBe(false);
    expect(isReviewNote(review('ai-mr-reviewer-gitlab-ai-hackathon_dc1918'))).toBe(true);
    expect(isPipelineFixNote(fix('someone'))).toBe(false);
  });

  it('an empty variable accepts the default reviewer and fixer, and nobody else', async () => {
    const { isReviewNote, isPipelineFixNote } = await load({ reviewer: '', fixer: '' });
    expect(isReviewNote(review('ai-mr-reviewer-gitlab-ai-hackathon_dc1918'))).toBe(true);
    expect(isPipelineFixNote(fix('ai-pipeline-fixer-gitlab-ai-hackathon'))).toBe(true);
    expect(isReviewNote(review('someone'))).toBe(false);
    expect(isPipelineFixNote(fix('someone'))).toBe(false);
  });

  // a value with no account names in it used to leave an empty allow-list
  it.each([' ', ',', ' , ', ',,'])('a variable of %j keeps the default reviewer and fixer', async (blank) => {
    const { isReviewNote, isPipelineFixNote } = await load({ reviewer: blank, fixer: blank });
    expect(isReviewNote(review('ai-mr-reviewer-gitlab-ai-hackathon_dc1918'))).toBe(true);
    expect(isPipelineFixNote(fix('ai-pipeline-fixer-gitlab-ai-hackathon'))).toBe(true);
  });

  it('a whitespace-only or comma-only variable never lets a stranger in', async () => {
    for (const blank of [' ', ',', ' , ']) {
      const { isReviewNote, isPipelineFixNote } = await load({ reviewer: blank, fixer: blank });
      expect(isReviewNote(review('someone'))).toBe(false);
      expect(isPipelineFixNote(fix('someone'))).toBe(false);
    }
  });

  it('a list ignores spaces and empty entries, and matches names exactly', async () => {
    const { isReviewNote, isPipelineFixNote } = await load({ reviewer: ' a-bot ,, b-bot,', fixer: 'fix-bot' });
    expect(isReviewNote(review('a-bot'))).toBe(true);
    expect(isReviewNote(review('b-bot'))).toBe(true);
    expect(isReviewNote(review('a-bot2'))).toBe(false);
    expect(isReviewNote(review('A-BOT'))).toBe(false);
    expect(isReviewNote(review('a-bot,b-bot'))).toBe(false);
    // the two lists are independent
    expect(isPipelineFixNote(fix('fix-bot'))).toBe(true);
    expect(isPipelineFixNote(fix('a-bot'))).toBe(false);
    expect(isReviewNote(review('fix-bot'))).toBe(false);
  });

  it('a custom list does not accept regex syntax', async () => {
    const { isReviewNote } = await load({ reviewer: '^bot-.*' });
    expect(isReviewNote(review('bot-1'))).toBe(false);
    expect(isReviewNote(review('^bot-.*'))).toBe(true);
  });

  it('rejects a note with no author, and still needs the right first line', async () => {
    const { isReviewNote, isPipelineFixNote } = await load();
    const r = 'ai-mr-reviewer-gitlab-ai-hackathon_dc1918';
    const f = 'ai-pipeline-fixer-gitlab-ai-hackathon';
    expect(isReviewNote(review(undefined))).toBe(false);
    expect(isPipelineFixNote(fix(undefined))).toBe(false);
    expect(isReviewNote(review(r, 'Looks fine to me'))).toBe(false);
    expect(isReviewNote(review(r, 'Review of abc12: too short'))).toBe(false);
    expect(isReviewNote(review(r, '  \n**Review of ABC1234:** shouty sha'))).toBe(true);
    expect(isPipelineFixNote(fix(f, 'Fixed the pipeline'))).toBe(false);
    expect(isPipelineFixNote(fix(f, '**Pipeline fix:** done'))).toBe(true);
  });

  it('a project can name its own accounts, several if needed', async () => {
    const { isReviewNote } = await load({ reviewer: 'our-reviewer, other-reviewer' });
    expect(isReviewNote(review('other-reviewer'))).toBe(true);
    expect(isReviewNote(review('ai-mr-reviewer-gitlab-ai-hackathon_dc1918'))).toBe(false);
  });
});
