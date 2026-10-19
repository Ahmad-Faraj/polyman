import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The release jobs in service/ci/service.gitlab-ci.yml, read as text: the
// switch to production is a person's go-ahead (Assisted), the rollback is not.
// .gitattributes has `*.yml text`, so a Windows checkout has CRLF line ends.
const ci = readFileSync(new URL('../ci/service.gitlab-ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** One top-level job: from its name line to the next top-level key. */
function job(name: string): string {
  const lines = ci.split('\n');
  const start = lines.findIndex((l) => l === `${name}:`);
  expect(start, `job ${name} exists`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^\S/.test(l) && !l.startsWith('#'));
  return rest.slice(0, end < 0 ? undefined : end).join('\n');
}

/** The rules of a job as written: each `- if:` with the lines under it. */
function rules(block: string): string[] {
  const body = block.split('\n  rules:\n')[1]?.split(/\n  \S/)[0] ?? '';
  return body
    .split(/\n(?=    - if:)/)
    .map((r) => r.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').trim())
    .filter(Boolean);
}

describe('the production switch waits for a person', () => {
  const promote = job('service:promote:production');

  it('is a manual job on the default branch, only with Google Cloud set up and service files changed', () => {
    const onMain = rules(promote).filter((r) => r.includes('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'));
    expect(onMain).toHaveLength(1);
    expect(onMain[0]).toContain('$GCP_PROJECT_ID');
    expect(onMain[0]).toContain('changes: *service_files');
    expect(onMain[0]).toMatch(/when: manual$/);
  });

  it('has no rule that starts it by itself', () => {
    for (const rule of rules(promote)) {
      expect(rule).toMatch(/when: (manual|never)$/);
    }
    expect(rules(promote).join('\n')).not.toMatch(/when: (on_success|always|delayed)/);
  });

  it('does not run on merge requests or any branch but the default one', () => {
    expect(promote).not.toContain('merge_request_event');
    for (const rule of rules(promote)) {
      expect(rule).toMatch(/\$CI_PIPELINE_SOURCE == "schedule"|\$CI_COMMIT_BRANCH == \$CI_DEFAULT_BRANCH/);
    }
  });

  it('still needs the candidate and its check, so a person only switches a candidate that passed', () => {
    expect(promote).toContain('needs: [service:deploy:candidate, service:check:candidate]');
    expect(promote).toContain('sh service/deploy/cloudrun.sh promote');
  });

  it('keeps passing the previous revision on to the rollback, even when the job fails after the switch', () => {
    expect(promote).toMatch(/artifacts:\n\s+# .*\n\s+when: always\n\s+reports:\n\s+dotenv: deploy\.env/);
  });
});

describe('the rest of the release stays automatic', () => {
  it('the production check and the rollback wait for the manual switch, not for the merge', () => {
    expect(job('service:check:production')).toContain('needs: [service:promote:production]');
    expect(job('service:rollback:production')).toMatch(/- \{ job: service:promote:production \}/);
  });

  it('the rollback is a safety net that runs on failure, never a manual job', () => {
    const rollback = job('service:rollback:production');
    const own = rules(rollback).filter((r) => r.includes('$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH'));
    expect(own).toHaveLength(1);
    expect(own[0]).toMatch(/when: on_failure$/);
    expect(rollback).not.toContain('when: manual');
  });

  it('the candidate still deploys on merge without a click', () => {
    expect(job('service:deploy:candidate')).not.toContain('when: manual');
    expect(job('service:check:candidate')).not.toContain('when: manual');
    expect(ci.match(/when: manual/g)).toHaveLength(1);
  });
});

describe('exit 3 is a warning, not a failure', () => {
  it('the promote and the production check let exit 3 through, so a switch that did nothing starts no rollback', () => {
    for (const name of ['service:promote:production', 'service:check:production']) {
      expect(job(name), name).toMatch(/\n  allow_failure:\n    exit_codes: \[3\]\n/);
    }
  });

  it('the rollback still runs on failure and is never allowed to fail', () => {
    const rollback = job('service:rollback:production');
    expect(rollback).toMatch(/when: on_failure/);
    expect(rollback).not.toContain('allow_failure');
  });
});
