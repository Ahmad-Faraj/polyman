#!/usr/bin/env node
// Drift verdict and GitLab report for a plan (`tofu show -json plan.bin`).
//
// Writes the summary GitLab's OpenTofu merge request widget reads
// (artifacts:reports:terraform): {"create": n, "update": n, "delete": n},
// counted as GitLab's documented jq filter counts them (a replace is one
// delete and one create).
//
// Drift is any resource the plan would create, update or delete. Adopting an
// existing resource is not drift: imports.tf adopts everything, so while the
// GitLab state is still empty every resource plans as an import with no
// change ("21 to import, 0 to add, 0 to change, 0 to destroy"), and
// `tofu plan -detailed-exitcode` still exits 2 for it. Outputs are ignored.
//
// usage: node plan-summary.mjs plan.json [summary.json]
//        exit 0 no drift, 1 drift, 2 bad input. No dependencies; Node 18+.

import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function summarize(plan) {
  const changes = plan?.resource_changes ?? [];
  const actions = changes.flatMap(r => r.change?.actions ?? []);
  const count = a => actions.filter(x => x === a).length;
  const report = {
    create: count('create'),
    update: count('update'),
    delete: count('delete'),
  };
  const imports = changes.filter(r => r.change?.importing).length;
  const drifted = changes
    .filter(r =>
      (r.change?.actions ?? []).some(a =>
        ['create', 'update', 'delete'].includes(a)
      )
    )
    .map(r => `${r.change.actions.join('+')} ${r.address}`);
  return { report, imports, drifted };
}

function main(argv) {
  const [file, out] = argv.slice(2);
  if (!file) {
    console.error('usage: node plan-summary.mjs plan.json [summary.json]');
    return 2;
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`cannot read ${file}: ${e.message}`);
    return 2;
  }
  const { report, imports, drifted } = summarize(plan);
  if (out) writeFileSync(out, JSON.stringify(report) + '\n');
  console.log(
    `plan: ${imports} to import, ${report.create} to add, ${report.update} to change, ${report.delete} to destroy`
  );
  if (drifted.length === 0) {
    console.log(
      'no drift: Google Cloud matches infra/ (imports only adopt what exists)'
    );
    return 0;
  }
  console.log(
    `DRIFT: Google Cloud and infra/ differ in ${drifted.length} resource(s). Either someone changed the project by hand (put it back, or write the change into infra/ in a merge request), or infra/ changed without the project following:`
  );
  for (const d of drifted) console.log(`  ${d}`);
  return 1;
}

const isMain = () => {
  try {
    return (
      realpathSync(process.argv[1]) ===
      realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
};
if (isMain()) process.exitCode = main(process.argv);
