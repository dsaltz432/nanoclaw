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

# Docker probe deadline. A healthy daemon answers in well under a second; 20s
# is generous for a loaded host and still far inside the 300s heartbeat
# interval, so a hung probe can never overlap the next run.
DOCKER_PROBE_TIMEOUT=20
AGENT_IMAGE="nanoclaw-agent:latest"

# Auto-recovery for a wedged daemon. Rate-limited hard: if a restart does not
# fix it, retrying every 5 minutes accomplishes nothing except thrashing a
# machine that is already unhealthy, so one attempt per hour and the alert
# still fires either way.
DOCKER_RESTART_TIMEOUT=120
DOCKER_RESTART_MIN_INTERVAL_MIN=60
DOCKER_RESTART_STAMP="${SNAPSHOT_DIR}/docker-restart.stamp"

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
emit_job com.nanoclaw.ff-claims       interval 60   "${HOME}/.local/share/nanoclaw/logs/ff-claims.log"
# backup-verify runs weekly (Sun 05:00); 7 days + a day of grace. The script
# appends to this log on every run, success or failure, so mtime is reliable.
emit_job com.nanoclaw.backup-verify   weekly 11640  "${LOG_DIR}/backup-verify.log"
# WatchPaths jobs fire only when their watched directory changes. They have
# been idle for months by design; staleness here is not a fault.
emit_job com.nanoclaw.briefing-upload      event - "${LOG_DIR}/briefing-upload.log"
emit_job com.nanoclaw.trip-briefing-upload event - "${LOG_DIR}/trip-briefing-upload.log"

