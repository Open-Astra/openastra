output "gateway_ip" {
  description = "Public IP address of the gateway Droplet"
  value       = var.floating_ip ? digitalocean_floating_ip.gateway[0].ip_address : digitalocean_droplet.gateway.ipv4_address
}

output "gateway_url" {
  description = "Gateway URL"
  value       = "http://${var.floating_ip ? digitalocean_floating_ip.gateway[0].ip_address : digitalocean_droplet.gateway.ipv4_address}:8080"
}

output "gateway_private_ip" {
  description = "Private IP of the gateway Droplet (VPC)"
  value       = digitalocean_droplet.gateway.ipv4_address_private
}

output "database_host" {
  description = "Managed PostgreSQL private host"
  value       = digitalocean_database_cluster.postgres.private_host
}

output "database_port" {
  description = "Managed PostgreSQL port"
  value       = digitalocean_database_cluster.postgres.port
}

output "database_uri" {
  description = "Managed PostgreSQL private connection URI"
  value       = digitalocean_database_cluster.postgres.private_uri
  sensitive   = true
}

output "registry_endpoint" {
  description = "Container registry endpoint for Docker image pushes"
  value       = digitalocean_container_registry.main.endpoint
}

output "ssh_command" {
  description = "SSH into the gateway Droplet"
  value       = "ssh root@${var.floating_ip ? digitalocean_floating_ip.gateway[0].ip_address : digitalocean_droplet.gateway.ipv4_address}"
}

output "domain_url" {
  description = "Domain URL (if configured)"
  value       = var.domain != "" ? "https://${var.domain}" : "n/a"
}
