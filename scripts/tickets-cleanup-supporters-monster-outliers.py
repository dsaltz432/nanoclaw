#!/usr/bin/env python3
"""
One-shot cleanup: extend the SR outlier filter retroactively to the
`Supporters` (WC) and `Monster Standing` (Fenway SRGM) categories.

Same pattern as `tickets-cleanup-sr-outliers.py` from 2026-05:
delete snapshots where the category lowest_price exceeds 5× the
cheapest seated category at the same (event, polled_at).

Default mode is dry-run; pass --apply to delete. Migration-guarded.

Usage:
  python3 scripts/tickets-cleanup-supporters-monster-outliers.py
  python3 scripts/tickets-cleanup-supporters-monster-outliers.py --apply
"""
from __future__ import annotations
import argparse
import os
import sqlite3

NANOCLAW_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(NANOCLAW_ROOT, "data/sessions/tickets/.claude/tickets.db")
MIGRATION_NAME = "supporters_monster_standing_cleanup_2026_05"
TARGET_CATEGORIES = ("Supporters", "Monster Standing")
# All categories that should be excluded from the "cheapest seated"
# comparator (i.e. the union of mixed-bag categories — adding new targets
# here keeps the comparator symmetric with the in-scraper filter).
SR_LIKE_CATEGORIES = ("Standing Room", "General Admission", "Supporters", "Monster Standing")
SR_OUTLIER_RATIO = 5.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="Delete rows (default: dry-run)")
    ap.add_argument("--limit", type=int, default=25, help="Cap rows shown in preview")
    ap.add_argument("--force", action="store_true",
                    help="Bypass migration-already-applied guard")
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

    target_ph = ",".join("?" for _ in TARGET_CATEGORIES)
    exclude_ph = ",".join("?" for _ in SR_LIKE_CATEGORIES)

    rows = conn.execute(
        f"""
        WITH target AS (
          SELECT id, event_id, polled_at, category, lowest_price, best_section
            FROM price_snapshots
           WHERE category IN ({target_ph})
        ),
        seated_min AS (
          SELECT event_id, polled_at, MIN(lowest_price) AS cheapest
            FROM price_snapshots
           WHERE category NOT IN ({exclude_ph})
           GROUP BY event_id, polled_at
        )
        SELECT target.id, target.event_id, target.polled_at, target.category,
               target.lowest_price, target.best_section,
               seated_min.cheapest,
               target.lowest_price / seated_min.cheapest AS ratio
          FROM target
          JOIN seated_min
            ON seated_min.event_id = target.event_id
           AND seated_min.polled_at = target.polled_at
         WHERE seated_min.cheapest > 0
           AND target.lowest_price > {SR_OUTLIER_RATIO} * seated_min.cheapest
         ORDER BY ratio DESC
        """,
        TARGET_CATEGORIES + SR_LIKE_CATEGORIES,
    ).fetchall()

    print(f"DB: {DB_PATH}")
    print(f"Mode: {'APPLY' if args.apply else 'DRY RUN'}")
    print(f"Targets: {TARGET_CATEGORIES}  threshold: >{SR_OUTLIER_RATIO}x cheapest seated")
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

    # Per-category summary
    by_cat: dict[str, list] = {}
    for r in rows:
        by_cat.setdefault(r[3], []).append(r)
    print("By category:")
    for cat, rs in by_cat.items():
        print(f"  {cat:<25s} {len(rs):>4d} rows  ratio {min(r[7] for r in rs):.1f}–{max(r[7] for r in rs):.1f}×")
    print()

    print(f"Sample (sorted by ratio desc, top {args.limit}):")
    print(f"  {'snap':>7}  {'event':>9}  {'cat':<18s}  {'price':>8}  {'seated':>8}  {'ratio':>5}  best_section")
    for r in rows[: args.limit]:
        snap_id, eid, polled, cat, price, best, cheapest, ratio = r
        print(f"  {snap_id:>7}  {eid:>9}  {cat:<18s}  ${price:>7.0f}  ${cheapest:>7.0f}  {ratio:>4.1f}×  {best or '—'}")
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
