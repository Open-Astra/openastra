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

    startup-script = <<-EOF
      #!/bin/bash
      set -e

      # Mount the data disk
      if ! blkid /dev/disk/by-id/google-typesense-data; then
        mkfs.ext4 -F /dev/disk/by-id/google-typesense-data
      fi
      mkdir -p /data
      mount /dev/disk/by-id/google-typesense-data /data || true
      echo "/dev/disk/by-id/google-typesense-data /data ext4 defaults,nofail 0 2" >> /etc/fstab

      # Run Typesense in Docker
      docker run -d \
        --name typesense \
        --restart always \
        -p 8108:8108 \
        -v /data:/data \
        -e TYPESENSE_API_KEY="${var.typesense_api_key}" \
        typesense/typesense:27.1 \
        --data-dir /data \
        --api-key "${var.typesense_api_key}" \
        --enable-cors
    EOF
  }

  service_account {
    scopes = ["cloud-platform"]
  }

  labels = {
    environment = "production"
    project     = var.project_name
  }
}
