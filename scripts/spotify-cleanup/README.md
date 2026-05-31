# Spotify Podcast Cleanup

Un-saves podcast episodes the owner is done with from Spotify's "Your Episodes" library, so
Spotify's own sync drops the local downloads off the owner's devices. Runs unattended on the
basement MacBook via a launchd cronjob, daily at **4:30 AM ET**.

It is a personal automation for a single Spotify account — not a public app.

## Why un-save (and not "mark as played")

The Spotify Web API has **no** "mark as played" / "set resume point" endpoint — playback
position is read-only — and **no** concept of a "download" (downloads are a local device
cache). The only lever is **un-saving** the episode from the cloud library; Spotify's sync
then removes the local file. The owner has auto-download off, so re-downloading isn't a
concern.

### Verified behavior (the "boomerang") — May 2026

Live testing confirmed the important part: **un-saving an episode reliably clears its
download off the phone** on the next sync. That is the actual goal and it works.

What it does *not* always do is keep the library bookmark gone. The device runs a **two-way
library sync**, so an episode the phone still holds locally can get **re-added to the cloud
library** seconds later (observed: 4 of 5 test removals re-appeared with a fresh `added_at`,
in a single sync event). Crucially, the re-added entry comes back as a **download-free
bookmark** — the local file stays gone. So:

- ✅ Downloads clear (storage reclaimed) — the thing we care about.
- ↩︎ Bookmarks may transiently re-appear; the next run simply un-saves them again (cheap, no
  download involved). The candidate count therefore won't necessarily drain to zero.

This is *not* caused by auto-download (which is off); it's the device reconciling its local
saved-state. It's expected and harmless given the goal is download cleanup, not a pristine
library count.

## What it removes

For every saved episode it reads `added_at`, `duration_ms`, and `resume_point`, then:

