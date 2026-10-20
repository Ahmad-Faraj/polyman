# Everything in this configuration already exists (created by hand from
# service/README.md). These blocks adopt it into state on the first apply;
# the first plan must show only imports: 0 to add, 0 to change, 0 to destroy.
# Once the state holds them they are no-ops and can stay or be removed.

import {
  for_each = local.services
  to       = google_project_service.enabled[each.key]
  id       = "${var.project}/${each.key}"
}

import {
  to = google_artifact_registry_repository.polyman
  id = "projects/${var.project}/locations/${var.region}/repositories/polyman"
}

import {
  to = google_compute_network.default
  id = "projects/${var.project}/global/networks/default"
}

import {
  to = google_compute_network.verify_isolated
  id = "projects/${var.project}/global/networks/verify-isolated"
}

import {
  to = google_compute_subnetwork.verify_isolated
  id = "projects/${var.project}/regions/${var.region}/subnetworks/verify-isolated"
}

import {
  to = google_compute_firewall.verify_deny_egress
  id = "projects/${var.project}/global/firewalls/verify-deny-egress"
}

import {
  to = google_service_account.gitlab_deployer
  id = "projects/${var.project}/serviceAccounts/${local.deployer_email}"
}

import {
  to = google_service_account.verify_runtime
  id = "projects/${var.project}/serviceAccounts/${local.runtime_email}"
}

import {
  for_each = local.deployer_roles
  to       = google_project_iam_member.deployer[each.key]
  id       = "${var.project} ${each.key} serviceAccount:${local.deployer_email}"
}

import {
  to = google_service_account_iam_member.deployer_acts_as_runtime
  id = "projects/${var.project}/serviceAccounts/${local.runtime_email} roles/iam.serviceAccountUser serviceAccount:${local.deployer_email}"
}

import {
  to = google_iam_workload_identity_pool.gitlab
  id = "projects/${var.project}/locations/global/workloadIdentityPools/gitlab"
}

import {
  to = google_iam_workload_identity_pool_provider.gitlab_com
  id = "projects/${var.project}/locations/global/workloadIdentityPools/gitlab/providers/gitlab-com"
}

import {
  to = google_service_account_iam_member.gitlab_wif_deployer
  id = "projects/${var.project}/serviceAccounts/${local.deployer_email} roles/iam.workloadIdentityUser principalSet://iam.googleapis.com/projects/${data.google_project.this.number}/locations/global/workloadIdentityPools/gitlab/attribute.project_path/${var.gitlab_project_path}"
}

import {
  to = google_cloud_run_v2_service.verify
  id = "projects/${var.project}/locations/${var.region}/services/polyman-verify"
}

import {
  to = google_cloud_run_v2_service_iam_member.public_invoker
  id = "projects/${var.project}/locations/${var.region}/services/polyman-verify roles/run.invoker allUsers"
}
