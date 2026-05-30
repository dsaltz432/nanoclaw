#!/usr/bin/env bash
#
# One-time setup for the public bucket that hosts published trip pages.
# Idempotent — safe to re-run; existing bucket + bindings are detected and skipped.
#
# What this does:
#   1. Creates gs://strava-trips/ in the active GCP project (if missing)
#   2. Enables uniform bucket-level access
#   3. Grants public read (allUsers → roles/storage.objectViewer)
#
# Prereqs:
#   - gcloud CLI installed and authenticated (`gcloud auth login`)
#   - An active project selected (`gcloud config set project <project>`)

set -euo pipefail

BUCKET="strava-trips"
LOCATION="us"

# ── sanity checks ────────────────────────────────────────────────────────────

command -v gcloud >/dev/null || {
  echo "ERROR: gcloud CLI not found in PATH."
  echo "Install: https://cloud.google.com/sdk/docs/install"
  exit 1
}

ACTIVE_ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
if [[ -z "${ACTIVE_ACCOUNT}" ]]; then
  echo "ERROR: No active gcloud account. Run 'gcloud auth login' first."
  exit 1
fi

ACTIVE_PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
if [[ -z "${ACTIVE_PROJECT}" ]]; then
  echo "ERROR: No active gcloud project. Run 'gcloud config set project <PROJECT_ID>' first."
  exit 1
fi

echo "Using account: ${ACTIVE_ACCOUNT}"
echo "Using project: ${ACTIVE_PROJECT}"
echo "Bucket:        gs://${BUCKET} (${LOCATION})"
echo

# ── create bucket ────────────────────────────────────────────────────────────

if gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  echo "✓ Bucket gs://${BUCKET} already exists — skipping creation."
else
  echo "Creating gs://${BUCKET}…"
  gcloud storage buckets create "gs://${BUCKET}" \
    --location="${LOCATION}" \
    --uniform-bucket-level-access
  echo "✓ Bucket created."
fi

# ── public read ──────────────────────────────────────────────────────────────

CURRENT_POLICY="$(gcloud storage buckets get-iam-policy "gs://${BUCKET}" --format=json 2>/dev/null || echo '{}')"
if echo "${CURRENT_POLICY}" | grep -q '"allUsers"' \
   && echo "${CURRENT_POLICY}" | grep -q 'roles/storage.objectViewer'; then
  echo "✓ Public read already granted — skipping."
else
  echo "Granting public read (allUsers → roles/storage.objectViewer)…"
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member=allUsers \
    --role=roles/storage.objectViewer >/dev/null
  echo "✓ Public read granted."
fi

# ── verify ───────────────────────────────────────────────────────────────────

echo
echo "Verifying…"
gcloud storage buckets describe "gs://${BUCKET}" \
  --format="value(name,location,iamConfiguration.uniformBucketLevelAccess.enabled)" \
  | awk '{ printf "  name: %s\n  location: %s\n  uniform_access: %s\n", $1, $2, $3 }'
echo

echo "Public URL pattern:"
echo "  https://storage.googleapis.com/${BUCKET}/<slug>.html"
echo
echo "Next: install the upload watcher so newly-published trips auto-upload:"
echo "  ln -s \"$(pwd)/launchd/com.nanoclaw.trip-briefing-upload.plist\" \\"
echo "        ~/Library/LaunchAgents/com.nanoclaw.trip-briefing-upload.plist"
echo "  launchctl load ~/Library/LaunchAgents/com.nanoclaw.trip-briefing-upload.plist"
echo
echo "Done."
