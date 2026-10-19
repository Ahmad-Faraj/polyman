import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// deploy/cloudrun.sh against stand-in gcloud and git that log what they are
// asked and answer from a small state file, so the release logic (what gets
// traffic, when rollback acts) is checked without Google Cloud.
const SCRIPT = new URL('../deploy/cloudrun.sh', import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Cloud {
  /** revisions and their traffic, as `gcloud run services describe --format=json` gives them */
  traffic: { revisionName?: string; percent?: number; tag?: string }[];
  /** what main points at once fetched; empty when the fetch fails */
  mainHead: string;
  /** what `git diff` of the service files between this commit and main says */
  serviceDiff?: 'same' | 'changed' | 'error';
}

function run(mode: string, cloud: Cloud, env: Record<string, string> = {}) {
  const work = mkdtempSync(join(tmpdir(), 'deploy-test-'));
  dirs.push(work);
  const bin = join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(join(work, 'describe.json'), JSON.stringify({ metadata: { name: 'polyman-verify' }, status: { url: 'https://polyman-verify-x.run.app', traffic: cloud.traffic } }));
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${work}/calls.log"\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub(
    'gcloud',
    `case "$*" in
  *create-cred-config*) : ;;
  *"services describe"*"--format=json"*) cat "${work}/describe.json" ;;
  *"services describe"*"value(status.url)"*) echo https://polyman-verify-x.run.app ;;
  *"services describe"*) echo polyman-verify ;;
esac`,
  );
  const diffStatus = { same: 0, changed: 1, error: 128 }[cloud.serviceDiff ?? 'same'];
  stub(
    'git',
    `case "$1" in
  fetch) [ -n "${cloud.mainHead}" ] ;;
  rev-parse) echo "${cloud.mainHead}" ;;
  diff) exit ${diffStatus} ;;
esac`,
  );
  const res = spawnSync('sh', [SCRIPT, mode], {
    cwd: work,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GCP_PROJECT_ID: 'p',
      GCP_WIF_PROVIDER: 'w',
      GCP_SERVICE_ACCOUNT: 's',
      GCP_ID_TOKEN: 't',
      CI_COMMIT_SHORT_SHA: 'abc1234',
      CI_COMMIT_SHA: 'abc1234full',
      CI_DEFAULT_BRANCH: 'main',
      CI_REPOSITORY_URL: 'https://example.invalid/repo.git',
      ...env,
    },
  });
  const calls = existsSync(join(work, 'calls.log')) ? readFileSync(join(work, 'calls.log'), 'utf8') : '';
  const dotenv = existsSync(join(work, 'deploy.env')) ? readFileSync(join(work, 'deploy.env'), 'utf8') : '';
  return { status: res.status, out: res.stdout + res.stderr, calls, dotenv, switches: calls.split('\n').filter((l) => l.includes('update-traffic')) };
}

const serving = (rev: string, ...tags: string[]): Cloud['traffic'] => [{ revisionName: rev, percent: 100 }, ...tags.map((tag) => ({ tag, percent: 0 }))];

