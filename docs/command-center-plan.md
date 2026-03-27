# NanoClaw Command Center — Implementation Plan

## Overview

A local web dashboard ("Command Center") for monitoring and managing the NanoClaw setup. Runs as a separate Node.js process alongside NanoClaw, accessible only on the home network.

## Architecture

- **Frontend:** React app (Vite build)
- **Backend:** Node.js HTTP server (Express)
- **Database:** Reads from NanoClaw's existing SQLite DB (`store/messages.db`)
- **Live data:** Shells out to `docker ps` for container status
- **Auth:** Simple password gate (env var or config file)
- **Network:** Binds to `0.0.0.0` so any device on the LAN can access it (e.g. `http://192.168.x.x:3100`)
- **Process:** Separate from NanoClaw — own launchd plist, independent lifecycle

## Why Separate Process

- Can restart/redeploy the dashboard without affecting NanoClaw (no Telegram disconnects, no killed containers)
- Safe to iterate on frequently
- Clean separation of concerns
- Tradeoff: no direct access to NanoClaw's in-memory state — use DB queries and `docker ps` instead (covers 95% of needs)
- Future option: NanoClaw writes a lightweight status file for real-time queue/session info

## Sections

### 1. Scheduled Tasks
- List all scheduled tasks with: name/ID, schedule (cron expression rendered human-readable), status (active/paused/completed), next run, last run
- Run history per task: timestamp, duration, pass/fail, result preview (expandable)
- Sourced from `scheduled_tasks` and `task_run_logs` tables

### 2. Groups
- List registered groups: name, folder, trigger pattern, isMain, channel type
- Container config (additional mounts, timeout overrides)
- Session status (active session ID or "no session")
- Sourced from `registered_groups` and `sessions` tables

### 3. Live Containers
- Currently running containers: name, group, uptime, image
- Sourced from `docker ps` filtered to `nanoclaw-*` containers
- Auto-refresh on interval (e.g. every 10s)

### 4. Projects
- Info on mounted projects (e.g. recipe-club)
- Git status: current branch, last commit, dirty/clean
- Recent PRs (via `gh pr list`)
- Link to GitHub repo
- Sourced from git commands on the mounted repo path and GitHub CLI

### 5. Container Logs
- Browse container run logs per group
- Show: timestamp, duration, exit code, session ID, mounts
- Expandable to view full log content
- Sourced from `groups/{folder}/logs/` directory

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Frontend framework | React 19 + TypeScript | Matches recipe-club stack, room to grow |
| Build tool | Vite | Fast dev server, simple config |
| CSS | Tailwind CSS | Rapid styling, consistent with recipe-club |
| Backend | Express | Lightweight, well-known, minimal boilerplate |
| DB access | better-sqlite3 | Already a dependency, synchronous reads |
| Container info | child_process → `docker ps --format json` | No Docker SDK needed |
| Auth | Express middleware | Simple password check via cookie/session |

## Directory Structure

```
dashboard/
├── server/
│   ├── index.ts          # Express server entry point
│   ├── routes/
│   │   ├── tasks.ts      # Scheduled tasks + run history API
│   │   ├── groups.ts     # Registered groups API
│   │   ├── containers.ts # Live container status API
│   │   ├── projects.ts   # Mounted project info API
│   │   └── logs.ts       # Container log viewer API
│   ├── auth.ts           # Password gate middleware
│   └── db.ts             # Read-only DB connection
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   ├── pages/
│   │   ├── Dashboard.tsx     # Overview/home page
│   │   ├── Tasks.tsx         # Scheduled tasks view
│   │   ├── Groups.tsx        # Groups view
│   │   ├── Containers.tsx    # Live containers view
│   │   ├── Projects.tsx      # Projects view
│   │   └── Logs.tsx          # Container log viewer
│   └── components/
│       ├── Layout.tsx
│       ├── Sidebar.tsx
│       └── ...
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── tailwind.config.js
```

## API Endpoints

```
GET  /api/tasks                    # List all scheduled tasks
GET  /api/tasks/:id/runs           # Run history for a task
GET  /api/groups                   # List registered groups
GET  /api/containers               # Live container status (docker ps)
GET  /api/projects                 # Mounted project info (git status, PRs)
GET  /api/logs/:groupFolder        # List log files for a group
GET  /api/logs/:groupFolder/:file  # Read a specific log file
POST /api/auth/login               # Password authentication
```

## Authentication

- Single password stored in env var `DASHBOARD_PASSWORD` or `~/.config/nanoclaw/dashboard.json`
- Login page with password field
- Sets an HTTP-only cookie on success
- Express middleware checks cookie on all `/api/*` routes
- No user management — just a gate to keep it off the public internet

## Deployment

- Runs on the same machine as NanoClaw
- Separate launchd plist: `com.nanoclaw.dashboard.plist`
- Default port: 3100 (configurable via `DASHBOARD_PORT` env var)
- Serves the built React app from `dashboard/dist/` in production
- In development: Vite dev server on :5173 proxying API calls to :3100

## Implementation Order

1. **Scaffold** — Initialize the dashboard directory, package.json, Vite + React + Tailwind, Express server
2. **Auth** — Password gate middleware, login page
3. **Scheduled Tasks** — API routes + UI (highest value — this is the original ask)
4. **Live Containers** — API route + UI (simple `docker ps` wrapper)
5. **Groups** — API route + UI
6. **Container Logs** — API route + log viewer UI
7. **Projects** — API route + UI (git status, PRs)
8. **Launchd plist** — Service management for auto-start
9. **Polish** — Auto-refresh, responsive layout, error handling

## Future Possibilities

- Real-time updates via WebSocket or SSE (NanoClaw writes status file, dashboard watches it)
- Task creation/editing from the UI
- Trigger manual task runs
- Group management (register, configure mounts)
- Conversation log viewer
- System health metrics (uptime, memory, disk)
