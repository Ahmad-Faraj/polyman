/**
 * Says when a change means the published flows must be republished. The flows
 * GitLab runs are the ones sync-flows last published, with .autonomy.yml's
 * values (go_ahead.people, the maintainers, the checks...) filled in at that
 * moment. Changing one of those values, or a flow file, changes nothing for
 * the agents until someone runs sync-flows again, and nothing else says so.
 *
 * It compares the flows filled in from the base (the MR's base, or the commit
 * before a push to the default branch) with the ones filled in from HEAD. It
 * needs no token: it only reads git. Exit 3 when a republish is needed (the
 * job allows it, so the pipeline passes with a warning), 0 when not.
 *
 *   node engine/src/cli/republish-check.ts [base]
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AutonomyConfig, loadConfig } from '../config.ts';
import { type FlowValues, HANDOFF_FLOWS, flowChanges, flowValues } from '../render.ts';

const env = process.env;
const dir = '.gitlab/duo/flows';
const file = env.AUTONOMY_CONFIG ?? '.autonomy.yml';
// As in the guard: the MR's base, or on the default branch the commit before
// the push (all zeros when there is none, so the previous commit).
const arg = process.argv[2] || env.CI_COMMIT_BEFORE_SHA;
const base = env.CI_MERGE_REQUEST_DIFF_BASE_SHA || (arg && !/^0+$/.test(arg) ? arg : 'HEAD~1');

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const show = (path: string) => {
  try {
    return git('show', `${base}:${path}`);
  } catch {
    return undefined;
  }
};

/** The values the flows get, with the same stand-ins on both sides for what only the catalog knows. */
const values = (config: AutonomyConfig) =>
  flowValues(
    {
      ...config,
      agents: {
        ...config.agents,
        reviewerAccount: config.agents.reviewerAccount || 'REVIEWER_ACCOUNT_NOT_SET',
        fixerAccount: config.agents.fixerAccount || 'FIXER_ACCOUNT_NOT_SET',
      },
    },
    Object.fromEntries(HANDOFF_FLOWS.map((f) => [f, '1'])),
  );

const isFlow = (f: string) => /\.ya?ml$/.test(f);
const name = (f: string) => f.replace(/^.*\//, '').replace(/\.ya?ml$/, '');

try {
  git('rev-parse', '--verify', '--quiet', `${base}^{commit}`);
} catch {
  console.error(`can't find the base commit ${base}; fetch the history (GIT_DEPTH: 0)`);
  process.exit(1);
}

const after = {
  sources: new Map(readdirSync(dir).filter(isFlow).map((f) => [name(f), readFileSync(join(dir, f), 'utf8')])),
  values: values(loadConfig(file)),
};

let baseValues: FlowValues = {};
const baseText = show(file);
const tmp = mkdtempSync(join(tmpdir(), 'republish-'));
try {
  const path = join(tmp, 'autonomy.yml');
  if (baseText !== undefined) writeFileSync(path, baseText);
  baseValues = values(loadConfig(path));
} catch (err) {
  // what was published from it can't be told apart, so count every setting as changed
  console.warn(`the base's ${file} doesn't load (${(err as Error).message}); counting every setting as changed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
const before = {
  sources: new Map(
    git('ls-tree', '--name-only', base, `${dir}/`)
      .split('\n')
      .filter(isFlow)
      .map((f) => [name(f), show(f) ?? '']),
  ),
  values: baseValues,
};

const changes = flowChanges(before, after);
if (!changes.length) {
  console.log(`the flows filled in from ${file} are the same as at ${base.slice(0, 8)}: nothing to republish`);
  process.exit(0);
}

const onDefaultBranch = !!env.CI_COMMIT_BRANCH && env.CI_COMMIT_BRANCH === env.CI_DEFAULT_BRANCH;
console.warn(
  onDefaultBranch
    ? 'The published flows are now behind the default branch. GitLab keeps running what was last published:'
    : 'Once this is merged, the published flows are behind it until someone republishes them. GitLab keeps running what was last published:',
);
for (const c of changes) {
  const why = [...c.settings.map((s) => `${s} changed in ${file}`), ...(c.fileChanged ? [`${dir}/${c.flow}.yaml changed`] : [])];
  console.warn(`  ${c.flow}: ${why.join('; ')}`);
}
console.warn(
  `${onDefaultBranch ? 'Republish' : 'After the merge, republish'} from the default branch with a token that has the api scope:\n` +
    '  GITLAB_TOKEN=... node engine/src/cli/sync-flows.ts\n' +
    'then GITLAB_TOKEN=... node engine/src/cli/doctor.ts should say each flow matches the repo.',
);
process.exit(3);
