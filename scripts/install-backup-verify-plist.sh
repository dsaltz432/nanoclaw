#!/usr/bin/env bash
#
# Install com.nanoclaw.backup-verify — weekly proof that the backup is restorable.
#
# Renders launchd/com.nanoclaw.backup-verify.plist with real paths, installs it,
# loads it, and runs one verification so you see the result immediately.
#
#   ./scripts/install-backup-verify-plist.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.nanoclaw.backup-verify"
TEMPLATE="${REPO_DIR}/launchd/${LABEL}.plist"
INSTALLED="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/.local/share/nanoclaw/logs"

[[ -f "${TEMPLATE}" ]] || { echo "ERROR: template missing at ${TEMPLATE}"; exit 1; }
[[ -x "${REPO_DIR}/scripts/backup-verify.sh" ]] || chmod +x "${REPO_DIR}/scripts/backup-verify.sh"
[[ -x "${REPO_DIR}/scripts/restore-backup.sh" ]] || chmod +x "${REPO_DIR}/scripts/restore-backup.sh"

command -v age >/dev/null || { echo "ERROR: age not installed (brew install age)"; exit 1; }
[[ -f "${HOME}/.config/age/nanoclaw-backup.key" ]] || {
  echo "ERROR: age private key missing — verification cannot decrypt the archive"; exit 1; }

# launchd opens Standard{Out,Error}Path at spawn; they must exist and be outside
# ~/Documents (see docs/host-cronjobs.md, the exit 78 gotcha).
mkdir -p "${LOG_DIR}"
mkdir -p "$(dirname "${INSTALLED}")"

echo "rendering ${LABEL}.plist"
sed -e "s#{{PROJECT_ROOT}}#${REPO_DIR}#g" \
    -e "s#{{HOME}}#${HOME}#g" \
    "${TEMPLATE}" > "${INSTALLED}"

plutil -lint "${INSTALLED}"

echo "loading"
launchctl unload "${INSTALLED}" 2>/dev/null || true
launchctl load "${INSTALLED}"

if ! launchctl list | grep -q "${LABEL}"; then
  echo "ERROR: ${LABEL} did not load"
  exit 1
fi
echo "loaded: $(launchctl list | grep "${LABEL}")"

echo
echo "running one verification now (downloads ~112MB, takes a couple of minutes)"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"

# Wait for the run to finish rather than tailing a half-written log.
for _ in $(seq 1 60); do
  sleep 5
  state="$(launchctl list | awk -v l="${LABEL}" '$3==l {print $1}')"
  [[ "${state}" == "-" ]] && break
done

echo
# The wrapper writes its detail to the repo log; the launchd log only catches
# anything that escapes that redirect (i.e. real crashes).
echo "--- ${REPO_DIR}/logs/backup-verify.log (tail) ---"
tail -20 "${REPO_DIR}/logs/backup-verify.log" 2>/dev/null || echo "(empty)"
if [[ -s "${LOG_DIR}/backup-verify.error.log" ]]; then
  echo "--- launchd stderr (unexpected) ---"
  tail -10 "${LOG_DIR}/backup-verify.error.log"
fi
echo
echo "--- status file ---"
cat "${REPO_DIR}/data/health-probe/backup-verify-status.txt" 2>/dev/null || echo "(not written)"
echo
echo "Scheduled: Sundays 05:00 local. Verify-only — it never touches the live install."
echo "The Health Watchdog reads the status file and alerts if it says FAIL or goes stale."
