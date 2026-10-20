# infra: the verify service's Google Cloud setup, as code

The Google Cloud resources behind the verify service were created by hand,
from the "One-time Google Cloud setup" block in
[`service/README.md`](../service/README.md) and the settings in
[`service/deploy/cloudrun.conf`](../service/deploy/cloudrun.conf). This
directory writes that setup down in OpenTofu, exactly as it exists in project
`polyman-511913`, so a plan shows any drift from it and a policy judge can
check that the sandbox around uploaded code stays closed.

Nothing here creates anything. Every resource is adopted with an `import`
block (`imports.tf`), and the first plan is all imports:

```
Plan: 21 to import, 0 to add, 0 to change, 0 to destroy.
```

## What is codified

| File | Resources | Imported from |
|---|---|---|
| `main.tf` | `google_project_service.enabled` (run, artifactregistry, compute, iamcredentials, sts) | `polyman-511913/<api>` |
| `registry.tf` | `google_artifact_registry_repository.polyman` (DOCKER, us-east1) | `projects/…/locations/us-east1/repositories/polyman` |
| `network.tf` | `google_compute_network.default`, `google_compute_network.verify_isolated`, `google_compute_subnetwork.verify_isolated` (10.20.0.0/26), `google_compute_firewall.verify_deny_egress` (EGRESS, deny all, 0.0.0.0/0, priority 100) | `projects/…/global/…`, `projects/…/regions/us-east1/…` |
| `iam.tf` | service accounts `gitlab-deployer` and `verify-runtime`; the deployer's project roles (`roles/run.admin`, `roles/artifactregistry.writer`, `roles/compute.networkUser`); the deployer's `roles/iam.serviceAccountUser` on verify-runtime; WIF pool `gitlab` and provider `gitlab-com`; the pool principal's `roles/iam.workloadIdentityUser` on the deployer | `projects/…/serviceAccounts/…`, `"<project> <role> <member>"`, `projects/…/workloadIdentityPools/…` |
| `run.tf` | `google_cloud_run_v2_service.verify` (`polyman-verify`), and its public `roles/run.invoker` for `allUsers` (`--allow-unauthenticated`) | `projects/…/locations/us-east1/services/polyman-verify` |

Two read-only data sources: `google_project` (for the project number in the
WIF principal) and `google_project_iam_policy.live` (so the policy judge sees
every project role, including ones granted outside this configuration).

The IAM grants are non-authoritative `*_iam_member` resources: the owners,
Google's service agents and anything else in the project policy are left
alone and are not managed here.

Deliberately not codified: the default network's auto-created subnets and its
`default-allow-*` firewall rules, the default compute service account, the
project's other enabled APIs, billing, and the GitLab CI/CD variables.

## Who owns what on the Cloud Run service

The release jobs in [`service/ci/service.gitlab-ci.yml`](../service/ci/service.gitlab-ci.yml)
(`service/deploy/cloudrun.sh candidate | promote | rollback | discard`) change
the service on every release. They own:

- the container image (`containers[0].image`, a new tag per commit),
- the env vars (`containers[0].env`: `APP_COMMIT` changes every release),
- the revision name (`template.revision`),
- the traffic split and the `c-<sha>` candidate tags (`traffic`),
- the gcloud client annotations (`client`, `client_version`).

`run.tf` ignores exactly those (`lifecycle.ignore_changes`), so a plan never
fights a release and an apply never rolls one back or moves traffic. Without
the ignore list the plan wants to update the service in place (image, env,
revision, client fields). No gcloud-set labels or annotations show up in the
v2 resource, so none need ignoring.

Everything else on the service is owned here, and drift in it shows in the
plan: the runtime identity (verify-runtime), gen1 (gVisor), the 3-instance
cap, concurrency 1, 2 CPU / 2Gi, the 3600 s timeout, startup CPU boost, the
startup probe, and all egress through `verify-isolated`. These must match
`cloudrun.conf`, since every `gcloud run deploy` sets them again.

## In CI

[`infra.gitlab-ci.yml`](infra.gitlab-ci.yml), included from the root
`.gitlab-ci.yml`, adds three jobs (`infra:check`, `infra:plan`,
`infra:import`), and the root file adds GitLab's IaC scanning
(`Jobs/SAST-IaC.gitlab-ci.yml`, the KICS analyzer), which scans these `.tf`
files in every pipeline.

