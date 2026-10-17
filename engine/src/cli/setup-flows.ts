/**
 * Creates the four Duo flows in a project, enables them and sets their
 * triggers, so nobody has to click through AI > Flows. Safe to run again: a
 * flow that already exists is left as it is, and only its trigger is brought
 * in line with the table below.
 *
 * The triggers only fire for what the flow is for. A pipeline trigger with no
 * condition wakes the reviewer for every pipeline in the project (tags,
 * schedules, the default branch), and each of those sessions costs credits
 * before it finds out it has nothing to do; in the sandbox that was about half
 * of all sessions.
 *
 * Afterwards it writes the service account names GitLab created into
 * .autonomy.yml (commit that through an MR), and `sync-flows` then publishes
 * the flows with those names filled in.
 *
 * Run it from your machine with your own token:
 *   GITLAB_TOKEN=... node engine/src/cli/setup-flows.ts [project path] [--dry-run]
 */
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { type AutonomyConfig } from '../config.ts';
import { loadConfig } from '../config.ts';
import { checkFlow } from '../flows.ts';
import { projectPathFrom } from '../project.ts';
import { flowValues, renderFlow } from '../render.ts';

const MENTION = 0;
const ASSIGN = 1;
const PIPELINE = 3;

interface TriggerSpec {
  events: number[];
  /** pipeline statuses that start the flow */
  status?: string[];
  /** only merge request pipelines */
  mergeRequests?: boolean;
  /** only pipelines on the default branch */
  defaultBranch?: boolean;
}

/**
 * The flows, in creation order. Assisted: none hands work to another (no
 * start_flow); each proposes, waits for a person's go-ahead (a mention), and
 * acts one step. Pipeline triggers only ever lead to a proposal.
 */
export const FLOWS: [string, string, TriggerSpec][] = [
  ['mr-reviewer', 'Reviews a merge request once its pipeline passes and proposes fixes; applies them, one round, on a go-ahead from a person.', { events: [PIPELINE, MENTION], status: ['success'], mergeRequests: true }],
  ['pipeline-fixer', 'Proposes the fix for a failed merge request pipeline; pushes it on a go-ahead from a person.', { events: [PIPELINE, MENTION], status: ['failed'], mergeRequests: true }],
  ['issue-builder', 'Proposes how it will fix an issue it is assigned or mentioned on; opens the MR with tests on a go-ahead from a person.', { events: [MENTION, ASSIGN] }],
  ['incident-responder', 'Opens an incident and proposes the rollback when a release fails its production check; prepares the rollback MR on a go-ahead from the maintainer.', { events: [PIPELINE, MENTION], status: ['failed'], defaultBranch: true }],
];

/** The trigger's filter: GitLab matches these rules against the pipeline event. */
export function pipelineFilter(spec: TriggerSpec, defaultBranch: string): Record<string, unknown> {
  if (!spec.events.includes(PIPELINE)) return {};
  const rules: { field: string; value: string[]; operator: 'in' }[] = [];
  if (spec.status) rules.push({ field: 'object_attributes.status', value: spec.status, operator: 'in' });
  if (spec.mergeRequests) rules.push({ field: 'object_attributes.source', value: ['merge_request_event'], operator: 'in' });
  if (spec.defaultBranch) rules.push({ field: 'object_attributes.ref', value: [defaultBranch], operator: 'in' });
  return { pipeline_hooks: { rules } };
}

/**
 * A flow's definition as it is created: this project's values, the IDs of the
 * flows it hands work to, and placeholders for the account names, which only
 * exist once the flows do (sync-flows fills them in afterwards).
 */
export function definitionFor(source: string, config: AutonomyConfig, ids: Record<string, string>): string {
  const values = flowValues(
    {
      ...config,
      agents: {
        ...config.agents,
        reviewerAccount: config.agents.reviewerAccount || 'REVIEWER_ACCOUNT_NOT_SET',
        fixerAccount: config.agents.fixerAccount || 'FIXER_ACCOUNT_NOT_SET',
      },
    },
    ids,
  );
  return renderFlow(source, values);
}

/** Whether a trigger already has these events and this filter (key order and event order don't matter). */
export function triggerMatches(trigger: { eventTypes: number[]; filter: unknown }, events: number[], filter: Record<string, unknown>): boolean {
  const current = typeof trigger.filter === 'string' ? JSON.parse(trigger.filter) : (trigger.filter ?? {});
  return isDeepStrictEqual([...trigger.eventTypes].sort(), [...events].sort()) && isDeepStrictEqual(current, filter);
}

