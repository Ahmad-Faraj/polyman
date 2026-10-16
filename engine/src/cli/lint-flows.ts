/**
 * Checks every Duo flow in .gitlab/duo/flows the way GitLab will when it's
 * saved in the AI catalog: as written, and with the @@markers@@ filled from
 * .autonomy.yml (flow IDs, and accounts not set yet, get a stand-in).
 *
 *   node engine/src/cli/lint-flows.ts [dir]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../config.ts';
import { checkFlow } from '../flows.ts';
import { HANDOFF_FLOWS, flowValues, renderFlow } from '../render.ts';

const dir = process.argv[2] ?? '.gitlab/duo/flows';
const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
// Stand-ins for what only exists once the flows are enabled (their accounts and
// IDs); `npm run doctor` and flows:sync check the real ones.
const config = loadConfig();
const values = flowValues(
  {
    ...config,
    agents: {
      ...config.agents,
      reviewerAccount: config.agents.reviewerAccount || 'REVIEWER_ACCOUNT',
      fixerAccount: config.agents.fixerAccount || 'FIXER_ACCOUNT',
    },
  },
  Object.fromEntries(HANDOFF_FLOWS.map((f) => [f, '1'])),
);
let failed = 0;

for (const file of files) {
  const source = readFileSync(join(dir, file), 'utf8');
  let problems = checkFlow(source);
  if (!problems.length) {
    try {
      problems = checkFlow(renderFlow(source, values)).map((p) => `once filled in: ${p}`);
    } catch (err) {
      problems = [(err as Error).message];
    }
  }
  if (problems.length) {
    failed++;
    console.error(`${file}:`);
    for (const p of problems) console.error(`  ${p}`);
  } else {
    console.log(`${file}: ok`);
  }
}

if (failed) process.exit(1);
