#!/usr/bin/env node
/**
 * The release gate: does a candidate (npm `next`) judge anything worse than
 * the version users have (`latest`)? Compares the two corpus summaries.
 *
 *   node corpus/regressions.mjs BASELINE_SUMMARY CANDIDATE_SUMMARY
 *
 * Exits 1 on a regression (or an unreadable summary), 0 otherwise, and lists
 * what the candidate fixes too.
 */
import fs from 'node:fs';
import { regressions } from './lib.mjs';

const [baselineFile, candidateFile] = process.argv.slice(2);
if (!baselineFile || !candidateFile) {
  console.error(
    'usage: node corpus/regressions.mjs BASELINE_SUMMARY CANDIDATE_SUMMARY'
  );
  process.exit(2);
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
let baseline, candidate;
try {
  baseline = read(baselineFile);
  candidate = read(candidateFile);
} catch (err) {
  console.error(`can't read a summary: ${err.message}`);
  process.exit(1);
}

const { added, fixed } = regressions(baseline, candidate);
console.log(`baseline:  ${baseline.polyman}`);
console.log(`candidate: ${candidate.polyman}`);
for (const f of fixed) console.log(`fixed       ${f.problem}: ${f.message}`);
for (const a of added) console.log(`REGRESSION  ${a.problem}: ${a.message}`);
if (added.length) {
  console.error(
    `${added.length} regression(s): the candidate judges worse than the baseline, so it must not become latest`
  );
  process.exit(1);
}
console.log(`no regression (${fixed.length} fixed)`);