describe('cloudrun.sh promote', () => {
  it('records the revision that served, switches traffic and drops older candidate URLs', () => {
    const r = run('promote', { traffic: serving('rev-1', 'c-old1234', 'c-abc1234'), mainHead: 'abc1234full' }, { CANDIDATE_REVISION: 'rev-2' });
    expect(r.status).toBe(0);
    expect(r.dotenv).toContain('PREVIOUS_REVISION=rev-1');
    expect(r.dotenv).toContain('PROMOTED=true');
    expect(r.switches[0]).toContain('--to-revisions rev-2=100');
    expect(r.switches[1]).toContain('--remove-tags c-old1234');
    expect(r.switches[1]).not.toContain('c-abc1234');
  });

  it('still promotes when main moved on with a change outside the service (a README, the corpus)', () => {
    const r = run('promote', { traffic: serving('rev-1'), mainHead: 'newer', serviceDiff: 'same' }, { CANDIDATE_REVISION: 'rev-2' });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('git diff --quiet abc1234full newer -- service src assets template package.json package-lock.json');
    expect(r.switches[0]).toContain('--to-revisions rev-2=100');
  });

  it('ends without a switch, as a warning (exit 3) and not a deployment, when a newer commit changed the service again', () => {
    const r = run('promote', { traffic: serving('rev-1'), mainHead: 'newer', serviceDiff: 'changed' }, { CANDIDATE_REVISION: 'rev-2' });
    expect(r.status).toBe(3);
    // the wording the incident responder recognises as a superseded release
    expect(r.out).toContain('not promoting: main has moved on');
    expect(r.switches).toEqual([]);
    // the production check sees nothing was promoted; the rollback has nothing to go back to
    expect(r.dotenv).toBe('SERVICE_URL=https://polyman-verify-x.run.app\nPREVIOUS_REVISION=\nPROMOTED=false\n');
  });

  it('refuses when it cannot compare this commit with main', () => {
    const r = run('promote', { traffic: serving('rev-1'), mainHead: 'newer', serviceDiff: 'error' }, { CANDIDATE_REVISION: 'rev-2' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('could not compare');
    expect(r.switches).toEqual([]);
  });

  it('refuses when it cannot read the head of main', () => {
    const r = run('promote', { traffic: serving('rev-1'), mainHead: '' }, { CANDIDATE_REVISION: 'rev-2' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('could not read the head of main');
    expect(r.switches).toEqual([]);
  });

  it('refuses when no revision serves all traffic and this is not the first release', () => {
    const r = run('promote', { traffic: [{ revisionName: 'rev-1', percent: 50 }, { revisionName: 'rev-0', percent: 50 }], mainHead: 'abc1234full' }, { CANDIDATE_REVISION: 'rev-2' });
    expect(r.status).toBe(1);
    expect(r.switches).toEqual([]);
  });
});

describe('cloudrun.sh rollback', () => {
  it("moves traffic back when production serves this pipeline's revision", () => {
    const r = run('rollback', { traffic: serving('rev-2'), mainHead: 'x' }, { CANDIDATE_REVISION: 'rev-2', PREVIOUS_REVISION: 'rev-1' });
    expect(r.status).toBe(0);
    expect(r.switches[0]).toContain('--to-revisions rev-1=100');
  });

  it('leaves a newer release alone', () => {
    const r = run('rollback', { traffic: serving('rev-3'), mainHead: 'x' }, { CANDIDATE_REVISION: 'rev-2', PREVIOUS_REVISION: 'rev-1' });
    expect(r.status).toBe(0);
    expect(r.switches).toEqual([]);
    expect(r.out).toContain('nothing to roll back');
  });

  it('fails loudly when the failed revision serves and there is nothing to go back to', () => {
    const r = run('rollback', { traffic: serving('rev-2'), mainHead: 'x' }, { CANDIDATE_REVISION: 'rev-2' });
    expect(r.status).toBe(1);
    expect(r.out).toContain('a person has to act');
    // who acts and the exact command, not only that someone should
    expect(r.out).toMatch(/NEXT STEP: a maintainer picks the last revision that passed its check .*gcloud run services update-traffic polyman-verify --region \S+ --to-revisions REVISION=100/);
  });

  it('runs (and does nothing) when the candidate deploy itself failed and left no dotenv', () => {
    const r = run('rollback', { traffic: serving('rev-1'), mainHead: 'x' });
    expect(r.status).toBe(0);
    expect(r.switches).toEqual([]);
  });
});

describe('cloudrun.sh discard', () => {
  it("removes every candidate's URL", () => {
    const r = run('discard', { traffic: serving('rev-1', 'c-abc1234', 'c-other12'), mainHead: 'x' });
    expect(r.status).toBe(0);
    expect(r.switches[0]).toContain('--remove-tags c-abc1234,c-other12');
  });
});
