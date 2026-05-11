resource "digitalocean_project" "main" {
  name        = var.project_name
  description = "Astra AI Agent Platform"
  purpose     = "Service or API"
  environment = var.environment == "production" ? "Production" : "Development"

  resources = compact([
    digitalocean_droplet.gateway.urn,
    digitalocean_database_cluster.postgres.urn,
    digitalocean_volume.typesense_data.urn,
    digitalocean_container_registry.main.urn,
    var.floating_ip ? digitalocean_floating_ip.gateway[0].urn : "",
    var.domain != "" ? digitalocean_domain.main[0].urn : "",
  ])
}
