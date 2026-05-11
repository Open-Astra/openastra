variable "do_token" {
  description = "DigitalOcean API token"
  type        = string
  sensitive   = true
}

variable "do_region" {
  description = "DigitalOcean region"
  type        = string
  default     = "nyc1"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "astra"
}

variable "environment" {
  description = "Deployment environment"
  type        = string
  default     = "production"
}

# --- Compute ---

variable "droplet_size" {
  description = "Droplet size slug (s-1vcpu-2gb=$12/mo, s-2vcpu-4gb=$24/mo, s-4vcpu-8gb=$48/mo)"
  type        = string
  default     = "s-2vcpu-4gb"
}

variable "droplet_image" {
  description = "Droplet OS image"
  type        = string
  default     = "ubuntu-24-04-x64"
}

variable "ssh_key_fingerprints" {
  description = "List of SSH key fingerprints to add to the Droplet"
  type        = list(string)
}

variable "gateway_image" {
  description = "Docker image for the gateway (e.g. registry.digitalocean.com/astra/gateway:latest)"
  type        = string
}

# --- Database ---

variable "db_size" {
  description = "Managed database size slug"
  type        = string
  default     = "db-s-1vcpu-1gb"
}

variable "db_node_count" {
  description = "Number of database nodes (1=single, 2+=HA)"
  type        = number
  default     = 1
}

# --- Volumes ---

variable "typesense_volume_size" {
  description = "Block storage volume size in GB for Typesense data"
  type        = number
  default     = 20
}

# --- Secrets ---

variable "db_password" {
  description = "PostgreSQL password (auto-set by managed DB, used for gateway env)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "jwt_secret" {
  description = "JWT signing secret (32+ hex chars)"
  type        = string
  sensitive   = true
}

variable "typesense_api_key" {
  description = "Typesense API key"
  type        = string
  sensitive   = true
}

variable "internal_api_key" {
  description = "Internal service-to-service API key"
  type        = string
  sensitive   = true
}

variable "llm_api_key" {
  description = "Primary LLM provider API key (Anthropic, OpenAI, etc.)"
  type        = string
  sensitive   = true
}

# --- Optional ---

variable "domain" {
  description = "Domain name to point to the Droplet (optional)"
  type        = string
  default     = ""
}

variable "floating_ip" {
  description = "Create a floating IP for stable addressing"
  type        = bool
  default     = true
}
