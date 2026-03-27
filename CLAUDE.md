# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/` | Skills loaded inside agent containers (browser, status, formatting) |
| `dashboard/` | Command Center web dashboard (separate process) |

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

## Sleep Prevention

macOS can enter "Maintenance Sleep" even with "prevent sleep" checked in Energy Saver, which kills scheduled tasks overnight. A `caffeinate -s` launchd service prevents this while on AC power.

| Component | Location |
|-----------|----------|
| Plist | `com.nanoclaw.caffeinate.plist` |
| LaunchAgent | `~/Library/LaunchAgents/com.nanoclaw.caffeinate.plist` |

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.caffeinate.plist    # start
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.caffeinate.plist  # stop
```

## Dashboard (Command Center)

Separate Node.js process serving a React web UI for monitoring NanoClaw. Accessible on the local network at `http://<host-ip>:3100`.

| Component | Location |
|-----------|----------|
| Frontend (React/Vite) | `dashboard/src/` |
| Backend (Express) | `dashboard/server/` |
| Launchd plist | `dashboard/com.nanoclaw.dashboard.plist` |
| Logs | `dashboard/logs/` |

Sections: Scheduled Tasks, Groups, Containers (live), Projects, Container Logs.

```bash
# Development
cd dashboard && npm run dev

# Rebuild frontend after changes
cd dashboard && npx vite build

# Service management (macOS)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.dashboard  # restart
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.dashboard.plist  # stop
launchctl load ~/Library/LaunchAgents/com.nanoclaw.dashboard.plist    # start
```

Config: password via `DASHBOARD_PASSWORD` env var, port via `DASHBOARD_PORT` (default 3100). Reads NanoClaw's SQLite DB (read-only) and shells out to `docker ps` for live container status.

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate skill, not bundled in core. Run `/add-whatsapp` (or `npx tsx scripts/apply-skill.ts .claude/skills/add-whatsapp && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
