# Health Watchdog

> **2026-11-24: the watchdog is now a script, not an agent.** The 13 checks below
> run as `scripts/watchdog.py` under launchd (`com.nanoclaw.watchdog`, :02 and :32),
> with the same thresholds, finding keys, state file and Alerts chat. The old
> "Health Watchdog" scheduled task is **paused**, not deleted. It cost ~$0.35/run
> (~$17/day of Opus) for rule-following that code does exactly. The rules in the
> agent-era sections below still describe what the script checks; the script header
> has the dedupe model (normal / once / two-run confirm). The "Ticket Pricer" task
> moved the same way to `scripts/tickets-pricer.py` (`com.nanoclaw.tickets-pricer`,
> :00 and :30): it alerts the tickets chat once per outage plus a recovery note,
> where the agent version re-alerted every 30 min (~40 messages on 2026-11-18..19).
> Both send through `scripts/nanoclaw_ipc.py` (drops a file in `data/ipc/<group>/messages/`).
> Install/undo: `scripts/install-script-jobs.sh` (header has the rollback).
> Logs: `~/.local/share/nanoclaw/logs/{watchdog,tickets-pricer}*.log`.
> Also: Home Assistant kernel findings now carry their since-boot count in the key
> (`ha-kernel-usb-resets:3`), so they alert when the count rises, not daily.

Continuous self-monitoring. A host-side heartbeat script (every 5 min) dumps `launchctl` +
disk state to a snapshot file and pings Healthchecks.io as a dead-man's switch. A NanoClaw
scheduled task (every 30 min) reads that snapshot, the SQLite task history, recent container
logs, and service error logs — and messages the dedicated `Alerts` Telegram chat *only* when
something is off. No daily "all clear" heartbeat: silence in `Alerts` means healthy. HC.io
covers the case where the host or NanoClaw itself goes silent.

Alerts go to their own chat / group folder (`telegram_ops`) so the watchdog never queues
behind `telegram_main` user activity.

The heartbeat is a host launchd job — see [host-cronjobs.md](host-cronjobs.md) for the plist
pattern.

| Component | Location |
|-----------|----------|
| Heartbeat script | `scripts/heartbeat.sh` |
| Heartbeat plist template | `launchd/com.nanoclaw.heartbeat.plist` |
| LaunchAgent (installed) | `~/Library/LaunchAgents/com.nanoclaw.heartbeat.plist` |
| HC.io ping URL | `~/.config/nanoclaw/healthchecks-ping-url` (not in repo) |
| Host snapshot | `data/health-probe/{launchctl,disk,timestamp}.txt` |
| Alerts chat | Telegram "Alerts" group, JID `tg:-5235132441` |
| Group folder | `groups/telegram_ops/` (CLAUDE.md + watchdog-state.json) |
| Heartbeat logs | `logs/heartbeat.log`, `logs/heartbeat.error.log` |

