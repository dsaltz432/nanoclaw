# Dashboard (Command Center)

Separate Node.js process serving a React web UI for monitoring NanoClaw. Accessible on the
local network at `http://<host-ip>:3100`. Design/plan detail in
[command-center-plan.md](command-center-plan.md).

| Component | Location |
|-----------|----------|
| Frontend (React/Vite) | `dashboard/src/` |
| Backend (Express) | `dashboard/server/` |
| Launchd plist | `dashboard/com.nanoclaw.dashboard.plist` |
| Logs | `dashboard/logs/` |

Sections: Scheduled Tasks (Daily/Weekly/Ad-Hoc), Groups, Containers (live), Projects, Beacon
Intel, Mortgage Rates, Email Unsub.

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

Config: password via `DASHBOARD_PASSWORD` env var, port via `DASHBOARD_PORT` (default 3100).
Reads NanoClaw's SQLite DB (read-only) and shells out to `docker ps` for live container status.
