#!/usr/bin/env bash
# ── Astra Agent Runtime — One-Click AWS EC2 Deploy ──
#
# Creates an EC2 instance with the full Astra stack running via Docker Compose.
# Uses Amazon Linux 2023, Elastic IP, and a new security group.
#
# Prerequisites:
#   - AWS CLI installed and configured (aws configure)
#   - An EC2 key pair created in your target region
#
# Usage:
#   ./deploy/aws/ec2/deploy.sh
#
# After deploy (~5 minutes):
#   ssh -i ~/.ssh/your-key.pem ec2-user@<ip>
#   cd /opt/astra && docker compose logs -f

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────
REGION="us-east-1"
INSTANCE_TYPE="t3.small"   # 2 vCPU, 2GB RAM — ~$15/mo
SG_NAME="astra-sg"
INSTANCE_NAME="astra"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[info]${NC} $*"; }
success() { echo -e "${GREEN}[ok]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC} $*"; }
fatal()   { echo -e "${RED}[fail]${NC} $*" >&2; exit 1; }

# ── Check dependencies ────────────────────────────────────────────
command -v aws  &>/dev/null || fatal "AWS CLI not found. Install: https://aws.amazon.com/cli/"
command -v curl &>/dev/null || fatal "curl not found"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║       Astra — AWS EC2 One-Click Deployer             ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Gather input ──────────────────────────────────────────────────
read -rp "AWS region           [${REGION}]: "        input; REGION="${input:-$REGION}"
read -rp "Instance type        [${INSTANCE_TYPE}]: " input; INSTANCE_TYPE="${input:-$INSTANCE_TYPE}"
read -rp "EC2 key pair name    (required): "         KEY_NAME
[[ -z "${KEY_NAME:-}" ]] && fatal "Key pair name is required"

echo ""
info "Secrets (will be written to .env on the instance):"
read -rsp "JWT_SECRET           : " JWT_SECRET;        echo
read -rsp "TYPESENSE_API_KEY    : " TYPESENSE_API_KEY; echo
read -rsp "INTERNAL_API_KEY     : " INTERNAL_API_KEY;  echo
read -rsp "PG_PASSWORD          : " PG_PASSWORD;       echo
read -rsp "LLM API key          : " LLM_API_KEY;       echo

echo ""
info "Deploying to ${REGION} on ${INSTANCE_TYPE}..."

# ── Security Group ────────────────────────────────────────────────
info "Creating security group '${SG_NAME}'..."
VPC_ID=$(aws ec2 describe-vpcs \
  --region "${REGION}" \
  --filters "Name=isDefault,Values=true" \
  --query "Vpcs[0].VpcId" \
  --output text)

SG_ID=$(aws ec2 describe-security-groups \
  --region "${REGION}" \
  --filters "Name=group-name,Values=${SG_NAME}" "Name=vpc-id,Values=${VPC_ID}" \
  --query "SecurityGroups[0].GroupId" \
  --output text 2>/dev/null || echo "None")

