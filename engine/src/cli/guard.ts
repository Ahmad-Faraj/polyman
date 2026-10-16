/**
 * Fails the MR pipeline if a commit made by an agent changed the pipeline, the
 * risk policy or the engine. The flows are told not to touch these files; this
 * makes sure of it.
 */
import { execFileSync } from 'node:child_process';
import { protectedPathViolations, parseGitLog } from '../agents.ts';
import { loadConfig } from '../config.ts';

const env = process.env;
// On the default branch the base is the commit before the push; GitLab sends
// all zeros when there is none, so fall back to the previous commit.
const arg = process.argv[2];
const base =
  arg && !/^0+$/.test(arg) ? arg : arg ? 'HEAD~1' : env.CI_MERGE_REQUEST_DIFF_BASE_SHA || `origin/${env.CI_DEFAULT_BRANCH ?? 'main'}`;
const config = loadConfig(env.AUTONOMY_CONFIG ?? '.autonomy.yml');

const log = execFileSync('git', ['log', '--format=%x00%H%x09%an%x09%ae', '--name-only', '--no-renames', `${base}..HEAD`], {
  encoding: 'utf8',
});
const commits = parseGitLog(log);
const violations = protectedPathViolations(commits, config.governance, config.incidentsFile);

if (!violations.length) {
  const agentCommits = commits.filter((c) => c.authorEmail.includes('service_account_')).length;
  console.log(`${commits.length} commits checked, ${agentCommits} by agents, none touch protected paths`);
} else {
  for (const v of violations) {
    console.error(`${v.sha.slice(0, 8)} by ${v.agent} changed protected files: ${v.files.join(', ')}`);
  }
  console.error('Agents may not change the pipeline, the risk policy or the engine. Revert these changes or have a person make them.');
  process.exit(1);
}
