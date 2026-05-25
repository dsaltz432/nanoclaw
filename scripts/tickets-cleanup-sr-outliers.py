#!/usr/bin/env python3
"""
One-shot cleanup: delete Standing Room / General Admission price_snapshots
whose lowest_price exceeds SR_OUTLIER_RATIO × the cheapest seated category
at the same (event, polled_at).

Mirrors the in-scraper filter added to `aggregate_by_category` so historical
data and forward-going data agree.

Default mode is dry-run; pass --apply to delete.

Usage:
  python3 scripts/tickets-cleanup-sr-outliers.py
  python3 scripts/tickets-cleanup-sr-outliers.py --apply
"""
from __future__ import annotations
import argparse
import os
import sqlite3
import sys

NANOCLAW_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(NANOCLAW_ROOT, "data/sessions/tickets/.claude/tickets.db")
MIGRATION_NAME = "sr_outlier_cleanup_2026_05"
SR_LIKE_CATEGORIES = ("Standing Room", "General Admission")
SR_OUTLIER_RATIO = 5.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Delete rows (default: dry-run)")
    ap.add_argument("--limit", type=int, default=20, help="Cap rows shown in preview")
    ap.add_argument(
        "--force", action="store_true",
        help="Bypass migration-already-applied guard"
    )
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, "
        "applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    )
    already = conn.execute(
        "SELECT applied_at FROM migrations WHERE name = ?", (MIGRATION_NAME,)
    ).fetchone()
    if already and not args.force:
        print(f"Migration '{MIGRATION_NAME}' already applied at {already[0]}.")
        print("Re-run with --force only if you've reverted relevant rows.")
        return

    placeholders = ",".join("?" for _ in SR_LIKE_CATEGORIES)

    # For each SR/GA snapshot, look up the cheapest non-SR-like category at the
    # same (event_id, polled_at). Flag rows where SR/GA lowest_price > 5x.
    rows = conn.execute(
        f"""
        WITH sr AS (
          SELECT id, event_id, polled_at, category, lowest_price
            FROM price_snapshots
           WHERE category IN ({placeholders})
        ),
        seated_min AS (
          SELECT event_id, polled_at, MIN(lowest_price) AS cheapest
            FROM price_snapshots
           WHERE category NOT IN ({placeholders})
           GROUP BY event_id, polled_at
        )
        SELECT sr.id, sr.event_id, sr.polled_at, sr.category, sr.lowest_price,
               seated_min.cheapest, sr.lowest_price / seated_min.cheapest AS ratio
          FROM sr
          JOIN seated_min
            ON seated_min.event_id = sr.event_id
           AND seated_min.polled_at = sr.polled_at
         WHERE seated_min.cheapest > 0
           AND sr.lowest_price > {SR_OUTLIER_RATIO} * seated_min.cheapest
         ORDER BY ratio DESC
        """,
        SR_LIKE_CATEGORIES + SR_LIKE_CATEGORIES,
    ).fetchall()

    print(f"DB: {DB_PATH}")
    print(f"Mode: {'APPLY' if args.apply else 'DRY RUN'}")
    print(f"Threshold: SR/GA > {SR_OUTLIER_RATIO}x cheapest seated category")
    print(f"Outlier rows found: {len(rows)}")
    print()

    if not rows:
        print("Nothing to clean.")
        if args.apply:
            conn.execute(
                "INSERT OR REPLACE INTO migrations (name) VALUES (?)", (MIGRATION_NAME,)
            )
            conn.commit()
        return

    print("Sample (sorted by ratio desc):")
    print(f"  {'snap_id':>8}  {'event':>9}  {'cat':<20}  {'price':>8}  {'seated':>8}  {'ratio':>5}  polled_at")
    for r in rows[: args.limit]:
        snap_id, eid, polled, cat, price, cheapest, ratio = r
        print(f"  {snap_id:>8}  {eid:>9}  {cat:<20}  ${price:>7.0f}  ${cheapest:>7.0f}  {ratio:>4.1f}x  {polled}")
    if len(rows) > args.limit:
        print(f"  ... and {len(rows) - args.limit} more")

    if args.apply:
        ids = [r[0] for r in rows]
        chunk = 500
        deleted = 0
        for i in range(0, len(ids), chunk):
            batch = ids[i : i + chunk]
            conn.execute(
                f"DELETE FROM price_snapshots WHERE id IN ({','.join('?' for _ in batch)})",
                batch,
            )
            deleted += len(batch)
        conn.execute(
            "INSERT OR REPLACE INTO migrations (name) VALUES (?)", (MIGRATION_NAME,)
        )
        conn.commit()
        print()
        print(f"Deleted {deleted} rows. Marked migration applied.")
    else:
        print()
        print("Dry run — no DB changes. Re-run with --apply to delete.")

    conn.close()


if __name__ == "__main__":
    main()
