#!/usr/bin/env bash
#
# setup-gcp.sh — Deploy NanoClaw on GCP Compute Engine (free tier eligible)
#
# Adapted from OpenClaw GCP guides for NanoClaw's lighter architecture.
# This script is idempotent — safe to run multiple times.
#
# Prerequisites:
#   - gcloud CLI installed (https://cloud.google.com/sdk/docs/install)
#   - Authenticated: gcloud auth login
#   - A GCP billing account (required even for free tier)
#   - Your NanoClaw fork URL (or use upstream)
#
# Usage:
#   chmod +x setup-gcp.sh
#   ./setup-gcp.sh
#
# What this script does:
#   1. Creates a GCP project (or uses existing)
#   2. Creates a free-tier-eligible e2-micro VM
#   3. SSHs in and installs Docker, Node.js, Claude Code
#   4. Clones your NanoClaw fork
#   5. Prints next steps for interactive setup
#
# Cost:
#   - e2-small: ~$13/month
#   - 30GB pd-standard disk: ~$1.20/month
#   - Estimated total: ~$15/month
#

set -euo pipefail

# ─── Configuration ───────────────────────────────────────────────────────────
# Edit these to match your preferences

PROJECT_ID="${GCP_PROJECT_ID:-nanoclaw-489701}"
ZONE="${GCP_ZONE:-us-central1-a}"
INSTANCE_NAME="${GCP_INSTANCE_NAME:-nanoclaw}"
MACHINE_TYPE="e2-small"
BOOT_DISK_SIZE="30GB"
BOOT_DISK_TYPE="pd-standard"        # pd-standard is cheapest; pd-balanced is faster but costs more
IMAGE_FAMILY="ubuntu-2404-lts-amd64"
IMAGE_PROJECT="ubuntu-os-cloud"

# Your NanoClaw fork — change this to your fork URL
NANOCLAW_REPO="${NANOCLAW_REPO:-https://github.com/dsaltz432/nanoclaw.git}"

# ─── Colors ──────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }

# ─── Preflight checks ───────────────────────────────────────────────────────

info "Running preflight checks..."

if ! command -v gcloud &> /dev/null; then
    err "gcloud CLI not found. Install it from https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Check if authenticated
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1 | grep -q '@'; then
    err "Not authenticated. Run: gcloud auth login"
    exit 1
fi

ACTIVE_ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>/dev/null | head -1)
ok "Authenticated as: $ACTIVE_ACCOUNT"

# ─── Step 1: Project setup ──────────────────────────────────────────────────

info "Step 1/5: Setting up GCP project..."

if gcloud projects describe "$PROJECT_ID" &>/dev/null; then
    ok "Project '$PROJECT_ID' already exists, using it"
else
    err "Project '$PROJECT_ID' not found. Check the project ID and try again."
    err "List your projects with: gcloud projects list"
    exit 1
fi

gcloud config set project "$PROJECT_ID" --quiet

# Check billing
BILLING_ACCOUNT=$(gcloud billing accounts list --filter=open=true --format="value(ACCOUNT_ID)" 2>/dev/null | head -1)
if [ -z "$BILLING_ACCOUNT" ]; then
    err "No active billing account found."
    err "Enable billing at: https://console.cloud.google.com/billing"
    err "A credit card is required but you won't be charged on free tier."
    exit 1
fi

# Link billing to project
LINKED_BILLING=$(gcloud billing projects describe "$PROJECT_ID" --format="value(billingAccountName)" 2>/dev/null || echo "")
if [ -z "$LINKED_BILLING" ] || [ "$LINKED_BILLING" = "billingAccounts/" ]; then
    info "Linking billing account to project..."
    gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT" --quiet
    ok "Billing linked"
else
    ok "Billing already linked"
fi

# Enable Compute Engine API
info "Enabling Compute Engine API..."
gcloud services enable compute.googleapis.com --quiet
ok "Compute Engine API enabled"

# ─── Step 2: Create VM ──────────────────────────────────────────────────────

info "Step 2/5: Creating VM instance..."

