#!/usr/bin/env bash
# Heartbeat + host health snapshot.
#
# Runs on the host every 5 min via com.nanoclaw.heartbeat.plist. Does two things:
#
#   1. Dumps host-only state (launchctl status, host disk usage) to
#      data/health-probe/ so the watchdog agent — which runs in a Linux
#      container and can't call launchctl — has something to read.
#
#   2. Pings Healthchecks.io as a dead-man's switch. Only pings when
#      com.nanoclaw is loaded and not in an error state, so HC.io going
#      silent means either the host is down OR NanoClaw itself is wedged.
#
# HC.io URL goes in ~/.config/nanoclaw/healthchecks-ping-url. Missing file =
# heartbeat is no-op for HC.io but still writes the snapshot.

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL_FILE="${HOME}/.config/nanoclaw/healthchecks-ping-url"
SNAPSHOT_DIR="${PROJECT_ROOT}/data/health-probe"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

mkdir -p "$SNAPSHOT_DIR"

# Atomic snapshot writes — build in tempfiles, rename into place.
TMP_LAUNCHD=$(mktemp)
TMP_DISK=$(mktemp)
TMP_TS=$(mktemp)

launchctl list 2>/dev/null | awk '$3 ~ /^com\.nanoclaw/' > "$TMP_LAUNCHD"
df -k "$PROJECT_ROOT" 2>/dev/null | tail -1 > "$TMP_DISK"
echo "$TIMESTAMP" > "$TMP_TS"

mv "$TMP_LAUNCHD" "$SNAPSHOT_DIR/launchctl.txt"
mv "$TMP_DISK"    "$SNAPSHOT_DIR/disk.txt"
mv "$TMP_TS"      "$SNAPSHOT_DIR/timestamp.txt"

# --- HC.io ping ---
if [ ! -s "$URL_FILE" ]; then
  exit 0
fi

URL=$(tr -d '[:space:]' < "$URL_FILE")
if [ -z "$URL" ]; then
  exit 0
fi

# launchctl list format: PID Status Label  (PID '-' = not running)
STATUS_LINE=$(awk '$3 == "com.nanoclaw" {print $1, $2}' "$SNAPSHOT_DIR/launchctl.txt")

if [ -z "$STATUS_LINE" ]; then
  curl -fsS --retry 2 --max-time 10 \
    --data-raw "com.nanoclaw not loaded in launchd" \
    "${URL}/fail" >/dev/null 2>&1
  exit 1
fi

PID=$(echo "$STATUS_LINE" | awk '{print $1}')
EXITCODE=$(echo "$STATUS_LINE" | awk '{print $2}')

if [ "$PID" = "-" ] && [ "$EXITCODE" != "0" ]; then
  curl -fsS --retry 2 --max-time 10 \
    --data-raw "com.nanoclaw not running (last exit: $EXITCODE)" \
    "${URL}/fail" >/dev/null 2>&1
  exit 1
fi

curl -fsS --retry 2 --max-time 10 "$URL" >/dev/null 2>&1
