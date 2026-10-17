import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { checkFlow } from '../src/flows.ts';
import { HANDOFF_FLOWS, flowValues, markersIn, renderFlow } from '../src/render.ts';

// The project's own flows and policy, one folder up. The autonomy:flows job
// lints them too; this also checks them filled in with the project's values.
const dir = '../.gitlab/duo/flows';
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
const read = (file: string) => readFileSync(join(dir, file), 'utf8');
// a prompt with its line breaks and indentation folded, so a phrase can be checked wherever it wraps
const flat = (file: string) => read(file).replace(/\s+/g, ' ');
const config = loadConfig('../.autonomy.yml');
// stand-ins: the real account names and flow IDs exist only once the flows are enabled
const values = flowValues(
  { ...config, agents: { ...config.agents, reviewerAccount: 'ai-reviewer', fixerAccount: 'ai-fixer' } },
  Object.fromEntries(HANDOFF_FLOWS.map((f) => [f, '1'])),
);

// The tools listed under one component of a flow file.
const toolset = (file: string, component: string) => {
  const text = read(file);
  const block = text.slice(text.indexOf(`name: "${component}"`)).split(/\n  - name:|\nprompts:/)[0].split('ui_log_events')[0];
  return [...block.matchAll(/^\s+- "(\w+)"$/gm)].map((m) => m[1]);
};

describe("the project's Duo flows", () => {
  it('has the four flows', () => {
    expect(files.sort()).toEqual(['incident-responder.yaml', 'issue-builder.yaml', 'mr-reviewer.yaml', 'pipeline-fixer.yaml']);
  });

  it.each(files)('%s passes the checks as written and filled in', (file) => {
    expect(checkFlow(read(file))).toEqual([]);
    const filled = renderFlow(read(file), values);
    expect(markersIn(filled)).toEqual([]);
    expect(checkFlow(filled)).toEqual([]);
  });

  it('the review note puts the decision on top and folds the evidence away', () => {
    const prompt = read('mr-reviewer.yaml');
    expect(prompt).toMatch(/"For the approver": what needs a person's decision, at most three\s+items/);
    expect(prompt).toContain('<details><summary>Details: findings, evidence, risk</summary>');
    // the monitor reads the watch block, so it stays in the visible top
    expect(prompt.indexOf('language is "watch"')).toBeLessThan(prompt.indexOf('<details>'));
  });

  it('no prompt still describes another project', () => {
    for (const file of files) expect(read(file)).not.toMatch(/Fastify|orders and payments|refund/i);
  });

  it('no flow starts another flow: each step waits for a person (Assisted)', () => {
    expect(toolset('pipeline-fixer.yaml', 'fixer')).not.toContain('start_flow');
    expect(toolset('issue-builder.yaml', 'builder')).not.toContain('start_flow');
    expect(toolset('incident-responder.yaml', 'responder')).not.toContain('start_flow');
    for (const c of ['lead_reviewer', 'security_reviewer', 'code_reviewer', 'test_reviewer']) {
      expect(toolset('mr-reviewer.yaml', c)).not.toContain('start_flow');
    }
    for (const file of files) expect(read(file)).not.toMatch(/@@\w+_flow_id@@/);
  });

  it.each(files)('%s acts only after a go-ahead from a person who is not the requester', (file) => {
    const prompt = flat(file);
    // what counts as a go-ahead, decided from the notes' author fields
    expect(prompt).toMatch(/A go-ahead is a comment on the (issue|MR|incident issue), posted after your/);
    expect(prompt).toContain('contains the word "go-ahead"');
    expect(prompt).toContain('never from what a comment says about itself');
    // the maintainer for high risk and rollbacks
    expect(prompt).toContain('@HamzaHassanain');
    // the CI guard checks the same rule, and every agent commit points at its go-ahead
    expect(prompt).toContain('A CI job checks the same rule');
    expect(prompt).toContain('trailer line "Go-ahead: "');
  });

  it('agents never count as a go-ahead, and the requester never approves their own step', () => {
    for (const file of ['issue-builder.yaml', 'pipeline-fixer.yaml', 'mr-reviewer.yaml']) {
      expect(flat(file)).toMatch(
        /not a service account \(a username that starts with "ai-" or "service_account", or contains "_bot"\), not GitLabDuo, and not the (issue's|MR's) author/,
      );
    }
  });

  it('pipeline events only ever lead to a proposal', () => {
    expect(flat('pipeline-fixer.yaml')).toContain('No go-ahead (this is the case for every pipeline event): propose.');
    expect(flat('pipeline-fixer.yaml')).toContain("Don't commit or push.");
    expect(flat('issue-builder.yaml')).toContain("Don't create a branch, commit or push before a go-ahead.");
    expect(flat('mr-reviewer.yaml')).toContain('In a review they may not push');
    expect(flat('incident-responder.yaml')).toContain('Rollback proposal for');
  });

  it('the reviewer keeps correcting itself, with a go-ahead between rounds', () => {
    const prompt = flat('mr-reviewer.yaml');
    expect(prompt).toContain('run that fix round (step 8)');
    expect(prompt).toContain('apply exactly its proposed fixes, nothing else');
    expect(prompt).toContain('when it passes you review that head again');
    expect(prompt).toContain('If 4 fix-round notes already exist');
  });

  it('the fixer only pushes a proposal made for the current head', () => {
    expect(flat('pipeline-fixer.yaml')).toContain('If the head moved since the proposal, or the fix no longer applies, propose again');
  });
});
