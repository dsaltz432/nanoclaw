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
Intel, Mortgage Rates, Email Unsub, Fantasy Football (see
[fantasy-football.md](fantasy-football.md) — that tab reads a second SQLite database
via `python3 -m ff.cli api`, not NanoClaw's).

```bash
# Development
cd dashboard && npm run dev

# Rebuild frontend after changes (also writes .br/.gz beside each asset)
cd dashboard && npx vite build

# Service management (macOS)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.dashboard  # restart
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.dashboard.plist  # stop
launchctl load ~/Library/LaunchAgents/com.nanoclaw.dashboard.plist    # start
```

Config: password via `DASHBOARD_PASSWORD` env var, port via `DASHBOARD_PORT` (default 3100).

Loading: each page is its own chunk (`React.lazy` in `src/App.tsx`, Suspense in
`Layout`), so the shared bundle is ~250 KB instead of ~860 KB. The build writes
Brotli and gzip copies of every JS/CSS asset (`precompress` in `vite.config.ts`);
`server/index.ts` serves the smallest one the browser accepts, with a one-year
immutable cache, since the file names carry content hashes.
Reads NanoClaw's SQLite DB (read-only) and shells out to `docker ps` for live container status.
