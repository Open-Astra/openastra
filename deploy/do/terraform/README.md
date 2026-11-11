# Astra — DigitalOcean Terraform Deployment

Droplet (gateway + Typesense via Docker Compose), managed PostgreSQL, a block
storage volume for Typesense data, and a cloud firewall.

## Deploy

```bash
cd deploy/do/terraform
cp terraform.tfvars.example terraform.tfvars   # git-ignored — never commit
# edit terraform.tfvars: ssh keys, allowed CIDRs, image tag

export TF_VAR_do_token="dop_v1_..."
export TF_VAR_jwt_secret="$(openssl rand -hex 32)"
export TF_VAR_internal_api_key="$(openssl rand -hex 32)"
export TF_VAR_typesense_api_key="$(openssl rand -hex 24)"
read -rs TF_VAR_llm_api_key && export TF_VAR_llm_api_key

terraform init
terraform plan
terraform apply
```

## Security notes

- **Secrets travel in Droplet user-data.** DigitalOcean has no managed secret
  store, so `templates/cloud-init.yml.tftpl` writes `/opt/astra/.env` from
  Terraform variables. User-data remains readable from the Droplet metadata
  service (`169.254.169.254`) and through the DO API for the Droplet's
  lifetime. If that is not acceptable, use the AWS or GCP stacks (which use
  Secrets Manager / Secret Manager), or rotate the secrets on the Droplet
  after first boot and keep the rotated values out of Terraform.
- **State holds the same secrets in plaintext.** Configure the remote backend
  stub in `main.tf`; never commit `terraform.tfstate` or `terraform.tfvars`.
- **Network access is opt-in.** `ssh_allowed_cidrs` and
  `gateway_allowed_cidrs` have no defaults, and SSH cannot be opened to
  `0.0.0.0/0`.
- **The gateway serves plain HTTP on :8080.** Put a DigitalOcean Load Balancer
  (with a managed certificate) or a TLS reverse proxy in front of it and
  restrict `gateway_allowed_cidrs` to that source. Do not send real
  credentials to `http://<droplet-ip>:8080` over the internet.
- Typesense is bound to `127.0.0.1` on the Droplet; PostgreSQL is reachable
  only over the VPC with TLS required.
- Pin `gateway_image` to an immutable version tag or digest, not `:latest`.
