variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
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

variable "gateway_image" {
  description = "Docker image URI for the Astra gateway (ECR or Docker Hub)"
  type        = string
}

variable "db_instance_class" {
  description = "RDS instance class"
  type        = string
  default     = "db.t3.micro"
}

variable "gateway_cpu" {
  description = "ECS task CPU units for the gateway (1024 = 1 vCPU)"
  type        = number
  default     = 512
}

variable "gateway_memory" {
  description = "ECS task memory (MiB) for the gateway"
  type        = number
  default     = 1024
}

variable "min_capacity" {
  description = "Minimum number of gateway ECS tasks"
  type        = number
  default     = 1
}

variable "max_capacity" {
  description = "Maximum number of gateway ECS tasks"
  type        = number
  default     = 3
}

variable "certificate_arn" {
  description = "ACM certificate ARN for HTTPS (leave empty to use HTTP only)"
  type        = string
  default     = ""
}

variable "db_password" {
  description = "PostgreSQL master password"
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
