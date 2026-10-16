import { describe, expect, it } from 'vitest';
import { isAgentEmail, isAgentLogin, parseGitLog, protectedPathViolations } from '../src/agents.ts';

const agentEmail = 'service_account_group_121124982_255137e55f6ff38b805a9b333089df65@noreply.gitlab.com';
const governance = ['.gitlab-ci.yml', '.autonomy.yml', '.autonomy/**', '.gitlab/**', 'engine/**'];

describe('agent detection', () => {
  it('recognises service account commits and logins', () => {
    expect(isAgentEmail(agentEmail)).toBe(true);
    expect(isAgentEmail('mznghanayem@gmail.com')).toBe(false);
    expect(isAgentLogin('ai-pipeline-fixer-gitlab-ai-hackathon')).toBe(true);
    expect(isAgentLogin('Mazen-Ghanaym')).toBe(false);
    expect(isAgentLogin(undefined)).toBe(false);
  });
});

describe('protectedPathViolations', () => {
  const log = [
    `\0aaa111\tMazen-Ghanaym\tmznghanayem@gmail.com\n\n.gitlab-ci.yml\nsrc/app.ts\n`,
    `\0bbb222\tpipeline-fixer\t${agentEmail}\n\nsrc/routes/orders.ts\n`,
    `\0ccc333\tmr-reviewer\t${agentEmail}\n\ntests/a.test.ts\nengine/src/risk.ts\n`,
  ].join('');

  it('parses git log output', () => {
    const commits = parseGitLog(log);
    expect(commits.map((c) => c.sha)).toEqual(['aaa111', 'bbb222', 'ccc333']);
    expect(commits[2].files).toEqual(['tests/a.test.ts', 'engine/src/risk.ts']);
  });

  it('flags only agent commits that touch protected paths', () => {
    const v = protectedPathViolations(parseGitLog(log), governance);
    expect(v).toEqual([{ sha: 'ccc333', agent: 'mr-reviewer', files: ['engine/src/risk.ts'] }]);
  });

  it('lets people change protected files', () => {
    const v = protectedPathViolations(parseGitLog(`\0aaa\tMazen\tm@x.com\n\n.gitlab-ci.yml\n`), governance);
    expect(v).toEqual([]);
  });
});
