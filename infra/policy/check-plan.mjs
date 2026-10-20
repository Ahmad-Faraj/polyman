#!/usr/bin/env node
// Policy judge for the verify service's infrastructure. Reads the JSON of a
// plan (`tofu show -json plan.bin`) and fails unless the state the plan would
// leave behind keeps the sandbox closed:
//
//   run-sa        Cloud Run runs as verify-runtime (the account with no roles)
//   run-gen1      execution environment gen1 (gVisor)
//   run-scale     at most 3 instances
//   run-egress    all egress goes into the verify-isolated VPC
//   fw-deny       verify-isolated denies all egress to 0.0.0.0/0, and no rule
//                 on it allows egress
//   runtime-roles verify-runtime holds no project role (in this configuration
//                 and in the live project IAM policy read during the plan)
//   wif-condition the GitLab WIF provider only trusts our project's protected
//                 main branch
//
// It judges the end state (planned_values, plus the data sources read during
// the plan in prior_state), so a change in the .tf files and drift in Google
// Cloud are judged the same way. A resource that is missing fails its check.
// The expected values are constants here, not read from the plan, so a change
// that edits a variable cannot also move the goalposts.
//
// usage: node check-plan.mjs plan.json   (exit 0 pass, 1 violations, 2 bad input)
// No dependencies; Node 18+.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const EXPECTED = {
  project: 'polyman-511913',
  service: 'polyman-verify',
  runtimeAccount: 'verify-runtime@polyman-511913.iam.gserviceaccount.com',
  network: 'verify-isolated',
  subnet: 'verify-isolated',
  maxInstances: 3,
  gitlabProjectPath:
    'gitlab-ai-hackathon/transcend-october-2026/30770856/showcase',
  wifProvider: 'gitlab-com',
};

/** every resource in a module tree (planned_values / prior_state values) */
function walk(module, out = []) {
  if (!module) return out;
  for (const r of module.resources ?? []) out.push(r);
  for (const c of module.child_modules ?? []) walk(c, out);
  return out;
}

/** last path segment: "verify-isolated" for a name or a full self link */
const leaf = v =>
  String(v ?? '')
    .split('/')
    .pop();

function cloudRun(managed, v) {
  const runs = managed.filter(
    r =>
      (r.type === 'google_cloud_run_v2_service' ||
        r.type === 'google_cloud_run_service') &&
      (r.values?.name ?? r.values?.metadata?.[0]?.name) === EXPECTED.service
  );
  if (runs.length === 0) {
    v('run-sa', `Cloud Run service ${EXPECTED.service} is not in the plan`);
    return;
  }
  for (const run of runs) {
    if (run.type !== 'google_cloud_run_v2_service') {
      v(
        'run-sa',
        `${run.address}: only google_cloud_run_v2_service is understood by this judge`
      );
      continue;
    }
    const t = run.values.template?.[0] ?? {};
    if (t.service_account !== EXPECTED.runtimeAccount)
      v(
        'run-sa',
        `${run.address}: runs as ${t.service_account || '(the default compute account)'}, not ${EXPECTED.runtimeAccount}`
      );

    if (t.execution_environment !== 'EXECUTION_ENVIRONMENT_GEN1')
      v(
        'run-gen1',
        `${run.address}: execution environment is ${t.execution_environment || '(unset, Cloud Run picks)'}, not EXECUTION_ENVIRONMENT_GEN1 (gVisor)`
      );

    // both the revision template and the service-level scaling must be capped
    const caps = [
      ['template.scaling', t.scaling?.[0]],
      ['scaling', run.values.scaling?.[0]],
    ];
    const tmax = t.scaling?.[0]?.max_instance_count;
    if (!(Number.isInteger(tmax) && tmax >= 1 && tmax <= EXPECTED.maxInstances))
      v(
        'run-scale',
        `${run.address}: template.scaling.max_instance_count is ${tmax ?? '(unset)'}, must be 1..${EXPECTED.maxInstances}`
      );
    for (const [where, s] of caps) {
      if (!s) continue;
      if (
        Number.isInteger(s.max_instance_count) &&
        s.max_instance_count > EXPECTED.maxInstances
      )
        v(
          'run-scale',
          `${run.address}: ${where}.max_instance_count is ${s.max_instance_count}, over ${EXPECTED.maxInstances}`
        );
      for (const k of ['min_instance_count', 'manual_instance_count'])
        if (Number.isInteger(s[k]) && s[k] > EXPECTED.maxInstances)
          v(
            'run-scale',
            `${run.address}: ${where}.${k} is ${s[k]}, over ${EXPECTED.maxInstances}`
          );
    }

    const vpc = t.vpc_access?.[0];
    const nics = vpc?.network_interfaces ?? [];
    if (!vpc || vpc.egress !== 'ALL_TRAFFIC')
      v(
        'run-egress',
        `${run.address}: vpc_access.egress is ${vpc?.egress || '(no VPC access)'}, not ALL_TRAFFIC`
      );
    if (vpc?.connector)
      v(
        'run-egress',
        `${run.address}: uses a VPC connector (${vpc.connector}), not direct egress into ${EXPECTED.network}`
      );
    if (
      nics.length !== 1 ||
      leaf(nics[0].network) !== EXPECTED.network ||
      leaf(nics[0].subnetwork) !== EXPECTED.subnet
    )
      v(
        'run-egress',
        `${run.address}: network interfaces ${JSON.stringify(nics.map(n => [n.network, n.subnetwork]))}, want exactly [${EXPECTED.network}, ${EXPECTED.subnet}]`
      );
  }
}

