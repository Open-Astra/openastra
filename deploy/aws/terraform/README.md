# Astra — AWS ECS Fargate Deployment

Deploys Astra on AWS using ECS Fargate (gateway + Typesense), RDS PostgreSQL 17, and an Application Load Balancer.

## Architecture

```
Internet → ALB (HTTP/HTTPS)
  → ECS Gateway Service (Fargate, private subnet, auto-scaling 1–3)
    → RDS PostgreSQL 17 (private subnet, encrypted)
    → Typesense 27.1 (Fargate, EFS for persistence, Service Discovery)
```

## Prerequisites

- [AWS CLI](https://aws.amazon.com/cli/) installed and configured (`aws configure`)
- [Terraform](https://www.terraform.io/downloads) >= 1.5
- Docker image built and pushed to ECR or Docker Hub

## Deploy

```bash
cd deploy/aws/terraform

# Initialize providers
terraform init

# Review plan
terraform plan \
  -var="gateway_image=your-account.dkr.ecr.us-east-1.amazonaws.com/astra:latest" \
  -var="db_password=your-secure-password" \
  -var="jwt_secret=your-jwt-secret" \
  -var="typesense_api_key=your-typesense-key" \
  -var="internal_api_key=your-internal-key" \
  -var="llm_api_key=your-llm-key"

# Apply (creates all resources, ~10 minutes)
terraform apply \
  -var="gateway_image=your-account.dkr.ecr.us-east-1.amazonaws.com/astra:latest" \
  -var="db_password=your-secure-password" \
  -var="jwt_secret=your-jwt-secret" \
  -var="typesense_api_key=your-typesense-key" \
  -var="internal_api_key=your-internal-key" \
  -var="llm_api_key=your-llm-key"
```

Or use a `terraform.tfvars` file:
```hcl
gateway_image     = "your-account.dkr.ecr.us-east-1.amazonaws.com/astra:latest"
db_password       = "your-secure-password"
jwt_secret        = "your-jwt-secret"
typesense_api_key = "your-typesense-key"
internal_api_key  = "your-internal-key"
llm_api_key       = "your-llm-key"
```

## Post-Deploy: Enable pgvector

Connect to RDS and enable the vector extension:

```bash
# Get the RDS endpoint
terraform output rds_endpoint

# Connect via bastion or temporary EC2 (RDS is in private subnet)
psql -h <rds-endpoint> -U postgres -d astra -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

## Update Gateway Image

```bash
# Push new image to ECR
docker build -t astra:latest .
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account>.dkr.ecr.us-east-1.amazonaws.com
docker tag astra:latest <account>.dkr.ecr.us-east-1.amazonaws.com/astra:latest
docker push <account>.dkr.ecr.us-east-1.amazonaws.com/astra:latest

# Force new ECS deployment
aws ecs update-service \
  --cluster astra-cluster \
  --service astra-gateway \
  --force-new-deployment \
  --region us-east-1
```

## Enable HTTPS

1. Request a certificate in ACM for your domain
2. Add to tfvars: `certificate_arn = "arn:aws:acm:us-east-1:..."`
3. `terraform apply` — adds HTTPS listener, redirects HTTP → HTTPS
4. Point your domain's CNAME to the ALB DNS name

## Cost Estimate (us-east-1)

| Resource | Spec | ~Monthly |
|----------|------|---------|
| ECS Fargate (gateway) | 0.5 vCPU, 1GB | ~$15 |
| ECS Fargate (Typesense) | 0.25 vCPU, 0.5GB | ~$8 |
| RDS PostgreSQL | db.t3.micro, 20GB gp3 | ~$15 |
| ALB | 1 instance | ~$18 |
| NAT Gateway | 1 instance | ~$35 |
| EFS | ~1GB | ~$1 |
| **Total** | | **~$92/mo** |

## Teardown

```bash
# Remove deletion protection first
terraform apply -var="..." # with deletion_protection=false in rds.tf
terraform destroy -var="..."
```
