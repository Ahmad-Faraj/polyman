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
const guard = (base: string) =>
  spawnSync(process.execPath, [GUARD, base], { cwd: repo, encoding: 'utf8', env: { ...process.env, AUTONOMY_CONFIG: CONFIG } });

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
});
