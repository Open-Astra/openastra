#!/usr/bin/env bash
# ── Astra Agent Runtime — One-Click DigitalOcean Deploy ──────────
#
# Deploys the full Astra stack to a DigitalOcean Droplet in one command.
# Prompts for API keys, generates secrets, provisions the Droplet,
# and auto-starts the gateway. No SSH required.
#
# Prerequisites:
#   brew install doctl
#   doctl auth init
#
# Usage:
#   ./deploy/deploy-droplet.sh
#   ./deploy/deploy-droplet.sh --size s-1vcpu-2gb --region sfo3
#
# Estimated cost: $6-12/mo depending on size

set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────────

DROPLET_NAME="astra"
REGION="nyc1"
SIZE="s-1vcpu-1gb"           # 1 vCPU, 1GB RAM — $6/mo
IMAGE="ubuntu-24-04-x64"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_URL="https://github.com/masecode67/open-agent.git"

# ── Parse arguments ──────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    --name)    DROPLET_NAME="$2"; shift 2 ;;
    --region)  REGION="$2"; shift 2 ;;
    --size)    SIZE="$2"; shift 2 ;;
    --image)   IMAGE="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: $0 [--name NAME] [--region REGION] [--size SIZE]"
      echo ""
      echo "Options:"
      echo "  --name    Droplet name (default: astra)"
      echo "  --region  DO region (default: nyc1)"
      echo "  --size    Droplet size (default: s-1vcpu-1gb)"
      echo ""
      echo "Sizes:"
      echo "  s-1vcpu-1gb     \$6/mo    — lightweight (scheduler + 2-3 agents)"
      echo "  s-1vcpu-2gb     \$12/mo   — comfortable"
      echo "  s-2vcpu-4gb     \$24/mo   — heavy use (many agents/channels)"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Preflight checks ────────────────────────────────────────────

if ! command -v doctl &>/dev/null; then
  echo "Error: doctl CLI is required."
  echo "  brew install doctl && doctl auth init"
  exit 1
fi

if ! doctl account get &>/dev/null; then
  echo "Error: doctl not authenticated. Run: doctl auth init"
  exit 1
fi

SSH_KEYS=$(doctl compute ssh-key list --format ID --no-header | tr '\n' ',' | sed 's/,$//')
if [[ -z "$SSH_KEYS" ]]; then
  echo "Error: No SSH keys in your DO account."
  echo "  doctl compute ssh-key create my-key --public-key-file ~/.ssh/id_ed25519.pub"
  exit 1
fi

# ── Collect API keys ────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║         Astra — DigitalOcean Deploy          ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Enter your API keys. Press Enter to skip optional ones."
echo ""

# Required: at least one LLM provider
read -rp "  Gemini API key (recommended): " GEMINI_API_KEY
read -rp "  Anthropic API key (optional): " ANTHROPIC_API_KEY
read -rp "  OpenAI API key (optional):    " OPENAI_API_KEY
read -rp "  Grok API key (optional):      " GROK_API_KEY

if [[ -z "$GEMINI_API_KEY" && -z "$ANTHROPIC_API_KEY" && -z "$OPENAI_API_KEY" && -z "$GROK_API_KEY" ]]; then
  echo ""
  echo "Error: At least one LLM API key is required."
  exit 1
fi

echo ""
echo "Optional services (press Enter to skip):"
read -rp "  Telegram bot token:    " TELEGRAM_BOT_TOKEN
read -rp "  Sanity project ID:     " SANITY_PROJECT_ID
read -rp "  Sanity API token:      " SANITY_API_TOKEN

# ── Generate secrets ────────────────────────────────────────────

JWT_SECRET=$(openssl rand -hex 32)
INTERNAL_API_KEY=$(openssl rand -hex 24)
TYPESENSE_API_KEY=$(openssl rand -hex 16)
PG_PASSWORD=$(openssl rand -hex 16)

# ── Build cloud-init ────────────────────────────────────────────

CLOUD_INIT=$(mktemp /tmp/astra-cloud-init.XXXXXX.yml)
trap 'rm -f "$CLOUD_INIT"' EXIT

cat > "$CLOUD_INIT" << CLOUDINIT
#cloud-config

package_update: true
package_upgrade: true

packages:
  - curl
  - git
  - ufw
  - fail2ban
  - unattended-upgrades

