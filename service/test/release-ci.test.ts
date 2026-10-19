import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// The release jobs in service/ci/service.gitlab-ci.yml, read as text: the
// switch to production is a person's go-ahead (Assisted), the rollback is not.
// .gitattributes has `*.yml text`, so a Windows checkout has CRLF line ends.
const ci = readFileSync(new URL('../ci/service.gitlab-ci.yml', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

/** One top-level job: from its name line to the next top-level key. */
function job(name: string, text = ci): string {
  const lines = text.split('\n');
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

// A manual job in rules blocks by default, and while one waits the pipeline is
// "blocked", even after another job failed: on 19 Oct the production check
// failed, canary:publish was still waiting, the pipeline never became "failed"
// and the incident responder (started by a failed main pipeline) never ran.
describe('no manual job keeps a failed main pipeline from showing as failed', () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const files = [
    '.gitlab-ci.yml',
    '.gitlab/ci/canary.gitlab-ci.yml',
    '.gitlab/ci/release.gitlab-ci.yml',
    'service/ci/service.gitlab-ci.yml',
    'engine/ci/autonomy.gitlab-ci.yml',
    'corpus/corpus.gitlab-ci.yml',
  ];
  /** Every top-level job of a file with a `when: manual` in it. */
  const manualJobs = (text: string) =>
    [...text.matchAll(/^([\w:.\-[\] ]+):$/gm)].map((m) => m[1]).filter((name) => job(name, text).includes('when: manual'));

  it('the root CI includes every file checked here', () => {
    const root = read('.gitlab-ci.yml');
    for (const file of files.slice(1)) expect(root).toContain(`local: ${file}`);
  });

  it('every manual job is optional (allow_failure: true), except the production switch', () => {
    const found: string[] = [];
    for (const file of files) {
      const text = read(file);
      for (const name of manualJobs(text)) {
        found.push(name);
        if (name === 'service:promote:production') continue;
        expect(job(name, text), `${file} ${name}`).toMatch(/\n  allow_failure: true\n/);
      }
    }
    expect(found.sort()).toEqual(['canary:publish', 'release:npm-next', 'release:promote', 'service:promote:production']);
  });

  it('canary:publish still runs only when a person clicks it, on a push to the default branch', () => {
    const publish = job('canary:publish', read('.gitlab/ci/canary.gitlab-ci.yml'));
    expect(rules(publish)).toEqual(['- if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH && $CI_PIPELINE_SOURCE == "push"\n      when: manual']);
  });

  // The switch stays blocking: allow_failure: true would hide a failed switch
  // from the rollback (when: on_failure). It blocks only until it is clicked;
  // in the drill it had run, so the production check could fail the pipeline.
  it('the production switch stays blocking, failing on anything but exit 3', () => {
    const promote = job('service:promote:production');
    expect(promote).not.toContain('allow_failure: true');
    expect(promote).toMatch(/\n  allow_failure:\n    exit_codes: \[3\]\n/);
  });
});
