output "cloud_run_url" {
  description = "Cloud Run gateway service URL"
  value       = google_cloud_run_v2_service.gateway.uri
}

output "cloud_sql_private_ip" {
  description = "Cloud SQL private IP address"
  value       = google_sql_database_instance.main.private_ip_address
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL connection name (for Cloud SQL Proxy)"
  value       = google_sql_database_instance.main.connection_name
}

output "typesense_vm_internal_ip" {
  description = "Typesense GCE VM internal IP address"
  value       = google_compute_address.typesense_internal.address
}

output "artifact_registry_url" {
  description = "Artifact Registry URL for pushing Docker images"
  value       = "${var.gcp_region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.gateway.repository_id}"
}
