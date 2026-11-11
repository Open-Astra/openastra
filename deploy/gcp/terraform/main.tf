terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }

  # ── Remote state (strongly recommended) ──────────────────────────
  # Terraform state contains every secret passed in via variables in
  # PLAINTEXT. Without a backend block that state is a local
  # terraform.tfstate file. Uncomment and point at a private, versioned GCS
  # bucket (ideally with CMEK) before applying for real:
  #
  # backend "gcs" {
  #   bucket = "my-org-terraform-state"
  #   prefix = "astra"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.gcp_region
}

resource "random_id" "suffix" {
  byte_length = 4
}

# ── Enable required GCP APIs ──────────────────────────────────────
resource "google_project_service" "services" {
  for_each = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "vpcaccess.googleapis.com",
    "servicenetworking.googleapis.com",
    "compute.googleapis.com",
  ])

  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}
