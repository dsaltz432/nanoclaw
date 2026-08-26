#!/usr/bin/env bash
#
# Weekly backup verification, run by com.nanoclaw.backup-verify (Sun 05:00).
#
# Wraps restore-backup.sh's verify-only mode and records the verdict where the
# Health Watchdog can see it. The wrapper exists for that last part: the backup
# silently contained a single empty database for months, and writing the result
# to a log nobody reads would repeat exactly that mistake. A failed verification
# has to become an alert.
#
# Writes data/health-probe/backup-verify-status.txt:
#   OK|<iso8601>|<db_count>
#   FAIL|<iso8601>|<short reason>

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATUS_FILE="${PROJECT_ROOT}/data/health-probe/backup-verify-status.txt"
LOG_FILE="${PROJECT_ROOT}/logs/backup-verify.log"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$(dirname "${STATUS_FILE}")" "${PROJECT_ROOT}/logs"

{
  echo "===== backup verify: ${TIMESTAMP} ====="
} >> "${LOG_FILE}"

OUTPUT="$(bash "${PROJECT_ROOT}/scripts/restore-backup.sh" 2>&1)"
RC=$?

echo "${OUTPUT}" >> "${LOG_FILE}"
echo "===== exit ${RC}: $(date -u +%Y-%m-%dT%H:%M:%SZ) =====" >> "${LOG_FILE}"

write_status() {   # verdict detail
  local tmp
  tmp="$(mktemp)"
  echo "$1|${TIMESTAMP}|$2" > "${tmp}"
  mv "${tmp}" "${STATUS_FILE}"
}

if [ "${RC}" -eq 0 ]; then
  # "databases: 13 total, 0 corrupt, 0 critical missing"
  DB_COUNT="$(echo "${OUTPUT}" | sed -n 's/^databases: \([0-9]*\) total.*/\1/p' | tail -1)"
  write_status "OK" "${DB_COUNT:-unknown} databases verified"
  exit 0
fi

# Keep the reason to one line so the status file stays trivially parseable.
REASON="$(echo "${OUTPUT}" | grep -E 'CRITICAL MISSING|BAD |VERDICT|ERROR' | head -3 | tr '\n' ' ' | cut -c1-200)"
write_status "FAIL" "${REASON:-restore-backup.sh exited ${RC}}"
exit 1
