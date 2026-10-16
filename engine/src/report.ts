import type { Tier } from './config.ts';
import type { RiskReport } from './risk.ts';

/** Markers around the summary in the assess job log, so the reviewer agent can find it. */
export const SUMMARY_START = '----- risk summary -----';
export const SUMMARY_END = '----- end risk summary -----';

const TIER_REVIEW: Record<Tier, string> = {
  low: "GitLab's Code Review flow reviews it; the lead reviewer writes the summary.",
  medium: 'Code and test reviewers.',
  high: 'Security, code and test reviewers.',
};

/** The risk breakdown the reviewer copies into its note for the approver. */
export function renderRiskSummary(report: RiskReport, reports: string[] = []): string {
  const f = report.stats.findings;
  const rows = [...report.factors]
    .sort((a, b) => b.points - a.points)
    .map((x) => `| ${x.detail.replace(/\|/g, '\\|')} | +${x.points} |`);
  return [
    `Risk: ${report.tier} (${report.score}/100). Review: ${TIER_REVIEW[report.tier]}`,
    report.forcedBy ? `High risk because ${report.forcedBy}.` : '',
    rows.length ? '| Why | Score |\n|---|---|\n' + rows.join('\n') : 'Nothing risky stood out in this change.',
    `Security scans: ${f.Critical} critical, ${f.High} high, ${f.Medium} medium` +
      (reports.length ? '' : ' (no scanner reports found)') +
      `. ${report.stats.files} files, ${report.stats.linesChanged} lines.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
