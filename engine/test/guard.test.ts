import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// guard.ts on a real git repo: an agent commit that moves a protected file away must still fail.

const GUARD = resolve(__dirname, '../src/cli/guard.ts');
const CONFIG = resolve(__dirname, 'fixtures/autonomy.yml');
const AGENT = ['-c', 'user.name=issue-builder', '-c', 'user.email=service_account_1@noreply.gitlab.com'];
const PERSON = ['-c', 'user.name=someone', '-c', 'user.email=someone@example.com'];

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const guard = (base: string, login?: string, extra: Record<string, string> = {}) =>
  spawnSync(process.execPath, [GUARD, base], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, CI_COMMIT_BRANCH: '', CI_DEFAULT_BRANCH: 'main', AUTONOMY_CONFIG: CONFIG, GITLAB_USER_LOGIN: login ?? '', ...extra },
  });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'guard-'));
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'engine'));
  writeFileSync(join(repo, 'engine/policy.ts'), 'export {};\n');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git('add', '.');
  git(...PERSON, 'commit', '-q', '-m', 'base');
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('guard', () => {
  it('passes agent commits outside protected paths', () => {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'README.md'), 'hello\n');
    git(...AGENT, 'commit', '-q', '-am', 'docs');
    expect(guard(base).status).toBe(0);
  });

  it('fails an agent commit that renames a protected file out of its path', () => {
    const base = git('rev-parse', 'HEAD');
    git('mv', 'engine/policy.ts', 'policy.ts');
    git(...AGENT, 'commit', '-q', '-m', 'move');
    const run = guard(base);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('engine/policy.ts');
  });

  describe('the incidents file', () => {
    const RESPONDER = ['-c', 'user.name=incident-responder', '-c', 'user.email=service_account_2@noreply.gitlab.com'];
    const lesson = (n: number) => ({ paths: [`src/f${n}.ts`], weight: 25, reason: `r${n}`, ref: `#${n}` });
    const write = (entries: object[]) => {
      mkdirSync(join(repo, '.autonomy'), { recursive: true });
      writeFileSync(join(repo, '.autonomy/incidents.json'), JSON.stringify(entries));
    };
    let base: string;
    beforeEach(() => {
      write([lesson(1)]);
      git('add', '.');
      git(...PERSON, 'commit', '-q', '-m', 'first lesson');
      base = git('rev-parse', 'HEAD');
    });

    it('lets the incident responder add a lesson', () => {
      write([lesson(1), lesson(2)]);
      git(...RESPONDER, 'commit', '-q', '-am', 'record incident 2');
      expect(guard(base, 'ai-incident-responder-gitlab-ai-hackathon').status).toBe(0);
    });

    it('fails when the responder rewrites an old lesson', () => {
      write([{ ...lesson(1), weight: 0 }, lesson(2)]);
      git(...RESPONDER, 'commit', '-q', '-am', 'record incident 2');
      expect(guard(base, 'ai-incident-responder-gitlab-ai-hackathon').status).toBe(1);
    });

    it('on the default branch, accepts the merged lesson although a person ran the pipeline', () => {
      write([lesson(1), lesson(2)]);
      git(...RESPONDER, 'commit', '-q', '-am', 'record incident 2');
      expect(guard(base, 'HamzaHassanain', { CI_COMMIT_BRANCH: 'main' }).status).toBe(0);
    });

    it('on the default branch, still fails a rewritten lesson', () => {
      write([{ ...lesson(1), weight: 0 }, lesson(2)]);
      git(...RESPONDER, 'commit', '-q', '-am', 'record incident 2');
      expect(guard(base, 'HamzaHassanain', { CI_COMMIT_BRANCH: 'main' }).status).toBe(1);
    });

    it('outside the default branch, a person running the pipeline does not let an agent append', () => {
      write([lesson(1), lesson(2)]);
      git(...RESPONDER, 'commit', '-q', '-am', 'record incident 2');
      expect(guard(base, 'HamzaHassanain', { CI_COMMIT_BRANCH: 'feature', CI_DEFAULT_BRANCH: 'main' }).status).toBe(1);
      expect(guard(base, 'HamzaHassanain', { CI_COMMIT_BRANCH: '', CI_DEFAULT_BRANCH: '' }).status).toBe(1);
    });

    it.each([
      ['a wrapped list', JSON.stringify({ incidents: [{ paths: ['src/f1.ts'], weight: 25, reason: 'r1', ref: '#1' }, { paths: ['src/f2.ts'], weight: 25, reason: 'r2', ref: '#2' }] })],
      ['null', 'null'],
      ['a shorter list', '[]'],
      ['invalid JSON', '[{'],
    ])('on the default branch, fails when the incidents file becomes %s', (_name, text) => {
      writeFileSync(join(repo, '.autonomy/incidents.json'), text);
      git(...RESPONDER, 'commit', '-q', '-am', 'rewrite lessons');
      expect(guard(base, 'HamzaHassanain', { CI_COMMIT_BRANCH: 'main' }).status).toBe(1);
    });

    it('fails another agent that only takes the responder name', () => {
      write([lesson(1), lesson(2)]);
      git(...RESPONDER, 'commit', '-q', '-am', 'record incident 2');
      const run = guard(base, 'ai-pipeline-fixer-gitlab-ai-hackathon');
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('.autonomy/incidents.json');
    });
  });
});
