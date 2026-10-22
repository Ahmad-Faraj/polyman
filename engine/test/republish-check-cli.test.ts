import { describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve('src/cli/republish-check.ts');
const ROOT = resolve('..');

/** This project's policy and flows. */
const project = (dir: string) => {
  cpSync(join(ROOT, '.autonomy.yml'), join(dir, '.autonomy.yml'));
  cpSync(join(ROOT, '.gitlab/duo/flows'), join(dir, '.gitlab/duo/flows'), { recursive: true });
};

/** A git repo with a base commit (by default this project's policy and flows), and one change on top. */
function repo(change: (dir: string) => void, seed: (dir: string) => void = project) {
  const dir = mkdtempSync(join(tmpdir(), 'republish-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(dir, 'README'), 'base\n');
  seed(dir);
  git('add', '.');
  git('-c', 'user.name=a', '-c', 'user.email=a@x', 'commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  change(dir);
  git('add', '-A');
  git('-c', 'user.name=a', '-c', 'user.email=a@x', 'commit', '-qm', 'change', '--allow-empty');
  return { dir, base };
}

const edit = (dir: string, file: string, from: string, to: string) => {
  const text = readFileSync(join(dir, file), 'utf8');
  if (!text.includes(from)) throw new Error(`${file} has no ${from}`);
  writeFileSync(join(dir, file), text.replace(from, to));
};
const addPerson = (dir: string) => edit(dir, '.autonomy.yml', '  people:\n', '  people:\n    - new-person\n');

// only the variables given: the tests may themselves run in an MR pipeline
const run = (dir: string, env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
  });

describe('republish-check', () => {
  it('warns in the MR, naming the flows that mention go_ahead.people, when the list changes', () => {
    const r = repo(addPerson);
    const out = run(r.dir, { CI_MERGE_REQUEST_DIFF_BASE_SHA: r.base });
    expect(out.status).toBe(3);
    expect(out.stderr).toContain('Once this is merged, the published flows are behind it');
    for (const flow of ['issue-builder', 'mr-reviewer', 'pipeline-fixer']) {
      expect(out.stderr).toContain(`  ${flow}: go_ahead.people changed in .autonomy.yml\n`);
    }
    // the incident responder only names the maintainers
    expect(out.stderr).not.toContain('incident-responder');
    expect(out.stderr).toContain('GITLAB_TOKEN=... node engine/src/cli/sync-flows.ts');
  });

  it('warns again on the default branch after the merge', () => {
    const r = repo(addPerson);
    const out = run(r.dir, { CI_COMMIT_BRANCH: 'main', CI_DEFAULT_BRANCH: 'main', CI_COMMIT_BEFORE_SHA: r.base });
    expect(out.status).toBe(3);
    expect(out.stderr).toContain('The published flows are now behind the default branch');
  });

  it('says nothing to do when the change fills nothing into the flows', () => {
    const r = repo((dir) => edit(dir, '.autonomy.yml', 'medium: 25', 'medium: 30'));
    const out = run(r.dir, {}, r.base);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('nothing to republish');
  });

  it('counts a changed flow file', () => {
    const r = repo((dir) => writeFileSync(join(dir, '.gitlab/duo/flows/issue-builder.yaml'), '\n', { flag: 'a' }));
    const out = run(r.dir, {}, r.base);
    expect(out.status).toBe(3);
    expect(out.stderr).toContain('  issue-builder: .gitlab/duo/flows/issue-builder.yaml changed\n');
  });

  it("counts every setting as changed when the base's .autonomy.yml doesn't load", () => {
    const r = repo(project, (dir) => {
      project(dir);
      writeFileSync(join(dir, '.autonomy.yml'), 'go_ahead: [unclosed\n');
    });
    const out = run(r.dir, {}, r.base);
    expect(out.status).toBe(3);
    expect(out.stderr).toMatch(/the base's \.autonomy\.yml doesn't load \(.*\); counting every setting as changed/s);
    // the files are the same, so it's the values: every setting each flow uses
    expect(out.stderr).not.toContain('.yaml changed');
    for (const flow of ['incident-responder', 'issue-builder', 'mr-reviewer', 'pipeline-fixer']) {
      expect(out.stderr).toMatch(new RegExp(`\n  ${flow}: .*go_ahead\\.maintainers changed`));
    }
    expect(out.stderr).toMatch(/\n {2}mr-reviewer: .*go_ahead\.people changed.*agents\.checks changed/);
  });

  it('needs no republish when a flow file is removed', () => {
    const r = repo((dir) => rmSync(join(dir, '.gitlab/duo/flows/incident-responder.yaml')));
    const out = run(r.dir, {}, r.base);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('nothing to republish');
  });

  it('counts every flow as new when the base has no policy and no flows', () => {
    const r = repo(project, () => {});
    const out = run(r.dir, {}, r.base);
    expect(out.status).toBe(3);
    expect(out.stderr).not.toContain("doesn't load");
    for (const flow of ['incident-responder', 'issue-builder', 'mr-reviewer', 'pipeline-fixer']) {
      expect(out.stderr).toMatch(new RegExp(`\n  ${flow}: .*\\.gitlab/duo/flows/${flow}\\.yaml changed\n`));
    }
  });

  it('falls back to the previous commit when GitLab sends no commit before the push', () => {
    const r = repo(addPerson);
    expect(run(r.dir, { CI_COMMIT_BEFORE_SHA: '0'.repeat(40) }).status).toBe(3);
  });

  it('fails when the base commit is not there', () => {
    const r = repo(addPerson);
    const out = run(r.dir, {}, 'f'.repeat(40));
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/can't find the base commit/);
  });
});
