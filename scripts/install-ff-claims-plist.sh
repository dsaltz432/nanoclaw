#!/usr/bin/env bash
#
# Installs com.nanoclaw.ff-claims: every 15 min, extract player claims from
# the articles ff-news.sh has stored (fantasy-football-agent CONTENT-PLAN.md,
# layer 2). Same launchd shape and caveats as install-ff-refresh-plists.sh.
#
# Idempotent: safe to re-run to pick up template changes.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FF_DIR="${FF_ROOT:-${HOME}/Documents/repositories/fantasy-football-agent}"
LAUNCHD_LOG_DIR="${HOME}/.local/share/nanoclaw/logs"
LABEL=com.nanoclaw.ff-claims

[[ -d "${FF_DIR}/ff" ]] || { echo "ERROR: ff package not found at ${FF_DIR}"; exit 1; }
command -v claude >/dev/null 2>&1 || ls "${HOME}"/.nvm/versions/node/*/bin/claude >/dev/null 2>&1 \
    || { echo "ERROR: claude CLI not found; the extractor needs Claude Code installed and logged in"; exit 1; }

mkdir -p "${LAUNCHD_LOG_DIR}" "${HOME}/Library/LaunchAgents"
chmod +x "${REPO_DIR}/scripts/ff-claims.sh"

TEMPLATE="${REPO_DIR}/launchd/${LABEL}.plist"
INSTALLED="${HOME}/Library/LaunchAgents/${LABEL}.plist"
[[ -f "${TEMPLATE}" ]] || { echo "ERROR: template not found at ${TEMPLATE}"; exit 1; }

echo "==> Rendering ${LABEL} -> ${INSTALLED}"
sed -e "s|{{PROJECT_ROOT}}|${REPO_DIR}|g" -e "s|{{HOME}}|${HOME}|g" "${TEMPLATE}" > "${INSTALLED}"
plutil -lint "${INSTALLED}"

echo "==> Reloading"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl load "${INSTALLED}"
launchctl list | grep -q "${LABEL}" || { echo "ERROR: ${LABEL} not registered"; exit 1; }

cat <<EOF
Installed. It has RunAtLoad, so it just fired. Check:

  launchctl list | grep ff-claims
  tail -20 ${LAUNCHD_LOG_DIR}/ff-claims.log

Trigger by hand:  launchctl kickstart -k gui/\$(id -u)/${LABEL}
EOF