/** .autonomy.yml with the agent account names set, comments and layout kept. */
export function withAccounts(text: string, accounts: { reviewer?: string; fixer?: string }): string {
  let out = text;
  for (const [key, value] of [
    ['reviewer_account', accounts.reviewer],
    ['fixer_account', accounts.fixer],
  ] as const) {
    if (!value) continue;
    // a GitLab username; anything else would end up as YAML in the file
    if (!/^[\w.-]+$/.test(value)) throw new Error(`not a username: ${JSON.stringify(value)}`);
    // the key's own line only, keeping a comment at its end
    const line = new RegExp(`^([ \\t]*${key}:)[^\\n#]*?([ \\t]+#[^\\n]*)?$`, 'm');
    if (!line.test(out)) throw new Error(`.autonomy.yml has no agents.${key} line to fill in`);
    out = out.replace(line, (_, start: string, comment = '') => `${start} ${value}${comment}`);
  }
  return out;
}

/**
 * Whether this run may write the account names into the .autonomy.yml it
 * finds here: only when this checkout is the project being set up, and only
 * if the file has the lines to fill. Checked before anything is created.
 */
export function mayWriteAccounts(own: string | undefined, projectPath: string, text: string | undefined): boolean {
  if (own?.toLowerCase() !== projectPath.toLowerCase()) return false;
  if (text === undefined) throw new Error('this checkout has no .autonomy.yml to write the accounts into');
  withAccounts(text, { reviewer: 'check', fixer: 'check' });
  return true;
}

/** What to tell the person at the end, and the new .autonomy.yml if there is one to write. */
export function finishAccounts(o: {
  own: string | undefined;
  projectPath: string;
  accounts: Record<string, string>;
  dryRun: boolean;
  write: boolean;
  text: string | undefined;
}): { messages: string[]; errors: string[]; write?: string } {
  const file = '.autonomy.yml';
  const reviewer = o.accounts['mr-reviewer'];
  const fixer = o.accounts['pipeline-fixer'];
  const unknown = [reviewer ? '' : 'mr-reviewer', fixer ? '' : 'pipeline-fixer'].filter(Boolean);
  if (o.dryRun) return { messages: [`dry run: nothing changed${o.write ? `; a real run writes the accounts into ${file}` : ''}`], errors: [] };
  if (unknown.length) {
    return { messages: [], errors: [`no service account found for ${unknown.join(' and ')}${o.write ? `; ${file} not changed` : ''}. Check the flow's trigger in AI > Flows and run this again.`] };
  }
  if (!o.write) return { messages: [`${file} not written: this checkout is ${o.own ?? 'not a GitLab project'}, not ${o.projectPath}. Put these names in that project's ${file}.`], errors: [] };
  const after = withAccounts(o.text!, { reviewer, fixer });
  if (after === o.text) return { messages: [`${file} already has these accounts`], errors: [] };
  return { messages: [`${file}: agent accounts set; commit it in an MR, then run sync-flows`], errors: [], write: after };
}

/** A GraphQL call: the data, or an error with GitLab's messages. */
export type Gql = <T>(query: string, variables?: Record<string, unknown>) => Promise<T>;
/** A GET on the REST API: null when GitLab says no (not found, not allowed). */
export type Rest = <T>(path: string) => Promise<T | null>;

/** Where to send the token: only over https. */
export function gitlabUrl(value = 'https://gitlab.com'): string {
  if (!value.startsWith('https://')) throw new Error(`refusing to send your token to ${value}: use an https:// GITLAB_URL`);
  return value.replace(/\/+$/, '');
}

interface PushLevel {
  access_level: number;
  user_id?: number | null;
  group_id?: number | null;
  deploy_key_id?: number | null;
}

/**
 * Whether these push rules keep the agents off the branch. Their service
 * accounts are Developers, so only role rules count: Maintainers (40 and up)
 * or no one (0). A rule for one user, a group or a deploy key also reports 40,
 * and that user or group could be an agent's, so it doesn't count; neither
 * does an empty list.
 */
