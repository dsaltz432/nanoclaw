#!/usr/bin/env bash
#
# NanoClaw backup: snapshots SQLite DBs + critical state, encrypts with age,
# uploads to gs://nanoclaw-backups/ under a FIXED filename so GCS object
# versioning handles retention (see bucket lifecycle rules).
#
# IMPORTANT: the age recipient public key below encrypts; the matching
# PRIVATE key lives at ~/.config/age/nanoclaw-backup.key. If you lose that
# private key, the backups are UNRECOVERABLE. Back it up to a password
# manager.
#
# Prereqs:
#   brew install age
#   ./scripts/setup-backup-sa.sh   (creates SA + downloads key)
#   age-keygen -o ~/.config/age/nanoclaw-backup.key  (then paste public key below)

set -euo pipefail

# ---- config ----
REPO_DIR="/Users/danielsaltz/Documents/repositories/nanoclaw"
BUCKET="nanoclaw-backups"
OBJECT_NAME="nanoclaw-backup.tar.gz.age"   # fixed name → versioning retains history
SA_KEY="${HOME}/.gcp/nanoclaw-backup.json"
AGE_RECIPIENT_FILE="${HOME}/.config/age/nanoclaw-backup.pub"   # contains: age1...
LOG_FILE="${REPO_DIR}/logs/backup.log"

# ---- setup ----
mkdir -p "${REPO_DIR}/logs"
exec >>"${LOG_FILE}" 2>&1
echo "===== backup run: $(date -u +%FT%TZ) ====="

cd "${REPO_DIR}"

command -v age >/dev/null || { echo "ERROR: age not installed (brew install age)"; exit 1; }
command -v gcloud >/dev/null || { echo "ERROR: gcloud not installed"; exit 1; }
[[ -f "${SA_KEY}" ]] || { echo "ERROR: service account key missing at ${SA_KEY}"; exit 1; }
[[ -f "${AGE_RECIPIENT_FILE}" ]] || { echo "ERROR: age public key missing at ${AGE_RECIPIENT_FILE}"; exit 1; }

AGE_RECIPIENT="$(cat "${AGE_RECIPIENT_FILE}")"

# ---- staging dir ----
STAGE="$(mktemp -d -t nanoclaw-backup)"

# Remember whichever gcloud account is active so we can restore it after
# `gcloud auth activate-service-account` flips the active account to the SA.
# Empty in launchd context (no prior user account), in which case we skip restore.
ORIGINAL_ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"

cleanup() {
  rm -rf "${STAGE}"
  if [[ -n "${ORIGINAL_ACCOUNT}" && "${ORIGINAL_ACCOUNT}" != *"iam.gserviceaccount.com" ]]; then
    gcloud config set account "${ORIGINAL_ACCOUNT}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ---- 1. stage data/ (excluding ephemeral bits) ----
# Includes SQLite DBs, sessions/ (Strava/Garmin credentials), beacon-geocache, etc.
# Excludes: ipc/ (ephemeral IPC files), email-unsubscribe/ (regenerable scan output).
echo "staging data/"
mkdir -p "${STAGE}/data"
rsync -a \
  --exclude 'ipc/' \
  --exclude 'email-unsubscribe/' \
  --exclude '*.db' \
  data/ "${STAGE}/data/"

# ---- 2. hot-copy SQLite DBs with .backup (safe while DB is in use) ----
for db in data/*.db; do
  [[ -f "${db}" ]] || continue
  name="$(basename "${db}")"
  echo "sqlite3 .backup ${name}"
  sqlite3 "${db}" ".backup '${STAGE}/data/${name}'"
done

# ---- 3. stage other state ----
[[ -f .env ]] && cp .env "${STAGE}/env"
[[ -d groups ]] && cp -R groups "${STAGE}/groups"
[[ -d "${HOME}/.gmail-mcp" ]] && cp -R "${HOME}/.gmail-mcp" "${STAGE}/gmail-mcp"

# ---- 3. tar + encrypt with age (streaming, never hits disk unencrypted) ----
ARCHIVE="${STAGE}/${OBJECT_NAME}"
echo "creating encrypted archive"
tar -C "${STAGE}" -czf - data groups env gmail-mcp 2>/dev/null \
  | age -r "${AGE_RECIPIENT}" -o "${ARCHIVE}"

SIZE="$(du -h "${ARCHIVE}" | awk '{print $1}')"
echo "archive size: ${SIZE}"

# ---- 4. auth as service account and upload ----
echo "activating service account"
gcloud auth activate-service-account --key-file="${SA_KEY}" >/dev/null

echo "uploading to gs://${BUCKET}/${OBJECT_NAME}"
gcloud storage cp "${ARCHIVE}" "gs://${BUCKET}/${OBJECT_NAME}"

echo "===== done: $(date -u +%FT%TZ) ====="
