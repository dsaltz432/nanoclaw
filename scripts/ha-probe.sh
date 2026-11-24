#!/usr/bin/env bash
#
# Home Assistant probe — run by com.nanoclaw.ha-probe every 30 min.
#
# SSHes to the Home Assistant Green with a dedicated key that the Green only
# allows to run one read-only script (/config/monitoring/ha_collect.sh, forced
# via `restrict,command=` in the Terminal & SSH add-on). It cannot run anything
# else, open a shell, or forward ports. This job never changes the Green.
#
# Writes, under data/health-probe/home-assistant/ (mounted read-only into the
# telegram_ops group, like the rest of health-probe/):
#
#   bundle.txt          latest full bundle: status + log digests from every layer.
#                       Read by the "Home Assistant Triage" agent task (AI review).
#   bundles/<ts>.txt    rolling history (last BUNDLE_KEEP), for spotting trends.
#   status.txt          fixed-rule backstop, read by Health Watchdog check 13:
#                         probe_state=ok|unreachable|error
#                         probe_at=<iso8601 UTC>
#                         <key>=<value> facts copied from the bundle's BACKSTOP
#                         FINDING|<critical|high>|<finding-key>|<message>   (0+ lines)
#
# Fixed rules live HERE, not in the watchdog prompt, so they are deterministic.
# Anything the rules don't cover is the triage agent's job.
#
# Context: built 2026-11-14 after Home Assistant was down ~3 days (containerd
# metadata corruption after an SSD USB reset) and nothing noticed. Source of
# truth for this setup: the home-assistant skill on Daniel's laptop.

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${PROJECT_ROOT}/data/health-probe/home-assistant"
HIST_DIR="${OUT_DIR}/bundles"
LOG_FILE="${HOME}/.local/share/nanoclaw/logs/ha-probe.log"
KEY="${HOME}/.ssh/ha_monitor_ed25519"
HA_HOST="${HA_HOST:-root@homeassistant.local}"
SSH_TIMEOUT=180          # collector normally takes ~30s
BUNDLE_KEEP=96           # 48h at one bundle per 30 min

# Grace periods so a deliberate reboot/update doesn't page anyone.
BOOT_GRACE_MIN=15
BACKUP_MAX_AGE_H=36
DISK_MAX_PCT=85

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT_DIR" "$HIST_DIR" "$(dirname "$LOG_FILE")"

# Bounded wait (macOS ships no timeout(1)); same approach as heartbeat.sh.
run_with_timeout() {
  local secs="$1"; shift
  local pid waited=0
  "$@" &
  pid=$!
  RWT_TIMED_OUT=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then kill -9 "$pid" 2>/dev/null; RWT_TIMED_OUT=1; break; fi
    sleep 1; waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null
  RWT_RC=$?
}

TMP_BUNDLE="$(mktemp)"
TMP_ERR="$(mktemp)"
TMP_STATUS="$(mktemp)"

run_with_timeout "$SSH_TIMEOUT" \
  ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 \
      -o ServerAliveInterval=15 "$HA_HOST" > "$TMP_BUNDLE" 2> "$TMP_ERR"

if [ "$RWT_TIMED_OUT" -eq 1 ]; then
  STATE="error"; REASON="collector did not finish within ${SSH_TIMEOUT}s"
elif [ "$RWT_RC" -eq 255 ]; then
  STATE="unreachable"; REASON="ssh failed: $(grep -v -iE 'post-quantum|store now|openssh.com/pq|server may need' "$TMP_ERR" | tail -1 | cut -c1-160)"
elif ! grep -q '^## BACKSTOP' "$TMP_BUNDLE"; then
  STATE="error"; REASON="collector output malformed (exit ${RWT_RC})"
else
  STATE="ok"; REASON=""
fi

fact() { grep -m1 "^$1=" "$TMP_BUNDLE" | cut -d= -f2-; }

