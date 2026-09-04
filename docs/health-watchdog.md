# Health Watchdog

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

`jobs.txt` freshness covers: backup, email-metadata, spotify-cleanup, ff-daily (daily);
ff-news (15 min), ff-live (2h) as intervals; backup-verify (weekly); briefing-upload +
trip-briefing-upload as never-alerting `event` jobs.

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