export function pushBlocked(levels: PushLevel[]): boolean {
  return levels.length > 0 && levels.every((l) => !l.user_id && !l.group_id && !l.deploy_key_id && (l.access_level === 0 || l.access_level >= 40));
}

/**
 * What still lets an agent's change reach the default branch unreviewed (#14):
 * the flows can push (run_git_command), and until the branch is protected and
 * red pipelines can't merge, only a prompt line keeps an agent off it. Empty
 * when nothing is missing.
 */
export async function unprotected(rest: Rest, projectPath: string, defaultBranch: string): Promise<string[]> {
  const enc = encodeURIComponent(projectPath);
  const branch = await rest<{ push_access_levels: PushLevel[] }>(`/projects/${enc}/protected_branches/${encodeURIComponent(defaultBranch)}`);
  const noPush = !!branch && pushBlocked(branch.push_access_levels ?? []);
  // the setting can come from the project or any group above it
  let mustSucceed = !!(await rest<{ only_allow_merge_if_pipeline_succeeds?: boolean }>(`/projects/${enc}`))?.only_allow_merge_if_pipeline_succeeds;
  const parts = projectPath.split('/').slice(0, -1);
  for (let i = parts.length; i > 0 && !mustSucceed; i--) {
    mustSucceed = !!(await rest<{ only_allow_merge_if_pipeline_succeeds?: boolean }>(`/groups/${encodeURIComponent(parts.slice(0, i).join('/'))}`))?.only_allow_merge_if_pipeline_succeeds;
  }
  return [noPush ? '' : `nothing shows that only Maintainers can push to ${defaultBranch} (it isn't protected that way, or the rule couldn't be read)`, mustSucceed ? '' : '"Pipelines must succeed" is off'].filter(Boolean);
}

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

async function allPages<T>(fetchPage: (after: string | null) => Promise<Page<T>>, stop: (node: T) => boolean = () => false): Promise<T[]> {
  const out: T[] = [];
  for (let after: string | null = null; ; ) {
    const page = await fetchPage(after);
    out.push(...page.nodes);
    if (!page.pageInfo.hasNextPage || page.nodes.some(stop)) return out;
    after = page.pageInfo.endCursor;
  }
}

interface Consumer {
  id: string;
  item: { id: string; name: string; project: { fullPath: string } | null };
}

interface Trigger {
  id: string;
  eventTypes: number[];
  filter: unknown;
  user: { username: string } | null;
  aiCatalogItemConsumer: { id: string } | null;
}

export interface SetupOptions {
  gql: Gql;
  rest: Rest;
  projectPath: string;
  /** each flow's YAML, by name */
  sources: Map<string, string>;
  config: AutonomyConfig;
  dryRun?: boolean;
  /** set the flows up even though the default branch isn't protected (test projects) */
  unprotected?: boolean;
  log?: (line: string) => void;
}

/**
 * Creates, enables and triggers the flows that are missing, and returns the
 * service account GitLab made for each flow it knows one for. A dry run only
 * reads, and says what it would do.
 */
