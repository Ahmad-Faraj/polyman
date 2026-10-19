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
 *   node engine/src/cli/sci-report.ts [--sessions sustainability/agent-tokens.json] [--if if-output.yaml] [--out sci] [--ci]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { loadConfig } from '../config.ts';
import { finishedJobs, GitLab } from '../gitlab.ts';
import { footprint, type SciCoefficients } from '../sci.ts';
import { type CiFootprint, type SessionRecord, checkIfRun, markdownSummary, metricsText, renderSciPage, summarize } from '../sci-report.ts';
import { median } from '../tokens.ts';

const argv = process.argv.slice(2);
const opt = (name: string, fallback?: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const value = argv[i + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return value;
};
const sessionsFile = opt('--sessions', 'sustainability/agent-tokens.json')!;
const ifFile = opt('--if');
const outDir = opt('--out', 'sci')!;
const env = process.env;

const data = JSON.parse(readFileSync(sessionsFile, 'utf8')) as { sessions: SessionRecord[]; coefficients?: { gridGramsPerKwh?: number } };
if (!Array.isArray(data.sessions)) throw new Error(`${sessionsFile} has no "sessions" list (write it with agent-tokens.ts --json)`);
const coefficients = loadConfig().sustainability;
const summary = summarize(data.sessions, coefficients, data.coefficients?.gridGramsPerKwh);
const check = ifFile ? checkIfRun(parse(readFileSync(ifFile, 'utf8')), data.sessions, coefficients) : null;

async function ciFootprint(c: SciCoefficients): Promise<CiFootprint | null> {
  const gl = new GitLab();
  const current = Number(env.CI_PIPELINE_ID);
  let ids: number[];
  let scope: string;
  if (env.CI_MERGE_REQUEST_IID) {
    const all = await gl.get<{ id: number; status: string }[]>(`/:project/merge_requests/${env.CI_MERGE_REQUEST_IID}/pipelines?per_page=100`);
    ids = all.filter((p) => p.id !== current && ['success', 'failed', 'canceled'].includes(p.status)).map((p) => p.id);
    scope = `!${env.CI_MERGE_REQUEST_IID}'s ${ids.length} finished pipeline${ids.length === 1 ? '' : 's'} before this one`;
  } else if (env.CI_COMMIT_BRANCH) {
    const all = await gl.get<{ id: number }[]>(`/:project/pipelines?ref=${encodeURIComponent(env.CI_COMMIT_BRANCH)}&status=success&source=push&per_page=11`);
    ids = all.map((p) => p.id).filter((id) => id !== current).slice(0, 10);
    scope = `the last ${ids.length} successful push pipelines on ${env.CI_COMMIT_BRANCH}`;
  } else return null;
  if (!ids.length) return null;
  const perPipeline: number[] = [];
  const jobs = [];
  for (const id of ids) {
    const js = await finishedJobs(gl, [id]);
    jobs.push(...js);
    perPipeline.push(footprint(js, c).totalGrams);
  }
  return { scope, pipelines: ids.length, footprint: footprint(jobs, c), perPipelineGrams: median(perPipeline) };
}

let ci: CiFootprint | null = null;
if (argv.includes('--ci')) {
  try {
    ci = await ciFootprint(coefficients);
  } catch (err) {
    console.warn(`warning: no CI footprint this time, the GitLab API answered: ${(err as Error).message}`);
  }
}

mkdirSync(outDir, { recursive: true });
const ciMetric = env.CI_MERGE_REQUEST_IID ? 'sci_ci_mr_runner_gco2e' : 'sci_ci_main_last10_runner_gco2e';
writeFileSync(join(outDir, 'metrics.txt'), metricsText(summary, ci, ciMetric));
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
