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
 * since those MRs can still change.
 *
 *   node engine/src/cli/ledger.ts [out-dir]   (default: ledger)
 *
 * Writes <out-dir>/ledger.json and <out-dir>/index.html.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { GitLab, GitLabError, required } from '../gitlab.ts';
import { type PushEvent, branchPushes, isPerson, isProjectPerson, tierFrom } from '../goahead.ts';
import { allPages, checkMr, eventsSince, gitRepo, notesOf } from '../goahead-mr.ts';
import { type GuardRun, type Ledger, type LedgerRecord, type OpenPush, chain, compare, counters, flowOf, recordsFor, second } from '../ledger.ts';
import { renderLedgerPage } from '../ledger-page.ts';

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
  source_branch: string;
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

  // The chain starts where the guard reached the default branch: the merge
  // that added it (--first-parent: the merge, not the commit on the MR's
  // branch). Agent pushes before it weren't asked to wait for a go-ahead.
  const [commit, at] = git('log', '--first-parent', '--diff-filter=A', '--format=%H %cI', '--', GUARD).split('\n').pop()!.split(' ');
  if (!commit || !at) throw new Error(`no commit on this branch adds ${GUARD}, so there is no guard to rebuild a ledger from`);
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

  const records: Omit<LedgerRecord, 'seq' | 'prev'>[] = [];
  const open: OpenPush[] = [];
  const runs: GuardRun[] = [];
  const skipped: string[] = [];
  for (const mr of mrs.sort((a, b) => Date.parse(a.merged_at ?? a.created_at) - Date.parse(b.merged_at ?? b.created_at))) {
    const merged = mr.state === 'merged' && mr.merged_at;
    // what the guard saw: the pushes in its window (`after` leaves out the day
    // it names) and, for a merged MR, up to the merge (a branch name can be used again later)
    const window = windows.get(mr.iid) ?? from;
    const start = Date.parse(window) + 86_400_000;
    const seen = events.filter((e) => Date.parse(e.created_at) >= start && (!merged || Date.parse(e.created_at) <= Date.parse(mr.merged_at!)));
    // the policy the guard read: the target branch's when the MR was merged (the
    // commit before the merge), or now, for an MR still open
    const mergeSha = mr.merge_commit_sha ?? mr.squash_commit_sha;
    const policyRef = !merged ? env.LEDGER_POLICY_REF || 'HEAD' : mergeSha ? `${mergeSha}^1` : mr.diff_refs?.base_sha;
    let policy: string;
    try {
      policy = git('show', `${policyRef}:${env.AUTONOMY_CONFIG ?? '.autonomy.yml'}`);
    } catch {
      continue; // no policy then, so no guard either
    }
    const configPath = join(mkdtempSync(join(tmpdir(), 'ledger-')), '.autonomy.yml');
    writeFileSync(configPath, policy);
    const config = loadConfig(configPath);
    if (!config.goAhead.people.length) continue;
    // only MRs an agent pushed to once the guard was there
    if (!branchPushes(seen, mr.source_branch).some((p) => !isProjectPerson(p.pusher, config) && fromGuard(p.at))) continue;
    if (!mr.head_pipeline || !mr.diff_refs) {
      skipped.push(`!${mr.iid}: no pipeline`);
      continue;
    }
    const jobs = await allPages<Job>(gl, `/:project/pipelines/${mr.head_pipeline.id}/jobs`);
    const guardJob = jobs.find((j) => j.name === 'autonomy:goahead');
    if (!guardJob) {
      skipped.push(`!${mr.iid}: its last pipeline (${mr.head_pipeline.id}) ran no autonomy:goahead`);
      continue;
    }
    for (const r of await guardRuns(gl, web, mr.iid)) if (fromGuard(r.at)) runs.push(r);

    const assess = jobs.find((j) => j.name === 'autonomy:assess');
    let tierText: string | undefined;
    try {
      tierText = assess ? (await gl.get<{ tier?: string }>(`/:project/jobs/${assess.id}/artifacts/risk-report.json`)).tier : undefined;
    } catch (err) {
      if (!(err instanceof GitLabError) || err.status !== 404) throw err;
    }
    if (!tierText) {
      if (merged) throw new Error(`can't read the risk tier of !${mr.iid}: pipeline ${mr.head_pipeline.id} has no autonomy:assess risk-report.json (expired?)`);
      console.warn(`warning: !${mr.iid} has no risk tier yet; judged as high, as the guard does`);
    }
    const tier = tierFrom(tierText);
    const closes = await gl.get<{ iid: number; author: { username: string } }[]>(`/:project/merge_requests/${mr.iid}/closes_issues`);
    const commits = git('rev-list', `${mr.diff_refs.base_sha}..${mr.diff_refs.head_sha}`).split('\n').filter(Boolean);
    const check = await checkMr(
      {
        mr,
        notes: await notesOf(gl, 'mergeRequest', mr.iid),
        closes,
        events: seen,
        commits,
        since: window,
        tier,
      },
      config,
      repo,
      (issue) => notesOf(gl, 'issue', issue),
    );
    const guard = { pipeline: mr.head_pipeline.id, job: guardJob.id, status: guardJob.status };
    const mine = recordsFor(web, { iid: mr.iid, merged_at: mr.merged_at ?? mr.created_at, source_branch: mr.source_branch, closes: closes.map((i) => i.iid), guard }, check, config).filter((r) =>
      fromGuard(r.pushed_at),
    );
    if (merged) records.push(...mine);
    else
      open.push(
        ...mine.map((r) => ({
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

  const ledger = chain(projectPath, since, records);
  let published = await previousLedger();
  if (published && published.rules !== ledger.rules) {
    // a reviewed change to the rules re-judges history: a new chain, which names the old one
    console.log(`the published ledger was judged by rules ${published.rules} and this one by rules ${ledger.rules}: a new chain starts, replacing ${published.records.length} record(s) ending in ${published.head}`);
    ledger.replaces = { rules: published.rules, head: published.head, records: published.records.length };
    published = null;
  }
  const problems = published ? compare(published, ledger) : [];
  const stats = counters(ledger, open, runs);

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'ledger.json'), JSON.stringify(ledger, null, 2) + '\n');
  writeFileSync(join(out, 'index.html'), renderLedgerPage({ ledger, open, runs, counters: stats, web, generatedAt: second(new Date().toISOString()), commit: env.CI_COMMIT_SHA ?? git('rev-parse', 'HEAD') }));

  for (const r of ledger.records) {
    console.log(
      `${r.seq}. !${r.mr} push at ${r.pushed_at} by @${r.agent}: ${r.accepted ? `go-ahead in note ${r.go_ahead!.note} by @${r.go_ahead!.by}` : `refused: ${r.reasons.join('; ')}`} (risk ${r.tier}, asked by ${r.requesters.map((x) => `@${x}`).join(', ') || 'nobody on record'})`,
    );
  }
  for (const p of open) console.log(`open !${p.mr} push at ${p.pushed_at} by @${p.agent}: ${p.accepted ? `go-ahead in note ${p.go_ahead!.note} by @${p.go_ahead!.by}` : `refused: ${p.reasons.join('; ')}`}`);
  for (const s of skipped) console.log(`not in the ledger: ${s}`);
  console.log(
    `${stats.records} record(s), ${stats.accepted} let through, ${stats.refused} refused; ${stats.goAheads} go-ahead(s) (${Object.entries(stats.byWhom).map(([k, v]) => `@${k} ${v}`).join(', ') || 'none'}); approver is not the requester: ${stats.approverNotRequester.holds}/${stats.approverNotRequester.of}; autonomy:goahead failed ${stats.failedRuns} time(s) on agent MRs; head ${ledger.head}`,
  );
  if (!published) return;
  if (!problems.length) {
    console.log(`the published ledger (${published.records.length} record(s), head ${published.head.slice(0, 12)}) is the start of this one: nothing in it changed`);
    return;
  }
  for (const p of problems) console.error(p);
  console.error(`The published go-ahead ledger doesn't match what GitLab says now, so this job fails and Pages keeps the published one. A person has to find out why before anything is published.`);
  process.exit(1);
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
