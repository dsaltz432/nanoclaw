#!/usr/bin/env bash
#
# Installs the two fantasy DATA refresh jobs:
#
#   com.nanoclaw.ff-live    every 2h   transactions, matchups, FAAB, rosters
#   com.nanoclaw.ff-daily   06:40      projections, ownership, market values
#
# These are separate from com.nanoclaw.ff-news (every 15 min), which refreshes
# news only and is installed by scripts/install-ff-news-plist.sh.
#
# Both plists launch via inline `/bin/bash -c` and log to ~/.local, because
# launchd is denied TCC access to ~/Documents at spawn time for a job loaded
# mid-session (exit 78). See launchd/com.nanoclaw.ff-live.plist.
#
# Idempotent: safe to re-run to pick up template changes.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FF_DIR="${FF_ROOT:-${HOME}/Documents/repositories/fantasy-football-agent}"
LAUNCHD_LOG_DIR="${HOME}/.local/share/nanoclaw/logs"
LABELS=(com.nanoclaw.ff-live com.nanoclaw.ff-daily)

[[ -d "${FF_DIR}/ff" ]] || { echo "ERROR: ff package not found at ${FF_DIR}"; exit 1; }

echo "==> Ensuring log dir ${LAUNCHD_LOG_DIR}"
mkdir -p "${LAUNCHD_LOG_DIR}" "${HOME}/Library/LaunchAgents"

echo "==> Making the job script executable"
chmod +x "${REPO_DIR}/scripts/ff-refresh.sh"

for LABEL in "${LABELS[@]}"; do
    TEMPLATE="${REPO_DIR}/launchd/${LABEL}.plist"
    INSTALLED="${HOME}/Library/LaunchAgents/${LABEL}.plist"

    [[ -f "${TEMPLATE}" ]] || { echo "ERROR: template not found at ${TEMPLATE}"; exit 1; }

    echo "==> Rendering ${LABEL} -> ${INSTALLED}"
    sed -e "s|{{PROJECT_ROOT}}|${REPO_DIR}|g" \
        -e "s|{{HOME}}|${HOME}|g" \
        "${TEMPLATE}" > "${INSTALLED}"

    echo "==> Validating plist syntax"
    plutil -lint "${INSTALLED}"

    echo "==> Unloading any previous version (ok if not loaded)"
    launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true

    echo "==> Loading ${LABEL}"
    launchctl load "${INSTALLED}"

    launchctl list | grep -q "${LABEL}" || { echo "ERROR: ${LABEL} not registered"; exit 1; }
    echo "    registered"
done

cat <<EOF

Installed. Verify (the second column is the last exit status — 0 is good, 78
means launchd was denied spawn-time access to a path under ~/Documents):

  launchctl list | grep -E 'ff-live|ff-daily'
  tail -20 ${LAUNCHD_LOG_DIR}/ff-live.log

ff-live has RunAtLoad, so it has just fired; give it ~30s then check the log.
Trigger either by hand with:

  launchctl kickstart -k gui/\$(id -u)/com.nanoclaw.ff-live
  launchctl kickstart -k gui/\$(id -u)/com.nanoclaw.ff-daily
EOF
