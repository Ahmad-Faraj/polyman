# The values CI needs (Settings > CI/CD > Variables, none secret).

output "GCP_PROJECT_ID" {
  value = var.project
}

output "GCP_WIF_PROVIDER" {
  value = google_iam_workload_identity_pool_provider.gitlab_com.name
}

output "GCP_SERVICE_ACCOUNT" {
  value = google_service_account.gitlab_deployer.email
}

output "GCP_REGION" {
  value = var.region
}

output "runtime_service_account" {
  value = google_service_account.verify_runtime.email
}

output "service_url" {
  value = google_cloud_run_v2_service.verify.uri
}

output "artifact_repository" {
  value = "${var.region}-docker.pkg.dev/${var.project}/${google_artifact_registry_repository.polyman.repository_id}"
}
