#!/usr/bin/env bash
# Heartbeat + host health snapshot.
#
# Runs on the host every 5 min via com.nanoclaw.heartbeat.plist. Does three
# things:
#
#   1. Dumps host-only state (launchctl status, host disk usage, periodic-job
#      freshness, service restarts) to data/health-probe/ so the watchdog agent
#      — which runs in a Linux container and can't call launchctl — has
#      something to read.
#
#   2. Pings Healthchecks.io as a dead-man's switch. Only pings when
#      com.nanoclaw is loaded and running, so HC.io going silent means either
#      the host is down OR NanoClaw itself is wedged.
#
#   3. Escalates a stuck watchdog to HC.io. The watchdog is what catches
#      everything else, but nothing was watching the watchdog — it is
#      self-excluded from its own task-failure check, and HC.io only ever
#      looked at the com.nanoclaw process. If the watchdog has not completed a
#      run in WATCHDOG_MAX_AGE_MIN while NanoClaw is otherwise healthy, fail
#      the check so it surfaces externally.
#
# HC.io URL goes in ~/.config/nanoclaw/healthchecks-ping-url. Missing file =
# heartbeat is no-op for HC.io but still writes the snapshot.

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
URL_FILE="${HOME}/.config/nanoclaw/healthchecks-ping-url"
SNAPSHOT_DIR="${PROJECT_ROOT}/data/health-probe"
LOG_DIR="${PROJECT_ROOT}/logs"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
NOW_EPOCH=$(date +%s)

# A daily job is late once it has missed its window plus 2h of grace.
DAILY_MAX_AGE_MIN=1560
WATCHDOG_MAX_AGE_MIN=90

mkdir -p "$SNAPSHOT_DIR"

# Atomic snapshot writes — build in tempfiles, rename into place.
TMP_LAUNCHD=$(mktemp)
TMP_DISK=$(mktemp)
TMP_TS=$(mktemp)
TMP_JOBS=$(mktemp)

launchctl list 2>/dev/null | awk '$3 ~ /^com\.nanoclaw/' > "$TMP_LAUNCHD"
df -k "$PROJECT_ROOT" 2>/dev/null | tail -1 > "$TMP_DISK"
echo "$TIMESTAMP" > "$TMP_TS"

# --- periodic job freshness -------------------------------------------------
#
# launchctl reports only PID and last exit code. A one-shot job that has
# stopped firing altogether sits at "- 0" forever, which is indistinguishable
# from healthy-and-idle. So derive "did it actually run" from the mtime of the
# log each job appends to.
#
# Format: label|kind|max_age_min|age_min|source
#   kind  = daily / interval / weekly -> alert when age_min > max_age_min
#           event  -> WatchPaths-triggered; dormancy is correct, never alert
#   age_min = -1 when the job has no log at all (never run, or log deleted)

emit_job() {                      # label kind max_age glob
  local label="$1" kind="$2" max_age="$3" glob="$4"
  local newest age=-1
  # shellcheck disable=SC2086
  newest=$(ls -t $glob 2>/dev/null | head -1)
  if [ -n "$newest" ] && [ -f "$newest" ]; then
    local mtime
    mtime=$(stat -f %m "$newest" 2>/dev/null || stat -c %Y "$newest" 2>/dev/null)
    [ -n "$mtime" ] && age=$(( (NOW_EPOCH - mtime) / 60 ))
  fi
  echo "${label}|${kind}|${max_age}|${age}|$(basename "${newest:-none}")" >> "$TMP_JOBS"
}

