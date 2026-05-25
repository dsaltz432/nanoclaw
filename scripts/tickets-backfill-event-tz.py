#!/usr/bin/env python3
"""
One-shot backfill: fix event_datetime values that were stored as venue-local
clock times labeled with a UTC offset.

Background: the discovery agent read StubHub event times (which are shown in
each venue's local timezone) and serialized them with a 'Z'/'+00:00' suffix —
treating the venue-local wall clock as if it were ET. This makes ET-venue
rows correct by coincidence and non-ET rows wrong by the venue/ET offset.

Algorithm per event:
  1. Parse stored value as UTC.
  2. Render its wall clock in ET (this gives back the original venue-local clock
     the agent saw on StubHub).
  3. Reinterpret that wall clock in the venue's actual IANA tz.
  4. Re-encode as true UTC.

Default mode is dry-run: prints a unified-diff-style preview, no DB writes.
Pass --apply to mutate the DB.

Usage:
  python3 scripts/tickets-backfill-event-tz.py            # dry run
  python3 scripts/tickets-backfill-event-tz.py --apply    # write
  python3 scripts/tickets-backfill-event-tz.py --tz America/Chicago  # filter
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from collections import Counter
from datetime import datetime
from zoneinfo import ZoneInfo

NANOCLAW_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(NANOCLAW_ROOT, "data/sessions/tickets/.claude/tickets.db")
VENUES_CONFIG_PATH = os.path.join(
    NANOCLAW_ROOT, "data/sessions/tickets/.claude/venues-config.json"
)
ET = ZoneInfo("America/New_York")
UTC = ZoneInfo("UTC")
MIGRATION_NAME = "event_datetime_venue_tz_normalize_2026_04"


def load_venue_tz() -> dict[str, str]:
    with open(VENUES_CONFIG_PATH) as f:
        cfg = json.load(f)
    return {v["slug"]: v["tz"] for v in cfg["venues"] if v.get("tz")}


def parse_stored(iso: str) -> datetime | None:
    """Return a tz-aware UTC datetime, or None for TBD / unparseable values."""
    if not iso:
        return None
    s = iso.strip()
    has_offset = s.endswith("Z") or "+" in s[10:] or s[19:].startswith("-")
    if not has_offset:
        # No TZ marker — treat as TBD placeholder, leave alone.
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        return None
    return d.astimezone(UTC)


def reinterpret(d_utc: datetime, venue_tz_name: str) -> datetime:
    """Take stored UTC, treat its ET wall clock as venue-local, return true UTC."""
    et_wall = d_utc.astimezone(ET).replace(tzinfo=None)
    venue_local = et_wall.replace(tzinfo=ZoneInfo(venue_tz_name))
    return venue_local.astimezone(UTC)


def fmt_iso(d: datetime) -> str:
    """Format as ISO with Z suffix (matches existing convention)."""
    return d.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Write changes (default: dry-run)")
    ap.add_argument("--tz", help="Filter to one venue tz (e.g. America/Chicago)")
    ap.add_argument("--limit", type=int, default=0, help="Cap rows shown in preview")
    ap.add_argument(
        "--force",
        action="store_true",
        help="Bypass the migration-already-applied guard (dangerous: re-running double-shifts data)",
    )
    args = ap.parse_args()

    venue_tz = load_venue_tz()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    # Idempotence guard: this migration is one-shot. Running it twice would
    # interpret already-correct UTC values as venue-local again and shift them
    # a second time. Refuse unless --force is passed.
    conn.execute(
        "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, "
        "applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    )
    already = conn.execute(
        "SELECT applied_at FROM migrations WHERE name = ?", (MIGRATION_NAME,)
    ).fetchone()
    if already and not args.force:
        print(f"Migration '{MIGRATION_NAME}' already applied at {already[0]}.")
        print("Refusing to run — re-running would double-shift event_datetime values.")
        print("Pass --force only if you've reverted the DB and need to re-apply.")
        conn.close()
        return

    rows = conn.execute(
        """
        SELECT id, team_slug, venue_slug, title, event_datetime, status
        FROM events
        WHERE event_datetime IS NOT NULL AND event_datetime != ''
        ORDER BY event_datetime
        """
    ).fetchall()

    changes: list[tuple[int, str, str, str, str]] = []  # id, slug, title, old, new
    skipped_no_venue = 0
    skipped_no_tz = 0
    skipped_tbd = 0
    skipped_unchanged = 0
    by_tz: Counter[str] = Counter()

    for r in rows:
        old = r["event_datetime"]
        d_utc = parse_stored(old)
        if d_utc is None:
            skipped_tbd += 1
            continue
        slug = r["venue_slug"]
        if not slug:
            skipped_no_venue += 1
            continue
        tz_name = venue_tz.get(slug)
        if not tz_name:
            skipped_no_tz += 1
            continue
        if args.tz and tz_name != args.tz:
            continue
        new_utc = reinterpret(d_utc, tz_name)
        new_iso = fmt_iso(new_utc)
        # Normalize old to Z form for comparison only
        old_normalized = fmt_iso(d_utc)
        if new_iso == old_normalized:
            skipped_unchanged += 1
            by_tz[tz_name] += 1
            continue
        changes.append((r["id"], slug, r["title"] or "", old, new_iso))
        by_tz[tz_name] += 1

    # Preview
    print(f"DB: {DB_PATH}")
    print(f"Mode: {'APPLY' if args.apply else 'DRY RUN'}")
    print(f"Total events scanned: {len(rows)}")
    print(f"  TBD / unparseable (skipped): {skipped_tbd}")
    print(f"  Missing venue_slug (skipped): {skipped_no_venue}")
    print(f"  Venue without tz mapping (skipped): {skipped_no_tz}")
    print(f"  Already correct (no shift needed): {skipped_unchanged}")
    print(f"  Will be updated: {len(changes)}")
    print()
    print("Counts by venue tz:", dict(by_tz))
    print()

    if not changes:
        print("No changes needed.")
        conn.close()
        return

    print("Sample changes:")
    sample = changes if args.limit == 0 else changes[: args.limit]
    for evid, slug, title, old, new in sample:
        old_et = parse_stored(old).astimezone(ET).strftime("%a %b %d %I:%M %p %Z")
        new_et = datetime.fromisoformat(new.replace("Z", "+00:00")).astimezone(ET).strftime(
            "%a %b %d %I:%M %p %Z"
        )
        print(f"  [{evid}] {slug:35s} {title[:40]:40s}")
        print(f"           {old}  ->  {new}")
        print(f"           ET wall: {old_et}  ->  {new_et}")

    if args.apply:
        print()
        print(f"Applying {len(changes)} updates...")
        cur = conn.cursor()
        cur.executemany(
            "UPDATE events SET event_datetime = ? WHERE id = ?",
            [(new, evid) for evid, _, _, _, new in changes],
        )
        cur.execute(
            "INSERT OR REPLACE INTO migrations (name) VALUES (?)", (MIGRATION_NAME,)
        )
        conn.commit()
        print(f"Updated {cur.rowcount} rows. Marked migration applied.")
    else:
        print()
        print("Dry run — no DB changes. Re-run with --apply to write.")

    conn.close()


if __name__ == "__main__":
    main()
