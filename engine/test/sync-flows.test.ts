import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// sync-flows.ts is a top-level script: fake the flow directory and GitLab's
// GraphQL endpoint, then import it fresh. checkFlow runs for real.

const fsState = vi.hoisted(() => ({ flows: {} as Record<string, string>, dirty: '' }));
const DIR = '.gitlab/duo/flows';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: ((path: unknown, ...rest: unknown[]) =>
      path === DIR ? Object.keys(fsState.flows) : (actual.readdirSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof actual.readdirSync,
    readFileSync: ((path: unknown, ...rest: unknown[]) =>
      typeof path === 'string' && path.startsWith(`${DIR}/`)
        ? fsState.flows[path.slice(DIR.length + 1)]
        : (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest)) as typeof actual.readFileSync,
  };
});

// the clean-tree check asks git; answer from the fake instead of the real checkout
vi.mock('node:child_process', () => ({
  execFileSync: (_cmd: string, args: string[]) =>
    args[0] === 'remote' ? 'git@gitlab.com:group/from-remote.git' : fsState.dirty,
}));

const saved = { ...process.env };
const savedArgv = [...process.argv];
const PROJECT = 'group/sub/proj';

const flow = (tool = 'read_file') => `version: "v1"
environment: ambient
components:
  - name: "agent"
    type: AgentComponent
    prompt_id: "p"
    inputs:
      - from: "context:goal"
        as: "event"
    toolset:
      - "${tool}"
prompts:
  - prompt_id: "p"
    name: "P"
    unit_primitives: []
    prompt_template:
      system: "hello"
      user: "{{event}}"
routers:
  - from: "agent"
    to: "end"
flow:
  entry_point: "agent"
`;

interface Req {
  url: string;
  headers: Record<string, string>;
  query: string;
  variables: Record<string, any>;
}
let reqs: Req[];
let catalog: Record<string, string>; // flow name -> catalog item id
let updateReply: (input: { id: string; definition: string }) => { errors: string[]; item: unknown };
let logs: string[];
let errs: string[];
let warns: string[];

function fakeGitLab(opts: { httpStatus?: number; gqlErrors?: string[] } = {}) {
  reqs = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
      const { query, variables } = JSON.parse(init.body);
      reqs.push({ url, headers: init.headers, query, variables });
      if (opts.httpStatus) return new Response('{}', { status: opts.httpStatus });
      if (opts.gqlErrors) return new Response(JSON.stringify({ errors: opts.gqlErrors.map((message) => ({ message })) }));
      const reply = (data: unknown) => new Response(JSON.stringify({ data }));
      if (query.includes('project(fullPath')) return reply({ project: { id: 'gid://gitlab/Project/42' } });
      if (query.includes('aiCatalogConfiguredItems')) {
        // behave like a GraphQL connection: honour first and the after cursor, and say if there is more
        const first = Number(/first:\s*(\d+)/.exec(query)?.[1] ?? 100);
        const start = variables.after ? Number(variables.after) : 0;
        const all = Object.entries(catalog).map(([name, id]) => ({
          id: `gid://gitlab/Ai::Catalog::ItemConsumer/${id.split('/').pop()}00`,
          item: { id, name },
        }));
        const end = Math.min(start + first, all.length);
        return reply({
          aiCatalogConfiguredItems: {
            nodes: all.slice(start, end),
            pageInfo: { hasNextPage: end < all.length, endCursor: String(end) },
          },
        });
      }
      if (query.includes('aiCatalogFlowUpdate')) return reply({ aiCatalogFlowUpdate: updateReply(variables.input) });
      throw new Error(`unexpected query: ${query}`);
    }),
  );
}

async function runSync(...args: string[]) {
  vi.resetModules();
  process.argv = ['node', 'sync-flows.ts', ...args];
  await import('../src/cli/sync-flows.ts');
}

const updates = () => reqs.filter((r) => r.query.includes('aiCatalogFlowUpdate'));
const released = (versionName = '1.0.1') => ({ errors: [], item: { latestVersion: { versionName } } });