**Scheduled task in SQLite:** `Health Watchdog` — cron `*/30 * * * *`, `context_mode: isolated`,
`group_folder: telegram_ops`, `chat_jid: tg:-5235132441`, `silent: 1` (final output is never
delivered — alerts go out only via explicit `send_message` calls, so a forgotten `<internal>`
wrapper can't page anyone; see [message-delivery.md](message-delivery.md)).

**Noise controls** (added 2026-09-02 after a run of 16 straight false-positive alerts):

- `restarts.txt` entries carry the old pid's exit status (`label|old_pid|new_pid|detected_at|last_exit`),
  and the heartbeat drops graceful stops (exit 0 / 143 / SIGTERM) at the source —
  `launchctl kickstart` during dev work no longer reads as a crash. Entries still expire after 6h.
- A missing/stale probe file must survive **two consecutive watchdog runs** before it alerts
  (macOS bind-mount rename races made files transiently invisible to the container).
- Container logs headed `TIMEOUT` with `Had Streaming Output: true` are idle-reaps of a
  successful run (exit 137 after the ~30 min follow-up window), not failures.
- Multiple restarts of one service in a run collapse into a single alert bullet; 3+ is
  reported as a crash loop.
- `read_probe` treats a present-but-**empty** file as present (added 2026-10-15). An empty
  `restarts.txt` is the healthy state (no crashes in 6h); the old `-s` test read it as
  MISSING and produced ~11 false `probe-missing:restarts.txt` alerts from Sep 21 to Oct 12.
  Other probe files that are empty still count as missing.

`jobs.txt` freshness covers: backup, email-metadata, spotify-cleanup, ff-daily (daily);
ff-news (15 min), ff-live (2h), ff-claims (15 min) as intervals; backup-verify (weekly); briefing-upload +
trip-briefing-upload as never-alerting `event` jobs; and one `ff-content.<site>.<job>` interval
line per fantasy content adapter, aged from its newest *successful* `ingest_runs` row (articles 60
min, live rankings 360, daily rankings the daily allowance) with `ok` or `FAIL:<error>` in the
source field, so a broken parser inside a green job still surfaces (see
[fantasy-football.md](fantasy-football.md#scheduled-jobs)).

**Topology:** Three layers cover three failure modes.
1. **HC.io alerts** = host machine is down, NanoClaw service is dead, or heartbeat plist itself
   is wedged (no pings in 10+ min).
2. **Watchdog alerts** = a sub-process / scheduled task / container run is misbehaving while
   everything else is fine.
3. **Daily ✓ heartbeat at 08:00 ET** = positive signal that the watchdog itself is running.
   Silence + no ✓ = watchdog is dead.

```bash
# Service management (macOS)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.heartbeat.plist     # start
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.heartbeat.plist   # stop

# Manual test
bash scripts/heartbeat.sh && cat data/health-probe/launchctl.txt

# Full setup on new machine
# 1. Create a Healthchecks.io check (5-min schedule, 10-min grace) and save the
#    ping URL to ~/.config/nanoclaw/healthchecks-ping-url
# 2. Install the plist with project-root + home substituted (same pattern as
#    the email-metadata plist; see docs/host-cronjobs.md).
# 3. The scheduled task is in SQLite; if missing on a new machine, recreate it.
```


## Home Assistant monitoring (added 2026-11-14)

Built after the Home Assistant Green was down ~3 days (2026-11-11 → 11-14) with
nothing noticing: an SSD USB reset corrupted containerd's metadata DB, containerd
crash-looped, and Core could not start. Two layers, both read-only toward the Green:

| Piece | Where | What it does |
|---|---|---|
| Collector | Green: `/config/monitoring/ha_collect.sh` | Prints a status + log bundle: backstop facts, versions/add-ons/backups, and warning/error digests (repeats collapsed to `count \| first .. last \| sample`) from Core, Supervisor, OS journal, kernel and the Z-Wave/Matter/Mosquitto/Ring-MQTT add-ons. |
| Monitor key | old Mac `~/.ssh/ha_monitor_ed25519` | Accepted by the Green's Terminal & SSH add-on only as `restrict,command="/config/monitoring/ha_collect.sh"` — it can run that script and nothing else (no shell, no forwarding; tested 2026-11-14). |
| `com.nanoclaw.ha-probe` | `scripts/ha-probe.sh`, `launchd/com.nanoclaw.ha-probe.plist`, `scripts/install-ha-probe-plist.sh` | Every 30 min: runs the collector, writes `data/health-probe/home-assistant/{bundle.txt,status.txt,bundles/}`. **Fixed rules live here** and become `FINDING\|severity\|key\|message` lines in `status.txt`. Log: `~/.local/share/nanoclaw/logs/ha-probe.log`. |
| Heartbeat | `scripts/heartbeat.sh` | `jobs.txt` row `com.nanoclaw.ha-probe interval 75` → watchdog check 8 flags a stalled probe. |
| Watchdog check 13 | Health Watchdog prompt (patched by `scripts/patch-watchdog-ha.py`; pre-patch copy in `groups/telegram_ops/watchdog-prompt.bak-2026-11-14-pre-ha.md`) | Relays `FINDING` lines verbatim; `ha-unreachable`/`ha-error` get two-run confirmation. No interpretation of logs. |
| Home Assistant Triage | scheduled task in `telegram_ops`, cron `0 7,19 * * *`, silent=1; prompt in `groups/telegram_ops/ha-triage-prompt.md` (apply edits with `scripts/create-ha-triage-task.py`) | AI review of `bundle.txt` against `groups/telegram_ops/ha-baseline.md`: reports only patterns that are not known noise AND new or worsening. State: `groups/telegram_ops/ha-triage-state.json`. |

Fixed backstop rules (in `ha-probe.sh`): Core not running (critical); add-on not
started, Supervisor unhealthy, resolution issue other than `no_current_backup`,
newest backup > 36h, kernel disk I/O errors or USB storage resets since boot, data
disk > 85%, Z-Wave cannot open its stick (high). Boot-dependent rules wait 15 min
after a reboot.

**False alarm from triage?** Add the pattern to `groups/telegram_ops/ha-baseline.md`
(and to the home-assistant skill's known-noise list on Daniel's laptop, which is
the source of truth). **No auto-repair** by design: alerts suggest what to check;
fixes happen from the laptop with Daniel's approval.

**Undo:** `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.ha-probe.plist`;
pause/delete the "Home Assistant Triage" task; restore the watchdog prompt from the
backup; remove the `ha-monitor@oldmac` line from the SSH add-on's `authorized_keys`
option and `/config/monitoring/` on the Green.

## Alert-delivery and false-alarm fixes (2026-11-14)

- **Telegram retry** (`src/channels/telegram.ts`): network errors, 5xx and 429
  are retried (2s, 5s, 15s; 429 honours `retry_after`, max 60s) before the
  final `Failed to send Telegram message` log line. Before this, a single 504
  (2026-10-15) silently dropped a watchdog alert, and dedupe meant it was never
  re-sent. A retry after a timeout can occasionally duplicate a message.
- **ffballers Tuesday window** (`scripts/heartbeat.sh`): ffballers' rankings
  page is down every Tuesday ~02:00-13:00 local for its weekly reset, so
  `ff-content.ffballers.rankings` gets `max_age_min=1200` until 16:00 Tuesday.
- **sqlite busy timeout** on the ff-content freshness query, so a read that
  lands on a write no longer reports `age -1 query-failed`.
- **Watchdog check 8** (patched by `scripts/patch-watchdog-ff-noise.py`;
  pre-patch prompt in `groups/telegram_ops/watchdog-prompt.bak-2026-11-14-pre-ff-noise.md`):
  `ff-content.*` stale/nolog findings need two consecutive runs; a `FAIL:`
  state alone (age still within limit) is not a finding.

Note: running `scripts/heartbeat.sh` by hand over SSH lacks Docker on PATH, so
it reports "docker CLI unusable" and pings Healthchecks.io `/fail`. Use
`launchctl kickstart gui/$(id -u)/com.nanoclaw.heartbeat` instead.
