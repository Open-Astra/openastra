resource "digitalocean_droplet" "gateway" {
  name     = "${var.project_name}-gateway-${random_id.suffix.hex}"
  region   = var.do_region
  size     = var.droplet_size
  image    = var.droplet_image
  vpc_uuid = digitalocean_vpc.main.id

  ssh_keys = var.ssh_key_fingerprints

  user_data = templatefile("${path.module}/templates/cloud-init.yml.tftpl", {
    project_name      = var.project_name
    gateway_image     = var.gateway_image
    jwt_secret        = var.jwt_secret
    internal_api_key  = var.internal_api_key
    typesense_api_key = var.typesense_api_key
    llm_api_key       = var.llm_api_key
    db_host           = digitalocean_database_cluster.postgres.private_host
    db_port           = digitalocean_database_cluster.postgres.port
    db_user           = digitalocean_database_cluster.postgres.user
    db_password       = digitalocean_database_cluster.postgres.password
    db_name           = digitalocean_database_db.astra.name
    db_sslmode        = "require"
    volume_name       = digitalocean_volume.typesense_data.name
  })

  tags = [
    var.project_name,
    var.environment,
    "gateway"
  ]

  lifecycle {
    create_before_destroy = true
  }
}

resource "digitalocean_floating_ip" "gateway" {
  count  = var.floating_ip ? 1 : 0
  region = var.do_region
}

resource "digitalocean_floating_ip_assignment" "gateway" {
  count      = var.floating_ip ? 1 : 0
  ip_address = digitalocean_floating_ip.gateway[0].ip_address
  droplet_id = digitalocean_droplet.gateway.id
}