beforeEach(() => {
  fsState.flows = { 'alpha.yaml': flow(), 'beta.yml': flow('edit_file') };
  fsState.dirty = '';
  catalog = { alpha: 'gid://gitlab/Ai::Catalog::Item/1', beta: 'gid://gitlab/Ai::Catalog::Item/2' };
  updateReply = () => released();
  delete process.env.GITLAB_PROJECT_PATH;
  delete process.env.GITLAB_URL;
  process.env.GITLAB_TOKEN = 'dev-token';
  logs = [];
  errs = [];
  warns = [];
  vi.spyOn(console, 'log').mockImplementation((m: string) => void logs.push(String(m)));
  vi.spyOn(console, 'error').mockImplementation((m: string) => void errs.push(String(m)));
  vi.spyOn(console, 'warn').mockImplementation((m: string) => void warns.push(String(m)));
  fakeGitLab();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...saved };
  process.argv = [...savedArgv];
});

describe('sync-flows: set-up', () => {
  it('refuses to run without GITLAB_TOKEN and sends nothing', async () => {
    delete process.env.GITLAB_TOKEN;
    await expect(runSync(PROJECT)).rejects.toThrow('GITLAB_TOKEN');
    expect(reqs).toEqual([]);
  });

  it('sends the token as a bearer header to /api/graphql on gitlab.com by default', async () => {
    await runSync(PROJECT);
    expect(reqs[0].url).toBe('https://gitlab.com/api/graphql');
    expect(reqs[0].headers.Authorization).toBe('Bearer dev-token');
  });

  it('uses GITLAB_URL for a self-managed instance', async () => {
    process.env.GITLAB_URL = 'https://gitlab.example.com';
    await runSync(PROJECT);
    expect(reqs.every((r) => r.url === 'https://gitlab.example.com/api/graphql')).toBe(true);
  });

  it('takes the project path from the argument, then GITLAB_PROJECT_PATH, then the built-in default', async () => {
    const lookups = () => reqs.filter((r) => r.query.includes('project(fullPath')).map((r) => r.variables.p);
    await runSync(PROJECT, '--dry-run');
    expect(lookups()).toEqual([PROJECT]);

    process.env.GITLAB_PROJECT_PATH = 'from/env';
    fakeGitLab();
    await runSync('--dry-run');
    expect(lookups()).toEqual(['from/env']);

    fakeGitLab();
    await runSync('other/arg', '--dry-run'); // the argument beats the variable
    expect(lookups()).toEqual(['other/arg']);

    delete process.env.GITLAB_PROJECT_PATH;
    fakeGitLab();
    await runSync('--dry-run');
    expect(lookups()).toEqual(['group/from-remote']); // then the origin remote
  });

  it('looks up the catalog by the project ID it just resolved', async () => {
    await runSync(PROJECT);
    expect(reqs[1].query).toContain('aiCatalogConfiguredItems');
    expect(reqs[1].variables).toMatchObject({ p: 'gid://gitlab/Project/42' }); // a paging fix may add an after cursor
  });
});

describe('sync-flows: updating flows', () => {
  it('updates each flow with the file contents, released as a patch version', async () => {
    await runSync(PROJECT);
    expect(updates().map((r) => r.variables.input)).toEqual([
      { id: catalog.alpha, definition: fsState.flows['alpha.yaml'], release: true, versionBump: 'PATCH' },
      { id: catalog.beta, definition: fsState.flows['beta.yml'], release: true, versionBump: 'PATCH' },
    ]);
  });

  it('names a flow after its file, for .yaml and .yml alike, and ignores other files', async () => {
    fsState.flows['README.md'] = '# not a flow';
    fsState.flows['notes.txt'] = 'x';
    await runSync(PROJECT);
    expect(updates()).toHaveLength(2);
    expect(logs).toEqual(['alpha: released 1.0.1', 'beta: released 1.0.1']);
  });

  it('reports the version GitLab released', async () => {
    updateReply = () => released('2.3.4');
    await runSync(PROJECT);
    expect(logs).toContain('alpha: released 2.3.4');
  });

  it('says "a new version" when GitLab does not return a version name', async () => {
    updateReply = () => ({ errors: [], item: null });
    await runSync(PROJECT);
    expect(logs).toContain('alpha: released a new version');
  });

  it.each(['Item is already released', "Definition can't be changed because it is released"])(
    "reports 'unchanged' and carries on when GitLab says: %s",
    async (message) => {
      updateReply = (input) => (input.id === catalog.alpha ? { errors: [message], item: null } : released());
      await runSync(PROJECT);
      expect(logs).toEqual(['alpha: unchanged', 'beta: released 1.0.1']);
      expect(updates()).toHaveLength(2);
    },
  );

  it('stops with the flow name and errors on any other update error', async () => {
    updateReply = () => ({ errors: ['Definition is invalid', 'Name is taken'], item: null });
    await expect(runSync(PROJECT)).rejects.toThrow('alpha: Definition is invalid; Name is taken');
    expect(updates()).toHaveLength(1); // beta was not attempted
  });

  // "Already released" only means unchanged when it is the only error.
  it("does not hide other errors behind an 'already released' one", async () => {
    updateReply = () => ({ errors: ['Item is already released', 'something else'], item: null });
    await expect(runSync(PROJECT)).rejects.toThrow('something else');
  });
});

