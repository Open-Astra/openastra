# Astra — GCP Cloud Run Deployment

Deploys Astra on GCP using Cloud Run (gateway), Cloud SQL PostgreSQL 17 (private IP), and a GCE VM for Typesense persistence.

## Architecture

```
Internet → Cloud Run Gateway (auto-scales 0–3, private VPC egress)
  → Cloud SQL PostgreSQL 17 (private IP, pgvector extension)
  → Typesense 27.1 (e2-small GCE VM, persistent disk)
```

**Why a GCE VM for Typesense?** Cloud Run is stateless — containers cannot mount persistent disks. Typesense requires `/data` to survive restarts. A small `e2-small` GCE VM (~$12/mo) with a 20GB persistent SSD is the cleanest solution.

## Prerequisites

- [gcloud CLI](https://cloud.google.com/sdk/docs/install) installed and authenticated
- [Terraform](https://www.terraform.io/downloads) >= 1.5
- A GCP project with billing enabled
- Docker image built and pushed to Artifact Registry

## Deploy

```bash
cd deploy/gcp/terraform

# Authenticate
gcloud auth application-default login

# Initialize providers
terraform init

# Review plan
terraform plan \
  -var="project_id=your-gcp-project-id" \
  -var="gateway_image=us-central1-docker.pkg.dev/your-project/astra-images/gateway:latest" \
  -var="db_password=your-secure-password" \
  -var="jwt_secret=your-jwt-secret" \
  -var="typesense_api_key=your-typesense-key" \
  -var="internal_api_key=your-internal-key" \
  -var="llm_api_key=your-llm-key"

# Apply (~15 minutes for first deploy)
terraform apply -var="project_id=your-gcp-project-id" # ... same vars
```

Or use a `terraform.tfvars` file:
```hcl
project_id        = "your-gcp-project-id"
gateway_image     = "us-central1-docker.pkg.dev/your-project/astra-images/gateway:latest"
db_password       = "your-secure-password"
jwt_secret        = "your-jwt-secret"
typesense_api_key = "your-typesense-key"
internal_api_key  = "your-internal-key"
llm_api_key       = "your-llm-key"
```

## Push Docker Image

```bash
# Configure Docker for Artifact Registry
gcloud auth configure-docker us-central1-docker.pkg.dev

# Get the registry URL
terraform output artifact_registry_url

# Build and push
docker build -t us-central1-docker.pkg.dev/YOUR_PROJECT/astra-images/gateway:latest .
docker push us-central1-docker.pkg.dev/YOUR_PROJECT/astra-images/gateway:latest
```

## Post-Deploy: Enable pgvector

```bash
# Get Cloud SQL connection name
terraform output cloud_sql_connection_name

# Connect via Cloud SQL Proxy
cloud-sql-proxy YOUR_PROJECT:us-central1:astra-db-XXXX &
psql -h 127.0.0.1 -U postgres -d astra -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

## Scale to Zero

By default `min_instances = 0` — Cloud Run scales to zero when idle. For always-on:
```hcl
min_instances = 1
```

## Cost Estimate (us-central1)

| Resource | Spec | ~Monthly |
|----------|------|---------|
| Cloud Run | 1 vCPU, 1GB, ~idle | ~$0–5 |
| Cloud SQL | db-f1-micro, 10GB | ~$7 |
| GCE VM (Typesense) | e2-small | ~$12 |
| Persistent disk | 20GB pd-ssd | ~$3 |
| VPC Connector | 2 instances | ~$15 |
| **Total** | | **~$37–42/mo** |

## Teardown

```bash
# Remove deletion protection first (edit cloud_sql.tf: deletion_protection = false)
terraform apply -var="project_id=..." # ... other vars
terraform destroy -var="project_id=..." # ... other vars
```