function firewall(managed, v) {
  const onIsolated = managed.filter(
    r =>
      r.type === 'google_compute_firewall' &&
      leaf(r.values?.network) === EXPECTED.network
  );
  const denyAll = onIsolated.filter(r => {
    const f = r.values;
    return (
      f.direction === 'EGRESS' &&
      !f.disabled &&
      (f.allow ?? []).length === 0 &&
      (f.deny ?? []).some(
        d => d.protocol === 'all' && (d.ports ?? []).length === 0
      ) &&
      (f.destination_ranges ?? []).includes('0.0.0.0/0') &&
      (f.target_tags ?? []).length === 0 &&
      (f.target_service_accounts ?? []).length === 0
    );
  });
  if (denyAll.length === 0)
    v(
      'fw-deny',
      `no enabled EGRESS rule on ${EXPECTED.network} denies all protocols to 0.0.0.0/0 for every instance`
    );
  for (const r of onIsolated) {
    const f = r.values;
    if (
      (f.allow ?? []).length > 0 &&
      (f.direction ?? 'INGRESS') === 'EGRESS' &&
      !f.disabled
    )
      v(
        'fw-deny',
        `${r.address}: allows egress on ${EXPECTED.network} (${JSON.stringify(f.allow)} to ${JSON.stringify(f.destination_ranges)})`
      );
  }
}

function runtimeRoles(managed, data, v) {
  const member = `serviceAccount:${EXPECTED.runtimeAccount}`;
  for (const r of managed) {
    const x = r.values ?? {};
    if (r.type === 'google_project_iam_member' && x.member === member)
      v(
        'runtime-roles',
        `${r.address}: grants ${x.role} on the project to verify-runtime`
      );
    if (
      r.type === 'google_project_iam_binding' &&
      (x.members ?? []).includes(member)
    )
      v(
        'runtime-roles',
        `${r.address}: grants ${x.role} on the project to verify-runtime`
      );
    if (r.type === 'google_project_iam_policy')
      checkPolicy(r.address, x.policy_data, member, v);
  }
  const live = data.find(r => r.type === 'google_project_iam_policy');
  if (!live)
    v(
      'runtime-roles',
      'the plan did not read the live project IAM policy (data.google_project_iam_policy)'
    );
  else
    checkPolicy(`${live.address} (live)`, live.values?.policy_data, member, v);
}

