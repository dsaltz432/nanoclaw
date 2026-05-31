#!/usr/bin/env python3
"""
Spotify Podcast Cleanup — un-save downloaded podcast episodes the owner is done with.

This is a personal automation for a single Spotify account (see README.md). It runs
unattended via launchd; on a scheduled run it relies on a cached refresh token and never
opens a browser. Run it once by hand with `--auth` to complete the first interactive sign-in.

Strategy (the Web API has NO "mark as played" / "set resume point" and NO concept of a
"download"): we REMOVE (un-save) episodes from the cloud library, and Spotify's own sync
then drops the local download from the owner's devices.

Three things get removed:
  - near-finished : stopped within NEAR_FINISH_THRESHOLD_MINUTES of the end (the ad-tail case)
  - fully-played  : marked fully_played but never auto-cleared (safety-net sweep; toggle with
                    INCLUDE_FULLY_PLAYED)
  - never-started : pos == 0 and older than NEVER_STARTED_MIN_AGE_DAYS

Removal uses the unified `DELETE /me/library` endpoint (the per-type `DELETE /me/episodes`
was removed in the Feb 2026 Web API changes); it takes Spotify URIs, not bare IDs.

Config comes from scripts/spotify-cleanup/.env (git-ignored). DRY_RUN defaults to true.
"""
from __future__ import annotations

import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import requests
import spotipy
from dotenv import load_dotenv
from spotipy.cache_handler import CacheFileHandler
from spotipy.oauth2 import SpotifyOAuth

# --- Paths -------------------------------------------------------------------
JOB_DIR = Path(__file__).resolve().parent            # scripts/spotify-cleanup
REPO_ROOT = JOB_DIR.parents[1]                       # repo root
LOGS_DIR = REPO_ROOT / "logs"
ENV_PATH = JOB_DIR / ".env"
CACHE_PATH = JOB_DIR / ".cache"                      # Spotipy OAuth token cache (refresh token)

# Load .env from the job directory regardless of CWD.
load_dotenv(ENV_PATH)

# --- Spotify API constants ---------------------------------------------------
API_BASE = "https://api.spotify.com/v1"
# user-library-read: list saved episodes; user-read-playback-position: resume_point per
# episode (without this scope the field is silently absent); user-library-modify: remove.
SCOPES = "user-library-read user-read-playback-position user-library-modify"
PAGE_SIZE = 50          # GET /me/episodes max per page
DELETE_BATCH = 40       # URIs per DELETE /me/library call (endpoint max is 40)


def env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    try:
        return float(raw) if raw not in (None, "") else default
    except ValueError:
        return default


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    try:
        return int(raw) if raw not in (None, "") else default
    except ValueError:
        return default


# --- Config (env overrides, with the spec's defaults) ------------------------
NEAR_FINISH_THRESHOLD_MS = int(env_float("NEAR_FINISH_THRESHOLD_MINUTES", 3) * 60_000)
NEVER_STARTED_MIN_AGE_DAYS = env_int("NEVER_STARTED_MIN_AGE_DAYS", 30)
INCLUDE_FULLY_PLAYED = env_bool("INCLUDE_FULLY_PLAYED", True)
DRY_RUN = env_bool("DRY_RUN", True)


def setup_logging() -> logging.Logger:
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    audit_path = LOGS_DIR / f"spotify-cleanup-audit-{stamp}.log"

    logger = logging.getLogger("spotify-cleanup")
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")

    # stdout → captured by launchd StandardOutPath
    stream = logging.StreamHandler(sys.stdout)
    stream.setFormatter(fmt)
    logger.addHandler(stream)

    # dedicated, auditable daily log file (appended)
    file_h = logging.FileHandler(audit_path, encoding="utf-8")
    file_h.setFormatter(fmt)
    logger.addHandler(file_h)

    logger.info("audit log: %s", audit_path)
    return logger


def build_auth_manager(interactive: bool) -> SpotifyOAuth:
    """SpotifyOAuth backed by the on-disk token cache.

    Spotipy reads SPOTIPY_CLIENT_ID / SPOTIPY_CLIENT_SECRET / SPOTIPY_REDIRECT_URI from the
    environment by default; we loaded them from .env above.
    """
    return SpotifyOAuth(
        scope=SCOPES,
        cache_handler=CacheFileHandler(cache_path=str(CACHE_PATH)),
        open_browser=interactive,
    )


