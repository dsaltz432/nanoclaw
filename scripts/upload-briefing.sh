#!/usr/bin/env bash
#
# Upload all sports briefing HTML files to gs://sports-briefings/
# Triggered by launchd WatchPaths when data/briefings/ changes,
# or run manually: ./scripts/upload-briefing.sh
#
# Public URL: https://storage.googleapis.com/sports-briefings/<filename>

set -euo pipefail

REPO_DIR="/Users/danielsaltz/Documents/repositories/nanoclaw"
BUCKET="sports-briefings"
SA_KEY="${HOME}/.gcp/nanoclaw-backup.json"
BRIEFINGS_DIR="${REPO_DIR}/data/briefings"
LOG_FILE="${REPO_DIR}/logs/briefing-upload.log"

mkdir -p "${REPO_DIR}/logs"
exec >>"${LOG_FILE}" 2>&1
echo "===== upload run: $(date -u +%FT%TZ) ====="

shopt -s nullglob
FILES=("${BRIEFINGS_DIR}"/*.html)
[[ ${#FILES[@]} -gt 0 ]] || { echo "no HTML files to upload"; exit 0; }

command -v gcloud >/dev/null || { echo "ERROR: gcloud not installed"; exit 1; }
[[ -f "${SA_KEY}" ]] || { echo "ERROR: service account key missing at ${SA_KEY}"; exit 1; }

# Remember active account so we can restore it
ORIGINAL_ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"

cleanup() {
  if [[ -n "${ORIGINAL_ACCOUNT}" && "${ORIGINAL_ACCOUNT}" != *"iam.gserviceaccount.com" ]]; then
    gcloud config set account "${ORIGINAL_ACCOUNT}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# gcloud storage's multiprocessing pool intermittently crashes on this host
# (leaked-semaphore warning at shutdown), which previously aborted the whole
# run. These are tiny files — disable parallelism for stability.
export CLOUDSDK_STORAGE_PROCESS_COUNT=1

gcloud auth activate-service-account --key-file="${SA_KEY}" >/dev/null

# Upload one file, retrying transient gcloud/network failures.
# Returns non-zero only after all attempts are exhausted.
upload_one() {
  local filepath="$1" filename="$2" attempt
  for attempt in 1 2 3; do
    if gcloud storage cp "${filepath}" "gs://${BUCKET}/${filename}" \
        --content-type="text/html" \
        --cache-control="public, max-age=60"; then
      return 0
    fi
    echo "  attempt ${attempt} failed for ${filename}; retrying in 3s..."
    sleep 3
  done
  return 1
}

# Track failures but keep going — a single flaky upload must NOT abort the run,
# or every file after it (e.g. a just-created briefing) silently never uploads.
failed=()
for filepath in "${FILES[@]}"; do
  filename="$(basename "${filepath}")"
  echo "uploading ${filename}"
  if upload_one "${filepath}" "${filename}"; then
    echo "https://storage.googleapis.com/${BUCKET}/${filename}"
  else
    echo "ERROR: gave up on ${filename} after 3 attempts"
    failed+=("${filename}")
  fi
done

if [[ ${#failed[@]} -gt 0 ]]; then
  echo "===== done WITH FAILURES (${#failed[@]}): ${failed[*]} — $(date -u +%FT%TZ) ====="
  exit 1
fi
echo "===== done: $(date -u +%FT%TZ) ====="