export async function setupFlows(o: SetupOptions): Promise<{ defaultBranch: string; accounts: Record<string, string> }> {
  const { gql, projectPath, dryRun = false } = o;
  const log = o.log ?? console.log;
  const check = (what: string, errors: string[]) => {
    if (errors.length) throw new Error(`${what}: ${errors.join('; ')}`);
  };

  const { project } = await gql<{ project: { id: string; repository: { rootRef: string } } | null }>(
    'query($p: ID!) { project(fullPath: $p) { id repository { rootRef } } }',
    { p: projectPath },
  );
  if (!project) throw new Error(`no project ${projectPath}, or your token can't see it`);
  const defaultBranch = project.repository.rootRef;

  const missing = await unprotected(o.rest, projectPath, defaultBranch);
  if (missing.length && !o.unprotected) {
    throw new Error(`not setting up agents that can push while ${missing.join(' and ')} (#14); fix that first, or pass --unprotected (a test project, or a person deciding to go ahead before #14)`);
  }

  // flows enabled here that this project owns: one enabled from another
  // project's catalog entry under the same name isn't ours
  const ours = (c: Consumer) => c.item.project?.fullPath.toLowerCase() === projectPath.toLowerCase();
  const consumers = async () =>
    (await allPages<Consumer>(async (after) =>
      (
        await gql<{ aiCatalogConfiguredItems: Page<Consumer> }>(
          `query($p: ProjectID!, $after: String) {
            aiCatalogConfiguredItems(projectId: $p, first: 100, after: $after) { nodes { id item { id name project { fullPath } } } pageInfo { hasNextPage endCursor } }
          }`,
          { p: project.id, after },
        )
      ).aiCatalogConfiguredItems,
    )).filter(ours);
  const triggers = () =>
    allPages<Trigger>(async (after) =>
      (
        await gql<{ project: { aiFlowTriggers: Page<Trigger> } }>(
          `query($p: ID!, $after: String) { project(fullPath: $p) {
            aiFlowTriggers(first: 100, after: $after) { nodes { id eventTypes filter user { username } aiCatalogItemConsumer { id } } pageInfo { hasNextPage endCursor } }
          } }`,
          { p: projectPath, after },
        )
      ).project.aiFlowTriggers,
    );
  // A flow this project owns, enabled or not: one created but never enabled must
  // be found, not made twice. The search is fuzzy and spans every public flow,
  // so it pages until it finds it.
  const ownItem = async (name: string) => {
    type Item = { id: string; name: string; project: { fullPath: string } | null };
    const mine = (i: Item) => i.name === name && i.project?.fullPath.toLowerCase() === projectPath.toLowerCase();
    const items = await allPages<Item>(
      async (after) =>
        (
          await gql<{ aiCatalogItems: Page<Item> }>(
            'query($s: String!, $after: String) { aiCatalogItems(search: $s, first: 50, after: $after) { nodes { id name project { fullPath } } pageInfo { hasNextPage endCursor } } }',
            { s: name, after },
          )
        ).aiCatalogItems,
      mine,
    );
    return items.find(mine);
  };

  // in a dry run the flows aren't created, so later flows get a stand-in for their IDs
  const planned: Record<string, string> = {};
  const accounts: Record<string, string> = {};

  for (const [name, description, spec] of FLOWS) {
    const source = o.sources.get(name);
    if (source === undefined) throw new Error(`no .gitlab/duo/flows/${name}.yaml`);
    let consumer = (await consumers()).find((c) => c.item.name === name);

    if (!consumer) {
      const ids = { ...Object.fromEntries((await consumers()).map((c) => [c.item.name, c.id.split('/').pop()!])), ...planned };
      const definition = definitionFor(source, o.config, ids);
      const problems = checkFlow(definition);
      if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);
      let itemId = (await ownItem(name))?.id;
      if (dryRun) {
        log(`${name}: would ${itemId ? `enable the existing flow (${itemId})` : 'create and enable it'}, and create its trigger`);
        planned[name] = 'DRY_RUN_ID';
        continue;
      }
      if (!itemId) {
        const created = await gql<{ aiCatalogFlowCreate: { errors: string[]; item: { id: string } | null } }>(
          'mutation($i: AiCatalogFlowCreateInput!) { aiCatalogFlowCreate(input: $i) { errors item { id } } }',
          { i: { name, description, projectId: project.id, definition, public: false, release: true } },
        );
        check(`${name}: create`, created.aiCatalogFlowCreate.errors);
        if (!created.aiCatalogFlowCreate.item) throw new Error(`${name}: GitLab created no flow and gave no reason`);
        itemId = created.aiCatalogFlowCreate.item.id;
      } else log(`${name}: found the flow (${itemId}), not enabled yet`);
      const enabled = await gql<{ aiCatalogItemConsumerCreate: { errors: string[]; itemConsumer: { id: string } | null } }>(
        'mutation($i: AiCatalogItemConsumerCreateInput!) { aiCatalogItemConsumerCreate(input: $i) { errors itemConsumer { id } } }',
        { i: { itemId, target: { projectId: project.id }, triggerTypes: ['mention'] } },
      ).catch((err: Error) => ({ aiCatalogItemConsumerCreate: { errors: [err.message], itemConsumer: null } }));
      if (enabled.aiCatalogItemConsumerCreate.errors.length || !enabled.aiCatalogItemConsumerCreate.itemConsumer) {
        throw new Error(
          `${name}: the flow exists (${itemId}) but could not be enabled: ${enabled.aiCatalogItemConsumerCreate.errors.join('; ') || 'no reason given'}. Run this again to retry; it finds the flow.`,
        );
      }
      consumer = { id: enabled.aiCatalogItemConsumerCreate.itemConsumer.id, item: { id: itemId, name, project: { fullPath: projectPath } } };
      log(`${name}: enabled`);
    }

    const filter = pipelineFilter(spec, defaultBranch);
    const trigger = (await triggers()).find((t) => t.aiCatalogItemConsumer?.id === consumer!.id);
    if (!trigger) {
      if (dryRun) log(`${name}: would create its trigger`);
      else {
        const made = await gql<{ aiFlowTriggerCreate: { errors: string[] } }>(
          'mutation($i: AiFlowTriggerCreateInput!) { aiFlowTriggerCreate(input: $i) { errors } }',
          { i: { projectPath, description: `${name}: ${description}`, eventTypes: spec.events, aiCatalogItemConsumerId: consumer.id, filter } },
        );
        check(`${name}: trigger`, made.aiFlowTriggerCreate.errors);
        log(`${name}: trigger created`);
      }
    } else if (!triggerMatches(trigger, spec.events, filter)) {
      if (dryRun) log(`${name}: would set its trigger to events ${spec.events.join(',')} with ${JSON.stringify(filter)}`);
      else {
        const updated = await gql<{ aiFlowTriggerUpdate: { errors: string[] } }>(
          'mutation($i: AiFlowTriggerUpdateInput!) { aiFlowTriggerUpdate(input: $i) { errors } }',
          { i: { id: trigger.id, eventTypes: spec.events, filter } },
        );
        check(`${name}: trigger`, updated.aiFlowTriggerUpdate.errors);
        log(`${name}: trigger set`);
      }
    } else log(`${name}: trigger already right`);

    const username = (await triggers()).find((t) => t.aiCatalogItemConsumer?.id === consumer!.id)?.user?.username;
    if (username) accounts[name] = username;
  }
  return { defaultBranch, accounts };
}