describe('sync-flows: flows with no catalog entry', () => {
  it('warns and skips a flow whose name is not in the catalog, and still syncs the others', async () => {
    delete catalog.alpha;
    await runSync(PROJECT);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('alpha: no flow with this name is enabled');
    expect(warns[0]).toContain(PROJECT);
    expect(updates().map((r) => r.variables.input.id)).toEqual([catalog.beta]);
  });

  it('does not fail when nothing matches', async () => {
    catalog = { unrelated: 'gid://gitlab/Ai::Catalog::Item/9' };
    await runSync(PROJECT);
    expect(warns).toHaveLength(2);
    expect(updates()).toEqual([]);
  });

  it('does not touch catalog flows that have no file', async () => {
    catalog.gamma = 'gid://gitlab/Ai::Catalog::Item/3';
    await runSync(PROJECT);
    expect(updates().map((r) => r.variables.input.id)).not.toContain(catalog.gamma);
  });
});

describe('sync-flows: catalog paging', () => {
  // The fake GraphQL server pages properly (first, after, pageInfo).
  it('finds a flow that is past the first 100 catalog items', async () => {
    const all: Record<string, string> = {};
    for (let i = 0; i < 120; i++) all[`other${i}`] = `gid://gitlab/Ai::Catalog::Item/${100 + i}`;
    all.alpha = catalog.alpha; // item 121, on the second page
    catalog = all;
    await runSync(PROJECT, '--dry-run');
    expect(warns.filter((w) => w.startsWith('alpha:'))).toEqual([]);
    expect(logs).toContain(`alpha: would update ${all.alpha}`);
  });

  it('does not warn about flows that are within the first page', async () => {
    // guards the fake: with a short catalog everything is on page one
    await runSync(PROJECT, '--dry-run');
    expect(warns).toEqual([]);
  });
});

describe('sync-flows: --dry-run', () => {
  it('says what it would update and sends no mutation', async () => {
    await runSync(PROJECT, '--dry-run');
    expect(updates()).toEqual([]);
    expect(logs).toEqual([`alpha: would update ${catalog.alpha}`, `beta: would update ${catalog.beta}`]);
  });

  it('works with the flag before the project path', async () => {
    await runSync('--dry-run', PROJECT);
    expect(reqs[0].variables).toEqual({ p: PROJECT });
    expect(updates()).toEqual([]);
  });

  it('still warns about flows missing from the catalog', async () => {
    delete catalog.beta;
    await runSync(PROJECT, '--dry-run');
    expect(warns[0]).toContain('beta: no flow with this name');
    expect(logs).toEqual([`alpha: would update ${catalog.alpha}`]);
  });

  it('still refuses to continue when a flow fails the checks', async () => {
    fsState.flows['beta.yml'] = flow('not_a_tool');
    await expect(runSync(PROJECT, '--dry-run')).rejects.toThrow('nothing was synced');
    expect(reqs).toEqual([]);
  });
});

