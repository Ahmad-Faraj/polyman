# The verify service. It runs code that strangers upload, so every setting
# leans to the safe side; they mirror service/deploy/cloudrun.conf.
#
# Ownership split: the CI jobs in service/ci/service.gitlab-ci.yml
# (service/deploy/cloudrun.sh candidate / promote / rollback / discard) own
# what changes on every release: the image, the APP_COMMIT env var, the
# revision name, the traffic split and its c-<sha> tags, and the gcloud client
# annotations. Those are ignored below so a plan never fights a release.
# Everything else (identity, sandbox, scale, network, limits) is owned here,
# and any drift in it shows up in the plan.
resource "google_cloud_run_v2_service" "verify" {
  project             = var.project
  name                = "polyman-verify"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  launch_stage        = "GA"
  deletion_protection = true

  scaling {
    max_instance_count = 3
  }

  template {
    service_account = google_service_account.verify_runtime.email
    # gen1 runs the container in gVisor, a stronger sandbox for untrusted code
    execution_environment = "EXECUTION_ENVIRONMENT_GEN1"
    # a whole contest: up to 26 problems at up to 120 s each fits in the hour
    timeout = "3600s"
    # one verification per instance
    max_instance_request_concurrency = 1

    scaling {
      max_instance_count = 3
    }

    # all egress goes into the isolated VPC, which denies egress: no internet
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = google_compute_network.verify_isolated.name
        subnetwork = google_compute_subnetwork.verify_isolated.name
      }
    }

    containers {
      # Owned by the deploy jobs (ignored below); this value is never applied.
      image = "${var.region}-docker.pkg.dev/${var.project}/${google_artifact_registry_repository.polyman.repository_id}/polyman-verify"

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      ports {
        name           = "http1"
        container_port = 8080
      }

      startup_probe {
        timeout_seconds   = 240
        period_seconds    = 240
        failure_threshold = 1
        tcp_socket {
          port = 8080
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      client,
      client_version,
      template[0].revision,
      template[0].containers[0].image,
      template[0].containers[0].env,
      traffic,
    ]
  }
}

# --allow-unauthenticated: anyone may call the service (it is a public tool).
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  project  = var.project
  location = google_cloud_run_v2_service.verify.location
  name     = google_cloud_run_v2_service.verify.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