def ensure_token(auth_manager: SpotifyOAuth, interactive: bool, log: logging.Logger) -> str:
    """Return a valid access token, refreshing silently from cache when possible.

    On a scheduled (headless) run with no usable cached token, fail loudly instead of
    hanging on a browser prompt.
    """
    cached = auth_manager.cache_handler.get_cached_token()
    if cached is None and not interactive:
        log.error(
            "No cached token at %s and not running interactively. "
            "Run `cleanup.py --auth` by hand once to complete the browser sign-in.",
            CACHE_PATH,
        )
        sys.exit(1)
    # get_access_token() refreshes via the cached refresh token, or runs the interactive
    # flow if there is no cache and open_browser is enabled.
    return auth_manager.get_access_token(as_dict=False)


def fetch_saved_episodes(sp: spotipy.Spotify, log: logging.Logger) -> list[dict]:
    """Page through the full saved-episodes library."""
    items: list[dict] = []
    offset = 0
    while True:
        page = sp.current_user_saved_episodes(limit=PAGE_SIZE, offset=offset)
        batch = page.get("items", []) if page else []
        items.extend(batch)
        if not page or page.get("next") is None or len(batch) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    log.info("scanned %d saved episode(s)", len(items))
    return items


def age_days(added_at: str) -> float:
    """Days since the episode was saved. added_at is ISO 8601 (e.g. 2024-01-15T10:00:00Z)."""
    dt = datetime.fromisoformat(added_at.replace("Z", "+00:00"))
    return (datetime.now(timezone.utc) - dt).total_seconds() / 86400.0


def classify(item: dict, log: logging.Logger, stats: dict) -> tuple[str, str] | None:
    """Return (uri, reason) if the episode should be removed, else None.

    Two non-removable states are counted in `stats` (reported in the summary) rather than
    logged per-item:
      - tombstone : the episode was deleted from Spotify's catalog, so every field incl. the
        URI is null. Nothing to remove by URI; only Spotify can garbage-collect it. Expected.
      - no_scope  : resume_point absent, which almost always means the
        user-read-playback-position scope wasn't granted — classification can't run, so skip.
    """
    ep = item.get("episode")
    if not ep:  # unavailable / removed episode
        stats["tombstone"] += 1
        return None

    name = ep.get("name") or "<unknown>"
    show = (ep.get("show") or {}).get("name") or "<unknown show>"
    duration_ms = ep.get("duration_ms") or 0
    uri = ep.get("uri")
    if not uri:
        # Catalog tombstone (deleted episode): no URI to address, so it can't be removed. Expected.
        stats["tombstone"] += 1
        return None

    rp = ep.get("resume_point")
    if rp is None:
        log.warning("resume_point missing for %r (%s) — scope likely absent; skipping", name, show)
        stats["no_scope"] += 1
        return None

    pos = rp.get("resume_position_ms") or 0  # key can be present-but-null
    finished = bool(rp.get("fully_played"))
    remaining_ms = duration_ms - pos
    age = age_days(item["added_at"])

    # Category A: effectively finished (the ad-tail case)
    if (not finished) and pos > 0 and remaining_ms <= NEAR_FINISH_THRESHOLD_MS:
        mins_left = max(0, round(remaining_ms / 60_000, 1))
        return uri, f"near_finished ({mins_left} min left) — {show}: {name}"

    # Category A': genuinely finished but not cleared (safety-net sweep)
    if finished and INCLUDE_FULLY_PLAYED:
        return uri, f"fully_played but still saved — {show}: {name}"

    # Category B: never started, and old enough
    if pos == 0 and (not finished) and age >= NEVER_STARTED_MIN_AGE_DAYS:
        return uri, f"never_started, aged out ({int(age)}d) — {show}: {name}"

    # Otherwise: keep (partially listened with meaningful time left, or recent unstarted)
    return None


