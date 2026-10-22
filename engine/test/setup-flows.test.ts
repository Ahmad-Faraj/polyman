import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { FLOWS, type Gql, type Rest, type SetupOptions, definitionFor, finishAccounts, gitlabUrl, isEntry, mayWriteAccounts, pipelineFilter, pushBlocked, setupFlows, triggerMatches, unprotected, withAccounts } from '../src/cli/setup-flows.ts';

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

  it('keeps a comment at the end of the line, and only touches that line', () => {
    const commented = `agents:\n  reviewer_account: "" # set by setup-flows\n\n  fixer_account: ""\n`;
    expect(withAccounts(commented, { reviewer: 'ai-r' })).toBe(`agents:\n  reviewer_account: ai-r # set by setup-flows\n\n  fixer_account: ""\n`);
  });

  it('refuses a value that is not a username', () => {
    expect(() => withAccounts(yml, { reviewer: 'a$&b' })).toThrow('not a username');
    expect(() => withAccounts(yml, { reviewer: 'a\nmonitor: x' })).toThrow('not a username');
  });

  it('says so when the file has no line to fill', () => {
    expect(() => withAccounts('agents: {}\n', { reviewer: 'ai-r' })).toThrow('no agents.reviewer_account line');
  });

  it('fills the key line, not a comment that names it or a longer key ending in it', () => {
    const tricky = `agents:\n  # reviewer_account: filled in by setup-flows\n  old_fixer_account: keep\n  reviewer_account: ""\n  fixer_account: ""\n`;
    expect(withAccounts(tricky, { reviewer: 'ai-r', fixer: 'ai-f' })).toBe(
      `agents:\n  # reviewer_account: filled in by setup-flows\n  old_fixer_account: keep\n  reviewer_account: ai-r\n  fixer_account: ai-f\n`,
    );
  });

  it('takes real account names, with digits and underscores', () => {
    const filled = withAccounts(yml, { reviewer: 'ai-mr-reviewer-gitlab-ai-hackathon_e50080', fixer: 'ai-pipeline-fixer-gitlab-ai-hackathon_b1d814' });
    expect(filled).toContain('  reviewer_account: ai-mr-reviewer-gitlab-ai-hackathon_e50080\n');
    expect(filled).toContain('  fixer_account: ai-pipeline-fixer-gitlab-ai-hackathon_b1d814\n');
  });
});

