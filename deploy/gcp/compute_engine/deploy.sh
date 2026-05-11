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

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────
PROJECT_ID=""
ZONE="us-central1-a"
MACHINE_TYPE="e2-standard-2"  # 2 vCPU, 8GB RAM — ~$49/mo
INSTANCE_NAME="astra"
FIREWALL_TAG="astra-server"

# ── Colors ────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[info]${NC} $*"; }
success() { echo -e "${GREEN}[ok]${NC}   $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC} $*"; }
fatal()   { echo -e "${RED}[fail]${NC} $*" >&2; exit 1; }

# ── Check dependencies ────────────────────────────────────────────
command -v gcloud &>/dev/null || fatal "gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install"

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

echo ""
info "Secrets (will be written to .env on the instance):"
read -rsp "JWT_SECRET           : " JWT_SECRET;        echo
read -rsp "TYPESENSE_API_KEY    : " TYPESENSE_API_KEY; echo
read -rsp "INTERNAL_API_KEY     : " INTERNAL_API_KEY;  echo
read -rsp "PG_PASSWORD          : " PG_PASSWORD;       echo
read -rsp "LLM API key          : " LLM_API_KEY;       echo

echo ""
info "Deploying to ${PROJECT_ID} / ${ZONE} on ${MACHINE_TYPE}..."

# ── Firewall rule ─────────────────────────────────────────────────
REGION="${ZONE%-*}"
info "Creating firewall rule for Astra..."
gcloud compute firewall-rules create "${FIREWALL_TAG}-allow" \
  --project="${PROJECT_ID}" \
  --direction=INGRESS \
  --priority=1000 \
  --network=default \
  --action=ALLOW \
  --rules=tcp:22,tcp:80,tcp:8080 \
  --target-tags="${FIREWALL_TAG}" \
  --description="Allow SSH, HTTP, and Astra gateway" \
  2>/dev/null || warn "Firewall rule already exists, skipping"

# ── Startup script ────────────────────────────────────────────────
STARTUP_SCRIPT=$(cat <<STARTUP
#!/bin/bash
set -euo pipefail

# Install Docker and Docker Compose v2
apt-get update -qq
apt-get install -y docker.io docker-compose-v2 curl
systemctl enable --now docker

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

docker compose up -d
STARTUP
)

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
  --metadata=startup-script="${STARTUP_SCRIPT}" \
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
echo "║  1. Wait ~3 minutes for Docker Compose to start     ║"
printf "║  2. curl http://%-36s║\n" "${EXTERNAL_IP}/health"
echo "║  3. gcloud compute ssh ${INSTANCE_NAME} --project=${PROJECT_ID}"
echo "║  4. Update gateway image in docker-compose.yml      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
warn "The IP address is ephemeral. Reserve a static IP in GCP Console for production."
warn "Remember to update the gateway image in /opt/astra/docker-compose.yml."
