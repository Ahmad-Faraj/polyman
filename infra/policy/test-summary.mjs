#!/usr/bin/env node
// The drift verdict of plan-summary.mjs, case by case: exit 0 no drift,
// 1 drift, 2 when the input isn't a plan or the summary can't be written.
//
// usage: node test-summary.mjs   (exit 0 when all hold, 1 otherwise)

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
  writeFileSync(file, JSON.stringify(plan));
  const got = quiet(() =>
    main(['node', 'plan-summary.mjs', file, join(dir, 'summary.json')])
  );
  const pass = got === want;
  ok &&= pass;
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}: exit ${got}${pass ? '' : `, want ${want}`}`
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
