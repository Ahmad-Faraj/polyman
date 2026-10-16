#!/usr/bin/env node
/**
 * Turns Stryker's JSON report into a GitLab metrics report, so the merge
 * request widget shows how the mutation score of polyman's verdict code moves.
 *
 * Usage: node corpus/mutation-metrics.mjs [mutation.json] [metrics.txt]
 */

import fs from 'node:fs';

const [input = 'corpus/out/mutation/mutation.json', output = 'metrics.txt'] =
  process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(input, 'utf8'));

const lines = [];
let detected = 0;
let valid = 0;
for (const [file, { mutants }] of Object.entries(report.files)) {
  const count = status => mutants.filter(m => m.status === status).length;
  const caught = count('Killed') + count('Timeout');
  const total = caught + count('Survived') + count('NoCoverage');
  detected += caught;
  valid += total;
  const name = file.replace(/^src\//, '').replace(/[^a-zA-Z0-9]+/g, '_');
  lines.push(`mutants_${name} ${total}`);
  lines.push(`mutants_survived_${name} ${count('Survived')}`);
  lines.push(`mutants_untested_${name} ${count('NoCoverage')}`);
}
const score = valid ? Math.round((1000 * detected) / valid) / 10 : 0;
lines.unshift(`mutation_score ${score}`);
fs.writeFileSync(output, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