{
  echo "probe_state=${STATE}"
  echo "probe_at=${TIMESTAMP}"
  [ -n "$REASON" ] && echo "probe_reason=${REASON}"

  if [ "$STATE" = "ok" ]; then
    sed -n '/^## BACKSTOP/,/^$/p' "$TMP_BUNDLE" | grep '='

    UP=$(fact uptime_min); UP=${UP:-0}
    CORE=$(fact core_running)
    ADDONS=$(fact addons_not_started)
    SUP=$(fact supervisor_healthy)
    RES=$(fact resolution_issues)
    BAGE=$(fact backup_age_h); BAGE=${BAGE:--1}
    KIO=$(fact kernel_io_errors); KIO=${KIO:-0}
    KUSB=$(fact kernel_usb_resets); KUSB=${KUSB:-0}
    DISK=$(fact data_disk_pct); DISK=${DISK:-0}
    ZW=$(fact zwave_state)

    if [ "$CORE" = "no" ] && [ "$UP" -ge "$BOOT_GRACE_MIN" ]; then
      echo "FINDING|critical|ha-core-down|Home Assistant Core is not running (Green up ${UP} min)"
    fi
    if [ -n "$ADDONS" ] && [ "$UP" -ge "$BOOT_GRACE_MIN" ]; then
      for a in ${ADDONS//,/ }; do
        echo "FINDING|high|ha-addon-down:${a}|Home Assistant add-on ${a} is not running"
      done
    fi
    [ "$SUP" = "false" ] && echo "FINDING|high|ha-supervisor-unhealthy|Home Assistant Supervisor reports itself unhealthy"
    if [ -n "$RES" ]; then
      for r in ${RES//,/ }; do echo "FINDING|high|ha-resolution:${r}|Home Assistant resolution center issue: ${r}"; done
    fi
    if [ "$BAGE" -lt 0 ] || [ "$BAGE" -gt "$BACKUP_MAX_AGE_H" ]; then
      echo "FINDING|high|ha-backup-stale|Newest Home Assistant backup is ${BAGE}h old (expected nightly; -1 = none found)"
    fi
    # The counts are since boot, so they never go down until the Green reboots.
    # The count is part of the finding key: the watchdog alerts when it goes UP,
    # not every 24h while it sits still (3 resets re-alerted daily 11-15..11-24).
    [ "$KIO" -gt 0 ] && echo "FINDING|high|ha-kernel-io-errors:${KIO}|Green kernel logged ${KIO} disk I/O error(s) since boot — external SSD/enclosure (see 2026-11-11 incident)"
    [ "$KUSB" -gt 0 ] && echo "FINDING|high|ha-kernel-usb-resets:${KUSB}|Green kernel logged ${KUSB} USB storage reset(s) since boot — external SSD/enclosure (see 2026-11-11 incident)"
    [ "$DISK" -gt "$DISK_MAX_PCT" ] && echo "FINDING|high|ha-disk-full|Green data disk at ${DISK}%"
    if [ "$ZW" = "serial_error" ] && [ "$UP" -ge "$BOOT_GRACE_MIN" ]; then
      echo "FINDING|high|ha-zwave-serial|Z-Wave JS cannot open the Z-Wave stick (locks/switches offline from HA)"
    fi
  else
    echo "FINDING|critical|ha-${STATE}|Home Assistant probe ${STATE}: ${REASON}"
  fi
} > "$TMP_STATUS"

chmod 644 "$TMP_STATUS" "$TMP_BUNDLE"
if [ "$STATE" = "ok" ]; then
  cp "$TMP_BUNDLE" "${HIST_DIR}/${STAMP}.txt"
  mv "$TMP_BUNDLE" "${OUT_DIR}/bundle.txt"
  # prune history
  ls -1t "$HIST_DIR"/*.txt 2>/dev/null | tail -n +$((BUNDLE_KEEP + 1)) | while read -r f; do rm -f "$f"; done
else
  rm -f "$TMP_BUNDLE"   # keep the last good bundle in place
fi
mv "$TMP_STATUS" "${OUT_DIR}/status.txt"
rm -f "$TMP_ERR"

# One line per run; its mtime is what heartbeat.sh's job-freshness check reads.
echo "${TIMESTAMP} state=${STATE} findings=$(grep -c '^FINDING' "${OUT_DIR}/status.txt") ${REASON}" >> "$LOG_FILE"
exit 0
