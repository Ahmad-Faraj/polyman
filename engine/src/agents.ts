import { matchesAny } from './glob.ts';

/** GitLab commits made by a flow's service account use this author email. */
const AGENT_EMAIL = /^service_account_.*@noreply\.gitlab\.com$/i;

export const isAgentEmail = (email: string) => AGENT_EMAIL.test(email);

/** Pipelines started by a flow (an agent pushed) run as its service account. */
export const isAgentLogin = (login: string | undefined, pattern = /^ai-/) => !!login && pattern.test(login);

export interface CommitFiles {
  sha: string;
  authorName: string;
  authorEmail: string;
  files: string[];
}

export interface Violation {
  sha: string;
  agent: string;
  files: string[];
}

/**
 * The incident responder's service account. Matched against the pipeline's user
 * (GITLAB_USER_LOGIN, set by GitLab from who pushed), never the commit author,
 * which any agent can set with `git -c user.name=...`.
 */
export const isIncidentResponderLogin = (login: string | undefined) => isAgentLogin(login, /^ai-incident-responder/);

/**
 * Whether the incidents file only grew: every entry that was there before is
 * still there, unchanged and in order. The responder may add a lesson, never
 * rewrite or drop one.
 */
export function onlyAppends(before: string | undefined, after: string | undefined): boolean {
  try {
    const old = before === undefined ? [] : JSON.parse(before);
    const now = after === undefined ? undefined : JSON.parse(after);
    if (!Array.isArray(old) || !Array.isArray(now) || now.length < old.length) return false;
    return old.every((entry, i) => JSON.stringify(entry) === JSON.stringify(now[i]));
  } catch {
    return false;
  }
}

/**
 * Agent commits that touch files only people may change. `exempt` names a
 * protected file a commit may change anyway (the incidents file, when the
 * incident responder only adds to it).
 */
export function protectedPathViolations(
  commits: CommitFiles[],
  governance: string[],
  exempt: (file: string, commit: CommitFiles) => boolean = () => false,
): Violation[] {
  return commits
    .filter((c) => isAgentEmail(c.authorEmail))
    .map((c) => ({
      sha: c.sha,
      agent: c.authorName,
      files: c.files.filter((f) => matchesAny(f, governance) && !exempt(f, c)),
    }))
    .filter((v) => v.files.length > 0);
}

/**
 * Parses `git log --format=%x00%H%x09%an%x09%ae --name-only` output.
 */
export function parseGitLog(output: string): CommitFiles[] {
  return output
    .split('\0')
    .filter((block) => block.trim())
    .map((block) => {
      const [header, ...rest] = block.split('\n');
      const [sha, authorName, authorEmail] = header.split('\t');
      return { sha, authorName, authorEmail, files: rest.map((l) => l.trim()).filter(Boolean) };
    });
}
