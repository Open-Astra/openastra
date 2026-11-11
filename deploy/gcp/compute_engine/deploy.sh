#!/usr/bin/env bash
# ── Astra Agent Runtime — One-Click GCP Compute Engine Deploy ──
#
# Creates a GCE instance with the full Astra stack running via Docker Compose.
# Uses Debian 12, static external IP, and a firewall rule for the project.
#
# Prerequisites:
#   - gcloud CLI installed and authenticated (gcloud auth login)
#   - A GCP project with billing enabled
#
# Usage:
#   ./deploy/gcp/compute_engine/deploy.sh
#
# After deploy (~5 minutes):
#   ssh to instance via gcloud compute ssh
#   sudo docker compose -f /opt/astra/docker-compose.yml logs -f
#
# Security model:
#   * Secrets are stored in Secret Manager and read by the VM through a
#     dedicated service account that can access only those secrets. Nothing
#     secret is placed in instance metadata / the startup script.
#   * SSH is limited to your current IP; :8080 to a CIDR you choose.
#   * The gateway is plain HTTP — front it with TLS before production use.

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────
PROJECT_ID=""
ZONE="us-central1-a"
MACHINE_TYPE="e2-standard-2"  # 2 vCPU, 8GB RAM — ~$49/mo
INSTANCE_NAME="astra"
FIREWALL_TAG="astra-server"
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
command -v gcloud &>/dev/null || fatal "gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install"
command -v curl &>/dev/null || fatal "curl not found"
command -v openssl &>/dev/null || fatal "openssl not found"

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║    Astra — GCP Compute Engine One-Click Deployer     ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# ── Gather input ──────────────────────────────────────────────────
read -rp "GCP project ID       (required): " PROJECT_ID
[[ -z "${PROJECT_ID:-}" ]] && fatal "Project ID is required"

read -rp "Zone                 [${ZONE}]: "         input; ZONE="${input:-$ZONE}"
read -rp "Machine type         [${MACHINE_TYPE}]: " input; MACHINE_TYPE="${input:-$MACHINE_TYPE}"

MY_IP=$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')
[[ "${MY_IP}" =~ ^[0-9.]+$ ]] || fatal "Could not determine your public IP"
echo ""
info "Ingress. SSH is limited to your IP (${MY_IP}/32)."
info "The gateway listens on plain HTTP :8080 — keep it limited to trusted"
info "addresses until you put an HTTPS load balancer or proxy in front of it."
read -rp "CIDR allowed to reach :8080 [${MY_IP}/32]: " input; APP_CIDR="${input:-${MY_IP}/32}"
[[ "${APP_CIDR}" =~ ^[0-9.]+/[0-9]{1,2}$ ]] || fatal "Invalid CIDR: ${APP_CIDR}"
if [[ "${APP_CIDR}" == "0.0.0.0/0" ]]; then
  warn "Gateway will be reachable from the whole internet over unencrypted HTTP."
  read -rp "Type 'yes' to continue: " confirm; [[ "${confirm}" == "yes" ]] || fatal "Aborted"
fi

echo ""
info "Secrets are stored in Secret Manager and fetched by the instance through"
info "a dedicated service account — they never appear in instance metadata."
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
info "Deploying to ${PROJECT_ID} / ${ZONE} on ${MACHINE_TYPE}..."

gcloud services enable compute.googleapis.com secretmanager.googleapis.com \
  --project="${PROJECT_ID}" --quiet

# ── Dedicated least-privilege service account ─────────────────────
SA_NAME="astra-vm-${INSTANCE_NAME}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
if ! gcloud iam service-accounts describe "${SA_EMAIL}" --project="${PROJECT_ID}" &>/dev/null; then
  info "Creating service account ${SA_NAME}..."
  gcloud iam service-accounts create "${SA_NAME}" --project="${PROJECT_ID}" \
    --display-name="Astra VM (${INSTANCE_NAME})" --quiet
fi

# ── Secrets → Secret Manager (accessor granted per secret only) ───
SECRET_PREFIX="astra-${INSTANCE_NAME}"
SECRET_KEYS=(JWT_SECRET TYPESENSE_API_KEY INTERNAL_API_KEY PG_PASSWORD "${LLM_KEY_NAME}")
put_secret() {
  local key="$1" value="$2" id="${SECRET_PREFIX}-$1"
  if ! gcloud secrets describe "${id}" --project="${PROJECT_ID}" &>/dev/null; then
    gcloud secrets create "${id}" --project="${PROJECT_ID}" \
      --replication-policy=automatic --quiet > /dev/null
  fi
  printf '%s' "${value}" | gcloud secrets versions add "${id}" \
    --project="${PROJECT_ID}" --data-file=- --quiet > /dev/null
  gcloud secrets add-iam-policy-binding "${id}" --project="${PROJECT_ID}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" --quiet > /dev/null
}
info "Writing secrets to Secret Manager (${SECRET_PREFIX}-*)..."
put_secret JWT_SECRET        "${JWT_SECRET}"
put_secret TYPESENSE_API_KEY "${TYPESENSE_API_KEY}"
put_secret INTERNAL_API_KEY  "${INTERNAL_API_KEY}"
put_secret PG_PASSWORD       "${PG_PASSWORD}"
put_secret "${LLM_KEY_NAME}" "${LLM_API_KEY}"
success "Secrets stored"

