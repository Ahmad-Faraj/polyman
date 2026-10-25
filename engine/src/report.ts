import type { Tier } from './config.ts';
import type { Finding, RiskReport } from './risk.ts';

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
    findingsList(report.counted ?? []),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The findings that counted, one line each, so a reviewer reads these instead of
 * the project's whole scanner report (most of it is on lines this change didn't
 * write). At most 25; the rest are counted.
 */
function findingsList(findings: Finding[]): string {
  if (!findings.length) return 'Findings on the lines this change wrote: none.';
  const rank: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3, Info: 4, Unknown: 5 };
  const sorted = [...findings].sort((a, b) => rank[a.severity] - rank[b.severity]);
  const lines = sorted
    .slice(0, 25)
    .map((f) => `- ${f.severity}: ${f.name.replace(/\s+/g, ' ').slice(0, 120)} (${f.scanner}) at ${f.file ?? 'no file'}${f.line ? `:${f.line}` : ''}`);
  const more = sorted.length > 25 ? [`- and ${sorted.length - 25} more`] : [];
  return ['Findings on the lines this change wrote:', ...lines, ...more].join('\n');
}
