/**
 * Writes the Impact Framework manifest of the agents' reviews from counted model
 * calls: the sessions agent-tokens.ts saved with --json, and the coefficients in
 * .autonomy.yml. It reads no API, so anyone can rebuild the committed manifest
 * from the committed data, then recompute it with if-run. This is the generator
 * of sustainability/agent-reviews.yml; agent-footprint.ts --manifest writes the
 * older, log-bounded kind.
 *
 *   node engine/src/cli/review-manifest.ts [sustainability/agent-tokens.json] [sustainability/agent-reviews.yml]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { type CountedSession, countedRuns, ifManifest } from '../manifest.ts';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const [input = 'sustainability/agent-tokens.json', output = 'sustainability/agent-reviews.yml'] = process.argv.slice(2);
let sessions: CountedSession[];
try {
  sessions = (JSON.parse(readFileSync(input, 'utf8')) as { sessions: CountedSession[] }).sessions;
} catch (err) {
  fail(`can't read the sessions in ${input}: ${(err as Error).message}`);
}
if (!Array.isArray(sessions)) fail(`${input} has no "sessions" list (write it with agent-tokens.ts --json)`);
const bad = sessions.filter((s) => s?.flow === 'mr-reviewer' && !(Number.isFinite(s.seconds) && s.seconds >= 0 && Number.isFinite(s.total?.calls) && s.total.calls >= 0));
if (bad.length) fail(`${bad.length} reviewer session(s) in ${input} have no valid seconds or call count, e.g. pipeline ${JSON.stringify((bad[0] as { pipeline?: unknown }).pipeline)}`);
const runs = countedRuns(sessions);
writeFileSync(output, ifManifest(runs, loadConfig().sustainability, 'counted'));
const kept = [...runs.values()].reduce((n, r) => n + r.length, 0);
const reviewer = sessions.filter((s) => s.flow === 'mr-reviewer').length;
console.error(`wrote ${output}: ${[...runs].map(([tier, r]) => `${r.length} ${tier}`).join(', ')} reviews; left out ${reviewer - kept} reviewer sessions that stopped early or have no known tier`);
console.error(`recompute it with npx -y -p @grnsft/if@1.1.1 if-run -m ${output}`);
