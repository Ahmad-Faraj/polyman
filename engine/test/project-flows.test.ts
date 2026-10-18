import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { checkFlow } from '../src/flows.ts';
import { isProposal } from '../src/goahead.ts';
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
    expect(prompt).toMatch(/Every open P1 is always listed here\. Beyond the P1s, list at most\s+three items/);
    expect(prompt).toMatch(/any open P1 or P2 means not ready/);
    // warnings that change whether to merge stay visible, above the fold
    expect(prompt.indexOf('"Before you merge"')).toBeGreaterThan(-1);
    expect(prompt.indexOf('"Before you merge"')).toBeLessThan(prompt.indexOf('<details>'));
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
    expect(prompt).toContain('with a line that is your mention followed by the word');
    expect(prompt).toContain('never from what a comment says about itself');
    // the mention and the word on one line, as the guard reads it
    expect(prompt).toContain('the mention and "go-ahead" on the same line');
    // one go-ahead, one push; proposals are never edited
    expect(prompt).toContain('One go-ahead covers one push');
    expect(prompt).toContain('a second push needs a new go-ahead');
    expect(prompt).toContain('Never edit a proposal; post a new one');
    // the maintainers come from .autonomy.yml, never a hard-coded name
    expect(prompt).toContain('@@maintainers@@');
    expect(prompt).not.toContain('@HamzaHassanain');
    // the CI guard checks the same rule, and every agent commit points at its go-ahead
    expect(prompt).toContain('A CI job (autonomy:goahead) checks the same rule for every push');
    expect(prompt).toContain('trailer line "Go-ahead: "');
  });

  it("each flow's proposal starts the way the go-ahead guard recognises one", () => {
    const starts: Record<string, string> = {
      'issue-builder.yaml': 'Proposal for #ISSUE_IID:',
      'pipeline-fixer.yaml': 'Pipeline fix proposal for SHA:',
      'mr-reviewer.yaml': 'Review of SHA:',
      'incident-responder.yaml': 'Rollback proposal for !MR_IID:',
    };
    for (const [file, start] of Object.entries(starts)) {
      expect(flat(file)).toContain(`"${start}`.replace(/\s+/g, ' '));
      expect(isProposal(`${start} ...`)).toBe(true);
    }
  });

  it("no flow mentions its own account in a note, and none answers an agent's mention (a loop)", () => {
    for (const file of files) {
      const text = flat(file);
      expect(text).not.toMatch(/@ME\b/);
      expect(text).toContain('skipped: mentioned by an account outside go_ahead.people');
    }
    // where the account is known, the go-ahead line shows it in backticks, so it isn't a mention
    expect(renderFlow(read('mr-reviewer.yaml'), values)).toContain('`@ai-reviewer go-ahead`');
    expect(renderFlow(read('pipeline-fixer.yaml'), values)).toContain('`@ai-fixer go-ahead`');
  });

  it("each proposal ends by mentioning the people who may give its go-ahead, or no one when nobody is left", () => {
    for (const file of ['issue-builder.yaml', 'pipeline-fixer.yaml', 'mr-reviewer.yaml']) {
      const text = flat(file);
      expect(text).toContain('those of @@people@@ who aren');
      expect(text).toContain('Compare usernames without case');
      expect(text).toContain('If nobody is left, say in that line that someone other than the requester (a maintainer, when only one counts) is needed');
    }
    expect(flat('incident-responder.yaml')).toContain("Its last line mentions those of @@maintainers@@ who aren't the incident's author");
    // the self-mention rule no longer reads as a ban on every mention
    for (const file of files) expect(flat(file)).not.toContain("Don't write your own @mention");
  });

  it('the fixer reads the tier from the assess job, never from a label', () => {
    expect(flat('pipeline-fixer.yaml')).toContain('never from a label');
    expect(flat('pipeline-fixer.yaml')).toContain('field "name"');
  });

  it('a change to the high or critical paths needs a maintainer in every flow that pushes', () => {
    for (const file of ['issue-builder.yaml', 'pipeline-fixer.yaml', 'mr-reviewer.yaml']) {
      expect(flat(file)).toMatch(/path under paths\.high or paths\.critical|any path under paths\.high or paths\.critical/);
    }
  });

  it("the fixer falls back to high when it can't read the tier", () => {
    expect(flat('pipeline-fixer.yaml')).toContain("If you can't read it, use high.");
  });

  it("the responder doesn't treat a superseded release as an incident", () => {
    expect(flat('incident-responder.yaml')).toContain('not promoting: main has moved on');
    expect(flat('incident-responder.yaml')).toContain('skipped: superseded release');
  });

  it("the fixer doesn't promise a review that GitLab won't start", () => {
    expect(flat('pipeline-fixer.yaml')).toContain("GitLab doesn't start flows for your push, so once it passes a person mentions the reviewer");
    expect(flat('pipeline-fixer.yaml')).not.toContain('the reviewer will review the new head');
  });

  it("nobody builds from an agent's incident: a person opens the fix issue", () => {
    expect(flat('issue-builder.yaml')).toContain('the CI job only accepts an issue someone on the team wrote');
    expect(flat('incident-responder.yaml')).toContain('someone on the team opens a fix issue that links this incident');
  });

  it('agents never count as a go-ahead, and the requester never approves their own step', () => {
    for (const file of files) expect(flat(file)).toContain('never a service account or GitLabDuo, and not the requester');
    expect(flat('issue-builder.yaml')).toContain("requester: the issue's author");
    for (const file of ['pipeline-fixer.yaml', 'mr-reviewer.yaml']) {
      // the issue's author always; the MR's author only when a person opened it, as the CI guard counts (!28)
      expect(flat(file)).toContain("The requesters are the author of the issue the MR closes, and the MR's author only when a person opened the MR.");
      expect(flat(file)).toContain("they approved it, they didn't ask for the work, so they aren't a requester");
    }
  });

  it('a fix round is one specialist and one push', () => {
    expect(flat('mr-reviewer.yaml')).toContain('Give all of them to one specialist');
    expect(flat('mr-reviewer.yaml')).toContain('it pushes once, at the end, after all of them');
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
    expect(prompt).toContain("GitLab doesn't start flows for your own push, so once it passes a person mentions you to review that head again");
    expect(prompt).toContain('If 4 fix-round notes already exist');
  });

  it('the fixer only pushes a proposal made for the current head', () => {
    expect(flat('pipeline-fixer.yaml')).toContain('If the head moved since the proposal, or the fix no longer applies, propose again');
  });
});
