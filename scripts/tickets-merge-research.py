#!/usr/bin/env python3
"""
Merges stadium research JSON files from /tmp/venues-research/ into
venues-config.json, replacing __template__ section_categories with the
researched explicit section lists.

Idempotent: re-running with the same inputs produces the same output.
"""
from __future__ import annotations
import json
import os
import sys

NANOCLAW_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(
    NANOCLAW_ROOT, "data/sessions/tickets/.claude/venues-config.json"
)
RESEARCH_DIR = "/tmp/venues-research"


def main():
    with open(CONFIG_PATH) as f:
        config = json.load(f)

    # Load all research files
    research: dict[str, dict] = {}
    for fname in sorted(os.listdir(RESEARCH_DIR)):
        if not fname.endswith(".json"):
            continue
        with open(os.path.join(RESEARCH_DIR, fname)) as f:
            data = json.load(f)
        for slug, venue_data in data.items():
            research[slug] = venue_data

    print(f"Loaded {len(research)} venues from research files")

    updated = 0
    skipped = 0
    missing = []

    for venue in config.get("venues", []):
        slug = venue["slug"]
        if slug in research:
            r = research[slug]
            if "description" in r and r["description"]:
                venue["description"] = r["description"]
            if "section_categories" in r:
                venue["section_categories"] = r["section_categories"]
                updated += 1
        else:
            # Venue wasn't in research; leave as-is (already-curated home venues)
            if venue.get("section_categories", {}).get("__template__"):
                missing.append(slug)
            skipped += 1

    with open(CONFIG_PATH, "w") as f:
        json.dump(config, f, indent=2, ensure_ascii=False)
        f.write("\n")

    print(f"Updated {updated} venues, skipped {skipped}")
    if missing:
        print(f"WARNING: {len(missing)} venues still have __template__ (not researched): {missing}", file=sys.stderr)


if __name__ == "__main__":
    main()
