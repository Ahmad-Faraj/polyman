import { execFileSync } from 'node:child_process';
import type { AutonomyConfig } from './config.ts';
import { matchesAny } from './glob.ts';
import { GitLab, GitLabError, RATE_LIMIT_RETRIES, backOff, required } from './gitlab.ts';
import { type BranchPush, type Note, type PushEvent, type Step, type Tier, type Verdict, attribute, branchPushes, goAheadFor, isProjectPerson } from './goahead.ts';

/**
 * The go-ahead guard's check of one merge request (wiki: Assisted), shared by
 * autonomy:goahead, which runs it on the MR's pipeline, and the go-ahead
 * ledger, which runs it again on every merged MR. Who pushed what comes from
 * GitLab's push events, who wrote what from its notes; git only says which
 * commit is in which push and what a commit changes.
 */

/** What the check asks git. */
export interface Repo {
  isAncestor(commit: string, of: string): boolean;
  /** the commit is in this checkout (a head a later force-push threw away is not) */
  has(sha: string): boolean;
  parents(sha: string): number;
  files(sha: string): string[];
}

/** The checkout the job runs in. */
export function gitRepo(): Repo {
  return {
    isAncestor: (commit, of) => {
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', commit, of], { stdio: 'ignore' });
        return true;
      } catch (err) {
        // exit 1 means "no"; anything else (an unknown commit, say) is an error, not a no
        if ((err as { status?: number }).status === 1) return false;
        throw new Error(`git can't compare ${commit.slice(0, 8)} with ${of.slice(0, 8)} (is the history fetched?)`);
      }
    },
    has: (sha) => {
      try {
        execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
    parents: (sha) => execFileSync('git', ['rev-list', '--parents', '-n', '1', sha], { encoding: 'utf8' }).trim().split(' ').length - 1,
    // -z: paths come out as they are, not quoted (a quoted "engine/\303\251.ts" wouldn't match engine/**)
    files: (sha) => execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-z', sha], { encoding: 'utf8' }).split('\0').filter(Boolean),
  };
}

export interface MrFacts {
  mr: { author: { username: string }; created_at: string; source_branch: string };
  notes: Note[];
  /** the issues GitLab says the MR closes */
  closes: { iid: number; author: { username: string } }[];
  events: PushEvent[];
  /** the MR's commits (base..head) */
  commits: string[];
  /** the day push events are read from, for the messages */
  since: string;
  tier: Tier;
}

export interface PushCheck {
  push: BranchPush;
  /** the commits this push brought */
  commits: string[];
  step: Step;
  /** the issue whose notes hold the go-ahead (a push from before the MR existed), or null: the MR's notes */
  issue: number | null;
  verdict: Verdict;
  /** what the guard prints for it */
  line: string;
}

export interface MrCheck {
  requesters: string[];
  /** pushes that brought commits */
  pushes: number;
  agentPushes: PushCheck[];
  /** everything that fails the job, in the order the guard prints it; `push` when it is about one agent push */
  problems: { text: string; push?: BranchPush }[];
}

export const isRollback = (account: string) => /incident-responder/i.test(account);

/**
 * The day push events are read from: two days before the MR's base commit
 * (the branch can't have been created before the commit it starts from), but
 * at most 120 days before the MR, so a long-stale base can't make the job read
 * more than the page cap allows. `after` leaves out the day it names, hence two days.
 */
export function eventsSince(mrCreated: string, baseTime: number): string {
  const created = Date.parse(mrCreated);
  const oldest = Math.min(created, Math.max(baseTime, created - 120 * 86_400_000));
  return new Date(oldest - 2 * 86_400_000).toISOString().slice(0, 10);
}

export async function checkMr(
  facts: MrFacts,
  config: AutonomyConfig,
  repo: Repo,
  issueNotesOf: (iid: number) => Promise<Note[]>,
): Promise<MrCheck> {
  const { mr, notes, closes, events, commits, since, tier } = facts;
  const isPerson = (username: string) => isProjectPerson(username, config);
  // A push whose head a later force-push threw away brought nothing that's still
  // here. A push whose old head is gone (a rebase or force-push) is read as if
  // it created the branch: it brought whatever earlier pushes didn't.
  const pushes = branchPushes(events, mr.source_branch)
    .filter((p) => repo.has(p.to))
    .map((p) => (p.from && !repo.has(p.from) ? { ...p, from: null } : p));
  const { by, unaccounted } = attribute(commits, pushes, (c, of) => repo.isAncestor(c, of));

  const problems: MrCheck['problems'] = [];
  for (const sha of unaccounted) problems.push({ text: `commit ${sha.slice(0, 8)} is in no push GitLab recorded for ${mr.source_branch}, so who pushed it and on whose go-ahead can't be told (pushes are read from ${since} on)` });

  const allBranchPushes = branchPushes(events, mr.source_branch);
  // Who opened the MR. GitLab records an MR a flow opens under the person whose
  // mention or assignment started the flow (composite identity), so when an
  // agent created the branch, the MR is the agent's: that person gave the
  // go-ahead, they didn't ask for the work.
  const creator = allBranchPushes.find((p) => p.from === null)?.pusher;
  const opener = isPerson(mr.author.username) && creator && !isPerson(creator) ? creator : mr.author.username;
  // the issues GitLab says this MR closes, parsed from a description the agent may
  // write, so only an issue a person wrote shows someone asked
  // ...or, for a rollback, the incident the responder opened: its push still
  // needs a maintainer's go-ahead on that issue
  const asked = closes.filter((i) => isPerson(i.author.username) || (isRollback(i.author.username) && isRollback(opener)));
  const issue = asked[0]?.iid ?? null;
  // whoever asked: the MR's author if a person opened it, and the issues' authors
  const requesters = [...(isPerson(opener) ? [opener] : []), ...closes.map((i) => i.author.username)];
  // an agent's MR with no person's issue has nobody on record who asked, so anyone could approve their own idea
  if (!isPerson(opener) && !asked.length) {
    problems.push({
      text: `an agent (@${opener}) opened this MR and GitLab lists no issue it closes that a person wrote, so who asked for the work isn't on record; link the issue ("Closes #N")`,
    });
  }
  // the agent's previous push to this branch: an older go-ahead was used up by it
  // (the agent accounts are shared, so a push to another MR spends nothing here)
  const previousPush = (pusher: string, at: string) =>
    allBranchPushes
      .filter((p) => p.pusher.toLowerCase() === pusher.toLowerCase() && Date.parse(p.at) < Date.parse(at))
      .map((p) => p.at)
      .pop();

  // the agent pushes that brought commits, and every agent push since the MR
  // opened even if it brought none: a rewind or a force-push back is a step too
  const agentPushes = [...new Set([...by.values(), ...pushes.filter((p) => Date.parse(p.at) >= Date.parse(mr.created_at))])]
    .filter((p) => !isPerson(p.pusher))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  // Agents may not change the pipeline, the policy or the engine. autonomy:guard
  // checks this by commit email, which an agent can set; this checks it by who
  // pushed. Only the incident responder may add to the incidents file.
  for (const [sha, p] of by) {
    if (isPerson(p.pusher)) continue;
    // a merge commit's diff hides what it brings in, so agents push none
    if (repo.parents(sha) > 1) {
      problems.push({ text: `commit ${sha.slice(0, 8)} pushed by @${p.pusher} is a merge commit; agents may not push merges (a person merges the default branch in)`, push: p });
      continue;
    }
    const touched = repo.files(sha).filter((f) => matchesAny(f, config.governance) && !(f === config.incidentsFile && isRollback(p.pusher)));
    if (touched.length) problems.push({ text: `commit ${sha.slice(0, 8)} pushed by @${p.pusher} changes files only people may change: ${touched.join(', ')}`, push: p });
  }

  let issueNotes: Note[] | null = null;
  const checks: PushCheck[] = [];
  for (const push of agentPushes) {
    const brought = [...by].filter(([, p]) => p === push).map(([sha]) => sha);
    const shas = brought.map((sha) => sha.slice(0, 8)).join(', ') || `no new commits, head ${push.to.slice(0, 8)}`;
    const step: Step = { requesters, tier, rollback: isRollback(push.pusher) };
    const beforeMr = Date.parse(push.at) < Date.parse(mr.created_at);
    if (beforeMr && !issue) {
      const reason = 'came before the MR, and GitLab lists no issue this MR closes, written by a person, to hold its go-ahead';
      const line = `push at ${push.at} by @${push.pusher} (${shas}) ${reason}`;
      checks.push({ push, commits: brought, step, issue: null, verdict: { ok: false, reason }, line });
      problems.push({ text: line, push });
      continue;
    }
    if (beforeMr) issueNotes ??= await issueNotesOf(issue!);
    const verdict = goAheadFor(push, beforeMr ? issueNotes! : notes, step, config, previousPush(push.pusher, push.at));
    const place = beforeMr ? ` on #${issue}` : '';
    const line = verdict.ok
      ? `push at ${push.at} by @${push.pusher} (${shas}): go-ahead in note ${verdict.note.id}${place} by @${verdict.note.author.username}`
      : `push at ${push.at} by @${push.pusher} (${shas})${place}: ${verdict.reason}`;
    checks.push({ push, commits: brought, step, issue: beforeMr ? issue : null, verdict, line });
    if (!verdict.ok) problems.push({ text: line, push });
  }
  return { requesters, pushes: new Set(by.values()).size, agentPushes: checks, problems };
}

/** Every page of a list, or an error if there are more than `pages` of them. */
export async function allPages<T>(gl: GitLab, path: string, pages = 20): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= pages; page++) {
    const batch = await gl.get<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) return out;
  }
  throw new Error(`more than ${pages * 100} records at ${path}; can't be sure every push was read`);
}

