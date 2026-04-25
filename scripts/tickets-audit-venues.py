#!/usr/bin/env python3
"""
Audit section_categories coverage by fetching one live event per away venue.

For each distinct away venue (is_home_game=0) with an upcoming active event,
pulls the StubHub page, extracts the sections StubHub actually returns, and
compares to what's in our section_categories table.

Output (stdout + /tmp/venue-audit.json):
  per-venue counts of matched vs unmapped StubHub sections, plus a sample
  of unmapped section names so we know what to add to venues-config.json.

Does not write to the DB — pure read + HTTP fetch.

Usage:
  python3 scripts/tickets-audit-venues.py
  python3 scripts/tickets-audit-venues.py --delay 5    # seconds between requests
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
import sqlite3
import sys
import time
from collections import defaultdict

NANOCLAW_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(
    NANOCLAW_ROOT, "data/sessions/tickets/.claude/tickets.db"
)

# Load scraper module (hyphenated filename, so use importlib)
spec = importlib.util.spec_from_file_location(
    "ticket_scraper", os.path.join(NANOCLAW_ROOT, "scripts/ticket-scraper.py")
)
scraper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scraper)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--delay", type=float, default=5.0, help="Seconds between requests")
    ap.add_argument("--limit", type=int, default=0, help="Cap venues to first N (0 = all)")
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)

    # Pick one event per away venue — soonest upcoming
    rows = conn.execute("""
        SELECT venue_slug, id, title, stubhub_url, event_datetime
        FROM events
        WHERE is_home_game = 0
          AND venue_slug IS NOT NULL
          AND status != 'completed'
          AND stubhub_url IS NOT NULL
          AND event_datetime > datetime('now')
        ORDER BY venue_slug, event_datetime
    """).fetchall()

    one_per_venue = {}
    for venue_slug, eid, title, url, dt in rows:
        if venue_slug not in one_per_venue:
            one_per_venue[venue_slug] = (eid, title, url, dt)

    # Load existing section_categories per venue
    mapping: dict[str, dict[str, str]] = defaultdict(dict)
    for vs, sec, cat in conn.execute(
        "SELECT venue_slug, section_name, category FROM section_categories"
    ):
        mapping[vs][sec] = cat
    conn.close()

    venues = list(one_per_venue.items())
    if args.limit:
        venues = venues[: args.limit]

    print(f"Auditing {len(venues)} away venues (delay {args.delay}s between requests)\n")

    audit = []
    for i, (venue_slug, (eid, title, url, dt)) in enumerate(venues):
        if i > 0:
            time.sleep(args.delay)
        print(f"[{i+1}/{len(venues)}] {venue_slug} — {title[:55]}")
        result = scraper.fetch_event_prices(url)
        if not result or "error" in result:
            err = result.get("error") if result else "none"
            detail = result.get("detail", "")[:80] if result else ""
            print(f"    SKIP: {err} {detail}")
            audit.append(
                {
                    "venue": venue_slug,
                    "event_id": eid,
                    "error": err,
                    "detail": detail,
                }
            )
            continue

        stubhub_sections = set(result.get("section_prices", {}).keys())
        our_sections = set(mapping.get(venue_slug, {}).keys())
        matched = stubhub_sections & our_sections
        unmapped = stubhub_sections - our_sections
        unused = our_sections - stubhub_sections

        audit.append(
            {
                "venue": venue_slug,
                "event_id": eid,
                "title": title,
                "stubhub_count": len(stubhub_sections),
                "our_mapped_count": len(our_sections),
                "matched": len(matched),
                "unmapped_count": len(unmapped),
                "unused_count": len(unused),
                "unmapped_sections": sorted(unmapped),
                "sample_matched": sorted(matched)[:5],
            }
        )
        pct = 100 * len(matched) / max(len(stubhub_sections), 1)
        print(
            f"    StubHub={len(stubhub_sections)} sections, "
            f"matched={len(matched)} ({pct:.0f}%), unmapped={len(unmapped)}"
        )
        if unmapped:
            sample = sorted(unmapped)[:8]
            print(f"    unmapped sample: {sample}")

    out_path = "/tmp/venue-audit.json"
    with open(out_path, "w") as f:
        json.dump(audit, f, indent=2)

    print(f"\n=== Summary (worst coverage first) ===")
    ranked = sorted(
        [a for a in audit if "error" not in a],
        key=lambda x: (-x["unmapped_count"], -x["stubhub_count"]),
    )
    for a in ranked:
        pct = 100 * a["matched"] / max(a["stubhub_count"], 1)
        print(
            f"  {a['venue']:40s} "
            f"{a['matched']:3d}/{a['stubhub_count']:3d} matched ({pct:3.0f}%)  "
            f"{a['unmapped_count']:3d} unmapped"
        )

    errors = [a for a in audit if "error" in a]
    if errors:
        print(f"\nErrors: {len(errors)}")
        for a in errors:
            print(f"  {a['venue']:40s} {a['error']} {a.get('detail','')[:60]}")

    print(f"\nFull report: {out_path}")


if __name__ == "__main__":
    main()
