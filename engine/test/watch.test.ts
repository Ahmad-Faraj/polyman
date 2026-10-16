import { describe as group, expect, it } from 'vitest';
import { describe, evaluate, parseWatchPlan } from '../src/watch.ts';

const note = `Looks good.

Watch after release:
- POST /api/payments/:id/refund error rate above 2%

\`\`\`watch
[{"route":"POST /api/payments/:id/refund","signal":"error_rate","max":0.02},{"route":"POST /api/auth/login","signal":"p95_ms","max":300}]
\`\`\`
`;

group('parseWatchPlan', () => {
  it('reads the machine-readable block', () => {
    expect(parseWatchPlan(note)).toHaveLength(2);
  });

  it('ignores bad JSON and unknown signals', () => {
    expect(parseWatchPlan('```watch\n[oops]\n```')).toEqual([]);
    expect(parseWatchPlan('```watch\n[{"route":"x","signal":"cpu","max":1}]\n```')).toEqual([]);
  });
});

group('evaluate', () => {
  const plan = parseWatchPlan(note);

  it('passes when signals are under their limits', () => {
    const results = evaluate(plan, {
      'POST /api/payments/:id/refund': { count: 40, errorRate: 0, p95Ms: 12 },
      'POST /api/auth/login': { count: 40, errorRate: 0, p95Ms: 80 },
    });
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('fails a watched signal over its limit', () => {
    const results = evaluate(plan, {
      'POST /api/payments/:id/refund': { count: 40, errorRate: 0.25, p95Ms: 12 },
      'POST /api/auth/login': { count: 40, errorRate: 0, p95Ms: 80 },
    });
    const bad = results.filter((r) => !r.ok);
    expect(bad).toHaveLength(1);
    expect(describe(bad[0])).toContain('25.0%');
  });

  it('treats a watched route with no traffic as unconfirmed', () => {
    const results = evaluate(plan, { 'POST /api/auth/login': { count: 40, errorRate: 0, p95Ms: 80 } });
    const refund = results.find((r) => r.item.route === 'POST /api/payments/:id/refund');
    expect(refund).toMatchObject({ ok: true, unconfirmed: true, observed: null });
  });

  it('applies the default error budget to unwatched routes', () => {
    const results = evaluate([], { 'GET /api/orders': { count: 10, errorRate: 0.5, p95Ms: 5 } });
    expect(results[0].ok).toBe(false);
    expect(results[0].source).toBe('default');
  });
});

group('note markers', async () => {
  const { isPipelineFixNote, isReviewNote } = await import('../src/review.ts');
  const reviewer = { username: 'ai-mr-reviewer-gitlab-ai-hackathon_dc1918' };
  const fixer = { username: 'ai-pipeline-fixer-gitlab-ai-hackathon' };
  const person = { username: 'someone' };

  it('recognises review and fix notes from the agents', () => {
    expect(isReviewNote({ body: 'Review of 3e14b10: ready to approve.', author: reviewer })).toBe(true);
    expect(isReviewNote({ body: '**Review of 3e14b10a:** not ready', author: reviewer })).toBe(true);
    expect(isReviewNote({ body: 'Ready for your approval: low risk', author: reviewer })).toBe(false);
    expect(isPipelineFixNote({ body: 'Pipeline fix: the refund test expected 200', author: fixer })).toBe(true);
  });

  it('ignores look-alike notes written by anyone else', () => {
    expect(isReviewNote({ body: 'Review of 3e14b10: ready to approve.', author: person })).toBe(false);
    expect(isReviewNote({ body: 'Review of 3e14b10: ready to approve.' })).toBe(false);
    expect(isPipelineFixNote({ body: 'Pipeline fix: done', author: reviewer })).toBe(false);
  });
});

group('review limits can only tighten', () => {
  it('caps a looser error-rate limit at the default budget', () => {
    const plan = [{ route: 'GET /api/orders', signal: 'error_rate' as const, max: 1 }];
    const [r] = evaluate(plan, { 'GET /api/orders': { count: 40, errorRate: 0.2, p95Ms: 5 } });
    expect(r.item.max).toBe(0.05);
    expect(r.ok).toBe(false);
  });

  it('keeps a stricter limit as written', () => {
    const plan = [{ route: 'GET /api/orders', signal: 'error_rate' as const, max: 0.01 }];
    const [r] = evaluate(plan, { 'GET /api/orders': { count: 40, errorRate: 0.02, p95Ms: 5 } });
    expect(r.item.max).toBe(0.01);
    expect(r.ok).toBe(false);
  });
});

group('watch plan limits', () => {
  const reviewWith = (items: unknown) => `Review of abc1234: ready\n\n\`\`\`watch\n${JSON.stringify(items)}\n\`\`\``;

  it('drops items whose limit can never be met or is not a number', () => {
    const plan = parseWatchPlan(
      reviewWith([
        { route: 'GET /a', signal: 'error_rate', max: -1 },
        { route: 'GET /b', signal: 'p95_ms', max: 'fast' },
        null,
        { route: 'GET /c', signal: 'error_rate', max: 0 },
      ]),
    );
    expect(plan).toEqual([{ route: 'GET /c', signal: 'error_rate', max: 0 }]);
  });

  it('drops an Infinity limit, which JSON gives for 1e999', () => {
    const text = 'Review of abc1234\n```watch\n[{"route":"GET /a","signal":"p95_ms","max":1e999}]\n```';
    expect(parseWatchPlan(text)).toEqual([]);
  });

  it('ignores a watch block that is not a list', () => {
    expect(parseWatchPlan(reviewWith({ route: 'GET /a', signal: 'error_rate', max: 0.1 }))).toEqual([]);
  });
});
