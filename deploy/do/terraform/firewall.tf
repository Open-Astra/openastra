resource "digitalocean_firewall" "gateway" {
  name = "${var.project_name}-gateway-fw-${random_id.suffix.hex}"

  droplet_ids = [digitalocean_droplet.gateway.id]

  # SSH — restricted to var.ssh_allowed_cidrs (never 0.0.0.0/0)
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.ssh_allowed_cidrs
  }

  # Gateway API — plain HTTP on 8080, restricted to var.gateway_allowed_cidrs.
  # Terminate TLS in front of it (DO Load Balancer or a reverse proxy) and
  # list only that source here. Ports 80/443 are not opened: nothing on the
  # Droplet listens on them.
  inbound_rule {
    protocol         = "tcp"
    port_range       = "8080"
    source_addresses = var.gateway_allowed_cidrs
  }

  # ICMP (ping)
  inbound_rule {
    protocol         = "icmp"
    source_addresses = ["0.0.0.0/0", "::/0"]
  }

  # All outbound
  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }

  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}