| Category | Rule | Default |
|---|---|---|
| **near-finished** | not `fully_played`, `pos > 0`, and within `NEAR_FINISH_THRESHOLD_MINUTES` of the end (the ad-tail case) | on |
| **fully-played sweep** | `fully_played` but still saved (Spotify's auto-remove is flaky) | `INCLUDE_FULLY_PLAYED=true` |
| **never-started** | `pos == 0`, not finished, and saved ≥ `NEVER_STARTED_MIN_AGE_DAYS` ago | 30 days |
| keep | everything else (partially listened with time left, or recently saved) | — |

Episodes whose `resume_point` is **absent** are logged as warnings and never removed — a
missing `resume_point` almost always means the `user-read-playback-position` scope wasn't
granted, which would silently break classification.

## Scopes

The OAuth token requests three scopes:

- `user-library-read` — list saved episodes (`GET /me/episodes`)
- `user-read-playback-position` — get `resume_point` per episode (**required**, see above)
- `user-library-modify` — remove episodes

## Removal endpoint (verified May 2026)

The per-type `DELETE /me/episodes` was **removed** in the February 2026 Web API changes and
replaced by the unified **`DELETE /me/library`**, which takes Spotify **URIs**
(`spotify:episode:…`), not bare IDs, as a comma-separated **`uris` query parameter** (not a
JSON body), **max 40 URIs per request**. This script lists/auths via Spotipy and issues the
removal as a raw `DELETE /me/library?uris=…` request (batched, ≤40) with the Spotipy-managed
bearer token — independent of whether the installed Spotipy version has wrapped the new
endpoint.

## Spotify Developer Dashboard setup (one-time, owner does this)

The Feb 2026 / Mar 9 2026 Development-Mode rules (verified live): **Premium account
required**, **one Development-Mode Client ID per developer**, **up to 5 authorized users**.

1. Create one app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   to get a **Client ID** and **Client Secret** (already filled into `.env`).
2. Add the Redirect URI **`http://127.0.0.1:8888/callback`** in the app settings — it must
   match `SPOTIPY_REDIRECT_URI` exactly. (Spotify requires the loopback IP `127.0.0.1`, not
   `localhost`, for new apps.)
3. Under the app's user-management settings, add the owner's own Spotify account as an
   authorized user, or API calls return 403.

## Files

| File | Purpose | Tracked? |
|---|---|---|
| `cleanup.py` | classification + removal | yes |
| `requirements.txt` | pinned deps (`spotipy`, `python-dotenv`, `requests`) | yes |
| `README.md` | this file | yes |
| `.env` | credentials + config overrides | **git-ignored** |
| `.cache` | Spotipy OAuth token cache (refresh token) — **do not delete** | **git-ignored** |
| `~/.local/share/nanoclaw/spotify-cleanup-venv/` | dedicated virtualenv (**outside the repo** — see below) | n/a (not in repo) |
| `../../launchd/com.nanoclaw.spotify-cleanup.plist` | launchd template | yes |
| `../install-spotify-cleanup-plist.sh` | render + install + load + test | yes |

### How launchd runs it (the `~/Documents` / exit-78 gotcha)

The repo lives under `~/Documents`, which is TCC-protected. **At spawn time** launchd itself
touches two things: the program in `ProgramArguments`, and the `StandardOutPath`/
`StandardErrorPath` files it opens for the child. For a LaunchAgent **loaded mid-session**
(`launchctl load`, vs. loaded at login/reboot), launchd is **denied access to anything under
`~/Documents` at spawn**, so if either of those is in the repo the job fails before it starts:
`posix_spawn(...) Operation not permitted`, exit **78**, empty logs.

The **child** process has no such restriction — it reads/writes `~/Documents` fine. So the plist
is shaped to keep launchd's spawn-time paths out of `~/Documents`:

- **Program:** inline `/bin/bash -c 'exec "<venv-python>" "<cleanup.py>"'` — no repo script in
  `ProgramArguments`; `/bin/bash` is the spawned binary. The venv python lives at
  `~/.local/share/nanoclaw/spotify-cleanup-venv` (outside `~/Documents`).
- **launchd stdout/stderr:** `~/.local/share/nanoclaw/logs/spotify-cleanup{,.error}.log`
  (outside `~/Documents`).
- **In the repo (child accesses these — fine):** `cleanup.py`, `.env`, `.cache`, and the detailed
  per-run **audit log** at `logs/spotify-cleanup-audit-YYYYMMDD.log`.

(The other nanoclaw jobs keep their scripts/logs in the repo and still work because they were
loaded at **login/reboot**, which grants launchd `~/Documents` access. A reboot would make a
repo-path plist work too — but the shape above works regardless of when it's loaded.)

Verify a run with `launchctl list | grep com.nanoclaw.spotify-cleanup` (column 2 = `0` good,
`78` = a `~/Documents` spawn path slipped in). Interactive use (`--auth`) calls the venv python
directly in your shell, where none of this applies.

## Configuration (`.env`)

| Setting | Default | Meaning |
|---|---|---|
| `SPOTIPY_CLIENT_ID` | — | from dashboard |
| `SPOTIPY_CLIENT_SECRET` | — | from dashboard |
| `SPOTIPY_REDIRECT_URI` | `http://127.0.0.1:8888/callback` | must match dashboard |
| `NEAR_FINISH_THRESHOLD_MINUTES` | `3` (this install: `5`) | within this many minutes of the end = finished |
| `NEVER_STARTED_MIN_AGE_DAYS` | `30` | only remove never-started episodes older than this |
| `INCLUDE_FULLY_PLAYED` | `true` | also sweep finished-but-not-cleared episodes |
| `DRY_RUN` | `true` (this install: `false` — **live**) | log only; delete nothing |

The Client ID/Secret live only in `.env` (git-ignored), never in the committed script.

## First-run auth (interactive, once)

Set up the venv and complete the browser sign-in by hand. This writes `.cache` (the refresh
token) so every scheduled run thereafter is silent. **Don't delete `.cache`** — doing so
forces a re-auth and breaks the headless run.

```bash
cd /Users/danielsaltz/Documents/repositories/nanoclaw
VENV="$HOME/.local/share/nanoclaw/spotify-cleanup-venv"
python3 -m venv "$VENV"
"$VENV/bin/pip" install -r scripts/spotify-cleanup/requirements.txt

# interactive: opens a browser, completes OAuth, writes .cache
"$VENV/bin/python" scripts/spotify-cleanup/cleanup.py --auth
```

For day-to-day manual runs, use the same `"$VENV/bin/python" scripts/spotify-cleanup/cleanup.py`
(add `--limit N` to cap a run; prefix `DRY_RUN=false` to actually remove). A scheduled
(headless) run with no usable cache **fails loudly** to the error log rather than hanging on a
browser prompt.

## Scheduling (launchd)

`install-spotify-cleanup-plist.sh` creates the (external) venv, renders the template with real
paths, `plutil -lint`s it, loads it, and — if `.cache` exists — kickstarts a test run, then
prints the run's exit code. Run the first-run auth above first.

```bash
scripts/install-spotify-cleanup-plist.sh
```

Confirm it ran: `launchctl list | grep com.nanoclaw.spotify-cleanup` — column 2 should be `0`
(see the exit-78 gotcha above if not). The installer works whether run from a normal Terminal
or an automation session — the spawn restriction is about *path locations*, not the loader.

Service management once installed:

```bash
launchctl load   ~/Library/LaunchAgents/com.nanoclaw.spotify-cleanup.plist   # start
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.spotify-cleanup.plist   # stop
launchctl kickstart -k gui/$(id -u)/com.nanoclaw.spotify-cleanup             # run now
launchctl list | grep com.nanoclaw.spotify-cleanup                           # registered? (col 2 = last exit)
```

The job fires at **machine-local 4:30 AM**; the basement MacBook is on ET, so that is 4:30 AM
ET. launchd fires in machine-local time — if the Mac's timezone ever changes, the fire time
moves with it.

## Logs

- `logs/spotify-cleanup.log` / `logs/spotify-cleanup.error.log` — launchd stdout/stderr.
- `logs/spotify-cleanup-audit-YYYYMMDD.log` — the script's own appended daily audit log:
  config, count scanned, per-category counts, and every episode it removed (or, in dry-run,
  would remove) with a reason.

## Suggested rollout

1. Run in dry-run for a few days; eyeball the would-remove list in the audit log.
2. Tune `NEAR_FINISH_THRESHOLD_MINUTES` and `NEVER_STARTED_MIN_AGE_DAYS` to taste.
3. Flip `DRY_RUN=false`, let it remove a small batch, confirm the downloads clear off the
   phone after a sync.
4. Once trusted, let the 4:30 AM scheduler run it.
