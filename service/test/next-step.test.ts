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
  stub('curl', repo.jobs ? `cat "${work}/jobs.json"` : 'exit 22');
  const res = spawnSync('sh', [SCRIPT], {
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
    },
  });
  return { status: res.status, out: res.stdout + res.stderr, calls: readFileSync(join(work, 'calls.log'), 'utf8') };
}

const jobs = [
  { id: 41, name: 'service:check:candidate' },
  { id: 42, name: 'service:promote:production' },
];

describe('next-step.sh after the candidate passed', () => {
  it('links the promote job when this is the newest commit on main', () => {
    const r = run({ mainHead: 'abc1234full', jobs });
    expect(r.status).toBe(0);
    expect(r.out).toContain('NEXT STEP: the candidate passed its check. To release it, a person who has read this log runs service:promote:production: https://gitlab.example/p/-/jobs/42');
    expect(r.out).not.toContain("don't promote");
  });

  it('still links the promote when main moved on outside the service, as the promote itself allows', () => {
    const r = run({ mainHead: 'newer', serviceDiff: 'same', jobs });
    expect(r.calls).toContain('git diff --quiet abc1234full newer -- service src assets template package.json package-lock.json');
    expect(r.out).toContain('https://gitlab.example/p/-/jobs/42');
  });

  it("says not to promote when a newer main commit changed the service again", () => {
    const r = run({ mainHead: 'newer', serviceDiff: 'changed', jobs });
    expect(r.status).toBe(0);
    expect(r.out).toContain("NEXT STEP: a newer main pipeline exists: don't promote this one.");
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

  it('falls back to the pipeline link when the job lookup fails', () => {
    const r = run({ mainHead: 'abc1234full' });
    expect(r.status).toBe(0);
    expect(r.out).toContain('runs service:promote:production in this pipeline: https://gitlab.example/p/-/pipelines/9 (the job link could not be looked up)');
    // the job token first, then the public API
    expect(r.calls).toMatch(/curl -sSf -H JOB-TOKEN: job-token https:\/\/gitlab\.example\/api\/v4\/projects\/1\/pipelines\/9\/jobs\?per_page=100\ncurl -sSf https:/);
  });

  it('runs at the end of the candidate check, so only after the samples passed', () => {
    const ci = readFileSync(new URL('../ci/service.gitlab-ci.yml', import.meta.url), 'utf8');
    const check = ci.slice(ci.indexOf('\nservice:check:candidate:'), ci.indexOf('\nservice:discard:candidate:'));
    expect(check).toMatch(/golden\.ts "\$CANDIDATE_URL" --json golden\.json\n(\s+#.*\n)*\s+- sh service\/deploy\/next-step\.sh\n/);
  });
});
