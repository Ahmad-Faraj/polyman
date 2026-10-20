# --- identities ---------------------------------------------------------------

# The identity CI deploys as (through Workload Identity Federation, no key).
resource "google_service_account" "gitlab_deployer" {
  project      = var.project
  account_id   = "gitlab-deployer"
  display_name = "GitLab CI deployer"
}

# The identity the verify service runs as. It holds no project role at all:
# code that strangers upload runs with it, so it must be able to do nothing.
resource "google_service_account" "verify_runtime" {
  project      = var.project
  account_id   = "verify-runtime"
  display_name = "verify service (no permissions)"
}

# --- what the deployer may do ------------------------------------------------

# Non-authoritative members: other bindings on the project (owners, Google
# service agents) are left alone and not managed here.
resource "google_project_iam_member" "deployer" {
  for_each = local.deployer_roles

  project = var.project
  role    = each.value
  member  = "serviceAccount:${google_service_account.gitlab_deployer.email}"
}

# It may deploy the service as verify-runtime, and act as nothing else.
resource "google_service_account_iam_member" "deployer_acts_as_runtime" {
  service_account_id = google_service_account.verify_runtime.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.gitlab_deployer.email}"
}

# --- who may become the deployer ---------------------------------------------

resource "google_iam_workload_identity_pool" "gitlab" {
  project                   = var.project
  workload_identity_pool_id = "gitlab"
}

# Trust GitLab's OIDC tokens only from this project's protected main branch:
# a pipeline on any other branch, tag or fork can't exchange its token.
resource "google_iam_workload_identity_pool_provider" "gitlab_com" {
  project                            = var.project
  workload_identity_pool_id          = google_iam_workload_identity_pool.gitlab.workload_identity_pool_id
  workload_identity_pool_provider_id = "gitlab-com"

  attribute_mapping = {
    "google.subject"         = "assertion.sub"
    "attribute.project_path" = "assertion.project_path"
  }
  attribute_condition = "assertion.project_path=='${var.gitlab_project_path}' && assertion.ref_protected=='true' && assertion.ref=='main' && assertion.ref_type=='branch'"

  oidc {
    issuer_uri        = "https://gitlab.com"
    allowed_audiences = ["https://gitlab.com"]
  }
}

resource "google_service_account_iam_member" "gitlab_wif_deployer" {
  service_account_id = google_service_account.gitlab_deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.gitlab.name}/attribute.project_path/${var.gitlab_project_path}"
}