if gcloud compute instances describe "$INSTANCE_NAME" --zone="$ZONE" &>/dev/null; then
    ok "Instance '$INSTANCE_NAME' already exists"
else
    info "Creating $MACHINE_TYPE instance in $ZONE..."
    info "  Boot disk: $BOOT_DISK_SIZE $BOOT_DISK_TYPE (Ubuntu 24.04)"
    info "  No service account, no Ops Agent (free tier)"
    echo ""

    gcloud compute instances create "$INSTANCE_NAME" \
        --zone="$ZONE" \
        --machine-type="$MACHINE_TYPE" \
        --image-family="$IMAGE_FAMILY" \
        --image-project="$IMAGE_PROJECT" \
        --boot-disk-size="$BOOT_DISK_SIZE" \
        --boot-disk-type="$BOOT_DISK_TYPE" \
        --no-service-account \
        --no-scopes \
        --metadata=enable-oslogin=true \
        --quiet

    ok "VM created"
fi

# Wait for VM to be ready
info "Waiting for VM to be reachable..."
for i in $(seq 1 30); do
    if gcloud compute ssh "$INSTANCE_NAME" --zone="$ZONE" --command="echo ready" &>/dev/null; then
        ok "VM is reachable"
        break
    fi
    if [ "$i" -eq 30 ]; then
        err "Timed out waiting for VM. Try: gcloud compute ssh $INSTANCE_NAME --zone=$ZONE"
        exit 1
    fi
    sleep 5
done

# ─── Step 3: Install dependencies on VM ─────────────────────────────────────

info "Step 3/5: Installing dependencies on VM..."

gcloud compute ssh "$INSTANCE_NAME" --zone="$ZONE" --command="bash -s" << 'REMOTE_SCRIPT'
set -euo pipefail

echo ">>> Updating system packages..."
sudo apt-get update -qq
sudo apt-get upgrade -y -qq

echo ">>> Setting up swap space (required on e2-micro — 1GB RAM is not enough for container builds)..."
if sudo swapon --show | grep -q '/swapfile'; then
    echo "Swap already configured"
else
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    echo "2GB swap enabled"
fi

echo ">>> Installing Docker..."
if command -v docker &> /dev/null; then
    echo "Docker already installed"
else
    curl -fsSL https://get.docker.com | sudo sh
    sudo usermod -aG docker $USER
    echo "Docker installed (group change takes effect on next login)"
fi

echo ">>> Installing Node.js 22..."
if command -v node &> /dev/null && node --version | grep -q "v22"; then
    echo "Node.js 22 already installed"
else
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y -qq nodejs
fi

echo ">>> Installing git and build tools..."
sudo apt-get install -y -qq git curl ca-certificates build-essential

echo ">>> Installing Claude Code..."
if command -v claude &> /dev/null; then
    echo "Claude Code already installed"
else
    sudo npm install -g @anthropic-ai/claude-code
fi

echo ">>> Verifying installations..."
echo "  Docker: $(docker --version 2>/dev/null || echo 'needs re-login for group')"
echo "  Node.js: $(node --version)"
echo "  npm: $(npm --version)"
echo "  Claude Code: $(claude --version 2>/dev/null || echo 'installed')"
echo ">>> Dependencies installed successfully"
REMOTE_SCRIPT

ok "Dependencies installed"

# ─── Step 4: Clone NanoClaw ─────────────────────────────────────────────────

info "Step 4/5: Cloning NanoClaw repository..."

gcloud compute ssh "$INSTANCE_NAME" --zone="$ZONE" --command="bash -s" << REMOTE_CLONE
set -euo pipefail

if [ -d "\$HOME/nanoclaw" ]; then
    echo "NanoClaw directory already exists, skipping clone"
else
    echo "Cloning from $NANOCLAW_REPO ..."
    git clone "$NANOCLAW_REPO" "\$HOME/nanoclaw"
    echo "Clone complete"
fi
REMOTE_CLONE

ok "NanoClaw cloned"

# ─── Step 5: Print next steps ───────────────────────────────────────────────

info "Step 5/5: Setup complete! Here's what to do next."

