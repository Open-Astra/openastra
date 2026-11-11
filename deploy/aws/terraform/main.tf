terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }

  # ── Remote state (strongly recommended) ──────────────────────────
  # Terraform state contains every secret passed in via variables (DB
  # password, JWT secret, API keys) in PLAINTEXT. Without a backend block
  # that state is a local terraform.tfstate file. Uncomment and fill in an
  # encrypted, access-controlled S3 backend before applying for real:
  #
  # backend "s3" {
  #   bucket         = "my-org-terraform-state"   # versioned, SSE-KMS, private
  #   key            = "astra/terraform.tfstate"
  #   region         = "us-east-1"
  #   encrypt        = true
  #   dynamodb_table = "terraform-locks"
  # }
}

provider "aws" {
  region = var.aws_region
}

data "aws_availability_zones" "available" {
  state = "available"
}

resource "random_id" "suffix" {
  byte_length = 4
}