**`infra:check`** (stage check; on the default branch, and wherever
`infra/**` changed) runs `tofu fmt -check -recursive`,
`tofu init -backend=false`, `tofu validate`, the policy judge against its
mutants on the synthetic fixture, and
[`policy/test-summary.mjs`](policy/test-summary.mjs), which checks the drift
verdict case by case (exit 0 no drift, 1 drift, 2 when the input is not a
plan, an entry has no address or actions, or the summary can't be written)
and the counts written for the merge request widget. It needs no Google
Cloud access and never
touches the state. OpenTofu 1.13.1 is downloaded from its GitHub release and
checked against the release's SHA256SUMS; the providers are verified against
`.terraform.lock.hcl`.

**`infra:plan`** (stage test) is the drift check. It runs only on the default
branch, which means pushes to `main` and the nightly pipeline schedule, and
only when `GCP_PLANNER_SA` (and `GCP_WIF_PROVIDER`) are set. Until then it is
skipped. It:

1. signs in with the job's OIDC token (`id_tokens`, audience
   `https://gitlab.com`) through the existing `gitlab-com` WIF provider, the
   same way the deploy jobs do, and impersonates `$GCP_PLANNER_SA`. No Google
   key is stored;
2. runs `tofu init` against the GitLab-managed state `verify`
   (`$CI_API_V4_URL/projects/$CI_PROJECT_ID/terraform/state/verify`, user
   `gitlab-ci-token`, password `$CI_JOB_TOKEN`, all as `TF_HTTP_*` variables);
3. runs `tofu plan -lock=false -detailed-exitcode`, so it never takes the lock
   and never writes the state. The only apply in CI is `infra:import`: a
   manual job on `main`, run once, that adopts the 21 resources into the state
   and refuses any plan but "21 to import, 0 to add, 0 to change, 0 to
   destroy", so it writes the state and never changes Google Cloud;
4. decides drift with [`policy/plan-summary.mjs`](policy/plan-summary.mjs) and
   judges the plan with [`policy/check-plan.mjs`](policy/check-plan.mjs). The
   job fails on either, with the reason in its log.

**`infra:import`** (manual, on `main` only, `resource_group: infra-state`)
is run once, by a person, to fill the empty `verify` state. It plans first and
refuses anything but "21 to import, 0 to add, 0 to change, 0 to destroy",
then applies that plan, which only writes the state. A plan right after it
must show no changes; its output is filtered to resource names and the
`Plan:` line, because the plan shows IAM members.

Imports are not drift. `imports.tf` adopts everything, so while the `verify`
state is empty every resource plans as an import with no change
(`21 to import, 0 to add, 0 to change, 0 to destroy`), and
`-detailed-exitcode` exits 2 for that. So the job does not use the exit code
to decide drift. It counts creates, updates and deletes in the plan JSON, and
only those are drift (exit 1 from tofu is still an error).

Artifacts: `reports: terraform` gets `{"create": n, "update": n, "delete": n}`
for the merge request widget, and `plan-report.txt` (counts, drifted
resources) and `policy-report.txt` (the judge) are exposed as "OpenTofu
plan". The plan JSON itself holds the live project IAM policy, which includes
people's addresses, so it stays in `/tmp` and is never uploaded.

### The planner account

`infra:plan` and `infra:import` sign in as a read-only service account,
`gitlab-planner`, set up on Oct 20:

- it holds `roles/viewer` and `roles/iam.workloadIdentityPoolViewer` (the
  permissions below) and nothing else;
- the existing WIF principal for this project
  (`principalSet://…/workloadIdentityPools/gitlab/attribute.project_path/<project>`)
  has `roles/iam.workloadIdentityUser` on it. The provider's condition already
  limits that principal to protected `main`, so only default-branch pipelines
  can plan;
