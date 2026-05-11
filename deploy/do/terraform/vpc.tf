resource "digitalocean_vpc" "main" {
  name     = "${var.project_name}-vpc-${random_id.suffix.hex}"
  region   = var.do_region
  ip_range = "10.10.0.0/16"
}
