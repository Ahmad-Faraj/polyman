import { describe, expect, it } from 'vitest';
import { checkFlow, promptProblems } from '../src/flows.ts';

const flow = (system: string, extra = '') => `version: "v1"
environment: ambient
components:
  - name: "agent"
    type: AgentComponent
    prompt_id: "p"
    inputs:
      - from: "context:goal"
        as: "event"
${extra}
prompts:
  - prompt_id: "p"
    name: "P"
    unit_primitives: []
    prompt_template:
      system: |
        ${system}
      user: "{{event}}"
routers:
  - from: "agent"
    to: "end"
flow:
  entry_point: "agent"
`;

describe('checkFlow', () => {
  it('accepts a valid flow', () => {
    expect(checkFlow(flow('Review the change.'))).toEqual([]);
  });

  it('rejects fields GitLab does not allow', () => {
    expect(checkFlow(flow('Review.', '    max_cycles: 60')).join()).toMatch(/additional properties/);
  });

  it('rejects HTML comments and placeholders in angle brackets', () => {
    expect(checkFlow(flow('Start the note with <!-- marker -->.')).join()).toMatch(/HTML comment/);
    expect(promptProblems('Use <goal> here')).toHaveLength(1);
  });

  it('rejects prompt variables that are not inputs', () => {
    expect(checkFlow(flow('Project {{project_id}}')).join()).toMatch(/project_id/);
  });
});
