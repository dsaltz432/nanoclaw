#!/usr/bin/env python3
"""
Seeds the `section_categories` table from `venues-config.json`.

For each venue, section_categories can be:
  - Explicit:   {"Field Level": ["109", "110", ...], "Upper Deck": [...], ...}
  - Template:   {"__template__": "mlb"} (or nba/nfl/nhl/wnba)
  - Omitted:    venue already seeded in DB — leave alone

Templates expand to sport-appropriate tiers with plausible section numbers.
They are intentionally broad — extra section rows that don't exist at a given
venue are harmless (never queried). Missing sections log as "unmapped" in
the scraper and can be refined with explicit mappings over time.

Idempotent: re-running replaces rows for venues in the config, does not touch
venues that are in the DB but not in the config.

Usage:
  python3 scripts/tickets-seed-venues.py              # seed
  python3 scripts/tickets-seed-venues.py --dry-run    # preview
"""
from __future__ import annotations
import json
import os
import sqlite3
import sys

NANOCLAW_ROOT = os.environ.get(
    "NANOCLAW_ROOT", os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
DB_PATH = os.environ.get(
    "TICKETS_DB",
    os.path.join(NANOCLAW_ROOT, "data/sessions/tickets/.claude/tickets.db"),
)
CONFIG_PATH = os.path.join(
    NANOCLAW_ROOT, "data/sessions/tickets/.claude/venues-config.json"
)


def expand_template(template_name: str, templates: dict) -> dict[str, list[str]]:
    """Expand a sport template into {category: [section_name, ...]}."""
    tmpl = templates.get(template_name)
    if not tmpl:
        raise ValueError(f"Unknown template: {template_name}")
    result: dict[str, list[str]] = {}
    for category, spec in tmpl.items():
        sections: list[str] = []
        if "range" in spec:
            lo, hi = spec["range"]
            sections.extend(str(n) for n in range(lo, hi + 1))
        if "letters" in spec:
            sections.extend(spec["letters"])
        if "extra" in spec:
            sections.extend(spec["extra"])
        result[category] = sections
    return result


def resolve_section_categories(venue: dict, templates: dict) -> dict[str, list[str]] | None:
    """Return {category: [sections]} or None if venue shouldn't be seeded."""
    sc = venue.get("section_categories")
    if sc is None:
        return None  # skip — already in DB
    if "__template__" in sc:
        return expand_template(sc["__template__"], templates)
    # Explicit mapping
    return {cat: list(sections) for cat, sections in sc.items()}


def main():
    dry_run = "--dry-run" in sys.argv

    with open(CONFIG_PATH) as f:
        config = json.load(f)

    templates = config.get("templates", {})
    venues = config.get("venues", [])

    if not os.path.exists(DB_PATH):
        print(f"ERROR: DB not found at {DB_PATH}", file=sys.stderr)
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS section_categories (
          venue_slug   TEXT NOT NULL,
          section_name TEXT NOT NULL,
          category     TEXT NOT NULL,
          PRIMARY KEY (venue_slug, section_name)
        )
    """)

    total_inserts = 0
    venues_touched = 0
    venues_skipped = 0

    for venue in venues:
        slug = venue["slug"]
        categories = resolve_section_categories(venue, templates)
        if categories is None:
            venues_skipped += 1
            continue

        # Wipe this venue's existing rows so we can fully replace them.
        # (Safe: we're only touching venues explicitly listed in the config.)
        if not dry_run:
            conn.execute(
                "DELETE FROM section_categories WHERE venue_slug = ?", (slug,)
            )

        inserts = 0
        for category, sections in categories.items():
            for section in sections:
                inserts += 1
                if dry_run:
                    continue
                conn.execute(
                    """INSERT OR REPLACE INTO section_categories
                       (venue_slug, section_name, category)
                       VALUES (?, ?, ?)""",
                    (slug, section, category),
                )
        if inserts:
            venues_touched += 1
            total_inserts += inserts
            print(f"  {slug}: {inserts} sections across {len(categories)} categories")

    if not dry_run:
        conn.commit()
    conn.close()

    action = "Would insert" if dry_run else "Inserted"
    print(
        f"\n{action} {total_inserts} rows across {venues_touched} venues "
        f"({venues_skipped} venues skipped — already in DB)"
    )


if __name__ == "__main__":
    main()
