#!/usr/bin/env node
// Reads Stryker's JSON report of the go-ahead rules and prints a GitLab metrics
// line: the share of planted bugs the tests caught (killed or timed out), over
// all mutants Stryker could judge (killed, timed out, survived, not covered).
// Usage: node ci/guard-mutation-score.mjs out/guard-mutation/mutation.json
import { readFileSync } from 'node:fs';

const report = JSON.parse(readFileSync(process.argv[2] ?? 'out/guard-mutation/mutation.json', 'utf8'));
let caught = 0;
let judged = 0;
for (const [file, { mutants }] of Object.entries(report.files)) {
  const c = mutants.filter((m) => m.status === 'Killed' || m.status === 'Timeout').length;
  const j = mutants.filter((m) => ['Killed', 'Timeout', 'Survived', 'NoCoverage'].includes(m.status)).length;
  console.error(`${file}: ${c}/${j} caught`);
  caught += c;
  judged += j;
}
console.log(`guard_mutation_score ${judged ? ((100 * caught) / judged).toFixed(1) : 0}`);
