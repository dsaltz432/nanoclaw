#!/usr/bin/env bash
#
# Renders launchd/com.nanoclaw.ff-news.plist with real paths, installs it to
# ~/Library/LaunchAgents, loads it, and triggers a test run.
#
# Idempotent: safe to re-run after editing the template or the interval.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.nanoclaw.ff-news"
TEMPLATE="${REPO_DIR}/launchd/${LABEL}.plist"
INSTALLED="${HOME}/Library/LaunchAgents/${LABEL}.plist"
FF_DIR="${FF_ROOT:-${HOME}/Documents/repositories/fantasy-football-agent}"

[[ -f "${TEMPLATE}" ]] || { echo "ERROR: template not found at ${TEMPLATE}"; exit 1; }
[[ -d "${FF_DIR}/ff" ]] || { echo "ERROR: ff package not found at ${FF_DIR}"; exit 1; }

echo "==> Rendering plist -> ${INSTALLED}"
mkdir -p "${HOME}/Library/LaunchAgents" "${REPO_DIR}/logs"
sed -e "s|{{PROJECT_ROOT}}|${REPO_DIR}|g" \
    -e "s|{{HOME}}|${HOME}|g" \
    "${TEMPLATE}" > "${INSTALLED}"

echo "==> Validating plist syntax"
plutil -lint "${INSTALLED}"

echo "==> Reloading job"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "${INSTALLED}"

echo "==> Triggering a test run"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"
sleep 12

echo "==> Last log lines"
tail -3 "${REPO_DIR}/logs/ff-news.log" 2>/dev/null || echo "(no output yet)"
if [[ -s "${REPO_DIR}/logs/ff-news.error.log" ]]; then
    echo "==> stderr (non-empty):"
    tail -5 "${REPO_DIR}/logs/ff-news.error.log"
fi

echo
echo "Installed. Runs every 15 minutes."
echo "  status : launchctl list | grep ${LABEL}"
echo "  logs   : tail -f ${REPO_DIR}/logs/ff-news.log"
echo "  stop   : launchctl bootout gui/\$(id -u)/${LABEL}"
