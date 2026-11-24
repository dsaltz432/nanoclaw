#!/usr/bin/env bash
#
# Install the two script jobs that replaced agent tasks on 2026-11-24:
#   com.nanoclaw.tickets-pricer   (was the "Ticket Pricer" scheduled task)
#   com.nanoclaw.watchdog         (was the "Health Watchdog" scheduled task)
#
#   ./scripts/install-script-jobs.sh            render + load both
#   ./scripts/install-script-jobs.sh watchdog   just one
#
# The old agent tasks are paused separately (status='paused' in
# store/messages.db scheduled_tasks) so the two never both run. To go back:
#   launchctl unload ~/Library/LaunchAgents/com.nanoclaw.{tickets-pricer,watchdog}.plist
#   sqlite3 store/messages.db "UPDATE scheduled_tasks SET status='active'
#     WHERE name IN ('Health Watchdog','Ticket Pricer')"

set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${HOME}/.local/share/nanoclaw/logs"
mkdir -p "${LOG_DIR}" "${HOME}/.local/share/nanoclaw/state" "${HOME}/Library/LaunchAgents"

for name in ${@:-tickets-pricer watchdog}; do
  LABEL="com.nanoclaw.${name}"
  TEMPLATE="${REPO_DIR}/launchd/${LABEL}.plist"
  INSTALLED="${HOME}/Library/LaunchAgents/${LABEL}.plist"
  [[ -f "${TEMPLATE}" ]] || { echo "ERROR: template missing at ${TEMPLATE}"; exit 1; }
  sed -e "s#{{PROJECT_ROOT}}#${REPO_DIR}#g" -e "s#{{HOME}}#${HOME}#g" "${TEMPLATE}" > "${INSTALLED}"
  plutil -lint "${INSTALLED}"
  launchctl unload "${INSTALLED}" 2>/dev/null || true
  launchctl load "${INSTALLED}"
  launchctl list | grep -q "${LABEL}" || { echo "ERROR: ${LABEL} did not load"; exit 1; }
  echo "loaded: $(launchctl list | grep "${LABEL}")"
done