/**
 * An issue's or MR's notes, oldest first. The job token can't read issue notes
 * over REST, and REST wants a login even on a public project, but GraphQL
 * serves a public project's notes without one. Notes that only members see
 * aren't there: a go-ahead in one doesn't count, which fails closed.
 */
export async function notesOf(gl: GitLab, kind: 'issue' | 'mergeRequest', iid: number, env: NodeJS.ProcessEnv = process.env): Promise<Note[]> {
  const rest = kind === 'issue' ? 'issues' : 'merge_requests';
  const name = kind === 'issue' ? `#${iid}` : `!${iid}`;
  try {
    return await allPages<Note>(gl, `/:project/${rest}/${iid}/notes?sort=asc&order_by=created_at`);
  } catch (err) {
    if (!(err instanceof GitLabError) || (err.status !== 401 && err.status !== 403)) throw err;
    console.warn(`warning: the notes of ${name} aren't readable with the job token; reading them through GraphQL (public notes only)`);
    return graphqlNotes(kind, iid, env);
  }
}

/** Notes through GraphQL, without credentials, oldest first. */
async function graphqlNotes(kind: 'issue' | 'mergeRequest', iid: number, env: NodeJS.ProcessEnv): Promise<Note[]> {
  const url = env.CI_API_GRAPHQL_URL || required(env, 'CI_API_V4_URL').replace(/\/v4\/?$/, '/graphql');
  const query = `query($path: ID!, $iid: String!, $after: String) {
    project(fullPath: $path) { ${kind}(iid: $iid) { notes(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id body system createdAt updatedAt author { username } }
    } } }
  }`;
  const name = kind === 'issue' ? `#${iid}` : `!${iid}`;
  const out: Note[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const post = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { path: required(env, 'CI_PROJECT_PATH'), iid: String(iid), after } }),
    };
    let res = await fetch(url, post);
    for (let tries = 1; res.status === 429 && tries <= RATE_LIMIT_RETRIES; tries++) {
      await backOff(res);
      res = await fetch(url, post);
    }
    const body = (await res.json().catch(() => null)) as {
      data?: { project?: Record<string, { notes: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GraphqlNote[] } } | null> | null };
      errors?: unknown;
    } | null;
    const notes = body?.data?.project?.[kind]?.notes;
    if (!res.ok || body?.errors || !notes) throw new Error(`GraphQL couldn't read the notes of ${name} (${res.status}): ${JSON.stringify(body?.errors ?? body).slice(0, 300)}`);
    for (const n of notes.nodes) {
      out.push({ id: Number(n.id.split('/').pop()), body: n.body, system: n.system, created_at: n.createdAt, updated_at: n.updatedAt, author: { username: n.author.username } });
    }
    if (!notes.pageInfo.hasNextPage) return out.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    after = notes.pageInfo.endCursor;
  }
  throw new Error(`more than 2000 notes on ${name}; can't be sure every go-ahead was read`);
}

interface GraphqlNote {
  id: string;
  body: string;
  system: boolean;
  createdAt: string;
  updatedAt: string;
  author: { username: string };
}
