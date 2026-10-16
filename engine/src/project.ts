import { execFileSync } from 'node:child_process';

/**
 * The GitLab project the maintainer tools act on: the first argument, else
 * GITLAB_PROJECT_PATH, else the path of the `origin` remote.
 */
export function projectPathFrom(arg: string | undefined, opts: { remoteOnly?: boolean } = {}): string {
  if (arg) return arg;
  // remoteOnly: which project this checkout is, whatever GITLAB_PROJECT_PATH says
  if (!opts.remoteOnly && process.env.GITLAB_PROJECT_PATH) return process.env.GITLAB_PROJECT_PATH;
  let url = '';
  try {
    url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  } catch {
    // no git or no origin; fall through to the error below
  }
  const path = /^(?:https?:\/\/[^/]+\/|[^@]+@[^:]+:)(.+?)(?:\.git)?\/?$/.exec(url)?.[1];
  if (!path) throw new Error('pass the project path (group/project) or set GITLAB_PROJECT_PATH');
  return path;
}