describe('sync-flows: refuses to sync a broken flow', () => {
  it('sends nothing at all if any flow fails checkFlow, even the valid ones', async () => {
    fsState.flows['beta.yml'] = flow('not_a_tool');
    await expect(runSync(PROJECT)).rejects.toThrow('1 flow file(s) failed the checks; nothing was synced');
    expect(reqs).toEqual([]);
    expect(errs).toEqual(['beta: component agent: unknown tool "not_a_tool"']);
  });

  it('counts and prints every broken flow', async () => {
    fsState.flows['alpha.yaml'] = flow('bad_one');
    fsState.flows['beta.yml'] = flow('bad_two');
    await expect(runSync(PROJECT)).rejects.toThrow('2 flow file(s) failed the checks');
    expect(errs).toHaveLength(2);
    expect(reqs).toEqual([]);
  });

  it('fails when a flow breaks the schema', async () => {
    fsState.flows['alpha.yaml'] = 'version: "v1"\n';
    await expect(runSync(PROJECT)).rejects.toThrow('nothing was synced');
    expect(errs[0]).toMatch(/^alpha: schema:/);
    expect(reqs).toEqual([]);
  });
});

describe('sync-flows: GraphQL failures', () => {
  it('fails with the GraphQL error messages, joined', async () => {
    fakeGitLab({ gqlErrors: ['first problem', 'second problem'] });
    await expect(runSync(PROJECT)).rejects.toThrow('first problem; second problem');
    expect(updates()).toEqual([]);
  });

  it('fails with the HTTP status when the reply has no error messages', async () => {
    fakeGitLab({ httpStatus: 502 });
    await expect(runSync(PROJECT)).rejects.toThrow('HTTP 502');
  });

  it('fails when the project cannot be found, before listing the catalog', async () => {
    fakeGitLab({ gqlErrors: ['project not found'] });
    await expect(runSync(PROJECT)).rejects.toThrow('project not found');
    expect(reqs).toHaveLength(1);
  });
});

describe('sync-flows: per-project values', () => {
  const withMarker = (text: string) => flow().replace('system: "hello"', `system: "${text}"`);

  it('fills markers from .autonomy.yml before checking and sending', async () => {
    fsState.flows['alpha.yaml'] = withMarker('Run @@checks@@. Never edit @@protected_paths@@.');
    await runSync(PROJECT);
    const sent = updates()[0].variables.input.definition as string;
    expect(sent).not.toContain('@@');
    expect(sent).toContain('npm run typecheck');
    expect(sent).toContain('.gitlab-ci.yml, .autonomy.yml');
  });

  it("fills a handoff flow's consumer ID from the catalog", async () => {
    catalog['mr-reviewer'] = 'gid://gitlab/Ai::Catalog::Item/7';
    fsState.flows['alpha.yaml'] = withMarker('hand over to @@mr_reviewer_flow_id@@');
    await runSync(PROJECT);
    expect(updates()[0].variables.input.definition).toContain('hand over to 700');
  });

  it('sends nothing when a marker has no value, and says which', async () => {
    fsState.flows['alpha.yaml'] = withMarker('hand over to @@issue_builder_flow_id@@');
    await expect(runSync(PROJECT)).rejects.toThrow('nothing was synced');
    expect(errs[0]).toContain('@@issue_builder_flow_id@@');
    expect(updates()).toEqual([]);
  });

  it('--print writes one flow, filled in, and sends nothing', async () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((t) => void out.push(String(t)) as never);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    fsState.flows['alpha.yaml'] = withMarker('Run @@checks@@');
    await expect(runSync(PROJECT, '--print', 'alpha')).rejects.toThrow('exit');
    expect(exit).toHaveBeenCalledWith(0);
    expect(out.join('')).toContain('Run npm ci');
    expect(updates()).toEqual([]);
  });

  it('refuses to publish uncommitted flow files unless told to', async () => {
    fsState.dirty = ' M .gitlab/duo/flows/alpha.yaml';
    await expect(runSync(PROJECT)).rejects.toThrow('uncommitted changes');
    expect(reqs).toEqual([]);
    await runSync(PROJECT, '--allow-dirty');
    expect(updates()).toHaveLength(2);
  });
});
