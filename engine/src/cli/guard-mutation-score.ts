/**
 * Prints the go-ahead rules' mutation score as GitLab metrics lines, and fails
 * when the run judged nothing or the score is under the floor.
 *
 *   node engine/src/cli/guard-mutation-score.ts out/guard-mutation/mutation.json [--floor 85]
 */
import { readFileSync } from 'node:fs';
import { scoreOf } from '../mutation.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--floor');
const floor = at >= 0 ? Number(args.splice(at, 2)[1]) : 0;
if (!Number.isFinite(floor)) throw new Error('--floor takes a percentage, like 85');
const s = scoreOf(JSON.parse(readFileSync(args[0] ?? 'out/guard-mutation/mutation.json', 'utf8')));
console.log(`guard_mutation_score ${s.score}`);
console.log(`guard_mutation_timeouts ${s.timeouts}`);
console.error(`${s.caught} of ${s.judged} planted bugs caught (${s.timeouts} by timing out)`);
if (s.score < floor) {
  console.error(`under the floor of ${floor}%: a change made the go-ahead rules' tests weaker`);
  process.exit(1);
}
