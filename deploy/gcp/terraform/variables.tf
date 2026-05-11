variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "gcp_region" {
  description = "GCP region for deployment"
  type        = string
  default     = "us-central1"
}

variable "gcp_zone" {
  description = "GCP zone for Compute Engine resources"
  type        = string
  default     = "us-central1-a"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "astra"
}

variable "gateway_image" {
  description = "Docker image URI for the Astra gateway (Artifact Registry or Docker Hub)"
  type        = string
}

variable "db_tier" {
  description = "Cloud SQL instance tier"
  type        = string
  default     = "db-f1-micro"
}

variable "min_instances" {
  description = "Minimum Cloud Run instances (0 = scale to zero)"
  type        = number
  default     = 0
}

variable "max_instances" {
  description = "Maximum Cloud Run instances"
  type        = number
  default     = 3
}

variable "typesense_machine_type" {
  description = "GCE machine type for the Typesense VM"
  type        = string
  default     = "e2-small"
}

variable "db_password" {
  description = "Cloud SQL PostgreSQL master password"
  type        = string
  sensitive   = true
}

variable "jwt_secret" {
  description = "JWT signing secret"
  type        = string
  sensitive   = true
}

variable "typesense_api_key" {
  description = "Typesense API key"
  type        = string
  sensitive   = true
}

variable "internal_api_key" {
  description = "Internal API key for service-to-service auth"
  type        = string
  sensitive   = true
}

variable "llm_api_key" {
  description = "Primary LLM provider API key"
  type        = string
  sensitive   = true
}