if [[ "${SG_ID}" == "None" ]] || [[ -z "${SG_ID}" ]]; then
  SG_ID=$(aws ec2 create-security-group \
    --region "${REGION}" \
    --group-name "${SG_NAME}" \
    --description "Astra agent runtime security group" \
    --vpc-id "${VPC_ID}" \
    --query "GroupId" \
    --output text)

  MY_IP=$(curl -s https://checkip.amazonaws.com)
  aws ec2 authorize-security-group-ingress --region "${REGION}" --group-id "${SG_ID}" \
    --ip-permissions \
    "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=${MY_IP}/32,Description=SSH}]" \
    "IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0,Description=HTTP}]" \
    "IpProtocol=tcp,FromPort=8080,ToPort=8080,IpRanges=[{CidrIp=0.0.0.0/0,Description=Astra}]" \
    > /dev/null
  success "Created security group ${SG_ID}"
else
  success "Using existing security group ${SG_ID}"
fi

# ── Latest Amazon Linux 2023 AMI ──────────────────────────────────
info "Looking up latest Amazon Linux 2023 AMI..."
AMI_ID=$(aws ec2 describe-images \
  --region "${REGION}" \
  --owners amazon \
  --filters \
    "Name=name,Values=al2023-ami-2023*-x86_64" \
    "Name=state,Values=available" \
  --query "sort_by(Images, &CreationDate)[-1].ImageId" \
  --output text)
success "AMI: ${AMI_ID}"

# ── User data script ──────────────────────────────────────────────
USER_DATA=$(cat <<USERDATA
#!/bin/bash
set -euo pipefail

# Install Docker
dnf install -y docker
systemctl enable --now docker
usermod -aG docker ec2-user

# Install Docker Compose
curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64" \
  -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Create app directory
mkdir -p /opt/astra
cd /opt/astra

# Write .env
cat > .env <<'ENV'
NODE_ENV=production
PORT=8080
JWT_SECRET=${JWT_SECRET}
TYPESENSE_API_KEY=${TYPESENSE_API_KEY}
INTERNAL_API_KEY=${INTERNAL_API_KEY}
PG_HOST=postgres
PG_PORT=5432
PG_USER=postgres
PG_PASSWORD=${PG_PASSWORD}
PG_DATABASE=astra
TYPESENSE_HOST=typesense
TYPESENSE_PORT=8108
LLM_API_KEY=${LLM_API_KEY}
ENV

# Write docker-compose.yml
cat > docker-compose.yml <<'COMPOSE'
version: "3.9"
services:
  postgres:
    image: pgvector/pgvector:pg17
    restart: unless-stopped
    environment:
      POSTGRES_DB: astra
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: \${PG_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  typesense:
    image: typesense/typesense:27.1
    restart: unless-stopped
    command: --data-dir /data --api-key \${TYPESENSE_API_KEY} --enable-cors
    volumes:
      - typesense_data:/data
    healthcheck:
      test: ["CMD-SHELL", "curl -sf http://localhost:8108/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5

  gateway:
    image: ghcr.io/your-org/astra:latest
    restart: unless-stopped
    ports:
      - "80:8080"
    env_file: .env
    depends_on:
      postgres:
        condition: service_healthy
      typesense:
        condition: service_healthy

volumes:
  postgres_data:
  typesense_data:
COMPOSE

docker-compose up -d
USERDATA
)

# ── Launch instance ───────────────────────────────────────────────
info "Launching EC2 instance..."
INSTANCE_ID=$(aws ec2 run-instances \
  --region "${REGION}" \
  --image-id "${AMI_ID}" \
  --instance-type "${INSTANCE_TYPE}" \
  --key-name "${KEY_NAME}" \
  --security-group-ids "${SG_ID}" \
  --user-data "${USER_DATA}" \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3"}}]' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${INSTANCE_NAME}}]" \
  --query "Instances[0].InstanceId" \
  --output text)
success "Launched instance ${INSTANCE_ID}"

# ── Allocate Elastic IP ───────────────────────────────────────────
info "Allocating Elastic IP..."
EIP_ALLOC=$(aws ec2 allocate-address --region "${REGION}" --domain vpc --query "AllocationId" --output text)

info "Waiting for instance to be running..."
aws ec2 wait instance-running --region "${REGION}" --instance-ids "${INSTANCE_ID}"

info "Associating Elastic IP..."
aws ec2 associate-address \
  --region "${REGION}" \
  --instance-id "${INSTANCE_ID}" \
  --allocation-id "${EIP_ALLOC}" \
  > /dev/null

PUBLIC_IP=$(aws ec2 describe-addresses \
  --region "${REGION}" \
  --allocation-ids "${EIP_ALLOC}" \
  --query "Addresses[0].PublicIp" \
  --output text)

# ── Done ──────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║             Astra Deployed on AWS EC2                ║"
echo "╠══════════════════════════════════════════════════════╣"
printf "║  Instance ID  : %-36s║\n" "${INSTANCE_ID}"
printf "║  Public IP    : %-36s║\n" "${PUBLIC_IP}"
printf "║  Region       : %-36s║\n" "${REGION}"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Next steps:                                         ║"
echo "║  1. Wait ~3 minutes for Docker Compose to start     ║"
printf "║  2. curl http://%-36s║\n" "${PUBLIC_IP}/health"
printf "║  3. ssh -i ~/.ssh/%s.pem ec2-user@%s\n" "${KEY_NAME}" "${PUBLIC_IP}"
echo "║  4. Update gateway image in docker-compose.yml      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
warn "Remember to add your LLM API keys to /opt/astra/.env and restart."
