resource "digitalocean_database_cluster" "postgres" {
  name                 = "${var.project_name}-db-${random_id.suffix.hex}"
  engine               = "pg"
  version              = "17"
  size                 = var.db_size
  region               = var.do_region
  node_count           = var.db_node_count
  private_network_uuid = digitalocean_vpc.main.id

  maintenance_window {
    day  = "monday"
    hour = "04:00:00"
  }
}

resource "digitalocean_database_db" "astra" {
  cluster_id = digitalocean_database_cluster.postgres.id
  name       = "astra"
}

resource "digitalocean_database_firewall" "postgres" {
  cluster_id = digitalocean_database_cluster.postgres.id

  rule {
    type  = "droplet"
    value = digitalocean_droplet.gateway.id
  }
}
