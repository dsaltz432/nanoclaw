#!/usr/bin/env bash
#
# Setup: creates a dedicated service account for NanoClaw GCS access
# with least-privilege access (objectUser) to configured buckets,
# and downloads a key to ~/.gcp/nanoclaw-backup.json.
# Idempotent — safe to re-run when adding new buckets.
#
# Prereqs: gcloud CLI installed and authenticated as a user with permission
# to create service accounts and grant bucket IAM in the project.

set -euo pipefail

PROJECT_ID="nanoclaw-489701"
BUCKETS=("nanoclaw-backups" "sports-briefings")
SA_NAME="nanoclaw-backup"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
KEY_DIR="${HOME}/.gcp"
KEY_FILE="${KEY_DIR}/nanoclaw-backup.json"

echo "==> Project: ${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}" >/dev/null

# 1. Create service account (idempotent)
if gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1; then
  echo "==> Service account ${SA_EMAIL} already exists, skipping create"
else
  echo "==> Creating service account ${SA_EMAIL}"
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="NanoClaw Backup Uploader" \
    --description="Write-only access to gs://${BUCKET} for daily backups"
fi

# 2. Grant roles/storage.objectUser on the bucket ONLY (not project-wide).
#    objectUser bundles create/get/list/delete/update on objects — required
#    because `gcloud storage cp` does a HEAD/GET on the destination and a
#    delete-and-replace when overwriting.
#
#    Safety properties that still hold:
#      - Bucket-scoped: cannot touch any other bucket in the project
#      - Archives are age-encrypted: leaked key only sees ciphertext
#      - Bucket has object versioning + noncurrent-version retention rules:
#        a "delete" only marks the object noncurrent, and the lifecycle policy
#        (keep 7+ newer versions, 14+ days) preserves history. A leaked key
#        cannot actually destroy past backups.
for BUCKET in "${BUCKETS[@]}"; do
  echo "==> Granting roles/storage.objectUser on gs://${BUCKET}"
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/storage.objectUser" >/dev/null
done

# 3. Create and download key
mkdir -p "${KEY_DIR}"
chmod 700 "${KEY_DIR}"

if [[ -f "${KEY_FILE}" ]]; then
  echo "==> Key already exists at ${KEY_FILE}, skipping key creation"
  echo "    (delete it first if you want to rotate)"
else
  echo "==> Creating key at ${KEY_FILE}"
  gcloud iam service-accounts keys create "${KEY_FILE}" \
    --iam-account="${SA_EMAIL}"
  chmod 600 "${KEY_FILE}"
fi

echo
echo "Done."
echo
echo "Service account: ${SA_EMAIL}"
echo "Key file:        ${KEY_FILE}"
echo "Bucket access:   ${BUCKETS[*]} (objectUser)"
echo
echo "Next step: the backup script will activate this key with:"
echo "  gcloud auth activate-service-account --key-file=${KEY_FILE}"
