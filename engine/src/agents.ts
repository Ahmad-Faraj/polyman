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

/** The incident responder records lessons in the incidents file; no other agent may. */
const INCIDENT_RESPONDER = /incident-responder/i;

/**
 * Agent commits that touch files only people may change. The one exception is
 * the incidents file, which the incident responder's rollback MR adds to.
 */
export function protectedPathViolations(commits: CommitFiles[], governance: string[], incidentsFile?: string): Violation[] {
  return commits
    .filter((c) => isAgentEmail(c.authorEmail))
    .map((c) => ({
      sha: c.sha,
      agent: c.authorName,
      files: c.files.filter(
        (f) => matchesAny(f, governance) && !(f === incidentsFile && INCIDENT_RESPONDER.test(c.authorName)),
      ),
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
