#!/usr/bin/env node
// The drift verdict of plan-summary.mjs, case by case: exit 0 no drift,
// 1 drift, 2 when the input isn't a plan or the summary can't be written;
// and the summary the merge request widget reads, count by count.
//
// usage: node test-summary.mjs   (exit 0 when all hold, 1 otherwise)

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './plan-summary.mjs';

const dir = mkdtempSync(join(tmpdir(), 'plan-summary-'));
const rc = (actions, extra = {}) => ({
  address: `x.${actions.join('_')}`,
  change: { actions, ...extra },
});
const cases = [
  [
    'imports with no change',
    { resource_changes: [rc(['no-op'], { importing: { id: 'a' } })] },
    0,
  ],
  ['unchanged resources', { resource_changes: [rc(['no-op'])] }, 0],
  ['an update', { resource_changes: [rc(['update'])] }, 1],
  ['a create', { resource_changes: [rc(['create'])] }, 1],
  ['a replace', { resource_changes: [rc(['delete', 'create'])] }, 1],
  ['a delete', { resource_changes: [rc(['delete'])] }, 1],
  ['an empty object', {}, 2],
  ['null', null, 2],
  ['an array', [], 2],
  ['no resources planned', { resource_changes: [] }, 2],
  ['a null entry', { resource_changes: [null] }, 2],
  ['an empty entry', { resource_changes: [{}] }, 2],
  ['an entry with no actions', { resource_changes: [rc([])] }, 2],
  [
    'actions that are not a list',
    { resource_changes: [{ address: 'x.y', change: { actions: 'create' } }] },
    2,
  ],
];

// what the widget reads for each plan: a replace is one delete and one create
const summaries = [
  ['imports with no change', { create: 0, update: 0, delete: 0 }],
  ['an update', { create: 0, update: 1, delete: 0 }],
  ['a create', { create: 1, update: 0, delete: 0 }],
  ['a replace', { create: 1, update: 0, delete: 1 }],
  ['a delete', { create: 0, update: 0, delete: 1 }],
];

let ok = true;
const quiet = fn => {
  const [log, err] = [console.log, console.error];
  console.log = console.error = () => {};
  try {
    return fn();
  } finally {
    [console.log, console.error] = [log, err];
  }
};
for (const [name, plan, want] of cases) {
  const file = join(dir, 'plan.json');
  const out = join(dir, 'summary.json');
  rmSync(out, { force: true });
  writeFileSync(file, JSON.stringify(plan));
  const got = quiet(() => main(['node', 'plan-summary.mjs', file, out]));
  const pass = got === want;
  ok &&= pass;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}: exit ${got}${pass ? '' : `, want ${want}`}`
  );
  const expected = summaries.find(([n]) => n === name)?.[1];
  if (!expected) continue;
  let written;
  try {
    written = JSON.parse(readFileSync(out, 'utf8'));
  } catch {
    written = null;
  }
  const same = JSON.stringify(written) === JSON.stringify(expected);
  ok &&= same;
  console.log(
    `${same ? 'PASS' : 'FAIL'}  ${name}: summary ${JSON.stringify(written)}${same ? '' : `, want ${JSON.stringify(expected)}`}`
  );
}
// a summary that can't be written is an error (2), not drift (1)
const file = join(dir, 'plan.json');
writeFileSync(file, JSON.stringify({ resource_changes: [rc(['no-op'])] }));
const got = quiet(() =>
  main([
    'node',
    'plan-summary.mjs',
    file,
    join(dir, 'no-such-dir', 'summary.json'),
  ])
);
ok &&= got === 2;
console.log(
  `${got === 2 ? 'PASS' : 'FAIL'}  an unwritable summary: exit ${got}`
);

rmSync(dir, { recursive: true, force: true });
console.log(ok ? 'drift verdict: all cases hold' : 'drift verdict test FAILED');
process.exitCode = ok ? 0 : 1;
