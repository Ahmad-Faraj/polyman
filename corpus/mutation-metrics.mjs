#!/usr/bin/env node
/**
 * Turns Stryker's JSON report into a GitLab metrics report, so the merge
 * request widget shows how the mutation score of polyman's verdict code moves.
 *
 * Usage: node corpus/mutation-metrics.mjs [mutation.json] [metrics.txt]
 */

import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './lib.mjs';

const [input = 'corpus/out/mutation/mutation.json', output = 'metrics.txt'] =
  process.argv.slice(2);

// The real path of `file`, symlinks followed. The output may not exist yet,
// so the nearest entry that does exist is resolved and the rest appended. A
// dangling symlink exists (lstat) but has no real path: null.
const lexists = p => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const realPath = file => {
  const missing = [];
  let at = file;
  while (!lexists(at)) {
    missing.unshift(path.basename(at));
    at = path.dirname(at);
  }
  try {
    return path.join(fs.realpathSync(at), ...missing);
  } catch {
    return null;
  }
};

// Both paths must stay inside the working directory, also through a symlink
// that points outside it.
const basePath = fs.realpathSync(process.cwd());
const inside = file => {
  const resolved = realPath(path.resolve(basePath, file));
  if (!resolved || !isInside(basePath, resolved)) {
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
