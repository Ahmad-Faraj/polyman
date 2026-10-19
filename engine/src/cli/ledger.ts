/**
 * The go-ahead ledger (#46, wiki: Assisted): rebuilds, from the GitLab API,
 * one record per agent push the go-ahead guard judged on a merged MR, chains
 * them by SHA-256, and fails if the ledger published on Pages isn't the start
 * of the rebuilt one. A record that changed after it was published (a
 * go-ahead edited or deleted, a proposal edited, a push rewritten) fails the
 * job, and the Pages job, which needs this one, keeps the last good ledger up.
 *
 * Each MR is judged by the guard's own check (goahead-mr.ts) with what the
 * guard had: the policy of the target branch when the MR was merged, the tier
 * the MR's last pipeline's autonomy:assess computed, the MR's commits, its
 * notes, the notes of the issue it closes and the project's push events.
 * Agent pushes on MRs that aren't merged yet are listed but not chained,
 * since those MRs can still change. The exception is a closed MR whose
 * accepted pushes reached the default branch through another MR (a person
 * moved them there after the guard refused a later push): those are chained
 * with the merge that brought them (carriedRecords).
 *
 *   node engine/src/cli/ledger.ts [out-dir]   (default: ledger)
 *
 * Writes <out-dir>/ledger.json and <out-dir>/index.html.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { GitLab, GitLabError, required } from '../gitlab.ts';
import { type Note, type PushEvent, branchPushes, isPerson, isProjectPerson, tierFrom } from '../goahead.ts';
import { allPages, checkMr, eventsSince, gitRepo, notesOf as fetchNotes, relatedIncident } from '../goahead-mr.ts';
import { type Carrier, type GuardRun, type Ledger, type LedgerRecord, type OpenPush, byMerge, carriedRecords, chain, compare, counters, flowOf, recordsFor, second, verifyChain } from '../ledger.ts';
import { renderLedgerPage } from '../ledger-page.ts';
import type { SciCoefficients } from '../sci.ts';
import { type SessionFile, loopGrams, loopsOf, previousPush, refusedGoAheads, summarize, summaryLine } from '../loops.ts';

const env = process.env;
const GUARD = 'engine/src/cli/goahead.ts';

try {
  await main();
} catch (err) {
  console.error(`autonomy:ledger could not finish, so it fails: ${(err as Error).message}`);
  process.exit(1);
}

interface Mr {
  iid: number;
  state: string;
  author: { username: string };
  created_at: string;
  merged_at: string | null;
  merged_by?: { username: string } | null;
  closed_at: string | null;
  source_branch: string;
  description?: string | null;
  sha: string;
  merge_commit_sha: string | null;
  squash_commit_sha: string | null;
  diff_refs: { base_sha: string; head_sha: string } | null;
  head_pipeline: { id: number } | null;
}

interface Job {
  id: number;
  name: string;
  status: string;
}

async function main() {
  const out = process.argv[2] ?? 'ledger';
  const gl = new GitLab();
  const projectPath = required(env, 'CI_PROJECT_PATH');
  const web = env.CI_PROJECT_URL || (await gl.get<{ web_url: string }>('/:project')).web_url;
  const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const repo = gitRepo();
  // each thread's notes, read once: the guard's check and the loops below both read them
  const noteCache = new Map<string, Promise<Note[]>>();
  const notesOf = (client: GitLab, kind: 'issue' | 'mergeRequest', iid: number) => {
    const key = `${kind}:${iid}`;
    if (!noteCache.has(key)) noteCache.set(key, fetchNotes(client, kind, iid));
    return noteCache.get(key)!;
  };

  // The chain starts where the guard reached the default branch: the merge
  // that added it (--first-parent: the merge, not the commit on the MR's
  // branch). Agent pushes before it weren't asked to wait for a go-ahead.
  // Read on the default branch, not HEAD: an MR branch that merged the default
  // branch in would put the start at that later merge.
  const chainRef = defaultBranchRef(git);
  const [commit, at] = git('log', '--first-parent', '--diff-filter=A', '--format=%H %cI', chainRef, '--', GUARD).split('\n').pop()!.split(' ');
  if (!commit || !at) throw new Error(`no commit on ${chainRef} adds ${GUARD}, so there is no guard to rebuild a ledger from`);
  const since = { commit, at: second(at) };
  const fromGuard = (iso: string) => Date.parse(iso) >= Date.parse(since.at);
  const listed = await allPages<{ iid: number; source_branch: string }>(gl, `/:project/merge_requests?state=all&updated_after=${encodeURIComponent(since.at)}&order_by=created_at&sort=asc`);

  // The push events, read once: first from two days before the guard (every
  // push the ledger records is after it), to find the MRs an agent pushed to.
  // Who counts as a person is each MR's own policy, below; here anyone off
  // today's list, or named like an agent, is enough to look closer.
  const today = loadConfig(env.AUTONOMY_CONFIG ?? '.autonomy.yml');
  const maybeAgent = (username: string) => !isProjectPerson(username, today) || !isPerson(username);
  const pushedSince = async (day: string) => allPages<PushEvent>(gl, `/:project/events?action=pushed&after=${day}&sort=asc`, 100);
  let from = new Date(Date.parse(since.at) - 2 * 86_400_000).toISOString().slice(0, 10);
  let events = await pushedSince(from);
  const agentBranches = new Set(events.filter((e) => fromGuard(e.created_at) && maybeAgent(e.author.username)).map((e) => e.push_data?.ref));
  const mrs: Mr[] = [];
  for (const { iid } of listed.filter((m) => agentBranches.has(m.source_branch))) mrs.push(await gl.get<Mr>(`/:project/merge_requests/${iid}`));
  // then from as far back as the guard reads for any of those MRs
  const windows = new Map<number, string>();
  for (const mr of mrs) {
    if (!mr.diff_refs || !repo.has(mr.diff_refs.base_sha)) continue;
    windows.set(mr.iid, eventsSince(mr.created_at, Number(git('show', '-s', '--format=%ct', mr.diff_refs.base_sha)) * 1000));
  }
  const earliest = [...windows.values()].sort()[0];
  if (earliest && earliest < from) events = await pushedSince((from = earliest));

  // the published ledger, read before judging: a merged MR's risk-report.json
  // expires, and its record there keeps the tier the guard used
  let published = await previousLedger();
  if (published) {
    // its tiers are trusted below, so it must verify first: after a rules bump
    // nothing compares it with the rebuilt ledger
    const broken = verifyChain(published);
    if (published.project !== projectPath) broken.unshift(`it is the ledger of ${published.project}, not of ${projectPath}`);
    if (broken.length) {
      for (const b of broken) console.error(`published ledger: ${b}`);
      console.error(`The published go-ahead ledger doesn't verify, so the tiers in it can't be trusted and this job fails. A person has to find out why before anything is published.`);
      process.exit(1);
    }
  }
  const publishedTier = new Map((published?.records ?? []).map((r) => [r.mr, r.tier]));

  // each record with the time it joins the chain (its merge, or for a carried push see below)
  const records: { record: Omit<LedgerRecord, 'seq' | 'prev'>; at: string }[] = [];
  const open: OpenPush[] = [];
  const runs: GuardRun[] = [];
  const skipped: string[] = [];
  for (const mr of mrs.sort((a, b) => Date.parse(a.merged_at ?? a.created_at) - Date.parse(b.merged_at ?? b.created_at))) {
    const merged = mr.state === 'merged' && mr.merged_at;
    const closed = mr.state === 'closed' && mr.closed_at;
    if (mr.state === 'closed' && !mr.closed_at) console.warn(`warning: !${mr.iid} is closed but GitLab gives no closed_at, so its pushes can't be matched to a merge on the default branch and stay in the open list`);
    // what the guard saw: the pushes in its window (`after` leaves out the day
    // it names) and, for a merged or closed MR, up to the merge or the close (a
    // branch name can be used again later, and a push after the close was never judged on this MR)
    const window = windows.get(mr.iid) ?? from;
    const start = Date.parse(window) + 86_400_000;
    const end = merged ? mr.merged_at : closed ? mr.closed_at : null;
    const seen = events.filter((e) => Date.parse(e.created_at) >= start && (!end || Date.parse(e.created_at) <= Date.parse(end)));
    // the policy the guard read: the target branch's when the MR was merged (the
    // commit before the merge); for a closed MR, whose pushes can still be
    // chained through the MR that carried them, the default branch's when it was
    // closed, so a later policy change can't re-judge a published record; now,
    // for an MR still open
    const mergeSha = mr.merge_commit_sha ?? mr.squash_commit_sha;
    const closedRef = closed ? git('rev-list', '-1', '--first-parent', `--before=${mr.closed_at}`, chainRef) : '';
    if (closed && !closedRef) {
      // today's policy would re-judge it, so it isn't judged at all
      skipped.push(`!${mr.iid}: closed at ${second(mr.closed_at!)}, before any commit on ${chainRef}, so the policy it was closed under can't be read`);
      continue;
    }
    const policyRef = merged ? (mergeSha ? `${mergeSha}^1` : mr.diff_refs?.base_sha) : closedRef || env.LEDGER_POLICY_REF || 'HEAD';
    let policy: string;
    try {
      policy = git('show', `${policyRef}:${env.AUTONOMY_CONFIG ?? '.autonomy.yml'}`);
    } catch {
      skipped.push(`!${mr.iid}: no ${env.AUTONOMY_CONFIG ?? '.autonomy.yml'} at ${policyRef}, so no guard either`);
      continue;
    }
    const configPath = join(mkdtempSync(join(tmpdir(), 'ledger-')), '.autonomy.yml');
    writeFileSync(configPath, policy);
    const config = loadConfig(configPath);
    if (!config.goAhead.people.length) {
      skipped.push(`!${mr.iid}: its policy names no go_ahead.people, so no guard either`);
      continue;
    }
    // only MRs an agent pushed to once the guard was there
    if (!branchPushes(seen, mr.source_branch).some((p) => !isProjectPerson(p.pusher, config) && fromGuard(p.at))) continue;
    if (!mr.diff_refs) {
      skipped.push(`!${mr.iid}: GitLab gives no diff refs, so its commits can't be read`);
      continue;
    }
    // no pipeline, or no guard job on it: still judged and recorded, refused (recordsFor)
    const jobs = mr.head_pipeline ? await allPages<Job>(gl, `/:project/pipelines/${mr.head_pipeline.id}/jobs`) : [];
    const guardJob = jobs.find((j) => j.name === 'autonomy:goahead');
    for (const r of await guardRuns(gl, web, mr.iid)) if (fromGuard(r.at)) runs.push(r);
    if (mr.state === 'opened' && !guardJob) {
      // still open: the guard may run yet, so it isn't refused, only not judged yet
      // (a closed MR without one is judged like a merged one: refused, and chained if its commits reached main)
      skipped.push(`!${mr.iid}: open, and autonomy:goahead hasn't run on ${mr.head_pipeline ? `pipeline ${mr.head_pipeline.id}` : 'it'} yet, so not judged yet`);
      continue;
    }

    const assess = jobs.find((j) => j.name === 'autonomy:assess');
    let tierText: string | undefined;
    try {
      tierText = assess ? (await gl.get<{ tier?: string }>(`/:project/jobs/${assess.id}/artifacts/risk-report.json`)).tier : undefined;
    } catch (err) {
      if (!(err instanceof GitLabError) || err.status !== 404) throw err;
    }
    // a closed MR's carried records are published too, so their tier survives the artifact the same way
    if (!tierText && (merged || closed)) tierText = publishedTier.get(mr.iid);
    if (!tierText) {
      if (merged && guardJob) throw new Error(`can't read the risk tier of !${mr.iid}: pipeline ${mr.head_pipeline?.id ?? 'none'} has no autonomy:assess risk-report.json (expired?), and no published record has it`);
      console.warn(`warning: !${mr.iid} has no risk tier${guardJob ? ' yet' : ''}; judged as high, as the guard does`);
    }
    const tier = tierFrom(tierText);
    const closes = await gl.get<{ iid: number; author: { username: string } }[]>(`/:project/merge_requests/${mr.iid}/closes_issues`);
    const commits = git('rev-list', `${mr.diff_refs.base_sha}..${mr.diff_refs.head_sha}`).split('\n').filter(Boolean);
    const check = await checkMr(
      {
        mr,
        notes: await notesOf(gl, 'mergeRequest', mr.iid),
        closes,
        related: closes.length ? [] : await relatedIncident(gl, mr.description),
        events: seen,
        commits,
        since: window,
        tier,
      },
      config,
      repo,
      (issue) => notesOf(gl, 'issue', issue),
    );
    const guard = { pipeline: mr.head_pipeline?.id ?? null, job: guardJob?.id ?? null, status: guardJob?.status ?? 'none' };
    const mine = recordsFor(web, { iid: mr.iid, merged_at: mr.merged_at ?? mr.created_at, source_branch: mr.source_branch, closes: closes.map((i) => i.iid), guard }, check, config).filter((r) =>
      fromGuard(r.pushed_at),
    );
    if (merged) {
      records.push(...mine.map((record) => ({ record, at: record.merged_at })));
      continue;
    }
    // a closed MR whose commits a person moved to an MR that merged: each push
    // whose head reached the default branch is chained, accepted or refused, so
    // a refused commit can't reach main unrecorded. It joins the chain when it
    // became chainable, the later of its carrier's merge and this MR's close, so
    // it lands after everything a run before that could have published.
    const carriers = new Map<string, Carrier | null>();
    if (closed && !env.CI_DEFAULT_BRANCH) console.warn(`warning: no CI_DEFAULT_BRANCH, so !${mr.iid}'s pushes can't be matched to a merge on it and stay in the open list`);
    else if (closed) for (const r of mine) if (repo.has(r.head) && repo.isAncestor(r.head, chainRef)) carriers.set(r.head, await carrierOf(gl, web, r.head, mr.iid));
    for (const record of carriedRecords(mine, (head) => carriers.get(head) ?? null)) {
      const at = Date.parse(record.merged_at) > Date.parse(mr.closed_at!) ? record.merged_at : second(mr.closed_at!);
      records.push({ record, at });
    }
    open.push(
      ...mine
        .filter((r) => !carriers.get(r.head))
        .map((r) => ({
          mr: r.mr,
          mr_url: r.mr_url,
          state: mr.state,
          agent: r.agent,
          flow: flowOf(r.agent),
          pushed_at: r.pushed_at,
          accepted: r.accepted,
          go_ahead: r.go_ahead,
          reasons: r.reasons,
        })),
    );
  }

  const ledger = chain(
    projectPath,
    since,
    byMerge(records, (r) => r.at).map((r) => r.record),
  );
  if (published && published.rules !== ledger.rules) {
    // a reviewed change to the rules re-judges history: a new chain, which names the old one
    console.log(`the published ledger was judged by rules ${published.rules} and this one by rules ${ledger.rules}: a new chain starts, replacing ${published.records.length} record(s) ending in ${published.head}`);
    ledger.replaces = { rules: published.rules, head: published.head, records: published.records.length };
    published = null;
  }
  const problems = published ? compare(published, ledger) : [];
  const stats = counters(ledger, open, runs);
  const page = (loops?: Parameters<typeof renderLedgerPage>[0]['loops']) =>
    renderLedgerPage({ ledger, open, runs, counters: stats, web, generatedAt: second(new Date().toISOString()), commit: env.CI_COMMIT_SHA ?? git('rev-parse', 'HEAD'), loops });

  // the chain first: the loop view below is only a view of it, so nothing in it may stop the chain being written and checked
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'ledger.json'), JSON.stringify(ledger, null, 2) + '\n');
  writeFileSync(join(out, 'index.html'), page());

  for (const r of ledger.records) {
    console.log(
      `${r.seq}. !${r.mr}${r.carried_by ? ` (merged in !${r.carried_by.mr})` : ''} push at ${r.pushed_at} by @${r.agent}: ${r.accepted ? `go-ahead in note ${r.go_ahead!.note} by @${r.go_ahead!.by}` : `refused: ${r.reasons.join('; ')}`} (risk ${r.tier}, asked by ${r.requesters.map((x) => `@${x}`).join(', ') || 'nobody on record'})`,
    );
  }
  for (const p of open) console.log(`open !${p.mr} push at ${p.pushed_at} by @${p.agent}: ${p.accepted ? `go-ahead in note ${p.go_ahead!.note} by @${p.go_ahead!.by}` : `refused: ${p.reasons.join('; ')}`}`);
  for (const s of skipped) console.log(`not in the ledger: ${s}`);
  console.log(
    `${stats.records} record(s), ${stats.accepted} let through, ${stats.refused} refused; ${stats.goAheads} go-ahead(s) (${Object.entries(stats.byWhom).map(([k, v]) => `@${k} ${v}`).join(', ') || 'none'}); approver is not the requester: ${stats.approverNotRequester.holds}/${stats.approverNotRequester.of}; autonomy:goahead failed ${stats.failedRuns} time(s) on agent MRs; head ${ledger.head}`,
  );
  if (published && problems.length) {
    for (const p of problems) console.error(p);
    console.error(`The published go-ahead ledger doesn't match what GitLab says now, so this job fails and Pages keeps the published one. A person has to find out why before anything is published.`);
    process.exit(1);
  }
  if (published) console.log(`the published ledger (${published.records.length} record(s), head ${published.head.slice(0, 12)}) is the start of this one: nothing in it changed`);

  try {
    await loopView(gl, web, ledger, open, mrs, notesOf, today.sustainability, out, page);
  } catch (err) {
    console.warn(`warning: the loop view could not be built, so the page is published without it: ${(err as Error).message}`);
  }
}

/**
 * One row per loop: the records grouped by the MR that merged them, with who
 * merged it (GitLab's merged_by), the go-aheads that didn't count, and the
 * grams of the loop's agent sessions from the committed session counts.
 * Rewrites the page with the loops and writes loops.json.
 */