EXTERNAL_IP=$(gcloud compute instances describe "$INSTANCE_NAME" \
    --zone="$ZONE" \
    --format="get(networkInterfaces[0].accessConfigs[0].natIP)" 2>/dev/null || echo "unknown")

echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  NanoClaw GCP VM is ready!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  Instance:  ${BLUE}$INSTANCE_NAME${NC}"
echo -e "  Zone:      ${BLUE}$ZONE${NC}"
echo -e "  IP:        ${BLUE}$EXTERNAL_IP${NC}"
echo -e "  Machine:   ${BLUE}$MACHINE_TYPE${NC} (~$13/month)"
echo -e "  Disk:      ${BLUE}$BOOT_DISK_SIZE $BOOT_DISK_TYPE${NC}"
echo ""
echo -e "${YELLOW}  Next steps (interactive — must be done manually):${NC}"
echo ""
echo "  1. SSH into the VM (note: use the same login method consistently"
echo "     to avoid the GCP username mismatch issue):"
echo ""
echo -e "     ${BLUE}gcloud compute ssh $INSTANCE_NAME --zone=$ZONE${NC}"
echo ""
echo "  2. IMPORTANT — re-login so Docker group takes effect:"
echo ""
echo -e "     ${BLUE}exit${NC}"
echo -e "     ${BLUE}gcloud compute ssh $INSTANCE_NAME --zone=$ZONE${NC}"
echo ""
echo "  3. Copy your .env file to the VM:"
echo ""
echo -e "     ${BLUE}gcloud compute scp .env $INSTANCE_NAME:~/nanoclaw/.env --zone=$ZONE${NC}"
echo ""
echo "     Your .env needs at minimum: CLAUDE_CODE_OAUTH_TOKEN"
echo "     (ANTHROPIC_API_KEY is NOT needed if you use an OAuth token)"
echo ""
echo "  4. Build NanoClaw:"
echo ""
echo -e "     ${BLUE}cd ~/nanoclaw${NC}"
echo -e "     ${BLUE}npm install${NC}"
echo -e "     ${BLUE}npm run build${NC}"
echo -e "     ${BLUE}./container/build.sh${NC}"
echo ""
echo "  5. Start Claude Code and run interactive setup (with phone ready for WhatsApp QR):"
echo ""
echo -e "     ${BLUE}cd ~/nanoclaw && claude${NC}"
echo ""
echo "     Then inside Claude Code:"
echo ""
echo -e "     ${BLUE}/setup${NC}"
echo ""
echo "     Claude Code will walk you through:"
echo "       - Choosing Docker as container runtime"
echo "       - WhatsApp QR code authentication (have your phone ready)"
echo "       - Registering your main channel"
echo "       - Configuring mount allowlists"
echo "       - Setting up systemd service"
echo ""
echo "  6. Enable linger so NanoClaw survives SSH disconnects:"
echo ""
echo -e "     ${BLUE}sudo loginctl enable-linger \$USER${NC}"
echo ""
echo "     Without this, NanoClaw dies every time you close your SSH session."
echo ""
echo "  7. Verify NanoClaw is running:"
echo ""
echo -e "     ${BLUE}systemctl --user status nanoclaw${NC}"
echo ""
echo -e "${YELLOW}  Cost reminders:${NC}"
echo ""
echo "    - e2-small: ~\$13/month"
echo "    - 30GB pd-standard disk: ~\$1.20/month"
echo "    - 1GB network egress/month is free (plenty for WhatsApp)"
echo "    - Your Anthropic API usage is billed separately by Anthropic"
echo ""
echo -e "${YELLOW}  Useful commands:${NC}"
echo ""
echo "    SSH in:          gcloud compute ssh $INSTANCE_NAME --zone=$ZONE"
echo "    Stop VM:         gcloud compute instances stop $INSTANCE_NAME --zone=$ZONE"
echo "    Start VM:        gcloud compute instances start $INSTANCE_NAME --zone=$ZONE"
echo "    View logs:       journalctl --user -u nanoclaw -f"
echo "    NanoClaw debug:  cd ~/nanoclaw && claude   (then type /debug)"
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════════${NC}"