#!/usr/bin/env python3
"""
One-off pricer pass for World Cup events (team_slug='world-cup-2026'),
bypassing the standard 5-event cap and tier interval.

Reuses fetch/aggregate/insert logic from `ticket-scraper.py` so behavior
stays identical to the cron Pricer for everything except event selection.

Usage:
  python3 scripts/tickets-scrape-world-cup.py
"""
from __future__ import annotations
import importlib.util
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

NANOCLAW_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(NANOCLAW_ROOT, "data/sessions/tickets/.claude/tickets.db")

spec = importlib.util.spec_from_file_location(
    "ticket_scraper", os.path.join(NANOCLAW_ROOT, "scripts/ticket-scraper.py")
)
scraper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scraper)

REQUEST_DELAY = 7  # seconds between requests (same as cron Pricer)


def main():
    if not os.path.exists(DB_PATH):
        print(f"DB not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    now = datetime.now(timezone.utc)
    now_iso = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    rows = conn.execute(
        """
        SELECT id, team_slug, venue_slug, stubhub_url, event_datetime, title
          FROM events
         WHERE team_slug = 'world-cup-2026'
           AND status != 'completed'
           AND stubhub_url IS NOT NULL
         ORDER BY datetime(event_datetime)
        """
    ).fetchall()

    if not rows:
        print("No World Cup events to scrape.")
        conn.close()
        return

    print(f"Targeting {len(rows)} World Cup events:")
    for r in rows:
        print(f"  [{r[0]}] {r[5]} ({r[4]})")
    print()

    summary = {"scraped": 0, "errors": 0, "details": []}

    for i, (eid, team, venue_slug, url, evt_dt, title) in enumerate(rows):
        if i > 0:
            time.sleep(REQUEST_DELAY)

        evt_time = datetime.fromisoformat(evt_dt.replace("Z", "+00:00"))
        if evt_time.tzinfo is None:
            evt_time = evt_time.replace(tzinfo=timezone.utc)
        hours_until = (evt_time - now).total_seconds() / 3600
        days_until = hours_until / 24

        print(f"[{i+1}/{len(rows)}] {title}", flush=True)
        prices = scraper.fetch_event_prices(url)

        if prices is None or "error" in prices:
            err_type = prices.get("error", "unknown") if prices else "fetch_none"
            detail = prices.get("detail", "") if prices else ""
            print(f"   ERROR: {err_type} {detail}")
            summary["errors"] += 1
            summary["details"].append({"event_id": eid, "error": err_type, "detail": detail})
            if prices and prices.get("error") == "404":
                conn.execute("UPDATE events SET status = 'pending' WHERE id = ?", (eid,))
                conn.commit()
            continue

        section_prices = prices.get("section_prices", {})
        categories = scraper.aggregate_by_category(conn, venue_slug, section_prices)
        if not categories:
            print("   no per-category data extracted (likely WAF or empty)")
            summary["errors"] += 1
            summary["details"].append({"event_id": eid, "error": "no_sections"})
            continue

        conn.execute(
            "UPDATE events SET status = 'active' WHERE id = ? AND status = 'pending'",
            (eid,),
        )
        for cat, data in categories.items():
            conn.execute(
                """INSERT INTO price_snapshots
                   (event_id, category, polled_at, days_until, hours_until,
                    lowest_price, listing_count, best_section)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    eid, cat, now_iso, round(days_until, 2), round(hours_until, 2),
                    data["lowest_price"], prices.get("total_listings"), data.get("best_section"),
                ),
            )
        conn.commit()
        summary["scraped"] += 1
        cheapest = min(categories.items(), key=lambda x: x[1]["lowest_price"])
        print(f"   OK — {len(categories)} categories, cheapest {cheapest[0]} ${cheapest[1]['lowest_price']:.0f}")

    print()
    print(json.dumps(summary, indent=2))
    conn.close()


if __name__ == "__main__":
    main()
