# ── VPC for private connectivity ──────────────────────────────────
resource "google_compute_network" "main" {
  name                    = "${var.project_name}-vpc"
  auto_create_subnetworks = false
  project                 = var.project_id

  depends_on = [google_project_service.services]
}

resource "google_compute_subnetwork" "main" {
  name          = "${var.project_name}-subnet"
  ip_cidr_range = "10.0.0.0/24"
  region        = var.gcp_region
  network       = google_compute_network.main.id
  project       = var.project_id
}

# ── VPC Access Connector (Cloud Run → private VPC) ────────────────
resource "google_vpc_access_connector" "main" {
  name          = "${var.project_name}-connector"
  region        = var.gcp_region
  project       = var.project_id
  ip_cidr_range = "10.8.0.0/28"
  network       = google_compute_network.main.name
  min_instances = 2
  max_instances = 3

  depends_on = [google_project_service.services]
}

# ── Cloud Run Gateway Service ─────────────────────────────────────
resource "google_cloud_run_v2_service" "gateway" {
  name     = "${var.project_name}-gateway"
  location = var.gcp_region
  project  = var.project_id

  template {
    service_account = google_service_account.gateway.email

    scaling {
      min_instance_count = var.min_instances
      max_instance_count = var.max_instances
    }

    vpc_access {
      connector = google_vpc_access_connector.main.id
      egress    = "ALL_TRAFFIC"
    }

    containers {
      image = var.gateway_image

      ports {
        container_port = 8080
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PORT"
        value = "8080"
      }
      env {
        name  = "PG_HOST"
        value = google_sql_database_instance.main.private_ip_address
      }
      env {
        name  = "PG_USER"
        value = "postgres"
      }
      env {
        name  = "PG_DATABASE"
        value = "astra"
      }
      env {
        name  = "PG_PORT"
        value = "5432"
      }
      env {
        name  = "TYPESENSE_HOST"
        value = google_compute_address.typesense_internal.address
      }
      env {
        name  = "TYPESENSE_PORT"
        value = "8108"
      }

      env {
        name = "JWT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.jwt_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "PG_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.db_password.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "TYPESENSE_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.typesense_api_key.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "INTERNAL_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.internal_api_key.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "LLM_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.llm_api_key.secret_id
            version = "latest"
          }
        }
      }

      startup_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 10
        timeout_seconds       = 5
        period_seconds        = 10
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/health"
          port = 8080
        }
        initial_delay_seconds = 30
        timeout_seconds       = 5
        period_seconds        = 30
        failure_threshold     = 3
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "1Gi"
        }
      }
    }
  }

  depends_on = [
    google_project_service.services,
    google_vpc_access_connector.main,
    google_sql_database_instance.main,
    google_compute_instance.typesense,
  ]
}
