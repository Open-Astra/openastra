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

# Secret access for the gateway is granted PER SECRET in secrets.tf
# (google_secret_manager_secret_iam_member.*_gateway). There is deliberately
# no project-wide roles/secretmanager.secretAccessor binding: a compromised
# gateway must not be able to read every secret in the project.

# ── Typesense VM service account (least privilege) ────────────────
# Replaces the default Compute Engine service account (project Editor).
# It can read exactly one secret — the Typesense API key — and write logs.
resource "google_service_account" "typesense" {
  account_id   = "${var.project_name}-typesense"
  display_name = "Astra Typesense VM Service Account"
  project      = var.project_id
}

resource "google_secret_manager_secret_iam_member" "typesense_api_key_vm" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.typesense_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.typesense.email}"
}

resource "google_project_iam_member" "typesense_logging" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.typesense.email}"
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