write_files:
  - path: /etc/ufw/applications.d/astra
    content: |
      [Astra]
      title=Astra Agent Gateway
      description=Astra HTTP/WS gateway
      ports=8080/tcp

  - path: /etc/systemd/system/astra.service
    content: |
      [Unit]
      Description=Open Astra
      After=docker.service
      Requires=docker.service

      [Service]
      Type=oneshot
      RemainAfterExit=yes
      WorkingDirectory=/opt/astra
      ExecStart=/usr/bin/docker compose up -d
      ExecStop=/usr/bin/docker compose down
      TimeoutStartSec=180

      [Install]
      WantedBy=multi-user.target

  - path: /opt/astra/.env
    permissions: "0600"
    content: |
      # ── Astra Environment (auto-generated) ──────────────────
      NODE_ENV=production
      PORT=8080

      # Inference providers
      GEMINI_API_KEY=${GEMINI_API_KEY}
      ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      OPENAI_API_KEY=${OPENAI_API_KEY}
      GROK_API_KEY=${GROK_API_KEY}

      # PostgreSQL
      PG_HOST=postgres
      PG_PORT=5432
      PG_DATABASE=astra
      PG_USER=postgres
      PG_PASSWORD=${PG_PASSWORD}

      # Typesense
      TYPESENSE_API_KEY=${TYPESENSE_API_KEY}
      TYPESENSE_HOST=typesense
      TYPESENSE_PORT=8108
      TYPESENSE_PROTOCOL=http

      # Embeddings
      EMBEDDING_PROVIDER=local

      # Security
      JWT_SECRET=${JWT_SECRET}
      INTERNAL_API_KEY=${INTERNAL_API_KEY}

      # Messaging
      TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}

      # Sanity CMS
      SANITY_PROJECT_ID=${SANITY_PROJECT_ID}
      SANITY_API_TOKEN=${SANITY_API_TOKEN}
      SANITY_DATASET=production

runcmd:
  - curl -fsSL https://get.docker.com | sh
  - systemctl enable docker
  - systemctl start docker

  - git clone ${REPO_URL} /opt/astra

  # Firewall
  - ufw default deny incoming
  - ufw default allow outgoing
  - ufw allow ssh
  - ufw allow 8080/tcp
  - ufw --force enable

  - systemctl enable fail2ban
  - systemctl start fail2ban

  # Start the stack immediately
  - cd /opt/astra && docker compose up -d

  # Enable auto-start on boot
  - systemctl daemon-reload
  - systemctl enable astra.service

final_message: "Astra is live (\$UPTIME seconds)"
CLOUDINIT

# ── Create Droplet ───────────────────────────────────────────────

echo ""
echo "Provisioning Droplet..."
echo "  Name:   ${DROPLET_NAME}"
echo "  Region: ${REGION}"
echo "  Size:   ${SIZE}"
echo ""

DROPLET_ID=$(doctl compute droplet create "$DROPLET_NAME" \
  --image "$IMAGE" \
  --size "$SIZE" \
  --region "$REGION" \
  --user-data-file "$CLOUD_INIT" \
  --ssh-keys "$SSH_KEYS" \
  --tag-name astra \
  --wait \
  --format ID \
  --no-header)

DROPLET_IP=$(doctl compute droplet get "$DROPLET_ID" --format PublicIPv4 --no-header)

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║              Astra is deploying!              ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "  IP:       ${DROPLET_IP}"
echo "  ID:       ${DROPLET_ID}"
echo "  Cost:     ~\$6/mo"
echo ""
echo "  The Droplet is installing Docker and starting"
echo "  the stack. This takes ~3-4 minutes."
echo ""
echo "  Check status:"
echo "    curl http://${DROPLET_IP}:8080/health"
echo ""
echo "  SSH in (if needed):"
echo "    ssh root@${DROPLET_IP}"
echo ""
echo "  View logs:"
echo "    ssh root@${DROPLET_IP} 'cd /opt/astra && docker compose logs -f gateway'"
echo ""
echo "  Destroy:"
echo "    doctl compute droplet delete ${DROPLET_ID} --force"
echo ""

# ── Wait for health check ────────────────────────────────────────

echo "Waiting for gateway to come online..."
echo ""

for i in $(seq 1 40); do
  if curl -sf "http://${DROPLET_IP}:8080/health" &>/dev/null; then
    echo ""
    echo "  Astra is live at http://${DROPLET_IP}:8080"
    echo ""
    exit 0
  fi
  printf "  %d/40 ... \r" "$i"
  sleep 10
done

echo ""
echo "  Gateway not responding yet. It may still be building."
echo "  Try: curl http://${DROPLET_IP}:8080/health"
echo "  Or:  ssh root@${DROPLET_IP} 'cd /opt/astra && docker compose logs gateway'"
echo ""
