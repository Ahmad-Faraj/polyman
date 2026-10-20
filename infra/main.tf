# What service/README.md ("One-time Google Cloud setup") created by hand,
# written down so a plan can show any drift from it. Nothing here is new:
# every resource is adopted with the import blocks in imports.tf.

data "google_project" "this" {
  project_id = var.project
}

# Read-only: the live project IAM policy, so the policy judge
# (policy/check-plan.mjs) can check that verify-runtime holds no project role
# at all, including roles granted outside this configuration.
data "google_project_iam_policy" "live" {
  project = var.project
}

locals {
  deployer_email = "gitlab-deployer@${var.project}.iam.gserviceaccount.com"
  runtime_email  = "verify-runtime@${var.project}.iam.gserviceaccount.com"

  # the APIs the setup enables
  services = toset([
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "compute.googleapis.com",
    "iamcredentials.googleapis.com",
    "sts.googleapis.com",
  ])

  # the project roles of the deployer, and nothing more
  deployer_roles = toset([
    "roles/run.admin",
    "roles/artifactregistry.writer",
    "roles/compute.networkUser",
  ])
}

# The APIs the setup enables. disable_on_destroy = false: removing this
# configuration must never switch off an API the running service needs.
resource "google_project_service" "enabled" {
  for_each = local.services

  project            = var.project
  service            = each.value
  disable_on_destroy = false
}
