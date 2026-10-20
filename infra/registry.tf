# Images for the verify service. CI copies the image it built into this
# repository (crane copy in service/deploy/cloudrun.sh); Cloud Run pulls it from here.
resource "google_artifact_registry_repository" "polyman" {
  project       = var.project
  location      = var.region
  repository_id = "polyman"
  format        = "DOCKER"
  mode          = "STANDARD_REPOSITORY"
}
