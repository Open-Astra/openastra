resource "digitalocean_volume" "typesense_data" {
  region                  = var.do_region
  name                    = "${var.project_name}-typesense-data-${random_id.suffix.hex}"
  size                    = var.typesense_volume_size
  initial_filesystem_type = "ext4"
  description             = "Persistent storage for Typesense search data"
}

resource "digitalocean_volume_attachment" "typesense_data" {
  droplet_id = digitalocean_droplet.gateway.id
  volume_id  = digitalocean_volume.typesense_data.id
}
