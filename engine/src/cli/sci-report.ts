/**
 * The SCI report CI shows (job autonomy:sci): from the counted agent sessions
 * and .autonomy.yml's coefficients, a GitLab metrics report for the MR widget,
 * a page for Pages (/sci/) and a summary in the job log. With --if, it checks
 * the Impact Framework's run of the committed manifest against sci.ts review
 * by review and fails if they disagree. With --ci, it adds the runner
 * footprint of CI itself, measured from job times: this MR's finished
 * pipelines, or on the default branch its last 10 successful push pipelines.
 * That part reads the GitLab API and is skipped with a warning if it can't.
 *
 * Exit codes: 0 the figures agree, 1 the Impact Framework disagrees (the
 * report is still written), 2 bad arguments or input.
 *
 *   node engine/src/cli/sci-report.ts [--sessions sustainability/agent-tokens.json] [--if if-output.yaml] [--out sci] [--ci]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadConfig } from '../config.ts';
import { GitLab, GitLabError } from '../gitlab.ts';
import { type CiFootprint, type SessionRecord, checkIfRun, ciFootprint, invalidInput, markdownSummary, metricsText, renderSciPage, summarize } from '../sci-report.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const argv = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) fail(`${name} needs a value`);
  return value;
};
const sessionsFile = opt('--sessions', 'sustainability/agent-tokens.json')!;
const ifFile = opt('--if');
const outDir = opt('--out', 'sci')!;
const env = process.env;

const read = <T>(file: string, what: string, parser: (text: string) => T): T => {
  try {
    return parser(readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`can't read ${what} in ${file}: ${(err as Error).message}`);
  }
};
const data = read(sessionsFile, 'the sessions', JSON.parse) as { sessions: SessionRecord[]; coefficients?: { gridGramsPerKwh?: number } } | null;
const coefficients = loadConfig().sustainability;
const invalid = invalidInput(data?.sessions, coefficients, data?.coefficients?.gridGramsPerKwh);
if (invalid || !data) fail(`${sessionsFile} or .autonomy.yml: ${invalid}`);
const summary = summarize(data.sessions, coefficients, data.coefficients?.gridGramsPerKwh);
const check = ifFile ? checkIfRun(read(ifFile, "if-run's output", parse), data.sessions, coefficients) : null;

let ci: CiFootprint | null = null;
if (argv.includes('--ci')) {
  try {
    ci = await ciFootprint(new GitLab(), env, coefficients);
  } catch (err) {
    // only the API is best effort: an answer it refused, or no answer at all
    const offline = err instanceof TypeError && err.message === 'fetch failed';
    if (!(err instanceof GitLabError) && !offline) throw err;
    console.warn(`warning: no CI footprint this time, the GitLab API answered: ${err.message}`);
  }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'metrics.txt'), metricsText(summary, ci));
writeFileSync(join(outDir, 'sci-report.json'), JSON.stringify({ functionalUnit: 'one merge request review', ...summary, impactFramework: check, ci }, null, 2) + '\n');
writeFileSync(
  join(outDir, 'index.html'),
  renderSciPage({
    summary,
    check,
    ci,
    web: env.CI_PROJECT_URL ?? 'https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase',
    generatedAt: new Date().toISOString(),
    commit: env.CI_COMMIT_SHA ?? 'local',
    pipelineUrl: env.CI_PIPELINE_URL,
  }),
);
console.log(markdownSummary(summary, check, ci));
console.log(`\nwrote ${outDir}/index.html, ${outDir}/metrics.txt and ${outDir}/sci-report.json`);
if (check?.mismatches.length) process.exit(1);
