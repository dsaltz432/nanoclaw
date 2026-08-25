#!/usr/bin/env bash
#
# Restore (or just verify) a NanoClaw backup.
#
# Default mode is VERIFY: download, decrypt, extract to a temp dir, integrity-
# check every SQLite DB, and report. It touches nothing in the live install.
# That is deliberate — the failure you actually want to catch is "the backup is
# not what I think it is", and you want to catch it on a normal Tuesday rather
# than during an outage.
#
#   ./scripts/restore-backup.sh                    # verify latest from GCS
#   ./scripts/restore-backup.sh --file b.age       # verify a local archive
#   ./scripts/restore-backup.sh --into /tmp/r      # keep the extraction
#   ./scripts/restore-backup.sh --apply            # overwrite the live install
#
# --apply stops NanoClaw, backs up what it is about to replace, restores, and
# leaves the service stopped so you can look before starting it.
#
# Requires: age, gcloud, sqlite3, and the private key at
# ~/.config/age/nanoclaw-backup.key (without it the archive is unrecoverable).

set -euo pipefail

REPO_DIR="/Users/danielsaltz/Documents/repositories/nanoclaw"
BUCKET="nanoclaw-backups"
OBJECT_NAME="nanoclaw-backup.tar.gz.age"
SA_KEY="${HOME}/.gcp/nanoclaw-backup.json"
AGE_KEY="${HOME}/.config/age/nanoclaw-backup.key"

# Databases that cannot be rebuilt from any external source. Their absence
# means the backup is not worth restoring from.
CRITICAL_DBS=(
  "store/messages.db"
  "data/sessions/tickets/.claude/tickets.db"
)

LOCAL_FILE=""
INTO=""
APPLY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --file)  LOCAL_FILE="$2"; shift 2 ;;
    --into)  INTO="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    *) echo "unknown argument: $1"; exit 2 ;;
  esac
done

command -v age     >/dev/null || { echo "ERROR: age not installed (brew install age)"; exit 1; }
command -v sqlite3 >/dev/null || { echo "ERROR: sqlite3 not installed"; exit 1; }
[[ -f "${AGE_KEY}" ]] || {
  echo "ERROR: age private key missing at ${AGE_KEY}"
  echo "       Without it this archive cannot be decrypted by anyone, ever."
  exit 1
}

WORK="${INTO:-$(mktemp -d -t nanoclaw-restore)}"
mkdir -p "${WORK}"
[[ -z "${INTO}" ]] && trap 'rm -rf "${WORK}"' EXIT

# ---- 1. obtain the archive ----
if [[ -n "${LOCAL_FILE}" ]]; then
  ARCHIVE="${LOCAL_FILE}"
  echo "using local archive: ${ARCHIVE}"
else
  command -v gcloud >/dev/null || { echo "ERROR: gcloud not installed"; exit 1; }
  [[ -f "${SA_KEY}" ]] || { echo "ERROR: service account key missing at ${SA_KEY}"; exit 1; }
  echo "downloading gs://${BUCKET}/${OBJECT_NAME}"
  gcloud auth activate-service-account --key-file="${SA_KEY}" >/dev/null
  gcloud storage cp "gs://${BUCKET}/${OBJECT_NAME}" "${WORK}/${OBJECT_NAME}" >/dev/null
  ARCHIVE="${WORK}/${OBJECT_NAME}"
fi

echo "archive size: $(du -h "${ARCHIVE}" | awk '{print $1}')"

# ---- 2. decrypt + extract ----
echo "decrypting"
age -d -i "${AGE_KEY}" -o "${WORK}/backup.tar.gz" "${ARCHIVE}"
echo "extracting"
mkdir -p "${WORK}/extracted"
tar -xzf "${WORK}/backup.tar.gz" -C "${WORK}/extracted"

# ---- 3. verify ----
echo
echo "--- contents ---"
for top in data groups env gmail-mcp store; do
  if [[ -e "${WORK}/extracted/${top}" ]]; then
    echo "  ${top}: present"
  else
    echo "  ${top}: MISSING"
  fi
done

echo
echo "--- databases ---"
DB_TOTAL=0
DB_BAD=0
while IFS= read -r db; do
  DB_TOTAL=$((DB_TOTAL + 1))
  rel="${db#"${WORK}/extracted/"}"
  result="$(sqlite3 "${db}" 'PRAGMA integrity_check;' 2>&1 | head -1)"
  size="$(du -h "${db}" | awk '{print $1}')"
  if [[ "${result}" == "ok" ]]; then
    printf "  ok    %-8s %s\n" "${size}" "${rel}"
  else
    DB_BAD=$((DB_BAD + 1))
    printf "  BAD   %-8s %s  (%s)\n" "${size}" "${rel}" "${result}"
  fi
done < <(find "${WORK}/extracted" -name '*.db' -type f | sort)

echo
MISSING=0
for req in "${CRITICAL_DBS[@]}"; do
  if [[ -s "${WORK}/extracted/${req}" ]]; then
    echo "  critical present: ${req}"
  else
    echo "  CRITICAL MISSING: ${req}"
    MISSING=$((MISSING + 1))
  fi
done

echo
echo "databases: ${DB_TOTAL} total, ${DB_BAD} corrupt, ${MISSING} critical missing"
if [[ ${DB_BAD} -gt 0 || ${MISSING} -gt 0 ]]; then
  echo "VERDICT: this backup is NOT safe to restore from."
  exit 1
fi
echo "VERDICT: backup verified."

if [[ ${APPLY} -eq 0 ]]; then
  echo
  echo "Verify-only (default). Nothing in the live install was touched."
  [[ -n "${INTO}" ]] && echo "Extraction kept at: ${WORK}/extracted"
  echo "Re-run with --apply to overwrite the live install."
  exit 0
fi

# ---- 4. apply ----
echo
echo "APPLYING to ${REPO_DIR}"
SAFETY="${REPO_DIR}/../nanoclaw-pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
echo "stopping com.nanoclaw"
launchctl unload "${HOME}/Library/LaunchAgents/com.nanoclaw.plist" 2>/dev/null || true
sleep 3

echo "saving current state to ${SAFETY}"
mkdir -p "${SAFETY}"
for top in data groups store; do
  [[ -e "${REPO_DIR}/${top}" ]] && cp -R "${REPO_DIR}/${top}" "${SAFETY}/"
done
[[ -f "${REPO_DIR}/.env" ]] && cp "${REPO_DIR}/.env" "${SAFETY}/env"

echo "restoring"
for top in data groups store; do
  [[ -e "${WORK}/extracted/${top}" ]] && cp -R "${WORK}/extracted/${top}" "${REPO_DIR}/"
done
[[ -f "${WORK}/extracted/env" ]] && cp "${WORK}/extracted/env" "${REPO_DIR}/.env" && chmod 600 "${REPO_DIR}/.env"

echo
echo "Restored. com.nanoclaw is still STOPPED on purpose — inspect first, then:"
echo "  launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist"
echo "Previous state preserved at: ${SAFETY}"