async function loopView(
  gl: GitLab,
  web: string,
  ledger: Ledger,
  open: OpenPush[],
  mrs: Mr[],
  notesOf: (client: GitLab, kind: 'issue' | 'mergeRequest', iid: number) => Promise<Note[]>,
  sci: SciCoefficients,
  out: string,
  page: (loops: Parameters<typeof renderLedgerPage>[0]['loops']) => string,
) {
  const byIid = new Map(mrs.map((m) => [m.iid, m]));
  const mergedBy = new Map<number, string | null>();
  for (const iid of new Set(ledger.records.map((r) => r.carried_by?.mr ?? r.mr))) {
    let mr = byIid.get(iid);
    try {
      mr ??= await gl.get<Mr>(`/:project/merge_requests/${iid}`);
    } catch (err) {
      if (!(err instanceof GitLabError) || err.status !== 404) throw err;
      console.warn(`warning: GitLab gives no !${iid}, so its loop shows no merger`);
    }
    mergedBy.set(iid, mr?.merged_by?.username ?? null);
  }
  const refused = new Map<number, ReturnType<typeof refusedGoAheads>>();
  for (const r of ledger.records.filter((x) => x.accepted)) {
    refused.set(r.seq, refusedGoAheads(await notesOf(gl, r.thread.kind === 'issue' ? 'issue' : 'mergeRequest', r.thread.iid), r, previousPush(ledger.records, r)));
  }
  const loops = loopsOf(
    ledger,
    open,
    (iid) => mergedBy.get(iid) ?? null,
    (records) =>
      records.flatMap((r) =>
        (refused.get(r.seq) ?? []).map((n) => ({
          note: n.id,
          url: `${web}/-/${r.thread.kind === 'issue' ? 'issues' : 'merge_requests'}/${r.thread.iid}#note_${n.id}`,
          by: n.author.username,
          at: second(n.created_at),
        })),
      ),
  );
  const sessions = sessionFile(env.LOOP_SESSIONS ?? 'sustainability/loop-sessions.json');
  const grams = sessions ? loopGrams(loops, sessions, sci) : new Map();
  const summary = summarize(loops, sessions ? grams : undefined);
  const withGrams = loops.map((l) => ({ ...l, grams: grams.get(l.mr) ?? null }));
  writeFileSync(
    join(out, 'loops.json'),
    JSON.stringify({ summary, sessions_counted_up_to: sessions?.counted_up_to ?? null, grid_gco2e_per_kwh: sci.gridGramsPerKwh, loops: withGrams }, null, 2) + '\n',
  );
  writeFileSync(join(out, 'index.html'), page({ rows: withGrams, summary, sessions: sessions ? { countedUpTo: sessions.counted_up_to, source: sessions.source } : null, grid: sci.gridGramsPerKwh }));

  for (const l of loops) {
    const g = grams.get(l.mr);
    console.log(
      `loop !${l.mr}${l.moved_from.length ? ` (from ${l.moved_from.map((m) => `!${m}`).join(', ')})` : ''}${l.issues.length ? ` for ${l.issues.map((i) => `#${i}`).join(', ')}` : ''}: asked by ${l.requesters.map((x) => `@${x}`).join(', ') || 'nobody on record'}, go-ahead @${l.go_ahead.by}, merged by ${l.merged_by ? `@${l.merged_by}` : 'unknown'}, ${l.minutes} min, ${l.fix_rounds} fix round(s), ${l.refused_pushes.length} refused push(es), ${l.refused_go_aheads.length} go-ahead(s) that didn't count${g ? `, ${g.low.toFixed(1)}-${g.high.toFixed(1)} gCO2e over ${g.sessions} session(s)` : ''}`,
    );
  }
  console.log(summaryLine(summary) + (sessions ? ` (agent sessions counted up to ${sessions.counted_up_to})` : ''));
}