# ── Firewall rules (explicit source ranges — never 0.0.0.0/0 by default) ──
info "Creating firewall rules for Astra..."
gcloud compute firewall-rules create "${FIREWALL_TAG}-allow-ssh" \
  --project="${PROJECT_ID}" \
  --direction=INGRESS \
  --priority=1000 \
  --network=default \
  --action=ALLOW \
  --rules=tcp:22 \
  --source-ranges="${MY_IP}/32" \
  --target-tags="${FIREWALL_TAG}" \
  --description="Astra: SSH from deployer IP" \
  2>/dev/null || warn "SSH firewall rule already exists — review its source ranges"
gcloud compute firewall-rules create "${FIREWALL_TAG}-allow-gateway" \
  --project="${PROJECT_ID}" \
  --direction=INGRESS \
  --priority=1000 \
  --network=default \
  --action=ALLOW \
  --rules=tcp:8080 \
  --source-ranges="${APP_CIDR}" \
  --target-tags="${FIREWALL_TAG}" \
  --description="Astra: gateway" \
  2>/dev/null || warn "Gateway firewall rule already exists — review its source ranges"

# ── Startup script ────────────────────────────────────────────────
# Contains NO secrets: only identifiers. The body is a quoted heredoc, so
# nothing below is expanded on this machine.
STARTUP_FILE=$(mktemp)
trap 'rm -f "${STARTUP_FILE}"' EXIT
{
  echo '#!/bin/bash'
  echo "PROJECT_ID='${PROJECT_ID}'"
  echo "SECRET_PREFIX='${SECRET_PREFIX}'"
  echo "SECRET_KEYS='${SECRET_KEYS[*]}'"
  echo "REPO_URL='${REPO_URL}'"
  echo "REPO_REF='${REPO_REF}'"
  echo "COMPOSE_VERSION='${COMPOSE_VERSION}'"
  echo "BUILDX_VERSION='${BUILDX_VERSION}'"
  cat <<'STARTUP'
set -euo pipefail

# Startup scripts re-run on every boot — only bootstrap once.
if [[ -f /opt/astra/.env ]]; then
  cd /opt/astra && docker compose up -d
  exit 0
fi

# Install Docker + git
apt-get update -qq
apt-get install -y docker.io git curl
systemctl enable --now docker

# Docker Compose + Buildx CLI plugins — pinned releases
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
  -o /usr/local/lib/docker/cli-plugins/docker-compose
curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-amd64" \
  -o /usr/local/lib/docker/cli-plugins/docker-buildx
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-buildx

# Source: the canonical repo and its docker-compose.yml (Postgres and
# Typesense are bound to 127.0.0.1 there; the gateway is built locally).
rm -rf /opt/astra
git clone --depth 1 --branch "${REPO_REF}" "${REPO_URL}" /opt/astra
cd /opt/astra

# .env — secrets pulled from Secret Manager via the VM service account
umask 077
ENV_TMP=$(mktemp)
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
  for key in ${SECRET_KEYS}; do
    echo "${key}=$(gcloud secrets versions access latest --project="${PROJECT_ID}" --secret="${SECRET_PREFIX}-${key}")"
  done
} > "${ENV_TMP}"
grep -q '^JWT_SECRET=.' "${ENV_TMP}" || { echo "FATAL: secrets not loaded from Secret Manager" >&2; exit 1; }
install -m 0600 "${ENV_TMP}" .env
rm -f "${ENV_TMP}"

docker compose up -d --build
STARTUP
} > "${STARTUP_FILE}"

# ── Create instance ───────────────────────────────────────────────
info "Creating GCE instance '${INSTANCE_NAME}'..."
gcloud compute instances create "${INSTANCE_NAME}" \
  --project="${PROJECT_ID}" \
  --zone="${ZONE}" \
  --machine-type="${MACHINE_TYPE}" \
  --image-family=debian-12 \
  --image-project=debian-cloud \
  --boot-disk-size=40GB \
  --boot-disk-type=pd-ssd \
  --tags="${FIREWALL_TAG}" \
  --service-account="${SA_EMAIL}" \
  --scopes=cloud-platform \
  --shielded-secure-boot \
  --metadata-from-file=startup-script="${STARTUP_FILE}" \
  --quiet

success "Instance created"

# ── Get external IP ───────────────────────────────────────────────
EXTERNAL_IP=$(gcloud compute instances describe "${INSTANCE_NAME}" \
  --project="${PROJECT_ID}" \
  --zone="${ZONE}" \
  --format="get(networkInterfaces[0].accessConfigs[0].natIP)")

# ── Done ──────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║         Astra Deployed on GCP Compute Engine         ║"
echo "╠══════════════════════════════════════════════════════╣"
printf "║  Instance     : %-36s║\n" "${INSTANCE_NAME}"
printf "║  External IP  : %-36s║\n" "${EXTERNAL_IP}"
printf "║  Project      : %-36s║\n" "${PROJECT_ID}"
printf "║  Zone         : %-36s║\n" "${ZONE}"
echo "╠══════════════════════════════════════════════════════╣"
echo "║  Next steps:                                         ║"
echo "║  1. Wait ~5-8 minutes for the image build + startup ║"
printf "║  2. curl http://%-36s║\n" "${EXTERNAL_IP}:8080/health"
echo "║  3. gcloud compute ssh ${INSTANCE_NAME} --project=${PROJECT_ID}"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
warn "The IP address is ephemeral. Reserve a static IP in GCP Console for production."
warn "Traffic to :8080 is plain HTTP. Terminate TLS (HTTPS load balancer or Caddy/nginx) before real use."
info "Secrets live in Secret Manager as ${SECRET_PREFIX}-* — rotate there, then delete /opt/astra/.env and reboot."
