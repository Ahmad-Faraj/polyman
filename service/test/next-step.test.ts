import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// deploy/next-step.sh against stand-in git and curl: after the candidate's
// check passes it names the promote job to click, or says not to.
const SCRIPT = new URL('../deploy/next-step.sh', import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Repo {
  /** what main points at once fetched; empty when the fetch fails */
  mainHead: string;
  serviceDiff?: 'same' | 'changed' | 'error';
  /** the pipeline's jobs as the API lists them; undefined when every lookup fails */
  jobs?: { id: number; name: string }[];
  /** what the API lists as the MRs of this commit; undefined when that lookup fails */
  mrs?: unknown[];
  /** GITLAB_USER_LOGIN, the person whose push started the pipeline */
  user?: string;
  /** a cloudrun.conf to use instead of the real one */
  conf?: string;
}

function run(repo: Repo) {
  const work = mkdtempSync(join(tmpdir(), 'next-step-test-'));
  dirs.push(work);
  const bin = join(work, 'bin');
  mkdirSync(bin);
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${work}/calls.log"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const diffStatus = { same: 0, changed: 1, error: 128 }[repo.serviceDiff ?? 'same'];
  stub(
    'git',
    `case "$1" in
  fetch) [ -n "${repo.mainHead}" ] ;;
  rev-parse) echo "${repo.mainHead}" ;;
  diff) exit ${diffStatus} ;;
esac`,
  );
  if (repo.jobs) writeFileSync(join(work, 'jobs.json'), JSON.stringify(repo.jobs));
  if (repo.mrs) writeFileSync(join(work, 'mrs.json'), JSON.stringify(repo.mrs));
  stub(
    'curl',
    `case "$*" in
  */repository/commits/*) ${repo.mrs ? `cat "${work}/mrs.json"` : 'exit 22'} ;;
  *) ${repo.jobs ? `cat "${work}/jobs.json"` : 'exit 22'} ;;
esac`,
  );
  let script = SCRIPT;
  if (repo.conf !== undefined) {
    // the script reads cloudrun.conf next to itself
    const deploy = join(work, 'deploy');
    mkdirSync(deploy);
    script = join(deploy, 'next-step.sh');
    writeFileSync(script, readFileSync(SCRIPT, 'utf8'));
    writeFileSync(join(deploy, 'cloudrun.conf'), repo.conf);
  }
  const res = spawnSync('sh', [script], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      CI_COMMIT_SHA: 'abc1234full',
      CI_DEFAULT_BRANCH: 'main',
      CI_REPOSITORY_URL: 'https://example.invalid/repo.git',
      CI_PIPELINE_URL: 'https://gitlab.example/p/-/pipelines/9',
      CI_PROJECT_URL: 'https://gitlab.example/p',
      CI_API_V4_URL: 'https://gitlab.example/api/v4',
      CI_PROJECT_ID: '1',
      CI_PIPELINE_ID: '9',
      CI_JOB_TOKEN: 'job-token',
      ...(repo.user ? { GITLAB_USER_LOGIN: repo.user } : {}),
    },
  });
  return { status: res.status, out: res.stdout + res.stderr, calls: readFileSync(join(work, 'calls.log'), 'utf8') };
}

const jobs = [
  { id: 41, name: 'service:check:candidate' },
  { id: 42, name: 'service:promote:production' },
];
// the API's MRs of a merge commit: the merged one names who merged it
const mrs = [
  { iid: 3, state: 'closed', merge_user: null },
  { iid: 149, state: 'merged', merge_user: { username: 'Ahmad-Faraj' }, merged_by: { username: 'Ahmad-Faraj' } },
];

