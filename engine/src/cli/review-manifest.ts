/**
 * Writes the Impact Framework manifest of the agents' reviews from counted model
 * calls: the sessions agent-tokens.ts saved with --json, and the coefficients in
 * .autonomy.yml. It reads no API, so anyone can rebuild the committed manifest
 * from the committed data, then recompute it with if-run.
 *
 *   node engine/src/cli/review-manifest.ts [sustainability/agent-tokens.json] [sustainability/agent-reviews.yml]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { loadConfig } from '../config.ts';
import { type CountedSession, countedRuns, ifManifest } from '../manifest.ts';

const [input = 'sustainability/agent-tokens.json', output = 'sustainability/agent-reviews.yml'] = process.argv.slice(2);
const { sessions } = JSON.parse(readFileSync(input, 'utf8')) as { sessions: CountedSession[] };
const runs = countedRuns(sessions);
writeFileSync(output, ifManifest(runs, loadConfig().sustainability, 'counted'));
console.error(`wrote ${output}: ${[...runs].map(([tier, r]) => `${r.length} ${tier}`).join(', ')} reviews; recompute it with npx -y -p @grnsft/if@1.1.1 if-run -m ${output}`);
