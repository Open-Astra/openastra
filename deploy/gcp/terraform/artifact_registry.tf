resource "google_artifact_registry_repository" "gateway" {
  location      = var.gcp_region
  repository_id = "${var.project_name}-images"
  description   = "Astra gateway Docker images"
  format        = "DOCKER"
  project       = var.project_id

  depends_on = [google_project_service.services]

  labels = {
    environment = "production"
    project     = var.project_name
  }
}