emit_job com.nanoclaw.backup          daily "$DAILY_MAX_AGE_MIN" "${LOG_DIR}/backup.log"
emit_job com.nanoclaw.email-metadata  daily "$DAILY_MAX_AGE_MIN" "${LOG_DIR}/email-metadata.log"
emit_job com.nanoclaw.spotify-cleanup daily "$DAILY_MAX_AGE_MIN" "${LOG_DIR}/spotify-cleanup-audit-*.log"
emit_job com.nanoclaw.ff-daily        daily "$DAILY_MAX_AGE_MIN" "${HOME}/.local/share/nanoclaw/logs/ff-daily.log"
# Interval jobs: max age = a few missed fires plus grace, not a day.
emit_job com.nanoclaw.ff-news         interval 60   "${LOG_DIR}/ff-news.log"
emit_job com.nanoclaw.ff-live         interval 360  "${HOME}/.local/share/nanoclaw/logs/ff-live.log"
# backup-verify runs weekly (Sun 05:00); 7 days + a day of grace. The script
# appends to this log on every run, success or failure, so mtime is reliable.
emit_job com.nanoclaw.backup-verify   weekly 11640  "${LOG_DIR}/backup-verify.log"
# WatchPaths jobs fire only when their watched directory changes. They have
# been idle for months by design; staleness here is not a fault.
emit_job com.nanoclaw.briefing-upload      event - "${LOG_DIR}/briefing-upload.log"
emit_job com.nanoclaw.trip-briefing-upload event - "${LOG_DIR}/trip-briefing-upload.log"

# --- service restart detection ---------------------------------------------
#
# com.nanoclaw is KeepAlive with launchd's default ~10s throttle, while this
# script samples every 300s. A crash-restart cycle is therefore invisible to
# HC.io roughly 97% of the time. Comparing the PID against the previous
# snapshot catches the restart after the fact, which is what actually matters.
#
# Entry format: label|old_pid|new_pid|detected_at|last_exit

# Only long-lived KeepAlive services qualify. Interval and one-shot jobs get a
# fresh PID on every fire by design — com.nanoclaw.heartbeat (this script) is
# itself running when it takes the snapshot, so tracking it produced a bogus
# "restart" every 5 minutes.
LONG_LIVED='com.nanoclaw|com.nanoclaw.dashboard|com.nanoclaw.caffeinate'

PREV_PIDS="${SNAPSHOT_DIR}/service-pids.txt"
TMP_PIDS=$(mktemp)
awk -v keep="^(${LONG_LIVED})$" '$1 != "-" && $3 ~ keep {print $3"="$1}' \
  "$TMP_LAUNCHD" | sort > "$TMP_PIDS"

: > "${TMP_JOBS}.restarts"
if [ -f "$PREV_PIDS" ]; then
  while IFS='=' read -r label pid; do
    [ -z "$label" ] && continue
    prev=$(awk -F= -v l="$label" '$1==l {print $2}' "$PREV_PIDS")
    if [ -n "$prev" ] && [ "$prev" != "$pid" ]; then
      # launchctl list column 2 for a running KeepAlive job is the exit
      # status of the PREVIOUS instance — i.e. how the old pid died.
      # 0, 143 (node's 128+SIGTERM) and -15 (raw SIGTERM) are deliberate
      # stops: launchctl kickstart, reloads, deploys. Recording those turned
      # every dev-loop restart into a "crashed" alert — 17 of them during
      # dashboard work on 2026-08-30 alone. Only actual crashes pass.
      last_exit=$(awk -v l="$label" '$3 == l {print $2}' "$TMP_LAUNCHD")
      case "$last_exit" in
        0|143|-15) ;; # graceful stop; not news
        *)
          echo "${label}|${prev}|${pid}|${TIMESTAMP}|${last_exit:-unknown}" \
            >> "${TMP_JOBS}.restarts"
          ;;
      esac
    fi
  done < "$TMP_PIDS"
fi

mv "$TMP_LAUNCHD" "$SNAPSHOT_DIR/launchctl.txt"
mv "$TMP_DISK"    "$SNAPSHOT_DIR/disk.txt"
mv "$TMP_JOBS"    "$SNAPSHOT_DIR/jobs.txt"
mv "$TMP_PIDS"    "$PREV_PIDS"
# Restarts persist briefly so one that happens between watchdog runs is not
# lost, then expire. They must expire: an entry that lingers is re-reported
# forever. A single restart on 2026-08-26 produced four separate alerts over
# the following four days because nothing ever aged it out. A crash is news
# for a few hours, not indefinitely.
# ISO8601 UTC sorts lexicographically, so a string compare against a cutoff is
# enough — and avoids awk's mktime(), which is a gawk extension absent from the
# awk macOS ships.
RESTART_CUTOFF="$(date -u -v-6H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -d '6 hours ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
if [ -s "${TMP_JOBS}.restarts" ]; then
  cat "${TMP_JOBS}.restarts" >> "$SNAPSHOT_DIR/restarts.txt"
