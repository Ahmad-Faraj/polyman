import { describe, expect, it } from 'vitest';
import { renderRiskSummary, SUMMARY_END, SUMMARY_START } from '../src/report.ts';
import type { RiskReport } from '../src/risk.ts';

const base = (over: Partial<RiskReport> = {}): RiskReport => ({
  score: 12,
  tier: 'low',
  forcedBy: null,
  factors: [{ id: 'paths.medium', points: 12, detail: 'medium path touched: src/routes/orders.ts' }],
  stats: { files: 2, linesChanged: 18, findings: { Critical: 0, High: 0, Medium: 0, Low: 0, Info: 0, Unknown: 0 } },
  counted: [],
  ...over,
});

describe('renderRiskSummary', () => {
  it('starts with the tier and score the reviewer reads', () => {
    expect(renderRiskSummary(base(), ['gl-sast-report.json']).split('\n')[0]).toMatch(/^Risk: low \(12\/100\)/);
  });

  it('names who reviews each tier', () => {
    expect(renderRiskSummary(base())).toMatch(/GitLab's Code Review flow/);
    expect(renderRiskSummary(base({ tier: 'medium' }))).toMatch(/Code and test reviewers/);
    expect(renderRiskSummary(base({ tier: 'high' }))).toMatch(/Security, code and test reviewers/);
  });

  it('explains a forced high tier and lists factors by weight', () => {
    const text = renderRiskSummary(
      base({
        tier: 'high',
        score: 52,
        forcedBy: 'it changes the pipeline or its policy (.gitlab-ci.yml)',
        factors: [
          { id: 'size', points: 12, detail: '200 lines changed across 4 files' },
          { id: 'governance', points: 40, detail: 'pipeline/policy files changed: .gitlab-ci.yml' },
        ],
      }),
    );
    expect(text).toMatch(/High risk because it changes the pipeline/);
    expect(text.indexOf('+40')).toBeLessThan(text.indexOf('+12'));
  });

  it('says when no scanner reports were found', () => {
    expect(renderRiskSummary(base(), [])).toMatch(/no scanner reports found/);
    expect(renderRiskSummary(base(), ['gl-sast-report.json'])).not.toMatch(/no scanner reports/);
  });

  it('has markers the reviewer can search the job log for', () => {
    expect(SUMMARY_START).not.toEqual(SUMMARY_END);
    expect(SUMMARY_START).toMatch(/risk summary/);
  });

  it('says nothing risky stood out when there are no factors, and has no table', () => {
    const text = renderRiskSummary(base({ score: 0, factors: [] }));
    expect(text).toContain('Nothing risky stood out in this change.');
    expect(text).not.toContain('| Why |');
  });

  it('escapes pipes in factor details so the table stays intact', () => {
    const text = renderRiskSummary(base({ factors: [{ id: 'x', points: 3, detail: 'a|b' }] }));
    expect(text).toContain('| a\\|b | +3 |');
  });

  it('reports scan counts, file and line totals, and omits the forced line when not forced', () => {
    const findings = { Critical: 1, High: 2, Medium: 3, Low: 0, Info: 0, Unknown: 0 };
    const text = renderRiskSummary(base({ stats: { files: 5, linesChanged: 99, findings } }), ['r.json']);
    expect(text).toContain('Security scans: 1 critical, 2 high, 3 medium. 5 files, 99 lines.');
    expect(text).not.toContain('High risk because');
  });

  it('lists the findings on the lines the change wrote, worst first', () => {
    const text = renderRiskSummary(
      base({
        counted: [
          { scanner: 'sast', severity: 'Low', name: 'Weak  hash', file: 'src/a.ts', line: 4 },
          { scanner: 'secret_detection', severity: 'Critical', name: 'API key', file: 'src/b.ts' },
        ],
      }),
    );
    expect(text).toMatch(/Findings on the lines this change wrote:\n- Critical: API key \(secret_detection\) at src\/b.ts\n- Low: Weak hash \(sast\) at src\/a.ts:4/);
  });

  it('says so when no finding is on a written line', () => {
    expect(renderRiskSummary(base())).toMatch(/Findings on the lines this change wrote: none\./);
  });
});
