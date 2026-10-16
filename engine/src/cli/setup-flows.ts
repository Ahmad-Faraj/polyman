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
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
 * In creation order: a flow is created after the ones it hands work over to
 * (pipeline-fixer to mr-reviewer; issue-builder to both; incident-responder to
 * issue-builder), since its definition names their IDs.
 */
export const FLOWS: [string, string, TriggerSpec][] = [
  ['mr-reviewer', 'Reviews a merge request once its pipeline passes, fixes what it finds and writes one note for the approver.', { events: [PIPELINE, MENTION], status: ['success'], mergeRequests: true }],
  ['pipeline-fixer', 'Fixes a failed merge request pipeline and hands the merge request to the reviewer.', { events: [PIPELINE, MENTION], status: ['failed'], mergeRequests: true }],
  ['issue-builder', 'Turns an issue it is assigned or mentioned on into a merge request with tests.', { events: [MENTION, ASSIGN] }],
  ['incident-responder', 'Opens an incident and a rollback when a release fails its production check.', { events: [PIPELINE], status: ['failed'], defaultBranch: true }],
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

/** .autonomy.yml with the agent account names set, comments and layout kept. */
export function withAccounts(text: string, accounts: { reviewer?: string; fixer?: string }): string {
  let out = text;
  for (const [key, value] of [
    ['reviewer_account', accounts.reviewer],
    ['fixer_account', accounts.fixer],
  ] as const) {
    if (!value) continue;
    const line = new RegExp(`^(\\s*${key}:).*$`, 'm');
    if (!line.test(out)) throw new Error(`.autonomy.yml has no agents.${key} line to fill in`);
    out = out.replace(line, `$1 ${value}`);
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const projectPath = projectPathFrom(args.find((a) => !a.startsWith('--')));
  const token = process.env.GITLAB_TOKEN;
  if (!token) throw new Error('set GITLAB_TOKEN (a token with the api scope) to set up flows');
  const api = process.env.GITLAB_URL ?? 'https://gitlab.com';
  if (!api.startsWith('https://')) throw new Error(`refusing to send your token to ${api}: use an https:// GITLAB_URL`);

  const gql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const res = await fetch(`${api}/api/graphql`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: { message: string }[] };
    if (!res.ok || body.errors?.length || !body.data) throw new Error(body.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`);
    return body.data;
  };
  const check = (what: string, errors: string[]) => {
    if (errors.length) throw new Error(`${what}: ${errors.join('; ')}`);
  };

  const { project } = await gql<{ project: { id: string; repository: { rootRef: string } } }>(
    'query($p: ID!) { project(fullPath: $p) { id repository { rootRef } } }',
    { p: projectPath },
  );
  const defaultBranch = project.repository.rootRef;

  // The flows can push (run_git_command). Until the default branch is protected
  // and red pipelines can't merge, only a prompt line keeps an agent off it.
  const rest = async <T>(path: string): Promise<T | null> => {
    const res = await fetch(`${api}/api/v4${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return res.ok ? ((await res.json()) as T) : null;
  };
  const enc = encodeURIComponent(projectPath);
  const branch = await rest<{ push_access_levels: { access_level: number }[] }>(`/projects/${enc}/protected_branches/${encodeURIComponent(defaultBranch)}`);
  // the agents' service accounts are Developers: Maintainers-only (40) or no one (0) keeps them off
  const noPush = !!branch && branch.push_access_levels.every((l) => l.access_level === 0 || l.access_level >= 40);
  let mustSucceed = !!(await rest<{ only_allow_merge_if_pipeline_succeeds: boolean }>(`/projects/${enc}`))?.only_allow_merge_if_pipeline_succeeds;
  const parts = projectPath.split('/').slice(0, -1);
  for (let i = parts.length; i > 0 && !mustSucceed; i--) {
    mustSucceed = !!(await rest<{ only_allow_merge_if_pipeline_succeeds?: boolean }>(`/groups/${encodeURIComponent(parts.slice(0, i).join('/'))}`))?.only_allow_merge_if_pipeline_succeeds;
  }
  const missing = [noPush ? '' : `Developers (and so the agents) can push to ${defaultBranch}`, mustSucceed ? '' : '"Pipelines must succeed" is off'].filter(Boolean);
  if (missing.length && !args.includes('--unprotected')) {
    throw new Error(`not setting up agents that can push while ${missing.join(' and ')} (#14); fix that first, or pass --unprotected for a test project`);
  }

  interface Consumer {
    id: string;
    item: { id: string; name: string };
  }
  const consumers = async () => {
    const out: Consumer[] = [];
    for (let after: string | null = null; ; ) {
      const data: { aiCatalogConfiguredItems: { nodes: Consumer[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await gql(
        `query($p: ProjectID!, $after: String) {
          aiCatalogConfiguredItems(projectId: $p, first: 100, after: $after) { nodes { id item { id name } } pageInfo { hasNextPage endCursor } }
        }`,
        { p: project.id, after },
      );
      out.push(...data.aiCatalogConfiguredItems.nodes);
      if (!data.aiCatalogConfiguredItems.pageInfo.hasNextPage) return out;
      after = data.aiCatalogConfiguredItems.pageInfo.endCursor;
    }
  };
  interface Trigger {
    id: string;
    eventTypes: number[];
    filter: unknown;
    user: { username: string } | null;
    aiCatalogItemConsumer: { id: string } | null;
  }
  const triggers = async () =>
    (
      await gql<{ project: { aiFlowTriggers: { nodes: Trigger[] } } }>(
        'query($p: ID!) { project(fullPath: $p) { aiFlowTriggers { nodes { id eventTypes filter user { username } aiCatalogItemConsumer { id } } } } }',
        { p: projectPath },
      )
    ).project.aiFlowTriggers.nodes;

  const config = loadConfig();
  const dir = '.gitlab/duo/flows';
  const files = new Map(readdirSync(dir).map((f) => [f.replace(/\.ya?ml$/, ''), join(dir, f)]));
  const accounts: Record<string, string> = {};

  for (const [name, description, spec] of FLOWS) {
    const file = files.get(name);
    if (!file) throw new Error(`no ${dir}/${name}.yaml`);
    let consumer = (await consumers()).find((c) => c.item.name === name);

    if (!consumer) {
      // the account names aren't known until the flows exist; sync-flows fills them in afterwards
      const ids = Object.fromEntries((await consumers()).map((c) => [c.item.name, c.id.split('/').pop()!]));
      const values = flowValues(
        { ...config, agents: { ...config.agents, reviewerAccount: config.agents.reviewerAccount || 'REVIEWER_ACCOUNT_NOT_SET', fixerAccount: config.agents.fixerAccount || 'FIXER_ACCOUNT_NOT_SET' } },
        ids,
      );
      const definition = renderFlow(readFileSync(file, 'utf8'), values);
      const problems = checkFlow(definition);
      if (problems.length) throw new Error(`${name}: ${problems.join('; ')}`);
      if (dryRun) {
        console.log(`${name}: would create, enable and set its trigger`);
        continue;
      }
      const created = await gql<{ aiCatalogFlowCreate: { errors: string[]; item: { id: string } | null } }>(
        'mutation($i: AiCatalogFlowCreateInput!) { aiCatalogFlowCreate(input: $i) { errors item { id } } }',
        { i: { name, description, projectId: project.id, definition, public: false, release: true } },
      );
      check(`${name}: create`, created.aiCatalogFlowCreate.errors);
      const enabled = await gql<{ aiCatalogItemConsumerCreate: { errors: string[]; itemConsumer: { id: string } | null } }>(
        'mutation($i: AiCatalogItemConsumerCreateInput!) { aiCatalogItemConsumerCreate(input: $i) { errors itemConsumer { id } } }',
        { i: { itemId: created.aiCatalogFlowCreate.item!.id, target: { projectId: project.id }, triggerTypes: ['mention'] } },
      );
      check(`${name}: enable`, enabled.aiCatalogItemConsumerCreate.errors);
      consumer = { id: enabled.aiCatalogItemConsumerCreate.itemConsumer!.id, item: { id: created.aiCatalogFlowCreate.item!.id, name } };
      console.log(`${name}: created and enabled`);
    }

    const filter = pipelineFilter(spec, defaultBranch);
    const trigger = (await triggers()).find((t) => t.aiCatalogItemConsumer?.id === consumer!.id);
    if (!trigger) {
      if (dryRun) console.log(`${name}: would create its trigger`);
      else {
        const made = await gql<{ aiFlowTriggerCreate: { errors: string[] } }>(
          'mutation($i: AiFlowTriggerCreateInput!) { aiFlowTriggerCreate(input: $i) { errors } }',
          { i: { projectPath, description: `${name}: ${description}`, eventTypes: spec.events, aiCatalogItemConsumerId: consumer.id, filter } },
        );
        check(`${name}: trigger`, made.aiFlowTriggerCreate.errors);
        console.log(`${name}: trigger created`);
      }
    } else if (JSON.stringify([...trigger.eventTypes].sort()) !== JSON.stringify([...spec.events].sort()) || JSON.stringify(trigger.filter ?? {}) !== JSON.stringify(filter)) {
      if (dryRun) console.log(`${name}: would set its trigger to events ${spec.events.join(',')} with ${JSON.stringify(filter)}`);
      else {
        const updated = await gql<{ aiFlowTriggerUpdate: { errors: string[] } }>(
          'mutation($i: AiFlowTriggerUpdateInput!) { aiFlowTriggerUpdate(input: $i) { errors } }',
          { i: { id: trigger.id, eventTypes: spec.events, filter } },
        );
        check(`${name}: trigger`, updated.aiFlowTriggerUpdate.errors);
        console.log(`${name}: trigger set`);
      }
    } else console.log(`${name}: trigger already right`);

    const username = (await triggers()).find((t) => t.aiCatalogItemConsumer?.id === consumer!.id)?.user?.username;
    if (username) accounts[name] = username;
  }

  const autonomy = '.autonomy.yml';
  let own: string | undefined;
  try {
    own = projectPathFrom(undefined);
  } catch {
    // no remote to tell which project this checkout is
  }
  if (own !== projectPath) {
    console.log(`\naccounts (not written: this checkout is ${own ?? 'not a GitLab project'}, not ${projectPath}):`, accounts);
    process.exit(0);
  }
  const before = readFileSync(autonomy, 'utf8');
  const after = withAccounts(before, { reviewer: accounts['mr-reviewer'], fixer: accounts['pipeline-fixer'] });
  if (after !== before && !dryRun) {
    writeFileSync(autonomy, after);
    console.log(`\n${autonomy}: agent accounts set (${accounts['mr-reviewer']}, ${accounts['pipeline-fixer']}); commit it in an MR, then run sync-flows`);
  } else console.log('\naccounts:', accounts);
}
