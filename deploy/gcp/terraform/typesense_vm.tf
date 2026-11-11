# ── Persistent disk for Typesense data ───────────────────────────
# Cloud Run is stateless — Typesense needs /data on a persistent disk.
# A small GCE VM (e2-small) is the cleanest solution.
resource "google_compute_disk" "typesense_data" {
  name  = "${var.project_name}-typesense-data"
  type  = "pd-ssd"
  zone  = var.gcp_zone
  size  = 20

  labels = {
    environment = "production"
    project     = var.project_name
  }
}

# ── Static internal IP for Typesense VM ──────────────────────────
resource "google_compute_address" "typesense_internal" {
  name         = "${var.project_name}-typesense-ip"
  subnetwork   = google_compute_subnetwork.main.id
  address_type = "INTERNAL"
  region       = var.gcp_region
}

# ── Firewall: allow Typesense port from VPC connector range only ──
resource "google_compute_firewall" "typesense_ingress" {
  name    = "${var.project_name}-typesense-ingress"
  network = google_compute_network.main.name

  allow {
    protocol = "tcp"
    ports    = ["8108"]
  }

  # VPC connector subnet CIDR (defined in cloud_run.tf)
  source_ranges = ["10.8.0.0/28"]
  target_tags   = ["typesense-vm"]
}

# ── Typesense GCE VM (Container-Optimized OS) ─────────────────────
resource "google_compute_instance" "typesense" {
  name         = "${var.project_name}-typesense"
  machine_type = var.typesense_machine_type
  zone         = var.gcp_zone

  tags = ["typesense-vm"]

  boot_disk {
    initialize_params {
      image = "projects/cos-cloud/global/images/family/cos-stable"
      size  = 10
      type  = "pd-standard"
    }
  }

  attached_disk {
    source      = google_compute_disk.typesense_data.id
    device_name = "typesense-data"
    mode        = "READ_WRITE"
  }

  network_interface {
    network    = google_compute_network.main.id
    subnetwork = google_compute_subnetwork.main.id
    network_ip = google_compute_address.typesense_internal.address
    # No access_config → no external IP
  }

  metadata = {
    google-logging-enabled = "true"

    # The API key is NOT embedded here: instance metadata is readable by
    # anything on the VM and by anyone with compute.instances.get. The
    # script fetches it from Secret Manager with the VM's own identity.
    startup-script = <<-EOF
      #!/bin/bash
      set -e

      # Mount the data disk
      if ! blkid /dev/disk/by-id/google-typesense-data; then
        mkfs.ext4 -F /dev/disk/by-id/google-typesense-data
      fi
      mkdir -p /data
      mountpoint -q /data || mount /dev/disk/by-id/google-typesense-data /data

      # Fetch the Typesense API key from Secret Manager (no gcloud on COS)
      MD=http://metadata.google.internal/computeMetadata/v1
      TOKEN=$(curl -sf -H "Metadata-Flavor: Google" "$MD/instance/service-accounts/default/token" \
        | sed -E 's/.*"access_token" *: *"([^"]+)".*/\1/')
      TS_KEY=$(curl -sf -H "Authorization: Bearer $TOKEN" \
        "https://secretmanager.googleapis.com/v1/projects/${var.project_id}/secrets/${google_secret_manager_secret.typesense_api_key.secret_id}/versions/latest:access" \
        | tr -d '\n ' | sed -E 's/.*"data":"([^"]+)".*/\1/' | base64 -d)
      if [ -z "$TS_KEY" ]; then
        echo "FATAL: could not read Typesense API key from Secret Manager" >&2
        exit 1
      fi

      # Key goes in a root-only env file, not on the command line (ps / docker inspect args)
      umask 077
      echo "TYPESENSE_API_KEY=$TS_KEY" > /var/lib/typesense.env

      # Run Typesense in Docker (startup scripts re-run on every boot)
      docker rm -f typesense 2>/dev/null || true
      docker run -d \
        --name typesense \
        --restart always \
        -p 8108:8108 \
        -v /data:/data \
        --env-file /var/lib/typesense.env \
        typesense/typesense:27.1 \
        --data-dir /data \
        --enable-cors
    EOF
  }

  service_account {
    email  = google_service_account.typesense.email
    scopes = ["cloud-platform"] # access is bounded by the SA's IAM roles, not scopes
  }

  shielded_instance_config {
    enable_secure_boot = true
  }

  depends_on = [
    google_secret_manager_secret_version.typesense_api_key,
    google_secret_manager_secret_iam_member.typesense_api_key_vm,
    google_compute_router_nat.main,
  ]

  labels = {
    environment = "production"
    project     = var.project_name
  }
}

# ── Cloud NAT ─────────────────────────────────────────────────────
# Nothing in this VPC has an external IP. Without NAT the Typesense VM
# cannot pull its image from Docker Hub, and the Cloud Run gateway (whose
# egress is routed through the VPC connector with ALL_TRAFFIC) cannot reach
# LLM provider APIs.
resource "google_compute_router" "main" {
  name    = "${var.project_name}-router"
  region  = var.gcp_region
  network = google_compute_network.main.id
  project = var.project_id
}

resource "google_compute_router_nat" "main" {
  name                               = "${var.project_name}-nat"
  router                             = google_compute_router.main.name
  region                             = var.gcp_region
  project                            = var.project_id
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
