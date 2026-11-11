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
#
# Security model:
#   * Secrets are stored as SSM SecureString parameters under
#     /astra/<instance-name>/ and read by the instance through a dedicated
#     IAM role scoped to that path. Nothing secret is placed in user-data.
#   * IMDSv2 is required, with hop limit 1 so containers cannot reach it.
#   * SSH is limited to your current IP; :8080 to a CIDR you choose.
#   * The gateway is plain HTTP — front it with TLS before production use.

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────
REGION="us-east-1"
INSTANCE_TYPE="t3.small"   # 2 vCPU, 2GB RAM — ~$15/mo
SG_NAME="astra-sg"
INSTANCE_NAME="astra"
REPO_URL="https://github.com/Open-Astra/openastra.git"
REPO_REF="main"
COMPOSE_VERSION="v2.29.7"   # pinned — bump deliberately
BUILDX_VERSION="v0.17.1"    # pinned — bump deliberately

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[info]${NC} $*"; }
success() { echo -e "${GREEN}[ok]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC} $*"; }
fatal()   { echo -e "${RED}[fail]${NC} $*" >&2; exit 1; }

# ── Check dependencies ────────────────────────────────────────────
command -v aws  &>/dev/null || fatal "AWS CLI not found. Install: https://aws.amazon.com/cli/"
command -v curl &>/dev/null || fatal "curl not found"
command -v openssl &>/dev/null || fatal "openssl not found"

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

MY_IP=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
[[ "${MY_IP}" =~ ^[0-9.]+$ ]] || fatal "Could not determine your public IP"
echo ""
info "Ingress. SSH is always limited to your IP (${MY_IP}/32)."
info "The gateway listens on plain HTTP :8080 — keep it limited to trusted"
info "addresses until you put a TLS-terminating proxy or ALB in front of it."
read -rp "CIDR allowed to reach :8080 [${MY_IP}/32]: " input; APP_CIDR="${input:-${MY_IP}/32}"
[[ "${APP_CIDR}" =~ ^[0-9.]+/[0-9]{1,2}$ ]] || fatal "Invalid CIDR: ${APP_CIDR}"
if [[ "${APP_CIDR}" == "0.0.0.0/0" ]]; then
  warn "Gateway will be reachable from the whole internet over unencrypted HTTP."
  read -rp "Type 'yes' to continue: " confirm; [[ "${confirm}" == "yes" ]] || fatal "Aborted"
fi

echo ""
info "Secrets are stored in SSM Parameter Store (SecureString) and fetched by"
info "the instance through its IAM role — they never appear in user-data."
info "Leave the first four blank to generate strong random values."
read -rsp "JWT_SECRET           [generate]: " JWT_SECRET;        echo
read -rsp "TYPESENSE_API_KEY    [generate]: " TYPESENSE_API_KEY; echo
read -rsp "INTERNAL_API_KEY     [generate]: " INTERNAL_API_KEY;  echo
read -rsp "PG_PASSWORD          [generate]: " PG_PASSWORD;       echo
JWT_SECRET="${JWT_SECRET:-$(openssl rand -hex 32)}"
TYPESENSE_API_KEY="${TYPESENSE_API_KEY:-$(openssl rand -hex 24)}"
INTERNAL_API_KEY="${INTERNAL_API_KEY:-$(openssl rand -hex 32)}"
PG_PASSWORD="${PG_PASSWORD:-$(openssl rand -hex 24)}"

read -rp  "LLM key env var name [ANTHROPIC_API_KEY]: " LLM_KEY_NAME
LLM_KEY_NAME="${LLM_KEY_NAME:-ANTHROPIC_API_KEY}"
[[ "${LLM_KEY_NAME}" =~ ^[A-Z][A-Z0-9_]*$ ]] || fatal "Invalid env var name: ${LLM_KEY_NAME}"
read -rsp "${LLM_KEY_NAME} value : " LLM_API_KEY; echo
[[ -z "${LLM_API_KEY:-}" ]] && fatal "An LLM provider API key is required"

echo ""
info "Deploying to ${REGION} on ${INSTANCE_TYPE}..."

# ── Secrets → SSM Parameter Store ─────────────────────────────────
PARAM_PATH="/astra/${INSTANCE_NAME}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
info "Writing secrets to SSM Parameter Store under ${PARAM_PATH}/ ..."
put_param() {
  # Value is passed via a 0600 temp file so it never shows up in `ps`.
  local name="$1" value="$2" tmp
  tmp=$(mktemp); chmod 600 "${tmp}"; printf '%s' "${value}" > "${tmp}"
  aws ssm put-parameter --region "${REGION}" --name "${PARAM_PATH}/${name}" \
    --type SecureString --overwrite --value "file://${tmp}" > /dev/null
  rm -f "${tmp}"
}
put_param JWT_SECRET        "${JWT_SECRET}"
put_param TYPESENSE_API_KEY "${TYPESENSE_API_KEY}"
put_param INTERNAL_API_KEY  "${INTERNAL_API_KEY}"
put_param PG_PASSWORD       "${PG_PASSWORD}"
put_param "${LLM_KEY_NAME}" "${LLM_API_KEY}"
success "Secrets stored"