/** Whether `argv1` is this file, through symlinks and short paths. */
export function isEntry(argv1: string | undefined, self: string): boolean {
  if (!argv1) return false;
  try {
    // .native also expands short Windows names (MOHAME~1), which the JS version doesn't
    return realpathSync.native(argv1) === realpathSync.native(self);
  } catch {
    return argv1 === self;
  }
}

// import.meta.main is undefined before Node 22.18 (and on 23.x to 24.1), which would skip this and exit 0
// having done nothing; compare real paths so a symlinked checkout or a short Windows path still runs it
if (import.meta.main ?? isEntry(process.argv[1], fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const projectPath = projectPathFrom(args.find((a) => !a.startsWith('--')));
  const token = process.env.GITLAB_TOKEN;
  if (!token) throw new Error('set GITLAB_TOKEN (a token with the api scope) to set up flows');
  const api = gitlabUrl(process.env.GITLAB_URL);

  const gql: Gql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const res = await fetch(`${api}/api/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length || !body.data) throw new Error(body.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`);
    return body.data;
  };
  const rest: Rest = async <T>(path: string): Promise<T | null> => {
    const res = await fetch(`${api}/api/v4${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return res.ok ? ((await res.json()) as T) : null;
  };

  // Only this checkout's own project gets its .autonomy.yml written; decide that (and
  // check the file can take the names) before anything is created.
  let own: string | undefined;
  try {
    own = projectPathFrom(undefined, { remoteOnly: true });
  } catch {
    // no remote to tell which project this checkout is
  }
  const autonomy = '.autonomy.yml';
  const read = () => (existsSync(autonomy) ? readFileSync(autonomy, 'utf8') : undefined);
  const write = mayWriteAccounts(own, projectPath, read());

  const dir = '.gitlab/duo/flows';
  const sources = new Map(readdirSync(dir).map((f) => [f.replace(/\.ya?ml$/, ''), readFileSync(join(dir, f), 'utf8')]));
  const { accounts } = await setupFlows({ gql, rest, projectPath, sources, config: loadConfig(), dryRun, unprotected: args.includes('--unprotected') });

  console.log('\naccounts:', accounts);
  const end = finishAccounts({ own, projectPath, accounts, dryRun, write, text: read() });
  if (end.write !== undefined) writeFileSync(autonomy, end.write);
  for (const line of end.messages) console.log(line);
  for (const line of end.errors) console.error(line);
  if (end.errors.length) process.exitCode = 1;
}
