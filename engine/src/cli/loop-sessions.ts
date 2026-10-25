/**
 * Writes sustainability/loop-sessions.json, the agent session counts the
 * ledger's loops turn into grams (autonomy:ledger, loops.ts). Each session's
 * model calls come from its checkpoint (GraphQL duoWorkflowEvents), which
 * needs a person's token: CI's job token can't read it, so the counts are
 * made outside CI and committed, with the time they are counted up to.
 *
 *   node engine/src/cli/loop-sessions.ts <sessions.json> [out]
 *
 * <sessions.json> is the usage counter's output: one row per duo_workflow
 * pipeline with workflow_id, pipeline_id, created_at, flow, mr, issue,
 * duration_s, usage_available and total.calls.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { type CountedSession, sessionsFrom } from '../loops.ts';

const [input, out = 'sustainability/loop-sessions.json'] = process.argv.slice(2);
if (!input) throw new Error('usage: node engine/src/cli/loop-sessions.ts <sessions.json> [out]');
const rows = JSON.parse(readFileSync(input, 'utf8')) as CountedSession[];
const file = sessionsFrom(
  rows,
  'every duo_workflow pipeline of the project: runner seconds from the job, model calls counted from the session checkpoint (GraphQL duoWorkflowEvents, read with a person token)',
);
// one session per line: the file stays readable and its diffs show which sessions came in
const lines = file.sessions.map((x) => `    ${JSON.stringify(x)}`).join(',\n');
writeFileSync(out, `{\n  "counted_up_to": ${JSON.stringify(file.counted_up_to)},\n  "source": ${JSON.stringify(file.source)},\n  "sessions": [\n${lines}\n  ]\n}\n`);
const uncounted = file.sessions.filter((s) => s.calls === null).length;
console.log(`${file.sessions.length} session(s), ${uncounted} without a checkpoint count, counted up to ${file.counted_up_to}: ${out}`);
