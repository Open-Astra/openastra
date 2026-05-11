# ── Private IP range for VPC peering ─────────────────────────────
resource "google_compute_global_address" "cloudsql_private_ip" {
  name          = "${var.project_name}-cloudsql-private-ip"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.main.id

  depends_on = [google_project_service.services]
}

resource "google_service_networking_connection" "cloudsql_vpc_peering" {
  network                 = google_compute_network.main.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.cloudsql_private_ip.name]

  depends_on = [google_project_service.services]
}

# ── Cloud SQL PostgreSQL 17 ───────────────────────────────────────
resource "google_sql_database_instance" "main" {
  name             = "${var.project_name}-db-${random_id.suffix.hex}"
  database_version = "POSTGRES_17"
  region           = var.gcp_region
  project          = var.project_id

  deletion_protection = true

  settings {
    tier = var.db_tier

    ip_configuration {
      ipv4_enabled                                  = false
      private_network                               = google_compute_network.main.id
      enable_private_path_for_google_cloud_services = true
    }

    backup_configuration {
      enabled                        = true
      start_time                     = "03:00"
      point_in_time_recovery_enabled = true
      transaction_log_retention_days = 7
      backup_retention_settings {
        retained_backups = 7
      }
    }

    database_flags {
      name  = "max_connections"
      value = "100"
    }

    insights_config {
      query_insights_enabled = true
    }
  }

  depends_on = [google_service_networking_connection.cloudsql_vpc_peering]
}

resource "google_sql_database" "astra" {
  name     = "astra"
  instance = google_sql_database_instance.main.name
  project  = var.project_id
}

resource "google_sql_user" "postgres" {
  name     = "postgres"
  instance = google_sql_database_instance.main.name
  password = var.db_password
  project  = var.project_id
}
