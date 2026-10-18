#!/usr/bin/env node
/**
 * Turns Stryker's JSON report into a GitLab metrics report, so the merge
 * request widget shows how the mutation score of polyman's verdict code moves.
 *
 * Usage: node corpus/mutation-metrics.mjs [mutation.json] [metrics.txt]
 */

import fs from 'node:fs';
import path from 'node:path';

const [input = 'corpus/out/mutation/mutation.json', output = 'metrics.txt'] =
  process.argv.slice(2);

// Both paths must stay inside the working directory: `path.relative` catches
// `..` and sibling folders such as `/repo-other`, which `startsWith` lets through.
const basePath = process.cwd();
const inside = file => {
  const resolved = path.resolve(basePath, file);
  const rel = path.relative(basePath, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    console.error(`path outside the working directory: ${file}`);
    process.exit(1);
  }
  return resolved;
};
const inputPath = inside(input);
const outputPath = inside(output);

const report = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

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
fs.writeFileSync(outputPath, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