fi
if [ -f "$SNAPSHOT_DIR/restarts.txt" ] && [ -n "$RESTART_CUTOFF" ]; then
  awk -F'|' -v cutoff="$RESTART_CUTOFF" 'NF >= 4 && $4 >= cutoff' \
    "$SNAPSHOT_DIR/restarts.txt" > "${SNAPSHOT_DIR}/restarts.tmp" \
    && mv "${SNAPSHOT_DIR}/restarts.tmp" "$SNAPSHOT_DIR/restarts.txt"
fi
rm -f "${TMP_JOBS}.restarts"
touch "$SNAPSHOT_DIR/restarts.txt"
# timestamp.txt last: it is the freshness signal for the whole snapshot, so it
# must never be newer than the files it vouches for.
mv "$TMP_TS" "$SNAPSHOT_DIR/timestamp.txt"

# --- HC.io ping -------------------------------------------------------------
if [ ! -s "$URL_FILE" ]; then
  exit 0
fi

URL=$(tr -d '[:space:]' < "$URL_FILE")
if [ -z "$URL" ]; then
  exit 0
fi

hc_fail() {
  curl -fsS --retry 2 --max-time 10 --data-raw "$1" "${URL}/fail" >/dev/null 2>&1
  exit 1
}

# launchctl list format: PID Status Label  (PID '-' = not running)
STATUS_LINE=$(awk '$3 == "com.nanoclaw" {print $1, $2}' "$SNAPSHOT_DIR/launchctl.txt")

if [ -z "$STATUS_LINE" ]; then
  hc_fail "com.nanoclaw not loaded in launchd"
fi

PID=$(echo "$STATUS_LINE" | awk '{print $1}')
EXITCODE=$(echo "$STATUS_LINE" | awk '{print $2}')

# A long-lived KeepAlive service with no PID is down, whatever its last exit
# code says. The old check only failed when the exit code was also non-zero,
# so a clean exit that launchd had not yet restarted pinged success.
# Re-check once before crying wolf: launchd's restart throttle is ~10s and we
# do not want a routine restart to register as an outage.
if [ "$PID" = "-" ]; then
  sleep 15
  RECHECK=$(launchctl list 2>/dev/null | awk '$3 == "com.nanoclaw" {print $1, $2}')
  RPID=$(echo "$RECHECK" | awk '{print $1}')
  if [ -z "$RECHECK" ]; then
    hc_fail "com.nanoclaw disappeared from launchd"
  fi
  if [ "$RPID" = "-" ]; then
    hc_fail "com.nanoclaw not running (last exit: $EXITCODE)"
  fi
fi

# NanoClaw is up. Is the thing that watches everything else still alive?
WATCHDOG_STATE="${PROJECT_ROOT}/groups/telegram_ops/watchdog-state.json"
if [ -f "$WATCHDOG_STATE" ]; then
  WD_MTIME=$(stat -f %m "$WATCHDOG_STATE" 2>/dev/null || stat -c %Y "$WATCHDOG_STATE" 2>/dev/null)
  if [ -n "$WD_MTIME" ]; then
    WD_AGE_MIN=$(( (NOW_EPOCH - WD_MTIME) / 60 ))
    if [ "$WD_AGE_MIN" -gt "$WATCHDOG_MAX_AGE_MIN" ]; then
      hc_fail "Health Watchdog has not completed a run in ${WD_AGE_MIN} min (NanoClaw itself is up)"
    fi
  fi
fi

curl -fsS --retry 2 --max-time 10 "$URL" >/dev/null 2>&1
