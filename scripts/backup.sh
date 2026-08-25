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
#
# rsync above excludes '*.db' so we never copy a torn page mid-write. That
# exclusion is recursive, so this loop must be recursive too. It used to be
# `for db in data/*.db`, which matched only the top level — every nested DB
# (tickets, garmin, strava, beacon, shopping, mortgage) was excluded by rsync
# and then never re-added, so backups contained exactly one database, and it
# was the empty data/nanoclaw.db.
DB_COUNT=0
while IFS= read -r db; do
  rel="${db#./}"
  dest="${STAGE}/${rel}"
  mkdir -p "$(dirname "${dest}")"
  echo "sqlite3 .backup ${rel}"
  if sqlite3 "${db}" ".backup '${dest}'"; then
    DB_COUNT=$((DB_COUNT + 1))
  else
    echo "ERROR: failed to snapshot ${rel}"
    exit 1
  fi
done < <(find ./data ./store -name '*.db' -type f 2>/dev/null)

echo "databases snapshotted: ${DB_COUNT}"

# ---- 3. stage other state ----
[[ -f .env ]] && cp .env "${STAGE}/env"
[[ -d groups ]] && cp -R groups "${STAGE}/groups"
[[ -d "${HOME}/.gmail-mcp" ]] && cp -R "${HOME}/.gmail-mcp" "${STAGE}/gmail-mcp"

# ---- 3. tar + encrypt with age (streaming, never hits disk unencrypted) ----
ARCHIVE="${STAGE}/${OBJECT_NAME}"

# Fail loudly rather than silently shipping an archive missing the two
# databases that cannot be reconstructed from any external source.
for required in store/messages.db data/sessions/tickets/.claude/tickets.db; do
  if [[ -f "${REPO_DIR}/${required}" && ! -s "${STAGE}/${required}" ]]; then
    echo "ERROR: ${required} exists but was not staged — refusing to upload a partial backup"
    exit 1
  fi
done

echo "creating encrypted archive"
TAR_PATHS=(data groups env gmail-mcp)
[[ -d "${STAGE}/store" ]] && TAR_PATHS+=(store)
tar -C "${STAGE}" -czf - "${TAR_PATHS[@]}" 2>/dev/null \
  | age -r "${AGE_RECIPIENT}" -o "${ARCHIVE}"

SIZE="$(du -h "${ARCHIVE}" | awk '{print $1}')"
echo "archive size: ${SIZE}"

# ---- 4. auth as service account and upload ----
echo "activating service account"
gcloud auth activate-service-account --key-file="${SA_KEY}" >/dev/null

echo "uploading to gs://${BUCKET}/${OBJECT_NAME}"
gcloud storage cp "${ARCHIVE}" "gs://${BUCKET}/${OBJECT_NAME}"

echo "===== done: $(date -u +%FT%TZ) ====="
