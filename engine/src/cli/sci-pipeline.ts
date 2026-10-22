/**
 * This pipeline's own runner footprint (job autonomy:sci:pipeline, stage
 * .post): the finished jobs' times from the GitLab API, through sci.ts's
 * coefficients, into a metrics report the MR widget compares with the target
 * branch's pipeline. The log names what it left out (itself, running, manual,
 * skipped). In an MR it also lists the costliest jobs against the same job on
 * the target branch.
 *
 * It never fails a pipeline: if the API refuses, can't be reached or answers
 * something odd, it warns, writes an empty metrics report and exits 0. A
 * missing metric is better than a wrong one.
 *
 *   node engine/src/cli/sci-pipeline.ts [--out sci-pipeline]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { GitLab } from '../gitlab.ts';
import { compareWithMain, comparisonSummary, pipelineFootprint, pipelineMetricsText, pipelineSummary } from '../sci-report.ts';

const argv = process.argv.slice(2);
const i = argv.indexOf('--out');
const outDir = i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'sci-pipeline';
const env = process.env;

const write = (metrics: string, json: unknown) => {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'metrics.txt'), metrics);
  writeFileSync(join(outDir, 'pipeline.json'), JSON.stringify(json, null, 2) + '\n');
};
const skip = (why: string): never => {
  console.warn(`warning: no pipeline footprint this time: ${why}`);
  write('', null);
  process.exit(0);
};

if (!(env.CI_API_V4_URL && env.CI_PROJECT_ID && env.CI_PIPELINE_ID)) skip('CI_API_V4_URL, CI_PROJECT_ID and CI_PIPELINE_ID are not all set, so this is not a CI job');

let gl: GitLab;
let pf: Awaited<ReturnType<typeof pipelineFootprint>>;
try {
  const coefficients = loadConfig().sustainability;
  gl = new GitLab();
  pf = await pipelineFootprint(gl, env, coefficients);
} catch (err) {
  skip((err as Error).message);
}
write(pipelineMetricsText(pf!), pf!);
console.log(pipelineSummary(pf!));

const target = env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
if (env.CI_MERGE_REQUEST_IID && target) {
  try {
    console.log('\n' + comparisonSummary(await compareWithMain(gl!, target, pf!)));
  } catch (err) {
    console.warn(`warning: no comparison with ${target} this time: ${(err as Error).message}`);
  }
}
console.log(`\nwrote ${outDir}/metrics.txt and ${outDir}/pipeline.json`);
