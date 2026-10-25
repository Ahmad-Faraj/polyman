#!/usr/bin/env node
/**
 * Turns Stryker's JSON report into a Markdown summary: the mutation score of
 * polyman's verdict code, the counts per file and the mutants no unit test
 * catches. The mutation workflow appends it to the run's summary
 * ($GITHUB_STEP_SUMMARY), so a pull request shows how the score moves.
 *
 * Usage: node corpus/mutation-metrics.mjs [mutation.json] [summary.md]
 */

import fs from 'node:fs';
import path from 'node:path';
import { isInside } from './lib.mjs';

const [input = 'corpus/out/mutation/mutation.json', output = 'summary.md'] =
  process.argv.slice(2);

// The real path of `file`, symlinks followed. The output may not exist yet,
// so the nearest entry that does exist is resolved and the rest appended. A
// dangling symlink is followed to where it points, so the check sees the file
// that would really be written. A symlink loop throws (ELOOP).
const lexists = p => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const realPath = (file, hops = 0) => {
  if (hops > 40)
    throw Object.assign(new Error('too many symlinks'), { code: 'ELOOP' });
  const missing = [];
  let at = file;
  while (!lexists(at)) {
    missing.unshift(path.basename(at));
    at = path.dirname(at);
  }
  try {
    return path.join(fs.realpathSync(at), ...missing);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // `at` is a dangling symlink: its target is read from the folder it is in
    const target = path.resolve(
      fs.realpathSync(path.dirname(at)),
      fs.readlinkSync(at)
    );
    return realPath(path.join(target, ...missing), hops + 1);
  }
};

// Both paths must stay inside the working directory, also through a symlink
// that points outside it.
const basePath = fs.realpathSync(process.cwd());
const inside = file => {
  let resolved;
  try {
    resolved = realPath(path.resolve(basePath, file));
  } catch (error) {
    console.error(`cannot resolve ${file}: ${error.code ?? error.message}`);
    process.exit(1);
  }
  if (!isInside(basePath, resolved)) {
    console.error(`path outside the working directory: ${file}`);
    process.exit(1);
  }
  return resolved;
};
const inputPath = inside(input);
const outputPath = inside(output);

const report = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

/** The most survivors listed; the run's summary has a size limit. */
const MAX_LISTED = 200;

const rows = [];
const missed = [];
let detected = 0;
let valid = 0;
for (const [file, { mutants }] of Object.entries(report.files)) {
  const count = status => mutants.filter(m => m.status === status).length;
  const caught = count('Killed') + count('Timeout');
  const total = caught + count('Survived') + count('NoCoverage');
  detected += caught;
  valid += total;
  rows.push(
    `| \`${file}\` | ${total} | ${caught} | ${count('Survived')} | ${count('NoCoverage')} |`
  );
  for (const m of mutants)
    if (m.status === 'Survived' || m.status === 'NoCoverage')
      missed.push({ file, ...m });
}
const score = valid ? Math.round((1000 * detected) / valid) / 10 : 0;

// Markdown code spans can't hold a backtick or a line break
const code = value =>
  `\`${String(value ?? '')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')}\``;
const where = m =>
  m.location?.start
    ? `${m.file}:${m.location.start.line}:${m.location.start.column}`
    : m.file;

const lines = [
  `## Mutation score: ${score}%`,
  '',
  `${detected} of ${valid} mutants caught by the unit tests (Killed or Timeout).`,
  '',
  '| File | Mutants | Caught | Survived | No coverage |',
  '| --- | ---: | ---: | ---: | ---: |',
  ...rows,
];
if (missed.length) {
  lines.push('', `### Not caught (${missed.length})`, '');
  for (const m of missed.slice(0, MAX_LISTED))
    lines.push(
      `- ${m.status} #${m.id ?? '?'} ${code(where(m))} ${m.mutatorName ?? 'mutant'}: ${m.replacement ? code(m.replacement) : '(no replacement)'}`
    );
  if (missed.length > MAX_LISTED)
    lines.push(
      `- and ${missed.length - MAX_LISTED} more: see the mutation report artifact`
    );
}
fs.writeFileSync(outputPath, `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
