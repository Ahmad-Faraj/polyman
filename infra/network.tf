# The project's auto-mode default network, as Google created it. Nothing of
# the verify service uses it; it is written down so it is not invisible drift.
# Its auto-created subnets and default-allow-* firewall rules are not codified.
resource "google_compute_network" "default" {
  project                 = var.project
  name                    = "default"
  description             = "Default network for the project"
  auto_create_subnetworks = true
  routing_mode            = "REGIONAL"
}

# A network with no way out: no Cloud NAT, no route the service can use to
# leave, and all egress denied. Cloud Run sends ALL of its egress into it
# (vpc_access.egress = ALL_TRAFFIC in run.tf), so uploaded code has no internet.
resource "google_compute_network" "verify_isolated" {
  project                 = var.project
  name                    = "verify-isolated"
  auto_create_subnetworks = false
  routing_mode            = "REGIONAL"
}

resource "google_compute_subnetwork" "verify_isolated" {
  project                  = var.project
  name                     = "verify-isolated"
  region                   = var.region
  network                  = google_compute_network.verify_isolated.id
  ip_cidr_range            = "10.20.0.0/26"
  private_ip_google_access = false
  stack_type               = "IPV4_ONLY"
}

resource "google_compute_firewall" "verify_deny_egress" {
  project            = var.project
  name               = "verify-deny-egress"
  network            = google_compute_network.verify_isolated.name
  direction          = "EGRESS"
  priority           = 100
  destination_ranges = ["0.0.0.0/0"]

  deny {
    protocol = "all"
  }
}