# ── IAM role: read only this deployment's parameters ──────────────
ROLE_NAME="astra-ec2-${INSTANCE_NAME}"
if ! aws iam get-role --role-name "${ROLE_NAME}" &>/dev/null; then
  info "Creating IAM role ${ROLE_NAME}..."
  aws iam create-role --role-name "${ROLE_NAME}" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    > /dev/null
fi
aws iam put-role-policy --role-name "${ROLE_NAME}" --policy-name astra-read-params \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParametersByPath\",\"ssm:GetParameters\"],\"Resource\":[\"arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${PARAM_PATH}\",\"arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter${PARAM_PATH}/*\"]},{\"Effect\":\"Allow\",\"Action\":\"kms:Decrypt\",\"Resource\":\"*\",\"Condition\":{\"StringEquals\":{\"kms:ViaService\":\"ssm.${REGION}.amazonaws.com\"}}}]}"
if ! aws iam get-instance-profile --instance-profile-name "${ROLE_NAME}" &>/dev/null; then
  aws iam create-instance-profile --instance-profile-name "${ROLE_NAME}" > /dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "${ROLE_NAME}" --role-name "${ROLE_NAME}"
  info "Waiting for the instance profile to propagate..."
  sleep 15
fi
success "IAM role ready"

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

  aws ec2 authorize-security-group-ingress --region "${REGION}" --group-id "${SG_ID}" \
    --ip-permissions \
    "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=${MY_IP}/32,Description=SSH}]" \
    "IpProtocol=tcp,FromPort=8080,ToPort=8080,IpRanges=[{CidrIp=${APP_CIDR},Description=Astra}]" \
    > /dev/null
  success "Created security group ${SG_ID}"
else
  warn "Using existing security group ${SG_ID} — review its ingress rules; they were NOT changed."
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
# Contains NO secrets: only the region, parameter path and repo URL. The
# body is a quoted heredoc, so nothing below is expanded on this machine.
USER_DATA_FILE=$(mktemp)
trap 'rm -f "${USER_DATA_FILE}"' EXIT
{
  echo '#!/bin/bash'
  echo "REGION='${REGION}'"
  echo "PARAM_PATH='${PARAM_PATH}'"
  echo "REPO_URL='${REPO_URL}'"
  echo "REPO_REF='${REPO_REF}'"
  echo "COMPOSE_VERSION='${COMPOSE_VERSION}'"
  echo "BUILDX_VERSION='${BUILDX_VERSION}'"
  cat <<'USERDATA'
set -euo pipefail

# Install Docker + git
dnf install -y docker git
systemctl enable --now docker
usermod -aG docker ec2-user

# Docker Compose + Buildx CLI plugins — pinned releases, not "latest"
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-amd64" \
  -o /usr/local/lib/docker/cli-plugins/docker-buildx
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-buildx

# Source: the canonical repo and its docker-compose.yml (Postgres and
# Typesense are bound to 127.0.0.1 there; the gateway is built locally).
git clone --depth 1 --branch "${REPO_REF}" "${REPO_URL}" /opt/astra
cd /opt/astra

# .env — secrets pulled from SSM Parameter Store via the instance role
umask 077
{
  echo "NODE_ENV=production"
  echo "PORT=8080"
  echo "PG_HOST=postgres"
  echo "PG_PORT=5432"
  echo "PG_USER=postgres"
  echo "PG_DATABASE=astra"
  echo "TYPESENSE_HOST=typesense"
  echo "TYPESENSE_PORT=8108"
  echo "TYPESENSE_PROTOCOL=http"
  echo "EMBEDDING_PROVIDER=local"
  aws ssm get-parameters-by-path --region "${REGION}" --path "${PARAM_PATH}" \
    --with-decryption --query 'Parameters[*].[Name,Value]' --output text \
    | while IFS=$'\t' read -r name value; do echo "${name##*/}=${value}"; done
} > .env
chmod 600 .env
grep -q '^JWT_SECRET=.' .env || { echo "FATAL: secrets not loaded from SSM" >&2; exit 1; }

docker compose up -d --build
USERDATA
} > "${USER_DATA_FILE}"

# ── Launch instance ───────────────────────────────────────────────
info "Launching EC2 instance..."
INSTANCE_ID=$(aws ec2 run-instances \
  --region "${REGION}" \
  --image-id "${AMI_ID}" \
  --instance-type "${INSTANCE_TYPE}" \
  --key-name "${KEY_NAME}" \
  --security-group-ids "${SG_ID}" \
  --user-data "file://${USER_DATA_FILE}" \
  --iam-instance-profile "Name=${ROLE_NAME}" \
  --metadata-options "HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1" \
  --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3","Encrypted":true}}]' \
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
echo "║  1. Wait ~5-8 minutes for the image build + startup ║"
printf "║  2. curl http://%-36s║\n" "${PUBLIC_IP}:8080/health"
printf "║  3. ssh -i ~/.ssh/%s.pem ec2-user@%s\n" "${KEY_NAME}" "${PUBLIC_IP}"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
warn "Traffic to :8080 is plain HTTP. Terminate TLS (ALB + ACM, or Caddy/nginx) before real use."
info "Secrets live in SSM under ${PARAM_PATH}/ — rotate there, then re-create /opt/astra/.env."
