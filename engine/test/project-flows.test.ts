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

  it('only the pipeline fixer, the issue builder and the incident responder may start flows', () => {
    expect(toolset('pipeline-fixer.yaml', 'fixer')).toContain('start_flow');
    // the issue builder's own push starts no flow, so it hands its MR on itself
    expect(toolset('issue-builder.yaml', 'builder')).toContain('start_flow');
    expect(toolset('incident-responder.yaml', 'responder')).toContain('start_flow');
    // the reviewer asks for GitLab's Code Review with a quick action instead: a
    // flow can't start Code Review with start_flow (one agent identity per request)
    for (const c of ['lead_reviewer', 'security_reviewer', 'code_reviewer', 'test_reviewer']) {
      expect(toolset('mr-reviewer.yaml', c)).not.toContain('start_flow');
    }
  });

  it('for low risk the lead asks GitLabDuo to review with one quick action, and checks a new request went through', () => {
    const prompt = read('mr-reviewer.yaml');
    // one command in GitLab: it adds the reviewer, or re-requests if already one
    // (`command :request_review, :assign_reviewer, :reviewer`), and it's on the
    // list of quick actions AI workflows may use
    expect(prompt).toMatch(/whose whole body is exactly "\/request_review @GitLabDuo"/);
    expect(prompt).toMatch(/Don't post any other quick\s+action\./);
    expect(prompt).toMatch(/system note "requested review from @GitLabDuo" is newer\s+than your quick-action note/);
    // the tools that path needs
    expect(toolset('mr-reviewer.yaml', 'lead_reviewer')).toEqual(
      expect.arrayContaining(['get_merge_request', 'create_merge_request_note', 'list_all_merge_request_notes']),
    );
  });

  it('the lead reviewer has no shell while it reads untrusted diffs and logs', () => {
    expect(toolset('mr-reviewer.yaml', 'lead_reviewer')).not.toContain('run_command');
  });

  it('hand-overs use the filled-in flow IDs, never a hard-coded one', () => {
    for (const file of files) {
      for (const [, id] of read(file).matchAll(/"ai_catalog_item_consumer_id": ([^,}\s]+)/g)) {
        expect(id).toMatch(/^@@\w+_flow_id@@$/);
      }
    }
  });

  it('the incident responder can read issue notes, which its duplicate check relies on', () => {
    expect(toolset('incident-responder.yaml', 'responder')).toEqual(expect.arrayContaining(['list_issue_notes', 'get_issue']));
  });

  it('the fixer only trusts a pipeline for the commit it pushed', () => {
    expect(read('pipeline-fixer.yaml')).toMatch(/head_pipeline when its sha is the\s+commit you pushed/);
  });
});
