import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { flowValues, markersIn, renderFlow } from '../src/render.ts';

const config = {
  ...DEFAULT_CONFIG,
  agents: { ...DEFAULT_CONFIG.agents, checks: 'make test', reviewerAccount: 'bot-a', fixerAccount: 'bot-b' },
  monitor: { measuredRoutes: ['GET /health', 'POST /api/x'] },
};

describe('flow values', () => {
  it('turns the governance globs into a readable list', () => {
    expect(flowValues(config, {}).protected_paths).toBe('.gitlab-ci.yml, .autonomy.yml, .autonomy/, .gitlab/');
  });

  it('lists the measured routes, or says there are none', () => {
    expect(flowValues(config, {}).measured_routes).toBe('GET /health, POST /api/x');
    expect(flowValues({ ...config, monitor: { measuredRoutes: [] } }, {}).measured_routes).toMatch(/^none/);
  });

  it('only offers the IDs of the flows others hand over to', () => {
    const v = flowValues(config, { 'mr-reviewer': '11', 'issue-builder': '22', 'pipeline-fixer': '33' });
    expect(v.mr_reviewer_flow_id).toBe('11');
    expect(v.issue_builder_flow_id).toBe('22');
    expect(Object.values(v)).not.toContain('33');
  });

  it('leaves out account names that are not set, so a flow that needs one fails to render', () => {
    const v = flowValues({ ...config, agents: { ...config.agents, fixerAccount: '' } }, {});
    expect(() => renderFlow('count notes by @@fixer_account@@', v)).toThrow('@@fixer_account@@');
  });
});

describe('renderFlow', () => {
  it('fills every marker, as often as it appears', () => {
    expect(renderFlow('@@checks@@ then @@checks@@', { checks: 'make test' })).toBe('make test then make test');
  });

  it('names every marker that has no value', () => {
    expect(() => renderFlow('@@a@@ @@b@@ @@c@@', { b: 'x' })).toThrow('no value for @@a@@, @@c@@');
  });

  it('leaves text without markers alone', () => {
    expect(renderFlow('a @ b @@ c', {})).toBe('a @ b @@ c');
    expect(markersIn('@@x@@ @@x@@ @@y@@')).toEqual(['x', 'y']);
  });
});
