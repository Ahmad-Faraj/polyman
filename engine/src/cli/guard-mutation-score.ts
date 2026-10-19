/**
 * Prints the go-ahead rules' mutation score as GitLab metrics lines, and fails
 * when the run judged nothing or the score is under the floor.
 *
 *   node engine/src/cli/guard-mutation-score.ts out/guard-mutation/mutation.json --floor 85
 *
 * The floor is required (a number from 0 to 100, as `--floor 85` or
 * `--floor=85`), so a missing or empty value can't switch the gate off.
 */
import { readFileSync } from 'node:fs';
import { scoreOf } from '../mutation.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

let file: string | undefined;
let floorText: string | undefined;
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--floor') floorText = args[++i] ?? '';
  else if (a.startsWith('--floor=')) floorText = a.slice('--floor='.length);
  else if (a.startsWith('--')) fail(`unknown option ${a}`);
  else if (file) fail(`one report only, got ${file} and ${a}`);
  else file = a;
}
if (!file) fail('usage: guard-mutation-score.ts REPORT.json --floor PERCENT');
if (floorText === undefined || !/^\d{1,3}(\.\d+)?$/.test(floorText.trim()) || Number(floorText) > 100) {
  fail(`--floor takes a percentage from 0 to 100, like 85 (got ${floorText === undefined ? 'nothing' : JSON.stringify(floorText)})`);
}
const floor = Number(floorText);

let report: unknown;
try {
  report = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  fail(`can't read the Stryker report ${file}: ${(err as Error).message}`);
}
let s: ReturnType<typeof scoreOf>;
try {
  s = scoreOf(report);
} catch (err) {
  fail((err as Error).message);
}
console.log(`guard_mutation_score ${s.score}`);
console.log(`guard_mutation_timeouts ${s.timeouts}`);
console.error(`${s.caught} of ${s.judged} planted bugs caught (${s.timeouts} by timing out)`);
// compare the exact share, not the rounded score: 84.96% is under a floor of 85
if ((100 * s.caught) / s.judged < floor) {
  console.error(`under the floor of ${floor}%: a change made the go-ahead rules' tests weaker`);
  process.exit(1);
}
