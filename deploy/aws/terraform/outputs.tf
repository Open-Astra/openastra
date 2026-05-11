output "gateway_url" {
  description = "Gateway URL (HTTP or HTTPS if certificate configured)"
  value       = var.certificate_arn != "" ? "https://${aws_lb.main.dns_name}" : "http://${aws_lb.main.dns_name}"
}

output "rds_endpoint" {
  description = "RDS PostgreSQL endpoint (without port)"
  value       = aws_db_instance.main.address
  sensitive   = false
}

output "rds_port" {
  description = "RDS PostgreSQL port"
  value       = aws_db_instance.main.port
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.main.name
}

output "typesense_service_discovery_name" {
  description = "Typesense service discovery DNS name (used by gateway)"
  value       = "typesense.astra.local"
}

output "alb_dns_name" {
  description = "Raw ALB DNS name"
  value       = aws_lb.main.dns_name
}
