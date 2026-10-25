/**
 * The session audit (wiki: Assisted): a check with no model in it of what the
 * Duo agents did, from what GitLab recorded. It lists the project's agent
 * sessions in a window (GraphQL duoWorkflowWorkflows), reads each one's trace
 * (REST .../ai/duo_workflows/workflows/:id/trace.jsonl) and checkpoint
 * (GraphQL duoWorkflowEvents), finds every push an agent made, and holds each
 * against the go-ahead ledger published on Pages and, for a push the ledger
 * doesn't have yet (an MR not merged, or merged since the last ledger), the
 * autonomy:goahead jobs on its MR. The rules are in session-audit.ts.
 *
 *   AUDIT_TOKEN=... node engine/src/cli/session-audit.ts [project] [--since 24h|YYYY-MM-DD|time] [--ledger url|file] [--json out.json] [--md out.md]
 *
 * Needs a token that can read the project's agent sessions (read_api, as a
 * Developer or more): AUDIT_TOKEN, else GITLAB_TOKEN. Without one it tries
 * the CI job token, which GitLab doesn't take for these reads, says so and
 * skips: a skipped audit passes, it doesn't pretend to have checked.
 *
 * Exits 1 when an agent push has no accepted go-ahead, 2 when it couldn't
 * finish (a session it couldn't read in full, a token GitLab didn't take), 0
 * otherwise.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { type Ledger, verifyChain } from '../ledger.ts';
import { gitlabUrl, projectPathFrom, tokenFetch } from '../project.ts';
import {
  type Audit,
  type GuardFacts,
  type GuardRun,
  type PushCheck,
  type SessionNode,
  type SessionReport,
  type TraceLine,
  exitCode,
  guardLines,
  judge,
  judgingOrder,
  ledgerRecordFor,
  parseTrace,
  renderAudit,
  sessionReport,
  summarize,
  windowStart,
  workflowId,
} from '../session-audit.ts';
import { isEntry } from './setup-flows.ts';

// import.meta.main is undefined before Node 22.18: compare real paths then (as setup-flows.ts does)
if (import.meta.main ?? isEntry(process.argv[1], fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error(`the session audit could not finish: ${(err as Error).message}`);
    process.exitCode = 2;
  }
}

export async function main(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const argv = [...args];
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    if (i < 0) return undefined;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
    argv.splice(i, 2);
    return value;
  };
  const now = new Date();
  const from = windowStart(opt('--since'), now);
  const ledgerAt = opt('--ledger') ?? env.LEDGER_URL ?? (env.CI_PAGES_URL ? `${env.CI_PAGES_URL.replace(/\/+$/, '')}/ledger/ledger.json` : undefined);
  const jsonOut = opt('--json');
  const mdOut = opt('--md');
  const projectPath = projectPathFrom(argv[0] ?? env.CI_PROJECT_PATH);
  const api = gitlabUrl(env.GITLAB_URL ?? env.CI_SERVER_URL);
  const project = encodeURIComponent(projectPath);
  const web = `${api}/${projectPath}`;

  const token = env.AUDIT_TOKEN || env.GITLAB_TOKEN;
  const auth: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : env.CI_JOB_TOKEN ? { 'JOB-TOKEN': env.CI_JOB_TOKEN } : {};
  // skipped for want of a token passes; a token GitLab doesn't take is a failure to finish
  const skip = (why: string) => {
    const text = `# Agent session audit: ${projectPath}\n\nSkipped: ${why}\n`;
    if (mdOut) writeFileSync(mdOut, text);
    console.log(text);
    return token ? 2 : 0;
  };

  async function graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await retrying(`${api}/api/graphql`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables }) });
    if (res.status !== 200) throw new Error(`GraphQL -> ${res.status}: ${res.text.slice(0, 200)}`);
    const body = JSON.parse(res.text) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
    return body.data as T;
  }
  async function rest<T>(path: string, raw = false): Promise<T> {
    const res = await retrying(`${api}/api/v4${path.replace(':project', `projects/${project}`)}`, { headers: auth });
    if (res.status >= 400) throw new Error(`GET ${path} -> ${res.status}`);
    return (raw ? res.text : JSON.parse(res.text)) as T;
  }

  // the sessions: anyone without read access gets an empty list, not an
  // error, so who is asking is read too, and nobody means no audit
  const sessions: SessionNode[] = [];
  let user: string | null = null;
  type Page = { currentUser: { username: string } | null; project: { duoWorkflowWorkflows: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: SessionNode[] } } | null };
  for (let after: string | null = null; ;) {
    const page: Page = await graphql<Page>(
      `
        query ($path: ID!, $from: ISO8601DateTime!, $after: String) {
          currentUser {
            username
          }
          project(fullPath: $path) {
            duoWorkflowWorkflows(updatedAfter: $from, first: 100, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                createdAt
                updatedAt
                status
                workflowDefinition
                agentName
                title
                stalled
                webUrl
                mergeRequest {
                  iid
                }
                workItem {
                  iid
                }
                preApprovedAgentPrivilegesNames
              }
            }
          }
        }
      `,
      { path: projectPath, from, after },
    ).catch((err: Error) => {
      // without AUDIT_TOKEN a refusal is the expected answer, not a failure
      if (!token && /-> 401/.test(err.message)) return { currentUser: null, project: null, refused: true } as Page & { refused: true };
      throw err;
    });
    user = page.currentUser?.username ?? null;
    if (!user) {
      const answer = 'refused' in page ? 'answered 401' : 'answered as if nobody asked';
      return skip(
        token
          ? `GitLab ${answer} to the token (expired or revoked?), so the agent sessions are not readable.`
          : `no AUDIT_TOKEN, and GitLab ${answer} to ${env.CI_JOB_TOKEN ? 'the CI job token' : 'a request without a token'}, so the agent sessions are not readable. Set AUDIT_TOKEN (a masked read_api token of a Developer on the project) to run the audit.`,
      );
    }
    if (!page.project) throw new Error(`no project ${projectPath} for @${user}`);
    const c = page.project.duoWorkflowWorkflows;
    sessions.push(...c.nodes);
    if (!c.pageInfo.hasNextPage) break;
    after = c.pageInfo.endCursor;
  }
  sessions.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  console.error(`reading ${sessions.length} session(s) updated since ${from} as @${user}`);

  async function trace(id: number): Promise<TraceLine[] | null> {
    const res = await retrying(`${api}/api/v4/ai/duo_workflows/workflows/${id}/trace.jsonl`, { headers: auth });
    if (res.status !== 200) throw new Error(`trace.jsonl -> ${res.status}`);
    const { lines, bad } = parseTrace(res.text);
    if (bad) console.error(`warning: session ${id}: ${bad} trace line(s) aren't JSON and were left out`);
    return lines;
  }
  async function checkpoint(id: number): Promise<object | null> {
    const data = await graphql<{ duoWorkflowEvents: { nodes: { compressedCheckpoint: string | null }[] } | null }>(
      `
        query ($id: AiDuoWorkflowsWorkflowID!) {
          duoWorkflowEvents(workflowId: $id) {
            nodes {
              compressedCheckpoint
            }
          }
        }
      `,
      { id: `gid://gitlab/Ai::DuoWorkflows::Workflow/${id}` },
    );
    const packed = data.duoWorkflowEvents?.nodes?.[0]?.compressedCheckpoint;
    // zlib, then Base64 (the plain `checkpoint` field is deprecated)
    return packed ? (JSON.parse(inflateSync(Buffer.from(packed, 'base64')).toString('utf8')) as object) : null;
  }

  const reports: SessionReport[] = new Array(sessions.length);
  const unread: number[] = [];
  await pool(sessions.length, 4, async (i) => {
    const node = sessions[i];
    const id = workflowId(node.id);
    // a session not read in full is reported as unread, not the end of the
    // audit; the trace or the checkpoint alone can miss a push (a specialist's
    // is only in the checkpoint), so either one failing counts
    const unreadable = (what: string) => (err: Error) => {
      console.error(`warning: session ${id}: ${what}: ${err.message}`);
      if (!unread.includes(id)) unread.push(id);
      return null;
    };
    const [t, c] = await Promise.all([trace(id).catch(unreadable('trace')), checkpoint(id).catch(unreadable('checkpoint'))]);
    // what GitLab stored in an odd shape ends this session's reading, not the audit
    try {
      reports[i] = sessionReport(node, web, t, c);
    } catch (err) {
      reports[i] = sessionReport(node, web, null, null);
      unreadable('trace and checkpoint')(err as Error);
    }
  });
  unread.sort((a, b) => a - b);

  // the published ledger: public, so no credentials go with it; a ledger whose own chain doesn't verify isn't used
  let ledger: Ledger | null = null;
  let ledgerProblem: string | null = null;
  if (!ledgerAt) ledgerProblem = 'no --ledger, LEDGER_URL or CI_PAGES_URL';
  else {
    try {
      const text = /^https:\/\//.test(ledgerAt) ? await tokenFetch(ledgerAt).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`)))) : readFileSync(ledgerAt, 'utf8');
      const read = JSON.parse(text) as Ledger;
      const broken = Array.isArray(read?.records) ? verifyChain(read) : ['it has no records'];
      if (read.project && read.project !== projectPath) broken.unshift(`it is the ledger of ${read.project}`);
      if (broken.length) ledgerProblem = `${ledgerAt} doesn't verify: ${broken.join('; ')}`;
      else ledger = read;
    } catch (err) {
      ledgerProblem = `can't read ${ledgerAt}: ${(err as Error).message}`;
    }
  }
  if (ledgerProblem) console.error(`warning: ledger not used: ${ledgerProblem}`);

  // each push against the ledger first, then the guard's runs on its MR
  const used = new Set<number>();
  const usedLines = new Set<string>();
  const facts = new Map<string, Promise<GuardFacts>>();
  const guardFacts = (branch: string, since: number) => {
    if (!facts.has(branch)) facts.set(branch, readGuard(branch, since));
    return facts.get(branch)!;
  };
  async function readGuard(branch: string, since: number): Promise<GuardFacts> {
    const mrs = await rest<{ iid: number; state: string; created_at: string; merged_at: string | null; closed_at: string | null }[]>(
      `/:project/merge_requests?source_branch=${encodeURIComponent(branch)}&state=all&per_page=100`,
    );
    // a branch name can be used again: the newest MR is the one these pushes went to
    const mr = mrs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
    if (!mr) return { mr: null, runs: [] };
    const closedAt = mr.merged_at ?? mr.closed_at;
    const pipelines = await rest<{ id: number; sha: string; created_at: string }[]>(`/:project/merge_requests/${mr.iid}/pipelines?per_page=100`);
    const runs: GuardRun[] = [];
    for (const p of pipelines.filter((x) => Date.parse(x.created_at) >= since - 5 * 60_000)) {
      // a pipeline can have more jobs than a page holds
      let job: { id: number; name: string; status: string; started_at: string | null } | undefined;
      for (let page = 1; !job; page++) {
        const jobs = await rest<{ id: number; name: string; status: string; started_at: string | null }[]>(`/:project/pipelines/${p.id}/jobs?per_page=100&page=${page}`);
        job = jobs.find((j) => j.name === 'autonomy:goahead');
        if (jobs.length < 100) break;
      }
      if (!job) continue;
      // the guard's own line for each push it judged, so a failed run refuses only the pushes it names;
      // a log it can't read leaves the pushes unjudged (judge() says so), and is said here
      const id = job.id;
      const log = ['success', 'failed'].includes(job.status)
        ? await rest<string>(`/:project/jobs/${id}/trace`, true).catch((err: Error) => {
            console.error(`warning: pipeline ${p.id}: the log of autonomy:goahead (job ${id}) is not readable: ${err.message}`);
            return null;
          })
        : null;
      runs.push({ pipeline: p.id, sha: p.sha, status: job.status, at: p.created_at, started: job.started_at ?? null, lines: log === null ? null : guardLines(log) });
    }
    return { mr: { iid: mr.iid, state: mr.state, closedAt }, runs };
  }
  const pushes: PushCheck[] = [];
  const earliest = new Map<string, number>();
  for (const s of reports) for (const p of s.pushes) if (p.branch) earliest.set(p.branch, Math.min(earliest.get(p.branch) ?? Infinity, Date.parse(p.at ?? s.createdAt)));
  const all = reports.flatMap((s) => s.pushes.map((p) => ({ s, p })));
  const judged: PushCheck[] = [];
  for (const i of judgingOrder(all.map(({ p }) => p))) {
    const { s, p } = all[i];
    const record = ledger ? ledgerRecordFor(p, s, ledger.records, used) : undefined;
    if (record) used.add(record.seq);
    const guard = !record && p.landed && p.branch ? await guardFacts(p.branch, earliest.get(p.branch)!) : undefined;
    judged[i] = judge(p, s, { record, facts: guard, guardSince: ledger?.since.at ?? null, used: usedLines, now });
  }
  pushes.push(...judged);

  const audit: Audit = {
    project: projectPath,
    window: { from, to: now.toISOString() },
    ledger: ledger ? { url: ledgerAt!, records: ledger.records.length, head: ledger.head } : null,
    ledgerProblem,
    sessions: reports,
    pushes,
    unread,
  };
  const summary = summarize(audit);
  const text = renderAudit(audit, summary);
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ ...audit, summary }, null, 2) + '\n');
  if (mdOut) writeFileSync(mdOut, text);
  console.log(text);
  for (const b of summary.breaks) console.error(`rule broken: session ${b.session} (${b.flow}) pushed ${b.branch ?? '?'}${b.head ? ` to ${b.head}` : ''}: ${b.why}`);
  return exitCode(summary);
}

/**
 * fetch with a token, trying again after a rate limit, a server error or a
 * dropped connection (as agent-tokens.ts does: a large checkpoint draws a 503
 * now and then).
 */
async function retrying(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await tokenFetch(url, init);
      if ((res.status === 429 || res.status >= 500) && attempt < 4) throw new Error(`${res.status}`);
      return { status: res.status, text: await res.text() };
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, (attempt + 1) * 5_000));
    }
  }
}

/** Runs work(0..n-1), at most `width` at a time. */
async function pool(n: number, width: number, work: (i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, n) }, async () => {
      while (next < n) await work(next++);
    }),
  );
}
