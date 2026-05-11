# ── Gateway service account ───────────────────────────────────────
resource "google_service_account" "gateway" {
  account_id   = "${var.project_name}-gateway"
  display_name = "Astra Gateway Service Account"
  project      = var.project_id
}

# Allow Cloud Run gateway to connect to Cloud SQL
resource "google_project_iam_member" "gateway_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.gateway.email}"
}

# Allow Cloud Run gateway to read secrets
resource "google_project_iam_member" "gateway_secrets" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.gateway.email}"
}

# Allow Cloud Run gateway to pull images from Artifact Registry
resource "google_project_iam_member" "gateway_registry" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.gateway.email}"
}

# Make Cloud Run service publicly accessible
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  project  = var.project_id
  location = var.gcp_region
  name     = google_cloud_run_v2_service.gateway.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
