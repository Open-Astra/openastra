resource "digitalocean_domain" "main" {
  count = var.domain != "" ? 1 : 0
  name  = var.domain
}

resource "digitalocean_record" "gateway_a" {
  count  = var.domain != "" ? 1 : 0
  domain = digitalocean_domain.main[0].id
  type   = "A"
  name   = "@"
  value  = var.floating_ip ? digitalocean_floating_ip.gateway[0].ip_address : digitalocean_droplet.gateway.ipv4_address
  ttl    = 300
}

resource "digitalocean_record" "gateway_api" {
  count  = var.domain != "" ? 1 : 0
  domain = digitalocean_domain.main[0].id
  type   = "A"
  name   = "api"
  value  = var.floating_ip ? digitalocean_floating_ip.gateway[0].ip_address : digitalocean_droplet.gateway.ipv4_address
  ttl    = 300
}
