# Host Cronjobs (launchd)

How NanoClaw runs **host-side scheduled jobs** — work that runs directly on the Mac
via launchd, separate from NanoClaw's own internal SQLite-backed scheduled tasks
(`src/task-scheduler.ts`, which run *inside* agent containers).

Use a host cronjob when the work must run on the host itself: shelling out to
`gcloud`/`docker`, touching the local filesystem, scanning Gmail metadata, pinging a
dead-man's switch, uploading to GCS, etc.

> **Internal task vs. host cronjob.** If the job is "invoke the agent on a schedule,"
> that's an internal scheduled task in SQLite (see `docs/REQUIREMENTS.md`). If the job is
> "run a host script on a schedule, no agent involved," it's a launchd cronjob — this doc.

## The pattern

Every host job is four files following the same convention (`<name>` = job slug):

| Piece | Location | Notes |
|-------|----------|-------|
| **Plist template** | `launchd/com.nanoclaw.<name>.plist` | Checked into the repo. Uses `{{PROJECT_ROOT}}`, `{{HOME}}`, `{{NODE_PATH}}` placeholders. |
| **Job script** | `scripts/<name>.{sh,ts}` | The actual work. |
| **Install script** | `scripts/install-<name>-plist.sh` | Renders template → installs → loads → tests. Model on `install-backup-plist.sh`. |
| **Installed copy** | `~/Library/LaunchAgents/com.nanoclaw.<name>.plist` | Rendered (real paths). What launchd actually runs. Not in the repo. |
| **Logs** | `logs/<name>.log` + `logs/<name>.error.log` | `StandardOutPath` / `StandardErrorPath`. |

The repo holds **templates** (with `{{...}}` placeholders); the install script renders
them with real absolute paths into `~/Library/LaunchAgents`. Keep the template generic so
the repo stays machine-independent.

## Scheduling flavors

### 1. Calendar-based (true cron — fires at a clock time)

Used by `backup` (3:15 AM) and `email-metadata` (8:00 AM). Fires at a wall-clock time;
if the machine is asleep, launchd runs it on wake.

```xml
<key>StartCalendarInterval</key>
<dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>15</integer>
</dict>
```

Omit a key to mean "every": only `Minute` → hourly; add `Weekday` (0–7, Sun=0/7) for
weekly. Use an `<array>` of `<dict>`s for multiple fire times.

### 2. Interval-based (every N seconds)

Used by `heartbeat` (every 300s). Add `RunAtLoad` to also fire immediately on load.

```xml
<key>StartInterval</key><integer>300</integer>
<key>RunAtLoad</key><true/>
```

### 3. File-watcher (not time-based, listed for completeness)

Used by `briefing-upload` and `trip-briefing-upload`. Fires whenever a watched directory
changes — the agent writes a file, launchd reacts and uploads it.

```xml
<key>WatchPaths</key>
<array>
    <string>{{PROJECT_ROOT}}/data/trip-briefings</string>
</array>
```

## Template skeleton

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw.<name></string>

    <!-- For a bash script: -->
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>{{PROJECT_ROOT}}/scripts/<name>.sh</string>
    </array>
    <!-- For a TypeScript script, instead use:
    <array>
        <string>{{NODE_PATH}}</string>
        <string>--import</string>
        <string>tsx</string>
        <string>{{PROJECT_ROOT}}/scripts/<name>.ts</string>
    </array> -->

    <key>WorkingDirectory</key>
    <string>{{PROJECT_ROOT}}</string>

    <!-- Pick ONE scheduling flavor from above -->
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key><integer>3</integer>
        <key>Minute</key><integer>15</integer>
    </dict>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>{{HOME}}/google-cloud-sdk/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>HOME</key>
        <string>{{HOME}}</string>
    </dict>

    <key>StandardOutPath</key>
    <string>{{PROJECT_ROOT}}/logs/<name>.log</string>
    <key>StandardErrorPath</key>
    <string>{{PROJECT_ROOT}}/logs/<name>.error.log</string>