describe('a dry run on a project with no flows yet', () => {
  it("no flow needs another flow's ID, so each can be planned before any exists (Assisted: no hand-offs)", () => {
    const config = loadConfig('../.autonomy.yml');
    for (const [name] of FLOWS) {
      const source = readFileSync(`../.gitlab/duo/flows/${name}.yaml`, 'utf8');
      expect(() => definitionFor(source, config, {})).not.toThrow();
    }
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

  it('sees the same number of events or rules with different values', () => {
    expect(triggerMatches({ eventTypes: [0, 1], filter }, [3, 0], filter)).toBe(false);
    expect(triggerMatches({ eventTypes: [3, 0], filter: pipelineFilter(spec('pipeline-fixer'), 'main') }, [3, 0], filter)).toBe(false);
    const incident = pipelineFilter(spec('incident-responder'), 'main');
    expect(triggerMatches({ eventTypes: [3], filter: pipelineFilter(spec('incident-responder'), 'next') }, [3], incident)).toBe(false);
  });

  it('sees a missing rule or a different event', () => {
    expect(triggerMatches({ eventTypes: [3, 0], filter: {} }, [3, 0], filter)).toBe(false);
    expect(triggerMatches({ eventTypes: [3], filter }, [3, 0], filter)).toBe(false);
  });
});

interface FakeOptions {
  /** catalog items that exist already (other projects' flows, or one of ours never enabled) */
  items?: { id: string; name: string; project: { fullPath: string } | null }[];
  /** enabling fails this many times */
  enableFailures?: number;
  /** flows enabled here already */
  consumers?: { id: string; item: { id: string; name: string; project: { fullPath: string } | null } }[];
  pushLevels?: { access_level: number; user_id?: number }[] | null;
  mustSucceed?: { project?: boolean; group?: boolean };
  /** the project's default branch */
  rootRef?: string;
  /** enabling a flow makes no trigger, as when the mention trigger was deleted by hand */
  noTriggerOnEnable?: boolean;
  /** what GitLab answers to a trigger create or update */
  triggerErrors?: string[];
}

/** Just enough of GitLab for setupFlows, with pages of one so paging is exercised. */
function fakeGitLab(o: FakeOptions = {}) {
  const items = [...(o.items ?? [])];
  const consumers: { id: string; item: { id: string; name: string; project: { fullPath: string } | null } }[] = [...(o.consumers ?? [])];
  const triggers: { id: string; eventTypes: number[]; filter: unknown; user: { username: string }; aiCatalogItemConsumer: { id: string } }[] = [];
  const mutations: string[] = [];
  /** each mutation's input, in order */
  const inputs: { mutation: string; input: Record<string, any> }[] = [];
  /** the definition each flow was created with, by name */
  const definitions = new Map<string, string>();
  let failures = o.enableFailures ?? 0;
  const page = <T>(nodes: T[], after: unknown) => {
    const at = after ? Number(after) : 0;
    return { nodes: nodes.slice(at, at + 1), pageInfo: { hasNextPage: at + 1 < nodes.length, endCursor: String(at + 1) } };
  };
  const gql = (async (query: string, v: Record<string, any> = {}) => {
    if (query.includes('repository { rootRef }')) return { project: { id: 'gid://gitlab/Project/1', repository: { rootRef: o.rootRef ?? 'main' } } };
    // newest first, as GitLab lists them
    if (query.includes('aiCatalogConfiguredItems')) return { aiCatalogConfiguredItems: page([...consumers].reverse(), v.after) };
    if (query.includes('aiFlowTriggers')) return { project: { aiFlowTriggers: page(triggers, v.after) } };
    if (query.includes('aiCatalogItems(')) return { aiCatalogItems: page(items, v.after) };
    mutations.push(query.match(/\{ (\w+)\(/)![1]);
    inputs.push({ mutation: mutations.at(-1)!, input: v.i });
    if (query.includes('aiCatalogFlowCreate')) {
      const item = { id: `gid://gitlab/Ai::Catalog::Item/${items.length + 100}`, name: v.i.name, project: { fullPath: 'Group/Polyman' } };
      definitions.set(v.i.name, v.i.definition);
      items.push(item);
      return { aiCatalogFlowCreate: { errors: [], item: { id: item.id } } };
    }
    if (query.includes('aiCatalogItemConsumerCreate')) {
      if (failures-- > 0) throw new Error('Internal server error');
      const item = items.find((i) => i.id === v.i.itemId)!;
      const consumer = { id: `gid://gitlab/Ai::Catalog::ItemConsumer/${consumers.length + 1}`, item: { id: item.id, name: item.name, project: item.project } };
      consumers.push(consumer);
      // GitLab makes the service account and a mention trigger when a flow is enabled
      if (!o.noTriggerOnEnable) triggers.push({ id: `t${triggers.length}`, eventTypes: [0], filter: {}, user: { username: `ai-${item.name}-group` }, aiCatalogItemConsumer: { id: consumer.id } });
      return { aiCatalogItemConsumerCreate: { errors: [], itemConsumer: { id: consumer.id } } };
    }
    if (query.includes('aiFlowTriggerCreate')) {
      if (o.triggerErrors) return { aiFlowTriggerCreate: { errors: o.triggerErrors } };
      const name = consumers.find((c) => c.id === v.i.aiCatalogItemConsumerId)!.item.name;
      triggers.push({ id: `t${triggers.length}`, eventTypes: v.i.eventTypes, filter: v.i.filter, user: { username: `ai-${name}-group` }, aiCatalogItemConsumer: { id: v.i.aiCatalogItemConsumerId } });
      return { aiFlowTriggerCreate: { errors: [] } };
    }
    if (query.includes('aiFlowTriggerUpdate')) {
      if (o.triggerErrors) return { aiFlowTriggerUpdate: { errors: o.triggerErrors } };
      Object.assign(triggers.find((t) => t.id === v.i.id)!, { eventTypes: v.i.eventTypes, filter: v.i.filter });
      return { aiFlowTriggerUpdate: { errors: [] } };
    }
    throw new Error(`fake GitLab doesn't know ${query}`);
  }) as Gql;
  const rest = (async (path: string) => {
    // only the default branch is protected
    if (path.includes('/protected_branches/')) return o.pushLevels === null || !path.endsWith(`/${o.rootRef ?? 'main'}`) ? null : { push_access_levels: o.pushLevels ?? [{ access_level: 40 }] };
    if (path.startsWith('/projects/')) return { only_allow_merge_if_pipeline_succeeds: o.mustSucceed?.project ?? true };
    if (path.startsWith('/groups/')) return { only_allow_merge_if_pipeline_succeeds: o.mustSucceed?.group ?? false };
    return null;
  }) as Rest;
  return { gql, rest, items, consumers, triggers, mutations, inputs, definitions };
}

describe('setupFlows against a fake GitLab', () => {
  const config = loadConfig('../.autonomy.yml');
  const sources = new Map(FLOWS.map(([name]) => [name, readFileSync(`../.gitlab/duo/flows/${name}.yaml`, 'utf8')]));
  const run = (gitlab: ReturnType<typeof fakeGitLab>, extra: Partial<SetupOptions> = {}) => {
    const lines: string[] = [];
    return setupFlows({ gql: gitlab.gql, rest: gitlab.rest, projectPath: 'group/polyman', sources, config, log: (l) => lines.push(l), ...extra }).then((r) => ({ ...r, lines }));
  };

  it('a dry run on a fresh project plans all four flows and changes nothing', async () => {
    const gitlab = fakeGitLab();
    const { lines } = await run(gitlab, { dryRun: true });
    expect(gitlab.mutations).toEqual([]);
    expect(lines).toEqual(FLOWS.map(([name]) => `${name}: would create and enable it, and create its trigger`));
  });

  it('creates and enables each flow, filters its trigger and returns the accounts; a second run changes nothing', async () => {
    const gitlab = fakeGitLab();
    const { accounts } = await run(gitlab);
    expect(gitlab.mutations.filter((m) => m === 'aiCatalogFlowCreate')).toHaveLength(4);
    expect(accounts).toEqual(Object.fromEntries(FLOWS.map(([name]) => [name, `ai-${name}-group`])));
    for (const [name, , spec] of FLOWS) {
      const consumer = gitlab.consumers.find((c) => c.item.name === name)!;
      const trigger = gitlab.triggers.find((t) => t.aiCatalogItemConsumer.id === consumer.id)!;
      expect(triggerMatches(trigger, spec.events, pipelineFilter(spec, 'main'))).toBe(true);
    }
    // Assisted: no flow hands work to another, so no definition names a flow ID
    for (const [name] of FLOWS) expect(gitlab.definitions.get(name)).not.toContain('ai_catalog_item_consumer_id');
    gitlab.mutations.length = 0;
    const again = await run(gitlab);
    expect(gitlab.mutations).toEqual([]);
    expect(again.lines.every((l) => l.endsWith('trigger already right'))).toBe(true);
  });

  it('a flow created but not enabled is found on the next run, not created twice', async () => {
    // another project's flow of the same name comes first in the search, ours (other case) on a later page
    const gitlab = fakeGitLab({ enableFailures: 1, items: [{ id: 'gid://gitlab/Ai::Catalog::Item/1', name: 'mr-reviewer', project: { fullPath: 'someone/else' } }] });
    await expect(run(gitlab)).rejects.toThrow(/mr-reviewer: the flow exists .* could not be enabled: Internal server error\. Run this again/);
    const { lines } = await run(gitlab);
    expect(gitlab.mutations.filter((m) => m === 'aiCatalogFlowCreate')).toHaveLength(4);
    expect(lines).toContain('mr-reviewer: found the flow (gid://gitlab/Ai::Catalog::Item/101), not enabled yet');
    expect(gitlab.consumers.find((c) => c.item.name === 'mr-reviewer')!.item.id).toBe('gid://gitlab/Ai::Catalog::Item/101');
  });

  it("ignores a flow enabled here under the same name from another project's catalog entry", async () => {
    const lookAlike = { id: 'gid://gitlab/Ai::Catalog::ItemConsumer/900', item: { id: 'gid://gitlab/Ai::Catalog::Item/9', name: 'mr-reviewer', project: { fullPath: 'someone/else' } } };
    const gitlab = fakeGitLab({ consumers: [lookAlike] });
    const { accounts } = await run(gitlab);
    expect(gitlab.mutations.filter((m) => m === 'aiCatalogFlowCreate')).toHaveLength(4);
    expect(accounts['mr-reviewer']).toBe('ai-mr-reviewer-group');
    // and the flows that hand work to the reviewer don't point at the look-alike
    expect(gitlab.definitions.get('pipeline-fixer')).not.toContain('"ai_catalog_item_consumer_id": 900,');
  });

  it('refuses while Developers can push to the default branch, before changing anything', async () => {
    const gitlab = fakeGitLab({ pushLevels: [{ access_level: 30 }] });
    await expect(run(gitlab)).rejects.toThrow(/only Maintainers can push to main .*\(#14\)/);
    expect(gitlab.mutations).toEqual([]);
  });

  it('refuses while "Pipelines must succeed" is off, and accepts it set on a group above', async () => {
    await expect(run(fakeGitLab({ mustSucceed: { project: false } }))).rejects.toThrow('"Pipelines must succeed" is off');
    await expect(run(fakeGitLab({ mustSucceed: { project: false, group: true } }), { dryRun: true })).resolves.toBeDefined();
  });

  it('refuses an unprotected branch unless told it is a test project', async () => {
    await expect(run(fakeGitLab({ pushLevels: null }), { dryRun: true })).rejects.toThrow('pass --unprotected');
    await expect(run(fakeGitLab({ pushLevels: null }), { dryRun: true, unprotected: true })).resolves.toBeDefined();
  });

  it('creates each flow private and released, and enables it in this project for mentions', async () => {
    const gitlab = fakeGitLab();
    await run(gitlab);
    expect(gitlab.inputs.filter((c) => c.mutation === 'aiCatalogFlowCreate').map((c) => c.input)).toEqual(
      FLOWS.map(([name, description]) => ({ name, description, projectId: 'gid://gitlab/Project/1', definition: gitlab.definitions.get(name), public: false, release: true })),
    );
    expect(gitlab.inputs.filter((c) => c.mutation === 'aiCatalogItemConsumerCreate').map((c) => c.input)).toEqual(
      FLOWS.map((_, i) => ({ itemId: `gid://gitlab/Ai::Catalog::Item/${100 + i}`, target: { projectId: 'gid://gitlab/Project/1' }, triggerTypes: ['mention'] })),
    );
  });

  it('creates the filtered trigger itself when enabling a flow made none', async () => {
    const gitlab = fakeGitLab({ noTriggerOnEnable: true });
    const { accounts, lines } = await run(gitlab);
    expect(gitlab.inputs.filter((c) => c.mutation === 'aiFlowTriggerCreate').map((c) => c.input)).toEqual(
      FLOWS.map(([name, description, spec], i) => ({
        projectPath: 'group/polyman',
        description: `${name}: ${description}`,
        eventTypes: spec.events,
        aiCatalogItemConsumerId: `gid://gitlab/Ai::Catalog::ItemConsumer/${i + 1}`,
        filter: pipelineFilter(spec, 'main'),
      })),
    );
    expect(lines).toContain('mr-reviewer: trigger created');
    expect(accounts).toEqual(Object.fromEntries(FLOWS.map(([name]) => [name, `ai-${name}-group`])));
  });

  it('stops when GitLab refuses to create or to update a trigger', async () => {
    const creating = fakeGitLab({ noTriggerOnEnable: true, triggerErrors: ['Filter is invalid'] });
    await expect(run(creating)).rejects.toThrow('mr-reviewer: trigger: Filter is invalid');
    expect(creating.mutations.at(-1)).toBe('aiFlowTriggerCreate');
    // enabling makes a mention-only trigger, which the reviewer's then has to be updated from
    const updating = fakeGitLab({ triggerErrors: ['Filter is invalid'] });
    await expect(run(updating)).rejects.toThrow('mr-reviewer: trigger: Filter is invalid');
    expect(updating.mutations.at(-1)).toBe('aiFlowTriggerUpdate');
  });

  it('a dry run says how it would set a stale trigger and that it would create a missing one, and changes nothing', async () => {
    const gitlab = fakeGitLab();
    await run(gitlab);
    const triggerOf = (name: string) => gitlab.triggers.findIndex((t) => t.aiCatalogItemConsumer.id === gitlab.consumers.find((c) => c.item.name === name)!.id);
    Object.assign(gitlab.triggers[triggerOf('mr-reviewer')], { eventTypes: [0], filter: {} });
    gitlab.triggers.splice(triggerOf('pipeline-fixer'), 1);
    gitlab.mutations.length = 0;
    const { lines } = await run(gitlab, { dryRun: true });
    expect(gitlab.mutations).toEqual([]);
    expect(lines).toEqual([
      `mr-reviewer: would set its trigger to events 3,0 with ${JSON.stringify(pipelineFilter(spec('mr-reviewer'), 'main'))}`,
      'pipeline-fixer: would create its trigger',
      'issue-builder: trigger already right',
      'incident-responder: trigger already right',
    ]);
  });

  it("uses the project's default branch when it isn't main, for the branch check and the incident responder's filter", async () => {
    const gitlab = fakeGitLab({ rootRef: 'master' });
    const { defaultBranch } = await run(gitlab);
    expect(defaultBranch).toBe('master');
    const incident = gitlab.consumers.find((c) => c.item.name === 'incident-responder')!;
    expect(gitlab.triggers.find((t) => t.aiCatalogItemConsumer.id === incident.id)!.filter).toEqual({
      pipeline_hooks: {
        rules: [
          { field: 'object_attributes.status', value: ['failed'], operator: 'in' },
          { field: 'object_attributes.ref', value: ['master'], operator: 'in' },
        ],
      },
    });
  });
});

describe('pushBlocked', () => {
  it('counts only Maintainer or no-one role rules', () => {
    expect(pushBlocked([{ access_level: 40 }])).toBe(true);
    expect(pushBlocked([{ access_level: 0 }])).toBe(true);
    expect(pushBlocked([{ access_level: 40 }, { access_level: 30 }])).toBe(false);
  });

  it('does not trust a rule for one user, a group or a deploy key (they report 40 too)', () => {
    expect(pushBlocked([{ access_level: 40 }, { access_level: 40, user_id: 7 }])).toBe(false);
    expect(pushBlocked([{ access_level: 40, group_id: 3 }])).toBe(false);
    expect(pushBlocked([{ access_level: 40, deploy_key_id: 2 }])).toBe(false);
  });

  it('does not trust an empty list', () => {
    expect(pushBlocked([])).toBe(false);
  });
});

describe('unprotected', () => {
  /** A REST API that answers only the paths given, and remembers every path asked for. */
  const recording = (answers: Record<string, unknown> = {}) => {
    const paths: string[] = [];
    const rest = (async (path: string) => {
      paths.push(path);
      return answers[path] ?? null;
    }) as Rest;
    return { rest, paths };
  };

  it('reads the rule for the default branch and walks every group above the project, nearest first', async () => {
    const { rest, paths } = recording({ '/projects/a%2Fb%2Fc%2Fproj/protected_branches/release%2F1': { push_access_levels: [{ access_level: 40 }] } });
    expect(await unprotected(rest, 'a/b/c/proj', 'release/1')).toEqual(['"Pipelines must succeed" is off']);
    expect(paths).toEqual(['/projects/a%2Fb%2Fc%2Fproj/protected_branches/release%2F1', '/projects/a%2Fb%2Fc%2Fproj', '/groups/a%2Fb%2Fc', '/groups/a%2Fb', '/groups/a']);
  });

  it('stops at the first group that requires pipelines to succeed', async () => {
    const { rest, paths } = recording({ '/groups/a%2Fb': { only_allow_merge_if_pipeline_succeeds: true } });
    expect(await unprotected(rest, 'a/b/c/proj', 'main')).toEqual(["nothing shows that only Maintainers can push to main (it isn't protected that way, or the rule couldn't be read)"]);
    expect(paths.filter((p) => p.startsWith('/groups/'))).toEqual(['/groups/a%2Fb%2Fc', '/groups/a%2Fb']);
  });
});

describe('gitlabUrl', () => {
  it('sends the token over https only', () => {
    expect(gitlabUrl()).toBe('https://gitlab.com');
    expect(gitlabUrl('https://gitlab.example.com')).toBe('https://gitlab.example.com');
    expect(() => gitlabUrl('http://gitlab.example.com')).toThrow('refusing to send your token');
    expect(gitlabUrl('https://gitlab.example.com/')).toBe('https://gitlab.example.com');
  });
});

describe('writing the accounts at the end of a run', () => {
  const yml = `agents:\n  reviewer_account: ""\n  fixer_account: ""\n`;
  const both = { 'mr-reviewer': 'ai-mr-reviewer-x', 'pipeline-fixer': 'ai-pipeline-fixer-x' };
  const end = (o: Partial<Parameters<typeof finishAccounts>[0]>) =>
    finishAccounts({ own: 'group/polyman', projectPath: 'group/polyman', accounts: both, dryRun: false, write: true, text: yml, ...o });

  it("only this checkout's own project gets its file written", () => {
    expect(mayWriteAccounts('Group/Polyman', 'group/polyman', yml)).toBe(true);
    expect(mayWriteAccounts('someone/else', 'group/polyman', yml)).toBe(false);
    expect(mayWriteAccounts(undefined, 'group/polyman', yml)).toBe(false);
  });

  it('refuses before anything is created when the file has no lines to fill', () => {
    expect(() => mayWriteAccounts('group/polyman', 'group/polyman', 'agents: {}\n')).toThrow('no agents.reviewer_account line');
    expect(() => mayWriteAccounts('group/polyman', 'group/polyman', undefined)).toThrow('no .autonomy.yml');
    expect(() => mayWriteAccounts('group/polyman', 'group/polyman', 'agents:\n  reviewer_account: ""\n')).toThrow('no agents.fixer_account line');
  });

  it('writes both names', () => {
    expect(end({}).write).toBe(`agents:\n  reviewer_account: ai-mr-reviewer-x\n  fixer_account: ai-pipeline-fixer-x\n`);
  });

  it("writes nothing for another project's checkout, and says where the names go", () => {
    const result = end({ own: 'someone/else', write: false });
    expect(result.write).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(result.messages[0]).toContain('this checkout is someone/else, not group/polyman');
  });

  it('fails, without writing, when an account is missing', () => {
    const result = end({ accounts: { 'mr-reviewer': 'ai-mr-reviewer-x' } });
    expect(result.write).toBeUndefined();
    expect(result.errors[0]).toContain('no service account found for pipeline-fixer');
  });

  it('names each missing account, and only mentions the file when it would be written', () => {
    expect(end({ accounts: { 'pipeline-fixer': 'ai-pipeline-fixer-x' } }).errors[0]).toMatch(/^no service account found for mr-reviewer; \.autonomy\.yml not changed\./);
    expect(end({ accounts: {}, write: false, own: 'someone/else' }).errors[0]).toMatch(/^no service account found for mr-reviewer and pipeline-fixer\. Check/);
  });

  it('a dry run on a fresh project, with no accounts yet, is not an error', () => {
    expect(end({ dryRun: true, accounts: {} }).errors).toEqual([]);
  });

  it('a dry run writes nothing and says so', () => {
    const result = end({ dryRun: true });
    expect(result.write).toBeUndefined();
    expect(result.messages).toEqual(['dry run: nothing changed; a real run writes the accounts into .autonomy.yml']);
  });

  it('leaves a file that already has the names alone', () => {
    const done = end({}).write!;
    expect(end({ text: done })).toEqual({ messages: ['.autonomy.yml already has these accounts'], errors: [] });
  });

  it("a dry run in another project's checkout doesn't say it writes .autonomy.yml", () => {
    expect(end({ dryRun: true, own: 'someone/else', write: false }).messages).toEqual(['dry run: nothing changed']);
  });

  it('says so when this checkout is not a GitLab project at all', () => {
    expect(end({ own: undefined, write: false }).messages).toEqual([".autonomy.yml not written: this checkout is not a GitLab project, not group/polyman. Put these names in that project's .autonomy.yml."]);
  });
});

describe('running setup-flows directly', () => {
  const self = fileURLToPath(new URL('../src/cli/setup-flows.ts', import.meta.url));

  it('runs its main block, so a missing token fails loudly instead of exiting 0 having done nothing', () => {
    // a project path, so the token check is what stops it, also outside a checkout
    const env: NodeJS.ProcessEnv = { ...process.env, GITLAB_PROJECT_PATH: 'group/project' };
    delete env.GITLAB_TOKEN;
    const r = spawnSync(process.execPath, [self], { env, encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/set GITLAB_TOKEN/);
  });

  it('knows itself through a symlink (the fallback for Node without import.meta.main)', () => {
    const link = join(mkdtempSync(join(tmpdir(), 'entry-')), 'setup-flows.ts');
    symlinkSync(self, link);
    expect(isEntry(link, self)).toBe(true);
    expect(isEntry(fileURLToPath(new URL('../src/cli/doctor.ts', import.meta.url)), self)).toBe(false);
    expect(isEntry(undefined, self)).toBe(false);
    // a path that doesn't exist falls back to comparing the strings
    expect(isEntry('/no/such/setup-flows.ts', self)).toBe(false);
    expect(isEntry('/no/such/x.ts', '/no/such/x.ts')).toBe(true);
  });
});