/** The committed agent session counts (loop-sessions.ts), or null when there are none: the loops are shown without grams. */
function sessionFile(path: string): SessionFile | null {
  if (!existsSync(path)) {
    console.warn(`warning: no ${path}, so the loops are shown without grams`);
    return null;
  }
  const file = JSON.parse(readFileSync(path, 'utf8')) as SessionFile;
  if (!Array.isArray(file?.sessions) || !file.counted_up_to) throw new Error(`${path} is not a session count (no sessions or no counted_up_to)`);
  return file;
}

/** The default branch as fetched (origin/<branch>), or HEAD where there is none (a run on the default branch itself). */
function defaultBranchRef(git: (...args: string[]) => string): string {
  const branch = env.CI_DEFAULT_BRANCH;
  if (!branch) {
    console.warn('warning: no CI_DEFAULT_BRANCH, so the chain start is read on HEAD');
    return 'HEAD';
  }
  try {
    git('rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`);
    return `origin/${branch}`;
  } catch {
    console.warn(`warning: origin/${branch} isn't fetched, so the chain start is read on HEAD (on another branch it may start too late)`);
    return 'HEAD';
  }
}

/** The ledger on Pages, or null if none was published yet (that run starts the chain). */
async function previousLedger(): Promise<Ledger | null> {
  const url = env.LEDGER_PREVIOUS_URL || (env.CI_PAGES_URL ? `${env.CI_PAGES_URL.replace(/\/+$/, '')}/ledger/ledger.json` : '');
  if (!url) {
    console.warn('warning: no CI_PAGES_URL or LEDGER_PREVIOUS_URL, so nothing to compare with');
    return null;
  }
  // the published file is public: no credentials go with this request
  const res = await fetch(url);
  if (res.status === 404) {
    console.log(`no ledger published at ${url} yet: this one starts the chain`);
    return null;
  }
  if (!res.ok) throw new Error(`can't read the published ledger at ${url}: ${res.status}`);
  const ledger = (await res.json()) as Ledger;
  if (!Array.isArray(ledger?.records)) throw new Error(`${url} is not a go-ahead ledger`);
  return ledger;
}

/** The first merged MR into the default branch, other than `iid`, whose commits include `sha`. */
async function carrierOf(gl: GitLab, web: string, sha: string, iid: number): Promise<Carrier | null> {
  const mrs = await allPages<{ iid: number; state: string; merged_at: string | null; target_branch: string }>(gl, `/:project/repository/commits/${sha}/merge_requests`);
  const merged = mrs
    .filter((m) => m.iid !== iid && m.state === 'merged' && m.merged_at && m.target_branch === env.CI_DEFAULT_BRANCH)
    .sort((a, b) => Date.parse(a.merged_at!) - Date.parse(b.merged_at!));
  return merged[0] ? { iid: merged[0].iid, mr_url: `${web}/-/merge_requests/${merged[0].iid}`, merged_at: merged[0].merged_at! } : null;
}

/** Every autonomy:goahead job on this MR's pipelines (the latest attempt of each). */
async function guardRuns(gl: GitLab, web: string, iid: number): Promise<GuardRun[]> {
  const pipelines = await allPages<{ id: number; sha: string; created_at: string }>(gl, `/:project/merge_requests/${iid}/pipelines`);
  const runs: GuardRun[] = [];
  for (const p of pipelines) {
    const job = (await allPages<Job>(gl, `/:project/pipelines/${p.id}/jobs`)).find((j) => j.name === 'autonomy:goahead');
    if (job) runs.push({ mr: iid, pipeline: p.id, url: `${web}/-/pipelines/${p.id}`, sha: p.sha, status: job.status, at: second(p.created_at) });
  }
  return runs.sort((a, b) => a.at.localeCompare(b.at));
}