</dict>
</plist>
```

### About `PATH` (the most common gotcha)

launchd jobs run with a **minimal environment** — your interactive shell's `PATH` is
*not* inherited. Every template sets `PATH` explicitly, and each job lists only the bins
it needs:

- `backup` / `*-upload` jobs add `{{HOME}}/google-cloud-sdk/bin` (and `/opt/homebrew/bin`) for `gcloud`/`gsutil`.
- `email-metadata` adds the nvm node bin dir.
- `heartbeat` needs nothing special, so it uses the bare `/usr/local/bin:/usr/bin:/bin`.

If a job "works in my terminal but not under launchd," a missing `PATH` entry is the first
suspect. Check `logs/<name>.error.log`.

### Placeholders

| Placeholder | Replace with | How |
|-------------|--------------|-----|
| `{{PROJECT_ROOT}}` | Absolute path to the repo | Computed by the install script |
| `{{HOME}}` | `$HOME` | Computed by the install script |
| `{{NODE_PATH}}` | Absolute path to `node` | `which node` (only for `.ts` jobs) |

## Installing (the reference flow)

`scripts/install-backup-plist.sh` is the canonical installer. Copy it for a new job. It:

1. Computes `REPO_DIR` from its own location (`$(cd "$(dirname …)/.." && pwd)`).
2. `sed`-substitutes `{{PROJECT_ROOT}}` and `{{HOME}}` → writes the installed copy.
   *(For a `.ts` job, also substitute `{{NODE_PATH}}` with `$(which node)`.)*
3. `plutil -lint` validates the rendered plist.
4. `launchctl unload` (ignore errors) → `launchctl load`.
5. Confirms with `launchctl list | grep <label>`.
6. Kickstarts a test run and tails the log.

```bash
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.nanoclaw.<name>"
TEMPLATE="${REPO_DIR}/launchd/${LABEL}.plist"
INSTALLED="${HOME}/Library/LaunchAgents/${LABEL}.plist"

sed -e "s|{{PROJECT_ROOT}}|${REPO_DIR}|g" \
    -e "s|{{HOME}}|${HOME}|g" \
    "${TEMPLATE}" > "${INSTALLED}"

plutil -lint "${INSTALLED}"
launchctl unload "${INSTALLED}" 2>/dev/null || true
launchctl load "${INSTALLED}"
launchctl list | grep "${LABEL}"
launchctl kickstart -k "gui/$(id -u)/${LABEL}"   # test run now
```

## Managing a job

```bash
LABEL=com.nanoclaw.<name>
launchctl load   ~/Library/LaunchAgents/${LABEL}.plist   # start
launchctl unload ~/Library/LaunchAgents/${LABEL}.plist   # stop
launchctl kickstart -k gui/$(id -u)/${LABEL}             # restart / run now
launchctl list | grep ${LABEL}                           # is it registered?
```

After editing a **template**, you must re-render and reload the installed copy
(re-run the install script) — launchd runs the installed copy, not the repo template.

## Checklist for a new job

1. Write `scripts/<name>.{sh,ts}` and test it directly.
2. Add `launchd/com.nanoclaw.<name>.plist` (template, with `{{...}}` placeholders).
3. Add `scripts/install-<name>-plist.sh` (copy `install-backup-plist.sh`).
4. Run the installer; confirm `launchctl list` shows it and the log looks right.
5. Document the job in `CLAUDE.md` with a component table + service-management commands
   (match the existing Health Watchdog / Email Unsubscribe / Sports Briefing sections),
   and note the schedule.

## Existing jobs (reference implementations)

| Job | Flavor | Schedule | Documented in |
|-----|--------|----------|---------------|
| `backup` | Calendar | 3:15 AM | installer is the cleanest reference |
| `email-metadata` | Calendar | 8:00 AM | CLAUDE.md "Email Unsubscribe Curator" |
| `heartbeat` | Interval | every 300s | CLAUDE.md "Health Watchdog" |
| `briefing-upload` | WatchPaths | on file write | CLAUDE.md "Sports Briefing" |
| `trip-briefing-upload` | WatchPaths | on file write | CLAUDE.md "Strava Trips" |
| `caffeinate` | (long-running) | always on AC | CLAUDE.md "Sleep Prevention" |
