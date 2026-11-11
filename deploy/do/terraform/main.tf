terraform {
  required_version = ">= 1.5"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }

  # ── Remote state (strongly recommended) ──────────────────────────
  # Terraform state contains every secret (API token, JWT secret, DB
  # password, API keys) in PLAINTEXT, and so does the Droplet's user-data
  # (see README "Security notes"). Keep state in a private, encrypted
  # bucket rather than a local terraform.tfstate. DigitalOcean Spaces is
  # S3-compatible:
  #
  # backend "s3" {
  #   endpoints                   = { s3 = "https://nyc3.digitaloceanspaces.com" }
  #   bucket                      = "my-org-terraform-state"
  #   key                         = "astra/terraform.tfstate"
  #   region                      = "us-east-1" # ignored by Spaces, required by Terraform
  #   skip_credentials_validation = true
  #   skip_requesting_account_id  = true
  #   skip_metadata_api_check     = true
  #   skip_region_validation      = true
  #   skip_s3_checksum            = true
  # }
}

provider "digitalocean" {
  token = var.do_token
}

resource "random_id" "suffix" {
  byte_length = 4
}
