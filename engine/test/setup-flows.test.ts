import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import { FLOWS, type Gql, type Rest, type SetupOptions, definitionFor, finishAccounts, gitlabUrl, isEntry, mayWriteAccounts, pipelineFilter, pushBlocked, setupFlows, triggerMatches, withAccounts } from '../src/cli/setup-flows.ts';

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
}

/** Just enough of GitLab for setupFlows, with pages of one so paging is exercised. */
function fakeGitLab(o: FakeOptions = {}) {
  const items = [...(o.items ?? [])];
  const consumers: { id: string; item: { id: string; name: string; project: { fullPath: string } | null } }[] = [...(o.consumers ?? [])];
  const triggers: { id: string; eventTypes: number[]; filter: unknown; user: { username: string }; aiCatalogItemConsumer: { id: string } }[] = [];
  const mutations: string[] = [];
  /** the definition each flow was created with, by name */
  const definitions = new Map<string, string>();
  let failures = o.enableFailures ?? 0;
  const page = <T>(nodes: T[], after: unknown) => {
    const at = after ? Number(after) : 0;
    return { nodes: nodes.slice(at, at + 1), pageInfo: { hasNextPage: at + 1 < nodes.length, endCursor: String(at + 1) } };
  };
  const gql = (async (query: string, v: Record<string, any> = {}) => {
    if (query.includes('repository { rootRef }')) return { project: { id: 'gid://gitlab/Project/1', repository: { rootRef: 'main' } } };
    // newest first, as GitLab lists them
    if (query.includes('aiCatalogConfiguredItems')) return { aiCatalogConfiguredItems: page([...consumers].reverse(), v.after) };
    if (query.includes('aiFlowTriggers')) return { project: { aiFlowTriggers: page(triggers, v.after) } };
    if (query.includes('aiCatalogItems(')) return { aiCatalogItems: page(items, v.after) };
    mutations.push(query.match(/\{ (\w+)\(/)![1]);
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
      triggers.push({ id: `t${triggers.length}`, eventTypes: [0], filter: {}, user: { username: `ai-${item.name}-group` }, aiCatalogItemConsumer: { id: consumer.id } });
      return { aiCatalogItemConsumerCreate: { errors: [], itemConsumer: { id: consumer.id } } };
    }
    if (query.includes('aiFlowTriggerCreate')) return { aiFlowTriggerCreate: { errors: [] } };
    if (query.includes('aiFlowTriggerUpdate')) {
      Object.assign(triggers.find((t) => t.id === v.i.id)!, { eventTypes: v.i.eventTypes, filter: v.i.filter });
      return { aiFlowTriggerUpdate: { errors: [] } };
    }
    throw new Error(`fake GitLab doesn't know ${query}`);
  }) as Gql;
  const rest = (async (path: string) => {
    if (path.includes('/protected_branches/')) return o.pushLevels === null ? null : { push_access_levels: o.pushLevels ?? [{ access_level: 40 }] };
    if (path.startsWith('/projects/')) return { only_allow_merge_if_pipeline_succeeds: o.mustSucceed?.project ?? true };
    if (path.startsWith('/groups/')) return { only_allow_merge_if_pipeline_succeeds: o.mustSucceed?.group ?? false };
    return null;
  }) as Rest;
  return { gql, rest, items, consumers, triggers, mutations, definitions };
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
