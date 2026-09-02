# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions. See [docs/host-cronjobs.md](docs/host-cronjobs.md) for the host-side launchd cronjob pattern (templates, install scripts, scheduling flavors).

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing (`<internal>` stripping — see [docs/message-delivery.md](docs/message-delivery.md)) |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |
| `dashboard/` | Command Center web dashboard (separate process) |

## Memory

**Silencing a scheduled task takes two things**, because there are two delivery paths and only one is filtered: the agent must make no `send_message` call *and* wrap its final output in `<internal>`. See [docs/message-delivery.md](docs/message-delivery.md).

Group and global memory are CLAUDE.md files loaded into the *runtime agent containers* — distinct from this file. Global memory is `groups/global/CLAUDE.md`, injected into non-main groups only; per-group memory is `groups/{name}/CLAUDE.md`. **This root `CLAUDE.md` is not loaded by runtime agents** — it's project instructions for Claude Code dev sessions. Full mechanics: [docs/SPEC.md](docs/SPEC.md#memory-system) and [groups/README.md](groups/README.md).

## Skills

Four types of skills exist in NanoClaw. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy and guidelines.

- **Feature skills** — merge a `skill/*` branch to add capabilities (e.g. `/add-telegram`, `/add-slack`)
- **Utility skills** — ship code files alongside SKILL.md (e.g. `/claw`)
- **Operational skills** — instruction-only workflows, always on `main` (e.g. `/setup`, `/debug`)
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, SKILL.md format rules, PR requirements, and the pre-submission checklist (searching for existing PRs/issues, testing, description format).

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Operational Subsystems

Each subsystem has a dedicated doc with its component table, schedule, service-management commands, and new-machine setup. The shared host launchd plist pattern lives in [docs/host-cronjobs.md](docs/host-cronjobs.md).

| Subsystem | Doc | At a glance |
|-----------|-----|-------------|
| Health Watchdog | [docs/health-watchdog.md](docs/health-watchdog.md) | Heartbeat + HC.io dead-man's switch; alerts to Telegram `Alerts` (`tg:-5235132441`). Scheduled task `Health Watchdog`, cron `*/30 * * * *`. |
| Email Unsubscribe Curator | [docs/email-unsubscribe.md](docs/email-unsubscribe.md) | Host script scans Gmail metadata; agent does browser unsubscribes. Scheduled task `Email Unsubscribe Analyzer`, cron `25 6 * * *`. |
| Sports Briefing | [docs/sports-briefing.md](docs/sports-briefing.md) | Daily HTML sports briefing → `gs://sports-briefings/`. Scheduled task `Sports Briefing Scout`, cron `15 21 * * *`. |
| Strava Trips | [docs/strava-trips.md](docs/strava-trips.md) | Publish grouped Strava activities as public HTML → `gs://strava-trips/`. Re-render: `npx tsx scripts/republish-trips.ts`. |
| Spotify Podcast Cleanup | [scripts/spotify-cleanup/README.md](scripts/spotify-cleanup/README.md) | Un-saves finished / near-finished / never-started episodes, plus a hard `MAX_AGE_DAYS` (90d) ceiling on anything unfinished, so Spotify drops the downloads. Host launchd job `com.nanoclaw.spotify-cleanup`, daily 4:30 AM ET (live; `DRY_RUN` flag + audit log are the safety rails). |
| Fantasy Football | [docs/fantasy-football.md](docs/fantasy-football.md) | Three Sleeper leagues; recommender only (Sleeper's API is read-only). Data layer in `~/Documents/repositories/fantasy-football-agent`, SQLite at `store/ff.db`, entry point `python3 -m ff.cli`. Code mounted read-only — this group reads third-party news text. Dashboard tab at `/fantasy` (waivers / trades / trends / news / alerts), served by `ff.cli api`. Telegram group `Fantasy Football` (`tg:-5468369997`), no trigger word — ask it questions directly. Three host refresh jobs, none of which can message anyone by construction: `com.nanoclaw.ff-news` (15 min, news), `com.nanoclaw.ff-live` (2h, transactions + **rosters**), `com.nanoclaw.ff-daily` (06:40, projections/values). See [docs/host-cronjobs.md](docs/host-cronjobs.md). Note `ff.cli live` does *not* refresh roster contents on its own — `scripts/ff-refresh.sh` adds the `ingest_league_chain` call that does. **No alerting job yet.** |
| Backup + verification | `scripts/backup.sh`, `scripts/restore-backup.sh` | Nightly encrypted backup → `gs://nanoclaw-backups/` (host launchd `com.nanoclaw.backup`, 3:15 AM). **Weekly restore verification** (`com.nanoclaw.backup-verify`, Sun 5:00 AM) downloads, decrypts and integrity-checks the archive, writing `data/health-probe/backup-verify-status.txt` which the watchdog alerts on. Restore with `./scripts/restore-backup.sh` (verify-only) or `--apply`. **The age private key is the only way to decrypt — it must exist outside this machine.** |
| Dashboard (Command Center) | [docs/dashboard.md](docs/dashboard.md) | React monitoring UI at `http://<host-ip>:3100`. Separate process. |

**Sleep Prevention:** a `caffeinate -s` launchd service (`com.nanoclaw.caffeinate.plist`) keeps macOS from entering "Maintenance Sleep" (which kills overnight scheduled tasks) while on AC power. Listed in [docs/host-cronjobs.md](docs/host-cronjobs.md).

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