def remove_episodes(uris: list[str], token: str, log: logging.Logger) -> None:
    """Un-save episodes via the unified DELETE /me/library endpoint.

    The Feb 2026 unified endpoint takes the URIs as a comma-separated `uris` QUERY
    parameter (not a JSON body), max 40 per request. It can remove any library item by URI
    (tracks, albums, …), so we hard-guard that we only ever send episode URIs — music can
    never be affected.
    """
    bad = [u for u in uris if not u.startswith("spotify:episode:")]
    if bad:
        log.error("refusing to remove %d non-episode URI(s), e.g. %s", len(bad), bad[:3])
        raise SystemExit(1)
    headers = {"Authorization": f"Bearer {token}"}
    for i in range(0, len(uris), DELETE_BATCH):
        batch = uris[i : i + DELETE_BATCH]
        # Encode each URI (colons → %3A) and join with literal commas, per the API example.
        query = ",".join(quote(u, safe="") for u in batch)
        resp = requests.delete(f"{API_BASE}/me/library?uris={query}", headers=headers, timeout=30)
        if not resp.ok:
            log.error("DELETE /me/library %d: %s", resp.status_code, resp.text[:500])
        resp.raise_for_status()
        log.info("removed batch of %d episode(s)", len(batch))


def parse_limit(argv: list[str]) -> int | None:
    """Optional `--limit N`: cap how many episodes are acted on in this run (for testing).

    Default is None = uncapped (the job's normal behavior). Accepts `--limit 5` or `--limit=5`.
    """
    for i, a in enumerate(argv):
        if a == "--limit" and i + 1 < len(argv):
            return int(argv[i + 1])
        if a.startswith("--limit="):
            return int(a.split("=", 1)[1])
    return None


def main() -> None:
    args = sys.argv[1:]
    interactive = "--auth" in args or sys.stdin.isatty()
    limit = parse_limit(args)
    log = setup_logging()
    log.info(
        "config: DRY_RUN=%s INCLUDE_FULLY_PLAYED=%s NEAR_FINISH=%dms NEVER_STARTED_MIN_AGE_DAYS=%d interactive=%s limit=%s",
        DRY_RUN, INCLUDE_FULLY_PLAYED, NEAR_FINISH_THRESHOLD_MS, NEVER_STARTED_MIN_AGE_DAYS, interactive, limit,
    )

    if not os.environ.get("SPOTIPY_CLIENT_ID") or not os.environ.get("SPOTIPY_CLIENT_SECRET"):
        log.error("SPOTIPY_CLIENT_ID / SPOTIPY_CLIENT_SECRET not set (expected in %s)", ENV_PATH)
        sys.exit(1)

    auth_manager = build_auth_manager(interactive)
    token = ensure_token(auth_manager, interactive, log)
    sp = spotipy.Spotify(auth_manager=auth_manager)

    items = fetch_saved_episodes(sp, log)

    candidates: list[tuple[str, str]] = []  # (uri, reason)
    reasons = {"near_finished": 0, "fully_played": 0, "never_started": 0}
    stats = {"tombstone": 0, "no_scope": 0}
    for item in items:
        result = classify(item, log, stats)
        if result is None:
            continue
        uri, reason = result
        candidates.append((uri, reason))
        for key in reasons:
            if reason.startswith(key):
                reasons[key] += 1
                break

    log.info(
        "summary: %d to remove (near_finished=%d, fully_played=%d, never_started=%d) "
        "of %d scanned; skipped %d catalog tombstone(s), %d missing-scope",
        len(candidates), reasons["near_finished"], reasons["fully_played"], reasons["never_started"],
        len(items), stats["tombstone"], stats["no_scope"],
    )

    if not candidates:
        log.info("nothing to remove. done.")
        return

    # --limit caps the actual action (test runs); the summary above still reflects the full set.
    targets = candidates if limit is None else candidates[:limit]
    if limit is not None and len(candidates) > limit:
        log.info("--limit %d: acting on first %d of %d candidate(s)", limit, len(targets), len(candidates))

    for _, reason in targets:
        log.info("%s %s", "WOULD REMOVE" if DRY_RUN else "REMOVE", reason)

    if DRY_RUN:
        log.info("DRY_RUN=true — deleted nothing. Set DRY_RUN=false in .env (or prefix the command) to act.")
        return

    remove_episodes([uri for uri, _ in targets], token, log)
    log.info("done — removed %d episode(s).", len(targets))


if __name__ == "__main__":
    main()
