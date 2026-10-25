import { describe, expect, it } from 'vitest';
import { NONE, add, flowOf, median, mrOf, roleOf, tokensOf, totalTokens } from '../src/tokens.ts';

const reply = (input: number, write: number, read: number, output: number, content = '', model = 'claude-sonnet-5-5') => ({
  type: 'ai',
  content,
  usage_metadata: { input_tokens: input, output_tokens: output, input_token_details: { cache_creation: write, cache_read: read } },
  response_metadata: { model_name: model },
});
const tool = (content: string) => ({ type: 'tool', content });

// the shape GraphQL's duoWorkflowEvents returns: a checkpoint as a JSON string
const checkpoint = JSON.stringify({
  channel_values: {
    status: 'Completed',
    conversation_history: {
      lead_reviewer: [
        { ...reply(100, 90, 0, 10), additional_kwargs: { tool_calls: [{ function: { name: 'get_merge_request', arguments: '{"project_id": "1", "merge_request_iid": 95}' } }] } },
        tool('{"merge_request": "{\\"iid\\":95}"}'),
        reply(200, 20, 170, 30, 'I reviewed MR !95 and posted the review note.'),
      ],
      lead_reviewer__code_reviewer__2: [reply(500, 400, 0, 50), tool('ok'), reply(600, 50, 540, 70, '', 'claude-haiku-5-5')],
    },
  },
});

describe('token counts from a session checkpoint', () => {
  it('counts each model reply once, by class, for the lead and each specialist', () => {
    const s = tokensOf(checkpoint);
    expect(s.status).toBe('Completed');
    expect(s.agents.map((a) => a.agent)).toEqual(['lead_reviewer', 'lead_reviewer__code_reviewer__2']);
    expect(s.agents[0]).toMatchObject({ calls: 2, cacheWrite: 110, cacheRead: 170, uncached: 20, output: 40, models: ['claude-sonnet-5-5'] });
    // uncached = input - cache write - cache read: (500 - 400) + (600 - 50 - 540)
    expect(s.agents[1]).toMatchObject({ calls: 2, cacheWrite: 450, cacheRead: 540, uncached: 110, output: 120, models: ['claude-sonnet-5-5', 'claude-haiku-5-5'] });
  });

  it('keeps the first agent\'s last reply, which is where a skip says so', () => {
    expect(tokensOf(checkpoint).lastText).toBe('I reviewed MR !95 and posted the review note.');
    const skip = JSON.stringify({ channel_values: { conversation_history: { lead_reviewer: [reply(10, 10, 0, 5, 'skipped: draft MR')] } } });
    expect(tokensOf(skip).lastText).toMatch(/^skipped:/);
  });

  it('finds the MR in a tool call, however deep the JSON escaping', () => {
    expect(tokensOf(checkpoint).mr).toBe(95);
    expect(mrOf('{\\\\\\"merge_request_iid\\\\\\": 103}')).toBe(103);
  });

  it('finds the MR in the pipeline event that started a session', () => {
    expect(mrOf('"goal": "{\\"merge_request\\":{\\"id\\":551041593,\\"iid\\":95,\\"title\\":\\"fix\\"}}"')).toBe(95);
    expect(mrOf('no merge request here')).toBeNull();
  });

  it('never counts a negative uncached part when the cache numbers cover the input', () => {
    const odd = JSON.stringify({ channel_values: { conversation_history: { issue_builder: [reply(100, 80, 40, 1)] } } });
    expect(tokensOf(odd).agents[0].uncached).toBe(0);
  });

  it('names the flow from its first agent and the role from the specialist part', () => {
    const s = tokensOf(checkpoint);
    expect(flowOf(s.agents)).toBe('mr-reviewer');
    expect(roleOf('lead_reviewer')).toBe('lead');
    expect(roleOf('lead_reviewer__security_reviewer__1')).toBe('security_reviewer');
    const named = (agent: string) => flowOf([{ agent, models: [], ...NONE }]);
    expect(named('builder')).toBe('issue-builder');
    expect(named('fixer')).toBe('pipeline-fixer');
    expect(named('responder')).toBe('incident-responder');
    expect(named('developer_agent')).toBe('gitlab: developer_agent');
  });

  it('adds classes, totals all four, and takes medians', () => {
    const [lead, code] = tokensOf(checkpoint).agents;
    const both = add(lead, code);
    expect(both.calls).toBe(4);
    expect(totalTokens(both)).toBe(20 + 110 + 170 + 40 + 110 + 450 + 540 + 120);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
});
