#!/usr/bin/env bash
#
# Install com.nanoclaw.ha-probe — Home Assistant status/log bundle every 30 min.
#
# Renders launchd/com.nanoclaw.ha-probe.plist with real paths, installs it,
# loads it (RunAtLoad fires one probe immediately), and shows the result.
#
#   ./scripts/install-ha-probe-plist.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.nanoclaw.ha-probe"
TEMPLATE="${REPO_DIR}/launchd/${LABEL}.plist"
INSTALLED="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/.local/share/nanoclaw/logs"

[[ -f "${TEMPLATE}" ]] || { echo "ERROR: template missing at ${TEMPLATE}"; exit 1; }
[[ -x "${REPO_DIR}/scripts/ha-probe.sh" ]] || chmod +x "${REPO_DIR}/scripts/ha-probe.sh"
[[ -f "${HOME}/.ssh/ha_monitor_ed25519" ]] || {
  echo "ERROR: ~/.ssh/ha_monitor_ed25519 missing — the Green only accepts that key for monitoring"; exit 1; }

mkdir -p "${LOG_DIR}" "$(dirname "${INSTALLED}")"

echo "rendering ${LABEL}.plist"
sed -e "s#{{PROJECT_ROOT}}#${REPO_DIR}#g" \
    -e "s#{{HOME}}#${HOME}#g" \
    "${TEMPLATE}" > "${INSTALLED}"
plutil -lint "${INSTALLED}"

echo "loading"
launchctl unload "${INSTALLED}" 2>/dev/null || true
launchctl load "${INSTALLED}"
launchctl list | grep -q "${LABEL}" || { echo "ERROR: ${LABEL} did not load"; exit 1; }
echo "loaded: $(launchctl list | grep "${LABEL}")"

echo "waiting for the first probe (~30-60s)"
for _ in $(seq 1 30); do
  [[ -s "${LOG_DIR}/ha-probe.log" ]] && break
  sleep 3
done
tail -1 "${LOG_DIR}/ha-probe.log" 2>/dev/null || echo "WARN: no probe run logged yet"
echo
cat "${REPO_DIR}/data/health-probe/home-assistant/status.txt" 2>/dev/null || true
