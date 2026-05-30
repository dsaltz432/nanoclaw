#!/usr/bin/env bash
#
# Upload all trip-briefing HTML files to gs://strava-trips/
# Triggered by launchd WatchPaths when data/trip-briefings/ changes,
# or run manually: ./scripts/upload-trip-briefing.sh
#
# Public URL: https://storage.googleapis.com/strava-trips/<filename>

set -euo pipefail

REPO_DIR="/Users/danielsaltz/Documents/repositories/nanoclaw"
BUCKET="strava-trips"
SA_KEY="${HOME}/.gcp/nanoclaw-backup.json"
BRIEFINGS_DIR="${REPO_DIR}/data/trip-briefings"
LOG_FILE="${REPO_DIR}/logs/trip-briefing-upload.log"
TOMBSTONE_DIR="${BRIEFINGS_DIR}/.tombstone"

mkdir -p "${REPO_DIR}/logs" "${TOMBSTONE_DIR}"
exec >>"${LOG_FILE}" 2>&1
echo "===== upload run: $(date -u +%FT%TZ) ====="

shopt -s nullglob
FILES=("${BRIEFINGS_DIR}"/*.html)
TOMBSTONES=("${TOMBSTONE_DIR}"/*)
if [[ ${#FILES[@]} -eq 0 && ${#TOMBSTONES[@]} -eq 0 ]]; then
  echo "nothing to do"
  exit 0
fi

command -v gcloud >/dev/null || { echo "ERROR: gcloud not installed"; exit 1; }
[[ -f "${SA_KEY}" ]] || { echo "ERROR: service account key missing at ${SA_KEY}"; exit 1; }

ORIGINAL_ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"

cleanup() {
  if [[ -n "${ORIGINAL_ACCOUNT}" && "${ORIGINAL_ACCOUNT}" != *"iam.gserviceaccount.com" ]]; then
    gcloud config set account "${ORIGINAL_ACCOUNT}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

gcloud auth activate-service-account --key-file="${SA_KEY}" >/dev/null

# Upload current files
for filepath in "${FILES[@]}"; do
  filename="$(basename "${filepath}")"
  echo "uploading ${filename}"
  gcloud storage cp "${filepath}" "gs://${BUCKET}/${filename}" \
    --content-type="text/html" \
    --cache-control="public, max-age=60"
  echo "https://storage.googleapis.com/${BUCKET}/${filename}"
done

# Delete tombstoned files from bucket (unpublish flow drops slug-named empty
# files into .tombstone/ so the watcher cleans up the remote copy).
# Defensive `${...+...}` expansion: under `set -u`, expanding an empty array
# with `${arr[@]}` errors. This idiom expands to nothing if the array is empty.
for tombstone in ${TOMBSTONES[@]+"${TOMBSTONES[@]}"}; do
  remote_name="$(basename "${tombstone}")"
  echo "removing ${remote_name} from gs://${BUCKET}/"
  gcloud storage rm "gs://${BUCKET}/${remote_name}" 2>/dev/null || echo "  (already absent)"
  rm "${tombstone}"
done

echo "===== done: $(date -u +%FT%TZ) ====="
