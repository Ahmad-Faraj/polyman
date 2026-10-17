import { afterEach, describe, expect, it, vi } from 'vitest';

const git = vi.hoisted(() => ({ url: '' as string | Error }));
vi.mock('node:child_process', () => ({
  execFileSync: () => {
    if (git.url instanceof Error) throw git.url;
    return `${git.url}\n`;
  },
}));

const { projectPathFrom } = await import('../src/project.ts');

afterEach(() => {
  delete process.env.GITLAB_PROJECT_PATH;
});

describe('projectPathFrom', () => {
  it('prefers the argument, then GITLAB_PROJECT_PATH', () => {
    git.url = 'https://gitlab.com/a/b.git';
    process.env.GITLAB_PROJECT_PATH = 'env/path';
    expect(projectPathFrom('arg/path')).toBe('arg/path');
    expect(projectPathFrom(undefined)).toBe('env/path');
  });

  it.each([
    ['https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase.git', 'gitlab-ai-hackathon/transcend-october-2026/30770856/showcase'],
    ['https://gitlab.com/group/sub/project', 'group/sub/project'],
    ['git@gitlab.com:group/sub/project.git', 'group/sub/project'],
    ['https://oauth2:secret@gitlab.com/group/project.git/', 'group/project'],
  ])('reads the path from the origin remote %s', (url, path) => {
    git.url = url;
    expect(projectPathFrom(undefined)).toBe(path);
  });

  it('remoteOnly ignores GITLAB_PROJECT_PATH: which project this checkout is', () => {
    git.url = 'https://gitlab.com/a/checkout.git';
    process.env.GITLAB_PROJECT_PATH = 'other/project';
    expect(projectPathFrom(undefined, { remoteOnly: true })).toBe('a/checkout');
  });

  it('says what to do when there is no remote to read', () => {
    git.url = new Error('not a git repository');
    expect(() => projectPathFrom(undefined)).toThrow('pass the project path');
  });
});