describe('next-step.sh after the candidate passed', () => {
  it('links the promote job when this is the newest commit on main', () => {
    const r = run({ mainHead: 'abc1234full', jobs, mrs });
    expect(r.status).toBe(0);
    expect(r.out).toContain('NEXT STEP: the candidate passed its check. To release it, @Ahmad-Faraj (who merged !149) runs service:promote:production: https://gitlab.example/p/-/jobs/42');
    expect(r.calls).toContain('curl -sSf -H JOB-TOKEN: job-token https://gitlab.example/api/v4/projects/1/repository/commits/abc1234full/merge_requests');
    expect(r.out).not.toContain("don't promote");
  });

  it('still links the promote when main moved on outside the service, as the promote itself allows', () => {
    const r = run({ mainHead: 'newer', serviceDiff: 'same', jobs });
    expect(r.calls).toContain('git diff --quiet abc1234full newer -- service src assets template package.json package-lock.json');
    expect(r.out).toContain('https://gitlab.example/p/-/jobs/42');
  });

  it("says not to promote when a newer main commit changed the service again", () => {
    const r = run({ mainHead: 'newer', serviceDiff: 'changed', jobs, mrs });
    expect(r.status).toBe(0);
    expect(r.out).toContain("NEXT STEP: @Ahmad-Faraj (who merged !149): a newer main pipeline exists, don't promote this one.");
    expect(r.out).toContain('https://gitlab.example/p/-/commit/newer/pipelines');
    expect(r.out).not.toContain('/-/jobs/42');
  });

  it('says when it cannot tell whether a newer pipeline exists, and never fails the job', () => {
    for (const repo of [{ mainHead: '', jobs }, { mainHead: 'newer', serviceDiff: 'error' as const, jobs }]) {
      const r = run(repo);
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/NEXT STEP: could not (read the head of main|compare this commit with main)/);
      expect(r.out).toContain('The promote job checks again');
      expect(r.out).toContain('/-/jobs/42');
    }
  });

  it('skips the comparison when SERVICE_PATHS cannot be read, instead of diffing the whole tree', () => {
    const r = run({ mainHead: 'newer', serviceDiff: 'changed', jobs, conf: "SERVICE=polyman-verify\nSERVICE_PATHS='service src'\n" });
    expect(r.status).toBe(0);
    expect(r.out).toContain('NEXT STEP: could not read SERVICE_PATHS');
    expect(r.out).toContain('https://gitlab.example/p/-/jobs/42');
    expect(r.out).not.toContain("don't promote");
    expect(r.calls).not.toContain('git diff');
  });

  it('names whoever pushed the commit when no merged MR can be found', () => {
    for (const repo of [{ mainHead: 'abc1234full', jobs, user: 'Mazen-Ghanaym' }, { mainHead: 'abc1234full', jobs, mrs: [], user: 'Mazen-Ghanaym' }]) {
      const r = run(repo);
      expect(r.status).toBe(0);
      expect(r.out).toContain('To release it, @Mazen-Ghanaym (who pushed this commit) runs service:promote:production: https://gitlab.example/p/-/jobs/42');
    }
  });

  it('falls back to the pipeline link when the job lookup fails', () => {
    const r = run({ mainHead: 'abc1234full' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('the person who merged this change runs service:promote:production in this pipeline: https://gitlab.example/p/-/pipelines/9 (the job link could not be looked up)');
    // the job token first, then the public API
    expect(r.calls).toMatch(/curl -sSf -H JOB-TOKEN: job-token https:\/\/gitlab\.example\/api\/v4\/projects\/1\/pipelines\/9\/jobs\?per_page=100\ncurl -sSf https:/);
  });

  it('runs at the end of the candidate check, so only after the samples passed', () => {
    const ci = readFileSync(new URL('../ci/service.gitlab-ci.yml', import.meta.url), 'utf8');
    const check = ci.slice(ci.indexOf('\nservice:check:candidate:'), ci.indexOf('\nservice:discard:candidate:'));
    expect(check).toMatch(/golden\.ts "\$CANDIDATE_URL" --json golden\.json\n(\s+#.*\n)*\s+- sh service\/deploy\/next-step\.sh\n/);
  });
});
