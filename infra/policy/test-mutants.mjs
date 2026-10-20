#!/usr/bin/env node
// Proves the policy judge has teeth: the base plan must PASS, and every
// mutant in ./mutants (the base plan with one unsafe change applied) must be
// REJECTED by the rule it names in "expect".
//
// The base plan is the synthetic fixture fixtures/plan.json by default: a
// hand-written plan with only the fields the judge reads and placeholder
// members, so no real plan output (which holds the live project IAM policy)
// is ever committed. A real `tofu show -json` output works too.
//
// usage: node test-mutants.mjs [plan.json]   (exit 0 when all hold, 1 otherwise)
//
// Mutant ops, applied to a copy of the plan JSON:
//   set                 values[path] = value on the resource at `address`, in
//                       planned_values and in resource_changes[].change.after
//   add_resource        a new managed resource, planned as a create
//   policy_add_binding  a binding added to the policy_data of the data source
//                       at `address` (live IAM drift read during the plan)

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge } from './check-plan.mjs';
import { summarize } from './plan-summary.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function resources(module, out = []) {
  if (!module) return out;
  for (const r of module.resources ?? []) out.push(r);
  for (const c of module.child_modules ?? []) resources(c, out);
  return out;
}

function setPath(obj, path, value) {
  let o = obj;
  for (const k of path.slice(0, -1)) {
    if (o?.[k] === undefined)
      throw new Error(
        `path ${JSON.stringify(path)} not found at ${JSON.stringify(k)}`
      );
    o = o[k];
  }
  o[path[path.length - 1]] = value;
}

function apply(plan, op) {
  if (op.op === 'set') {
    const targets = [
      ...resources(plan.planned_values?.root_module)
        .filter(r => r.address === op.address)
        .map(r => r.values),
      ...(plan.resource_changes ?? [])
        .filter(r => r.address === op.address && r.change?.after)
        .map(r => r.change.after),
    ];
    if (targets.length === 0)
      throw new Error(`no resource ${op.address} in the plan`);
    for (const t of targets) setPath(t, op.path, structuredClone(op.value));
  } else if (op.op === 'add_resource') {
    plan.planned_values.root_module.resources.push(
      structuredClone(op.resource)
    );
    const { address, mode, type, name, provider_name, values } = op.resource;
    (plan.resource_changes ??= []).push({
      address,
      mode,
      type,
      name,
      provider_name,
      change: {
        actions: ['create'],
        before: null,
        after: structuredClone(values),
      },
    });
  } else if (op.op === 'policy_add_binding') {
    const ds = resources(plan.prior_state?.values?.root_module).find(
      r => r.address === op.address
    );
    if (!ds) throw new Error(`no data source ${op.address} in prior_state`);
    const policy = JSON.parse(ds.values.policy_data);
    (policy.bindings ??= []).push(structuredClone(op.binding));
    ds.values.policy_data = JSON.stringify(policy);
  } else {
    throw new Error(`unknown op ${op.op}`);
  }
}

function main(argv) {
  const file = argv[2] ?? join(here, 'fixtures', 'plan.json');
  console.log(`base plan: ${file}`);
  const real = JSON.parse(readFileSync(file, 'utf8'));
  let ok = true;

  const base = judge(real);
  if (base.length === 0) console.log('PASS      base plan accepted');
  else {
    ok = false;
    console.log('FAIL      base plan rejected:');
    for (const x of base) console.log(`            [${x.rule}] ${x.message}`);
  }

  // the drift verdict: the base plan has none; a mutant that adds a
  // resource is drift (a create)
  const drift = p => summarize(p).drifted.length > 0;
  if (drift(real)) {
    ok = false;
    console.log(
      `FAIL      base plan counted as drift: ${summarize(real).drifted.join(', ')}`
    );
  } else console.log('PASS      base plan is no drift (imports only)');

  const dir = join(here, 'mutants');
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .sort();
  for (const f of files) {
    const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const plan = structuredClone(real);
    try {
      for (const op of m.ops) apply(plan, op);
    } catch (e) {
      ok = false;
      console.log(`ERROR     ${f}: could not apply (${e.message})`);
      continue;
    }
    if (m.ops.some(op => op.op === 'add_resource') && !drift(plan)) {
      ok = false;
      console.log(
        `FAIL      ${f}: adds a resource but is not counted as drift`
      );
    }
    const hits = judge(plan);
    const caught = hits.filter(x => x.rule === m.expect);
    if (caught.length > 0) {
      console.log(`REJECTED  ${f}: ${m.description}`);
      console.log(`            [${caught[0].rule}] ${caught[0].message}`);
    } else {
      ok = false;
      const other = hits.length
        ? ` (only other rules fired: ${hits.map(x => x.rule).join(', ')})`
        : '';
      console.log(
        `ACCEPTED  ${f}: ${m.description}; expected [${m.expect}] to reject it${other}`
      );
    }
  }
  console.log(
    ok
      ? `\nall ${files.length} mutants rejected, base plan accepted`
      : '\npolicy test FAILED'
  );
  return ok ? 0 : 1;
}

process.exitCode = main(process.argv);
