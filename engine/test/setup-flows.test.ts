import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { FLOWS, definitionFor, pipelineFilter, triggerMatches, withAccounts } from '../src/cli/setup-flows.ts';

const spec = (name: string) => FLOWS.find(([n]) => n === name)![2];

describe('flow triggers', () => {
  it('the reviewer and the fixer only wake for merge request pipelines', () => {
    expect(pipelineFilter(spec('mr-reviewer'), 'main')).toEqual({
      pipeline_hooks: {
        rules: [
          { field: 'object_attributes.status', value: ['success'], operator: 'in' },
          { field: 'object_attributes.source', value: ['merge_request_event'], operator: 'in' },
        ],
      },
    });
    expect(pipelineFilter(spec('pipeline-fixer'), 'main')).toMatchObject({
      pipeline_hooks: { rules: [{ value: ['failed'] }, { value: ['merge_request_event'] }] },
    });
  });

  it('the incident responder only wakes for failed pipelines on the default branch', () => {
    expect(pipelineFilter(spec('incident-responder'), 'trunk')).toMatchObject({
      pipeline_hooks: { rules: [{ value: ['failed'] }, { field: 'object_attributes.ref', value: ['trunk'] }] },
    });
  });

  it('a flow without a pipeline trigger has no filter', () => {
    expect(pipelineFilter(spec('issue-builder'), 'main')).toEqual({});
  });

  it('creates each flow after the flows it hands work over to', async () => {
    const { readFileSync } = await import('node:fs');
    const order = FLOWS.map(([n]) => n);
    for (const [name] of FLOWS) {
      const text = readFileSync(`../.gitlab/duo/flows/${name}.yaml`, 'utf8');
      for (const [, target] of text.matchAll(/@@(\w+)_flow_id@@/g)) {
        expect(order.indexOf(target.replaceAll('_', '-'))).toBeLessThan(order.indexOf(name));
      }
    }
  });
});

describe('withAccounts', () => {
  const yml = `agents:\n  # set by setup-flows\n  reviewer_account: ""\n  fixer_account: ""\nmonitor: {}\n`;

  it('fills the account lines and keeps the rest', () => {
    expect(withAccounts(yml, { reviewer: 'ai-mr-reviewer-x', fixer: 'ai-pipeline-fixer-x' })).toBe(
      `agents:\n  # set by setup-flows\n  reviewer_account: ai-mr-reviewer-x\n  fixer_account: ai-pipeline-fixer-x\nmonitor: {}\n`,
    );
  });

  it('leaves a line alone when that account is unknown', () => {
    expect(withAccounts(yml, { reviewer: 'ai-r' })).toContain('fixer_account: ""');
  });

  it('says so when the file has no line to fill', () => {
    expect(() => withAccounts('agents: {}\n', { reviewer: 'ai-r' })).toThrow('no agents.reviewer_account line');
  });
});

describe('a dry run on a project with no flows yet', () => {
  it('can plan all four: each later flow gets a stand-in ID for the ones before it', () => {
    const config = loadConfig('../.autonomy.yml');
    const planned: Record<string, string> = {};
    for (const [name] of FLOWS) {
      const source = readFileSync(`../.gitlab/duo/flows/${name}.yaml`, 'utf8');
      expect(() => definitionFor(source, config, planned)).not.toThrow();
      planned[name] = 'DRY_RUN_ID';
    }
  });

  it('without the stand-ins the second flow could not be planned (the bug the reviewer found)', () => {
    const config = loadConfig('../.autonomy.yml');
    const source = readFileSync('../.gitlab/duo/flows/pipeline-fixer.yaml', 'utf8');
    expect(() => definitionFor(source, config, {})).toThrow('@@mr_reviewer_flow_id@@');
  });
});

describe('triggerMatches', () => {
  const filter = pipelineFilter(spec('mr-reviewer'), 'main');

  it('ignores the order of keys and of events', () => {
    const reordered = { pipeline_hooks: { rules: [{ operator: 'in', value: ['success'], field: 'object_attributes.status' }, { operator: 'in', value: ['merge_request_event'], field: 'object_attributes.source' }] } };
    expect(triggerMatches({ eventTypes: [0, 3], filter: reordered }, [3, 0], filter)).toBe(true);
  });

  it('reads a filter that comes back as a JSON string', () => {
    expect(triggerMatches({ eventTypes: [3, 0], filter: JSON.stringify(filter) }, [3, 0], filter)).toBe(true);
  });

  it('sees a missing rule or a different event', () => {
    expect(triggerMatches({ eventTypes: [3, 0], filter: {} }, [3, 0], filter)).toBe(false);
    expect(triggerMatches({ eventTypes: [3], filter }, [3, 0], filter)).toBe(false);
  });
});
