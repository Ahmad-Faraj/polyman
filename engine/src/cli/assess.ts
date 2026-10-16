/**
 * Scores the current change and writes:
 *   risk-report.json  full machine-readable report
 *   autonomy.env      dotenv for downstream jobs (AUTONOMY_TIER, AUTONOMY_SCORE)
 *   metrics.txt       OpenMetrics for the MR metrics widget
 * and prints a markdown summary between markers in the job log. The engine
 * doesn't comment on the MR itself; the mr-reviewer agent reads this log and
 * puts the summary in its note.
 */
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { changedFiles, loadIncidents, securityFindings } from '../inputs.ts';
import { assessRisk } from '../risk.ts';
import { GitLab } from '../gitlab.ts';
import { renderRiskSummary, SUMMARY_END, SUMMARY_START } from '../report.ts';

const env = process.env;
const baseRef = process.argv[2] ?? (env.CI_MERGE_REQUEST_DIFF_BASE_SHA || `origin/${env.CI_DEFAULT_BRANCH ?? 'main'}`);

const config = loadConfig(env.AUTONOMY_CONFIG ?? '.autonomy.yml');
const files = changedFiles(baseRef);
const { findings, reports } = securityFindings(env.AUTONOMY_REPORTS_DIR ?? '.');
const report = assessRisk(files, findings, config, loadIncidents(config.incidentsFile));

writeFileSync('risk-report.json', JSON.stringify({ ...report, baseRef, reports, files, findings }, null, 2));
writeFileSync('autonomy.env', `AUTONOMY_TIER=${report.tier}\nAUTONOMY_SCORE=${report.score}\n`);
writeFileSync(
  'metrics.txt',
  [
    `autonomy_risk_score ${report.score}`,
    `autonomy_files_changed ${report.stats.files}`,
    `autonomy_lines_changed ${report.stats.linesChanged}`,
    `autonomy_security_findings ${findings.length}`,
  ].join('\n') + '\n',
);

console.log(`risk ${report.score}/100 -> ${report.tier}${report.forcedBy ? ` (forced: ${report.forcedBy})` : ''}`);
for (const f of report.factors) console.log(`  +${String(f.points).padStart(2)} ${f.id}: ${f.detail}`);
console.log(`scanner reports: ${reports.length ? reports.join(', ') : 'none'}`);
console.log([SUMMARY_START, renderRiskSummary(report, reports), SUMMARY_END].join('\n'));

// Name the pipeline after the result so the tier shows in the pipeline list and
// the reviewer can read it from the pipeline API. The job token may set this.
if (env.CI_PIPELINE_ID && env.CI_JOB_TOKEN) {
  const top = [...report.factors].sort((a, b) => b.points - a.points)[0];
  const name = `risk ${report.tier} ${report.score}/100${top ? ` - ${top.detail}` : ''}`.slice(0, 250);
  await new GitLab()
    .put(`/:project/pipelines/${env.CI_PIPELINE_ID}/metadata`, { name })
    .then(() => console.log(`pipeline name: ${name}`))
    .catch((err) => console.warn(`could not name the pipeline: ${err.message}`));
}