- `GCP_PLANNER_SA` is set to its email in Settings > CI/CD > Variables;
- the project has the Cloud Resource Manager and IAM APIs enabled
  (`gcloud services enable cloudresourcemanager.googleapis.com
  iam.googleapis.com`). Without them every read of a project service, the IAM
  policy, the service accounts and the pool fails with 403, and the plan shows
  only the 5 resources it could read ([#99](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/issues/99)).

With that in place, the plan on `main` shows the 21 imports and no drift
([infra:plan](https://gitlab.com/gitlab-ai-hackathon/transcend-october-2026/30770856/showcase/-/jobs/17323792278)).
`infra:import` writes them into the `verify` state once; until it has run,
every nightly plan shows the imports and no drift.

It must not be `gitlab-deployer`, which can write.

## Running a plan by hand

To try it without touching the GitLab state, copy the `.tf` files to a
scratch directory and add an `override.tf` there with
`terraform { backend "local" { path = "scratch.tfstate" } }`, then plan with
your own gcloud login:

```sh
GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token) tofu plan -out=plan.bin
tofu show -json plan.bin > /tmp/plan.json   # keep it out of the repo: it holds the IAM policy
node policy/plan-summary.mjs /tmp/plan.json
node policy/check-plan.mjs /tmp/plan.json
```

(`*_override.tf`, `plan.bin` and `plan.json` are git-ignored here.) The
provider is pinned to `hashicorp/google ~> 8.7`, and `.terraform.lock.hcl`
records the 8.7.0 checksums for linux_amd64, windows_amd64 and darwin_arm64.

### What a planner identity needs

A plan only reads. These are the API calls a plan makes (taken from the
provider's request log of a real plan on 20 Oct 2026), and the permissions
behind them:

| Permission | Call |
|---|---|
| `resourcemanager.projects.get` | `projects.get`, and the billing info `data.google_project` reads |
| `resourcemanager.projects.getIamPolicy` | the project policy (the deployer's role members and `data.google_project_iam_policy`) |
| `serviceusage.services.list` | the enabled APIs |
| `artifactregistry.repositories.get` | the `polyman` repository |
| `compute.networks.get`, `compute.subnetworks.get`, `compute.firewalls.get` | the two networks, the subnet, the egress rule |
| `iam.serviceAccounts.get`, `iam.serviceAccounts.getIamPolicy` | the two service accounts and their IAM policies |
| `iam.workloadIdentityPools.get`, `iam.workloadIdentityPools.getAttestationRules`, `iam.workloadIdentityPoolProviders.get` | the pool (the provider also lists its attestation rules) and the provider |
| `run.services.get`, `run.services.getIamPolicy` | the service and its invoker policy |

`roles/viewer` holds all of them, but far more besides. A tighter fit is a
custom role with exactly these permissions, or the predefined set
`roles/browser` + `roles/serviceusage.serviceUsageViewer` +
`roles/artifactregistry.reader` + `roles/compute.networkViewer` +
`roles/iam.serviceAccountViewer` + `roles/iam.workloadIdentityPoolViewer` +
`roles/run.viewer`.

## Policy judge

[`policy/check-plan.mjs`](policy/check-plan.mjs) (Node 18+, no dependencies)
reads `tofu show -json` output and judges the state the plan would leave. It
fails unless:

| Rule | Check |
|---|---|
| `run-sa` | the service runs as `verify-runtime@polyman-511913.iam.gserviceaccount.com` |
| `run-gen1` | execution environment `EXECUTION_ENVIRONMENT_GEN1` (gVisor) |
| `run-scale` | max instances 1..3 (template), and no service-level count over 3 |
| `run-egress` | `vpc_access.egress = ALL_TRAFFIC`, no connector, exactly one interface on `verify-isolated`/`verify-isolated` |
| `fw-deny` | an enabled EGRESS rule on `verify-isolated` denies all protocols to `0.0.0.0/0` for every instance, and no rule on it allows egress |
| `runtime-roles` | verify-runtime holds no project role, in this configuration or in the live project policy read during the plan |
| `wif-condition` | the pool holds only the `gitlab-com` provider (any other provider id fails); its condition, read as CEL reads it, is `assertion.<claim> == <literal>` terms joined by `&&`, each literal in `'` or `"` with no quote or backslash inside (anything else fails, so a literal can't swallow terms), whose exact values include our project path, `ref=='main'` and `ref_protected=='true'`, with issuer `https://gitlab.com` |

The expected values are constants in the judge, not read from the plan, so a
change cannot edit a variable and move the goalposts with it. A resource that
disappears from the plan fails its rule.

[`policy/test-mutants.mjs`](policy/test-mutants.mjs) proves the judge has
teeth: the base plan must pass and each mutant in
[`policy/mutants/`](policy/mutants) (the base plan with one unsafe change)
must be rejected by the rule it names. The base plan is
[`policy/fixtures/plan.json`](policy/fixtures/plan.json). It is a synthetic,
hand-written plan with only the fields the judge reads, the real
non-personal values, and placeholder members (`user:owner-a@example.com`).
No real plan output is committed. A real plan works as the base too:

```sh
node policy/test-mutants.mjs                 # the fixture (what infra:check runs)
node policy/test-mutants.mjs /tmp/plan.json  # a real plan
```

| Mutant | Rejected by |
|---|---|
| `gen2.json`: gen2, no gVisor | `run-gen1` |
| `maxscale-100.json`: 100 instances | `run-scale` |
| `runtime-sa-default.json`: runs as the default compute account | `run-sa` |
| `vpc-private-ranges-only.json`: public egress leaves the VPC | `run-egress` |
| `egress-opened.json`: the egress rule flipped to allow | `fw-deny` |
| `runtime-editor.json`: this config grants verify-runtime `roles/editor` | `runtime-roles` |
| `runtime-editor-live.json`: `roles/editor` granted by hand (live drift) | `runtime-roles` |
| `wif-no-ref.json`: condition without `ref=='main'` | `wif-condition` |
| `wif-or-bypass.json`: every term kept, but `\|\| ref_type=='tag'` | `wif-condition` |
| `wif-second-provider.json`: a second provider in the pool, another issuer and no condition | `wif-condition` |
| `wif-string-literal.json`: the terms hidden in a string literal, `assertion.sub > "0 && … && x"` | `wif-condition` |
| `wif-mixed-quotes.json`: a literal opened with `"` and closed with `'`, `assertion.ref=="x' && … && z=='y"` | `wif-condition` |
| `wif-space-in-literal.json`: `ref=='ma in'`, which a reader that drops spaces takes for `main` | `wif-condition` |
