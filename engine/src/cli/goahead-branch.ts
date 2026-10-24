/**
 * Fails a branch pipeline if an agent pushed to a branch no MR covers without
 * a person's go-ahead (#64, wiki: Assisted). autonomy:goahead judges pushes
 * in MR pipelines; GitLab runs a branch pipeline instead when the branch has
 * no open MR, and this is the guard there.
 *
 * The same rules as on an MR (src/goahead.ts), read from what GitLab recorded:
 * who pushed what from the push events, who wrote what from the notes. With no
 * MR, the go-ahead has to be on the issue the branch is named after
 * ("<iid>-..."), after the agent's proposal there. A push an MR's own guard
 * judged (one made while an MR from this branch was open, or before one
 * opened) is left to it if that MR is still open or merged; a closed MR may
 * have been closed with its guard failing, so its pushes are judged here.
 * With no MR there is no risk score either, so the push is judged as high
 * risk: only a maintainer's go-ahead counts. AUTONOMY_TIER is not read here,
 * since a branch pipeline's variables can come from the push itself.
 *
 * CI runs this file and reads the policy from the default branch, not from the
 * branch being judged, so a push can't change the check it is checked by.
 */
import { execFileSync } from 'node:child_process';
import { GitLab, GitLabError, required } from '../gitlab.ts';
import type { PushEvent } from '../goahead.ts';
import { BRANCH_TIER, type BranchMr, checkBranch, issueOfBranch } from '../goahead-branch.ts';
import { allPages, eventsSince, gitRepo, notesOf, policyAt } from '../goahead-mr.ts';

const env = process.env;

try {
  await main();
} catch (err) {
  console.error(`autonomy:goahead:branch could not finish, so it fails: ${(err as Error).message}`);
  process.exit(1);
}

async function main() {
  const branch = required(env, 'CI_COMMIT_BRANCH');
  const defaultBranch = env.CI_DEFAULT_BRANCH ?? 'main';
  if (branch === defaultBranch) {
    console.log(`${branch} is the default branch, which autonomy:guard:main checks: nothing to judge here`);
    return;
  }
  const policyRef = env.AUTONOMY_POLICY_REF || `origin/${defaultBranch}`;
  const config = policyAt(policyRef, env.AUTONOMY_CONFIG ?? '.autonomy.yml', 'the default branch');
  const repo = gitRepo();
  const base = execFileSync('git', ['merge-base', policyRef, 'HEAD'], { encoding: 'utf8' }).trim();
  const commits = execFileSync('git', ['rev-list', `${base}..HEAD`], { encoding: 'utf8' }).split('\n').filter(Boolean);

  const gl = new GitLab();
  const project = required(env, 'CI_PROJECT_ID');
  const mrs = (await allPages<BranchMr & { source_project_id: number }>(gl, `/:project/merge_requests?state=all&source_branch=${encodeURIComponent(branch)}`)).filter(
    (mr) => String(mr.source_project_id) === project,
  );
  // Pushes from two days before the commit the branch starts from, which is on
  // the default branch, so no pusher sets its date.
  const baseTime = Number(execFileSync('git', ['show', '-s', '--format=%ct', base], { encoding: 'utf8' }).trim()) * 1000;
  if (!Number.isFinite(baseTime) || baseTime <= 0) throw new Error(`can't read the date of the base commit ${base}`);
  const since = eventsSince(new Date().toISOString(), baseTime);
  const events = await allPages<PushEvent>(gl, `/:project/events?action=pushed&after=${since}&sort=asc`, 100);
  const iid = issueOfBranch(branch);
  const issue = iid
    ? await gl.get<{ iid: number; author: { username: string } }>(`/:project/issues/${iid}`).catch((err: unknown) => {
        if (err instanceof GitLabError && err.status === 404) return null;
        throw err;
      })
    : null;

  const check = await checkBranch({ branch, events, commits, mrs, issue, since }, config, repo, (n) => notesOf(gl, 'issue', n));
  if (check.openMr !== null) {
    console.log(`${branch} has an open MR, !${check.openMr}: autonomy:goahead in its pipeline judges every push to it`);
    return;
  }
  for (const c of check.covered) console.log(`push at ${c.push.at} by @${c.push.pusher}: judged by autonomy:goahead on !${c.mr}`);
  for (const c of check.agentPushes) if (c.verdict.ok) console.log(c.line);

  if (!check.problems.length) {
    console.log(`${commits.length} commit(s) on ${branch} not on ${defaultBranch}, ${check.agentPushes.length} agent push(es) no MR covers, risk ${BRANCH_TIER}: each had its own go-ahead`);
    return;
  }
  for (const p of check.problems) console.error(p.text);
  const maintainers = config.goAhead.maintainers.map((m) => `@${m}`).join(', ');
  console.error(
    `Assisted: an agent acts only on a person's go-ahead, one per push, from someone who didn't ask for the work. ${branch} has no MR, so the go-ahead has to be on the issue the branch is named after, and with no risk score it is judged as ${BRANCH_TIER} risk: only ${maintainers || 'a maintainer'}. If an MR for this branch opened after this job started, retry the job: that MR's pipeline judges these pushes.`,
  );
  console.error(
    `Next: a go-ahead can't be given after the push. ${maintainers ? `One of ${maintainers}` : 'A maintainer'} deletes the branch or moves the commits that had one to a new branch; for anything still wanted, the agent proposes again on the issue and waits for a new go-ahead.`,
  );
  process.exit(1);
}