# --- fantasy content-layer runs ----------------------------------------------
#
# ff-news / ff-live / ff-daily above only say the JOB fired. Each expert-site
# adapter inside them is its own `content.<site>.<articles|rankings>` row in
# the data layer's ingest_runs table, and a broken parser is a FAILED row
# while the job itself keeps exiting 0. So: one line per enabled adapter,
# aged from its newest SUCCESSFUL run. A parser that starts failing stops
# refreshing that age, and the watchdog's ordinary "job stale" rule fires
# within the adapter's cadence (articles 15 min -> 60; live rankings 2h ->
# 360; daily rankings -> the daily allowance). The 5th field carries the
# newest run's state so the alert names the fault: ok, or FAIL:<error>.
FF_DB="${FF_DB:-${HOME}/Documents/repositories/fantasy-football-agent/store/ff.db}"
if [ -f "$FF_DB" ] && command -v sqlite3 >/dev/null 2>&1; then
  # Enabled adapters and their cadence, mirrored from ff/content/pipeline.py
  # (ARTICLE_SOURCES, RANKING_SOURCES, RANKING_CADENCE_MIN).
  FF_CONTENT_JOBS="ffballers.articles:60 cbs.articles:60 fantasypros.articles:60 footballguys.articles:60 draftsharks.articles:60 fantasylife.articles:60 fantasypros.rankings:360 ffballers.rankings:360 cbs.rankings:${DAILY_MAX_AGE_MIN} footballguys.rankings:${DAILY_MAX_AGE_MIN}"
  for spec in $FF_CONTENT_JOBS; do
    src="${spec%%:*}"; max_age="${spec##*:}"
    # started_at is local ISO with a numeric offset; strftime('%s') of the
    # first 19 chars treats it as UTC, so apply the offset ourselves.
    row=$(sqlite3 -separator '|' "file:${FF_DB}?mode=ro" "
      SELECT
        COALESCE((SELECT CAST((strftime('%s','now') - (strftime('%s', substr(started_at,1,19))
                 - (CAST(substr(started_at,20,3) AS INTEGER)*3600 + CAST(substr(started_at,23,2) AS INTEGER)*60
                    * (CASE WHEN substr(started_at,20,1)='-' THEN -1 ELSE 1 END)))) / 60 AS INTEGER)
                  FROM ingest_runs WHERE source='content.${src}' AND ok=1 ORDER BY id DESC LIMIT 1), -1),
        COALESCE((SELECT CASE WHEN ok=1 THEN 'ok' ELSE 'FAIL:' || replace(replace(COALESCE(error,'?'),'|','/'),char(10),' ') END
                  FROM ingest_runs WHERE source='content.${src}' ORDER BY id DESC LIMIT 1), 'never')
    " 2>/dev/null)
    age="${row%%|*}"; state="${row#*|}"
    [ -z "$row" ] && { age=-1; state="query-failed"; }
    echo "ff-content.${src}|interval|${max_age}|${age}|${state:0:120}" >> "$TMP_JOBS"
  done
fi

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

# --- docker liveness --------------------------------------------------------
#
# Every agent runs in a container, so a wedged Docker daemon fails 100% of
# tasks while com.nanoclaw stays green and its proxy port keeps listening.
# That was the 2026-09-11..13 outage: the Linux VM died, `docker run` hung
# forever at container-create, and the only signal was the watchdog going
# stale — downstream, ~2h late, and naming the wrong fault ("watchdog stuck",
# followed by a reassuring "NanoClaw itself is up").
#
# The probe choice is the whole trick. Docker Desktop answers /_ping, /info,
# /networks and /containers/json out of its own apicache, so `docker info` and
# `docker ps` report healthy against a daemon that is gone — they did exactly
# that for three days. A *filtered* image query is forwarded to the real
# daemon, so it hangs when the daemon is dead. It starts nothing, and it
# doubles as an agent-image presence check, since a missing image also fails
# every container.
#
# Bounded wait, since macOS ships no timeout(1). Polls rather than arming a
# `( sleep N; kill )` subshell: killing that subshell does not reap the
# sleep(1) it spawned, so every run left a stray sleep behind until it aged
# out. This leaves nothing to clean up, and 1s granularity is irrelevant
# against deadlines measured in tens of seconds.
# Sets RWT_RC and RWT_TIMED_OUT. Redirect the call to capture output.
run_with_timeout() {
  local secs="$1"; shift
  local pid waited=0
  "$@" &
  pid=$!
  RWT_TIMED_OUT=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then
      kill -9 "$pid" 2>/dev/null
      RWT_TIMED_OUT=1
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null
  RWT_RC=$?
}

TMP_DOCKER=$(mktemp)
DOCKER_PROBE_OUT=$(mktemp)

run_with_timeout "$DOCKER_PROBE_TIMEOUT" \
  docker images --filter "reference=${AGENT_IMAGE}" --format '{{.ID}}' \
  > "$DOCKER_PROBE_OUT" 2>/dev/null
DOCKER_TIMED_OUT=$RWT_TIMED_OUT
DOCKER_RC=$RWT_RC

DOCKER_IMAGE_ID=$(tr -d '[:space:]' < "$DOCKER_PROBE_OUT")
rm -f "$DOCKER_PROBE_OUT"

# A tripped deadline means the daemon never answered. A fast non-zero exit is
# the CLI failing outright (missing binary, bad socket, permissions) — a
# different fault that deserves a different message.
if [ "$DOCKER_TIMED_OUT" -eq 1 ]; then
  DOCKER_STATE="unresponsive"
elif [ "$DOCKER_RC" -ne 0 ]; then
  DOCKER_STATE="cli-error"
elif [ -z "$DOCKER_IMAGE_ID" ]; then
  DOCKER_STATE="image-missing"
else
  DOCKER_STATE="ok"
fi

# Format: state|image|image_id|timeout_s
echo "${DOCKER_STATE}|${AGENT_IMAGE}|${DOCKER_IMAGE_ID:-none}|${DOCKER_PROBE_TIMEOUT}" \
  > "$TMP_DOCKER"

mv "$TMP_LAUNCHD" "$SNAPSHOT_DIR/launchctl.txt"
mv "$TMP_DISK"    "$SNAPSHOT_DIR/disk.txt"
mv "$TMP_DOCKER"  "$SNAPSHOT_DIR/docker.txt"
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

# Docker is checked before the watchdog: when the daemon is down the watchdog
# is stale *because* of it, so reporting staleness first buries the lede and
# points at the wrong thing to fix.
case "$DOCKER_STATE" in
  unresponsive)
    # Observed twice (2026-09-11, 2026-09-14): Docker Desktop's Resource Saver
    # idle-shutdown the Linux VM after 300s with no containers, and the resume
    # wedged. NanoClaw idles ~28 of every 30 minutes, so it crosses that
    # threshold constantly. Restarting Docker is the known remedy, and doing
    # it here turns a multi-hour outage into one missed task.
    RECOVERY="no auto-restart attempted"
    STAMP_AGE_MIN=$(( DOCKER_RESTART_MIN_INTERVAL_MIN + 1 ))
    if [ -f "$DOCKER_RESTART_STAMP" ]; then
      STAMP_MTIME=$(stat -f %m "$DOCKER_RESTART_STAMP" 2>/dev/null \
        || stat -c %Y "$DOCKER_RESTART_STAMP" 2>/dev/null)
      [ -n "$STAMP_MTIME" ] && STAMP_AGE_MIN=$(( (NOW_EPOCH - STAMP_MTIME) / 60 ))
    fi

    if [ "$STAMP_AGE_MIN" -ge "$DOCKER_RESTART_MIN_INTERVAL_MIN" ]; then
      # Stamp BEFORE attempting. A restart that hangs must not leave the
      # rate limit unarmed for the next run to retry into.
      touch "$DOCKER_RESTART_STAMP"
      run_with_timeout "$DOCKER_RESTART_TIMEOUT" docker desktop restart \
        >/dev/null 2>&1
      if [ "$RWT_TIMED_OUT" -eq 1 ]; then
        RECOVERY="auto-restart timed out after ${DOCKER_RESTART_TIMEOUT}s"
      elif [ "$RWT_RC" -ne 0 ]; then
        RECOVERY="auto-restart failed (exit ${RWT_RC})"
      else
        RECOVERY="auto-restart issued; next heartbeat confirms"
      fi
    else
      RECOVERY="auto-restart suppressed (last attempt ${STAMP_AGE_MIN}m ago, min ${DOCKER_RESTART_MIN_INTERVAL_MIN}m)"
    fi

    # Alert regardless of the outcome. A self-healed outage is still an
    # outage, and silent recovery would hide a daemon wedging nightly.
    hc_fail "docker daemon did not answer within ${DOCKER_PROBE_TIMEOUT}s - every agent container will fail (com.nanoclaw is up); ${RECOVERY}"
    ;;
  cli-error)
    hc_fail "docker CLI unusable (exit ${DOCKER_RC}) - every agent container will fail"
    ;;
  image-missing)
    hc_fail "agent image ${AGENT_IMAGE} not found - every agent container will fail (rebuild: container/build.sh)"
    ;;
esac

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
