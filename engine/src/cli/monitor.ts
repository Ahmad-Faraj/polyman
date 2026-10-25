/**
 * After a release: checks the watch list from the agents' review against what
 * production actually did and writes health-report.json (the release notes
 * quote it).
 * Exits non-zero when a signal is over its limit, which fails the release
 * pipeline and hands it to the incident responder.
 *
 *   node engine/src/cli/monitor.ts traffic.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { GitLab, required } from '../gitlab.ts';
import { isReviewNote } from '../review.ts';
import { describe, evaluate, parseWatchPlan, type RouteStats } from '../watch.ts';

const env = process.env;
const gl = new GitLab();
const iid = required(env, 'RELEASE_MR_IID');
const traffic = JSON.parse(readFileSync(process.argv[2] ?? 'traffic.json', 'utf8')) as { routes: Record<string, RouteStats> };

// Rollback should depend on production, not on whether we could read a
// comment: if the review can't be read, run the default checks and say so.
let plan: ReturnType<typeof parseWatchPlan> = [];
let planSource: 'review' | 'none' | 'unreadable' = 'none';
try {
  const notes = await gl.get<{ body: string; author: { username: string } }[]>(
    `/:project/merge_requests/${iid}/notes?per_page=100&sort=desc`,
  );
  const review = notes.find(isReviewNote);
  if (review) {
    plan = parseWatchPlan(review.body);
    planSource = 'review';
  }
} catch (err) {
  planSource = 'unreadable';
  console.warn(`warning: couldn't read the review on !${iid} (${(err as Error).message}); using the default checks only`);
}
// No routes at all means the traffic run measured nothing, which is not the
// same as one watched route going unexercised: fail rather than pass blind.
if (!Object.keys(traffic.routes ?? {}).length) {
  console.error('traffic.json has no routes: nothing was measured, so this release is not confirmed');
  process.exit(1);
}
const results = evaluate(plan, traffic.routes);
const failed = results.filter((r) => !r.ok);

writeFileSync('health-report.json', JSON.stringify({ mr: Number(iid), planSource, plan, results, routes: traffic.routes }, null, 2));

for (const r of results) console.log(`${r.unconfirmed ? '??  ' : r.ok ? 'ok  ' : 'FAIL'} ${describe(r)}`);
if (failed.length) process.exit(1);
