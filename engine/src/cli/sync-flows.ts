/**
 * Pushes the flow files in .gitlab/duo/flows to the project's AI Catalog
 * flows, so nobody has to paste YAML into the UI. Each file updates the
 * catalog flow with the same name and releases it as a new patch version.
 * Every file is checked first and nothing is sent if one fails.
 *
 * The files hold @@name@@ markers for what differs per project; they are
 * filled from .autonomy.yml and from the catalog (the IDs of the flows that
 * others hand over to) before anything is checked or sent.
 *
 * Run it from your machine, not from CI (it uses your own token):
 *   GITLAB_TOKEN=... node engine/src/cli/sync-flows.ts [project path] [--dry-run]
 *   ... --print NAME   prints one flow filled in, to paste when creating it in the UI
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gitlabUrl, projectPathFrom, tokenFetch } from '../project.ts';
import { loadConfig } from '../config.ts';
import { checkFlow } from '../flows.ts';
import { flowValues, renderFlow } from '../render.ts';

const args = process.argv.slice(2);
const printName = args.includes('--print') ? args[args.indexOf('--print') + 1] : undefined;
const dryRun = args.includes('--dry-run') || !!printName;
const projectPath = projectPathFrom(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--print'));
const token = process.env.GITLAB_TOKEN;
if (!token) throw new Error('set GITLAB_TOKEN (a token with the api scope) to sync flows');
const api = gitlabUrl(process.env.GITLAB_URL);

// Publish what is committed, not whatever happens to be on disk.
if (!dryRun && !args.includes('--allow-dirty')) {
  const dirty = execFileSync('git', ['status', '--porcelain', '--', '.gitlab/duo/flows'], { encoding: 'utf8' }).trim();
  if (dirty) throw new Error(`uncommitted changes in .gitlab/duo/flows; commit them first (or pass --allow-dirty):\n${dirty}`);
}

async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await tokenFetch(`${api}/api/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let body: { data?: T; errors?: { message: string }[] };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} from ${api}/api/graphql (not JSON)`);
  }
  if (!res.ok || body.errors?.length) throw new Error(body.errors?.map((e) => e.message).join('; ') ?? `HTTP ${res.status}`);
  return body.data as T;
}

const dir = '.gitlab/duo/flows';
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
const sources = new Map(files.map((f) => [basename(f).replace(/\.ya?ml$/, ''), readFileSync(join(dir, f), 'utf8')]));

// Check the files as written first, so a broken one fails before any request.
let broken = 0;
for (const [name, source] of sources) {
  const problems = checkFlow(source);
  if (problems.length) {
    broken++;
    console.error(`${name}: ${problems.join('; ')}`);
  }
}
if (broken) throw new Error(`${broken} flow file(s) failed the checks; nothing was synced`);

const { project } = await graphql<{ project: { id: string } }>('query($p: ID!) { project(fullPath: $p) { id } }', {
  p: projectPath,
});
// The catalog holds agents and flows together and is paged, so follow the cursor.
interface CatalogPage {
  aiCatalogConfiguredItems: {
    nodes: { id: string; item: { id: string; name: string } }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}
const items = new Map<string, string>();
const consumerIds: Record<string, string> = {};
for (let after: string | null = null; ; ) {
  const { aiCatalogConfiguredItems: page }: CatalogPage = await graphql<CatalogPage>(
    `query($p: ProjectID!, $after: String) {
      aiCatalogConfiguredItems(projectId: $p, first: 100, after: $after) {
        nodes { id item { id name } }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { p: project.id, after },
  );
  for (const n of page.nodes) {
    items.set(n.item.name, n.item.id);
    const consumer = /\/(\d+)$/.exec(n.id ?? '')?.[1];
    if (consumer) consumerIds[n.item.name] = consumer;
  }
  if (!page.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
  after = page.pageInfo.endCursor;
}

const config = loadConfig();
// A flow's service account only exists once the flow is enabled, so --print
// (used to create it) puts a placeholder in and says to sync afterwards.
const missingAccounts = !config.agents.reviewerAccount || !config.agents.fixerAccount;
if (printName && missingAccounts) {
  config.agents = {
    ...config.agents,
    reviewerAccount: config.agents.reviewerAccount || 'REVIEWER_ACCOUNT_NOT_SET',
    fixerAccount: config.agents.fixerAccount || 'FIXER_ACCOUNT_NOT_SET',
  };
  console.warn('agent accounts are not in .autonomy.yml yet: once the flows are enabled, add them and run sync-flows');
}
const values = flowValues(config, consumerIds);
const rendered = new Map<string, string>();
for (const [name, source] of sources) {
  if (printName && name !== printName) continue;
  let problems: string[];
  try {
    const text = renderFlow(source, values);
    rendered.set(name, text);
    problems = checkFlow(text);
  } catch (err) {
    problems = [`${(err as Error).message} (set it in .autonomy.yml, or enable the flow it names first)`];
  }
  if (problems.length) {
    broken++;
    console.error(`${name}: ${problems.join('; ')}`);
  }
}
if (broken) throw new Error(`${broken} flow file(s) failed the checks; nothing was synced`);

if (printName) {
  const text = rendered.get(printName);
  if (!text) throw new Error(`no flow file named ${printName} in ${dir}`);
  process.stdout.write(text);
  process.exit(0);
}

for (const [name, definition] of rendered) {
  const id = items.get(name);
  if (!id) {
    console.warn(`${name}: no flow with this name is enabled in ${projectPath}; create it in the UI first`);
    continue;
  }
  if (dryRun) {
    console.log(`${name}: would update ${id}`);
    continue;
  }
  const { aiCatalogFlowUpdate } = await graphql<{
    aiCatalogFlowUpdate: { errors: string[]; item: { latestVersion?: { versionName?: string } } | null };
  }>(
    `mutation($input: AiCatalogFlowUpdateInput!) {
      aiCatalogFlowUpdate(input: $input) { errors item { latestVersion { versionName } } }
    }`,
    { input: { id, definition, release: true, versionBump: 'PATCH' } },
  );
  const { errors } = aiCatalogFlowUpdate;
  if (errors.length === 1 && /already released|can't be changed because it is released/i.test(errors[0])) {
    // GitLab doesn't cut a new version when the definition is unchanged. Only
    // trust that when it is the only error; anything else is a real failure.
    console.log(`${name}: unchanged`);
    continue;
  }
  if (aiCatalogFlowUpdate.errors.length) throw new Error(`${name}: ${aiCatalogFlowUpdate.errors.join('; ')}`);
  console.log(`${name}: released ${aiCatalogFlowUpdate.item?.latestVersion?.versionName ?? 'a new version'}`);
}
