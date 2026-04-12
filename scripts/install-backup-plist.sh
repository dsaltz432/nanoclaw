#!/usr/bin/env bash
#
# Renders launchd/com.nanoclaw.backup.plist with real paths, installs it to
# ~/Library/LaunchAgents, reloads launchd, triggers a test run, and tails
# the log so you can see what happened.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.nanoclaw.backup"
TEMPLATE="${REPO_DIR}/launchd/${LABEL}.plist"
INSTALLED="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_FILE="${REPO_DIR}/logs/backup.log"

[[ -f "${TEMPLATE}" ]] || { echo "ERROR: template not found at ${TEMPLATE}"; exit 1; }

echo "==> Rendering plist → ${INSTALLED}"
mkdir -p "${HOME}/Library/LaunchAgents" "${REPO_DIR}/logs"
sed -e "s|{{PROJECT_ROOT}}|${REPO_DIR}|g" \
    -e "s|{{HOME}}|${HOME}|g" \
    "${TEMPLATE}" > "${INSTALLED}"

echo "==> Validating plist syntax"
plutil -lint "${INSTALLED}"

echo "==> Unloading any previous version (ok if not loaded)"
launchctl unload "${INSTALLED}" 2>/dev/null || true

echo "==> Loading plist"
launchctl load "${INSTALLED}"

echo "==> Confirming launchd sees the job"
launchctl list | grep "${LABEL}" || { echo "ERROR: job not registered"; exit 1; }

echo "==> Triggering test run via kickstart"
: > "${LOG_FILE}"   # clear log so tail shows only this run
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

echo
echo "==> Tailing ${LOG_FILE} (Ctrl-C to stop)"
echo "    Also check: logs/backup.out.log and logs/backup.error.log"
echo
sleep 1
tail -f "${LOG_FILE}"