function checkPolicy(where, policyData, member, v) {
  let policy;
  try {
    policy = JSON.parse(policyData ?? '');
  } catch {
    v('runtime-roles', `${where}: policy_data is not readable JSON`);
    return;
  }
  for (const b of policy.bindings ?? [])
    if ((b.members ?? []).includes(member))
      v('runtime-roles', `${where}: verify-runtime holds ${b.role}`);
}

function wif(managed, v) {
  // The deployer's principalSet trusts the whole pool, so every provider in
  // the plan is judged, and a provider other than the expected one is itself
  // a violation: a second provider with an empty condition would otherwise
  // open the deploy to any token its issuer signs.
  const providers = managed.filter(
    r => r.type === 'google_iam_workload_identity_pool_provider'
  );
  for (const r of providers)
    if (r.values?.workload_identity_pool_provider_id !== EXPECTED.wifProvider)
      v(
        'wif-condition',
        `${r.address}: unexpected WIF provider ${r.values?.workload_identity_pool_provider_id}; only ${EXPECTED.wifProvider} may be in the pool the deployer trusts`
      );
  if (
    !providers.some(
      r => r.values?.workload_identity_pool_provider_id === EXPECTED.wifProvider
    )
  ) {
    v(
      'wif-condition',
      `WIF provider ${EXPECTED.wifProvider} is not in the plan`
    );
    return;
  }
  const required = [
    `assertion.project_path=='${EXPECTED.gitlabProjectPath}'`,
    `assertion.ref=='main'`,
    `assertion.ref_protected=='true'`,
  ];
  for (const r of providers) {
    const cond = String(r.values.attribute_condition ?? '');
    // Only a plain conjunction of equalities is accepted: any ||, negation,
    // ternary or grouping could make a required term optional.
    if (/\|\||!|\?|\(|\)/.test(cond)) {
      v(
        'wif-condition',
        `${r.address}: condition is not a plain && of equalities: ${cond || '(empty)'}`
      );
      continue;
    }
    const terms = cond
      .split('&&')
      .map(s => s.replace(/\s+/g, '').replace(/"/g, "'"));
    for (const need of required)
      if (!terms.includes(need))
        v(
          'wif-condition',
          `${r.address}: condition lacks ${need} (it is: ${cond || '(empty)'})`
        );
    if ((r.values.oidc?.[0]?.issuer_uri ?? '') !== 'https://gitlab.com')
      v(
        'wif-condition',
        `${r.address}: issuer is ${r.values.oidc?.[0]?.issuer_uri}, not https://gitlab.com`
      );
  }
}

/** @returns {{rule: string, message: string}[]} the violations; empty means pass */
export function judge(plan) {
  const managed = walk(plan?.planned_values?.root_module).filter(
    r => r.mode !== 'data'
  );
  const data = walk(plan?.prior_state?.values?.root_module).filter(
    r => r.mode === 'data'
  );
  const out = [];
  const v = (rule, message) => out.push({ rule, message });
  cloudRun(managed, v);
  firewall(managed, v);
  runtimeRoles(managed, data, v);
  wif(managed, v);
  return out;
}

function main(argv) {
  const file = argv[2];
  if (!file) {
    console.error(
      'usage: node check-plan.mjs plan.json   (the output of tofu show -json plan.bin)'
    );
    return 2;
  }
  let plan;
  try {
    plan = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`cannot read ${file}: ${e.message}`);
    return 2;
  }
  if (!plan?.planned_values) {
    console.error(
      `${file} has no planned_values: is it the output of tofu show -json on a saved plan?`
    );
    return 2;
  }
  const violations = judge(plan);
  if (violations.length === 0) {
    console.log(
      'policy: PASS (run-sa, run-gen1, run-scale, run-egress, fw-deny, runtime-roles, wif-condition)'
    );
    return 0;
  }
  console.log(`policy: FAIL, ${violations.length} violation(s)`);
  for (const { rule, message } of violations)
    console.log(`  [${rule}] ${message}`);
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
