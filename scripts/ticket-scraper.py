#!/usr/bin/env python3
from __future__ import annotations
"""
StubHub ticket price scraper for NanoClaw.

Fetches prices for active events via HTTP (no browser needed), extracts
per-section pricing from embedded HTML data, aggregates by ticket category,
and writes snapshots to tickets.db.

Usage (inside container):
  python3 /home/node/nanoclaw/scripts/ticket-scraper.py

Usage (host-side, for testing):
  python3 scripts/ticket-scraper.py

Outputs JSON summary to stdout for the calling agent to parse.
"""
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

# DB path: inside container it's /home/node/.claude/tickets.db
# On host, fall back to the tickets group's session dir.
NANOCLAW_ROOT = os.environ.get(
    "NANOCLAW_ROOT", os.path.join(os.path.dirname(__file__), "..")
)
DB_PATH = os.environ.get(
    "TICKETS_DB",
    os.path.join(NANOCLAW_ROOT, "data/sessions/tickets/.claude/tickets.db"),
)
# Inside container, .claude is at /home/node/.claude
if os.path.exists("/home/node/.claude/tickets.db"):
    DB_PATH = "/home/node/.claude/tickets.db"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/131.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# Scrape tier: how often to poll based on hours until event
TIERS = [
    (6, 10),        # <6h: every 10 min
    (24, 30),       # 6-24h: every 30 min
    (48, 60),       # 24-48h: every 1h
    (168, 120),     # 2-7d: every 2h
    (720, 360),     # 7-30d: every 6h
    (2160, 1440),   # 30-90d: every 24h
    (float("inf"), 10080),  # >90d: weekly
]


def get_poll_interval_minutes(hours_until: float) -> int:
    """Return the polling interval in minutes based on hours until event."""
    for threshold, interval in TIERS:
        if hours_until < threshold:
            return interval
    return 10080


def get_due_events(conn: sqlite3.Connection) -> list[dict]:
    """Find active events that are due for a price check."""
    now = datetime.now(timezone.utc)
    # Exclude events currently in WAF cooldown. After N consecutive WAF blocks
    # the scraper sets waf_muted_until to skip them for a few hours, so one
    # consistently-blocked URL can't permanently block the catch-up queue.
    rows = conn.execute("""
        SELECT e.id, e.team_slug, e.venue_slug, e.stubhub_url, e.event_datetime, e.title,
               MAX(ps.polled_at) as last_polled
        FROM events e
        LEFT JOIN price_snapshots ps ON e.id = ps.event_id
        WHERE e.status != 'completed'
          AND (datetime(e.event_datetime) > datetime('now') OR e.event_datetime IS NULL)
          AND (e.waf_muted_until IS NULL OR datetime(e.waf_muted_until) <= datetime('now'))
        GROUP BY e.id
        ORDER BY datetime(e.event_datetime)
    """).fetchall()

    due = []
    for eid, team, venue_slug, url, event_dt, title, last_polled in rows:
        if not url:
            continue

        # NULL dates (e.g., Jets TBD games) treated as far-out → weekly tier
        if not event_dt:
            hours_until = 99999.0
        else:
            try:
                evt_time = datetime.fromisoformat(event_dt.replace("Z", "+00:00"))
            except ValueError:
                evt_time = datetime.fromisoformat(event_dt).replace(tzinfo=timezone.utc)
            if evt_time.tzinfo is None:
                evt_time = evt_time.replace(tzinfo=timezone.utc)
            hours_until = (evt_time - now).total_seconds() / 3600
            if hours_until < 0:
                continue

        interval = get_poll_interval_minutes(hours_until)

        if last_polled:
            # Handle various timezone formats: "...Z", "...+00:00", "...+00:00Z"
            cleaned = last_polled.replace("Z", "")
            if "+" not in cleaned and "-" not in cleaned[10:]:
                cleaned += "+00:00"
            last_time = datetime.fromisoformat(cleaned)
            if last_time.tzinfo is None:
                last_time = last_time.replace(tzinfo=timezone.utc)
            minutes_since = (now - last_time).total_seconds() / 60
            if minutes_since < interval:
                continue

        if last_polled:
            overdue_ratio = minutes_since / interval
        else:
            overdue_ratio = float("inf")

        due.append({
            "id": eid,
            "team_slug": team,
            "venue_slug": venue_slug,
            "url": url,
            "title": title,
            "hours_until": hours_until,
            "days_until": hours_until / 24,
            "overdue_ratio": overdue_ratio,
        })

    # Cap per run to avoid WAF throttling. We split the budget so close games
    # always get first cut (CLOSE_RESERVE slots, sorted by hours_until ASC) and
    # the remainder is reserved for catch-up — most-overdue events first
    # (overdue_ratio = minutes_since_last_poll / tier_interval). This stops far
    # events from starving when the front of the queue is full of recurring
    # close games.
    PER_RUN_CAP = 7
    CLOSE_RESERVE = 5

    by_close = sorted(due, key=lambda e: e["hours_until"])
    close_picks = by_close[:CLOSE_RESERVE]
    close_ids = {e["id"] for e in close_picks}
    catchup = sorted(
        (e for e in due if e["id"] not in close_ids),
        key=lambda e: e["overdue_ratio"],
        reverse=True,
    )
    catchup_picks = catchup[: PER_RUN_CAP - len(close_picks)]
    capped = close_picks + catchup_picks
    total_due = len(due)

    if capped:
        games = ", ".join(
            f"{e['title'][:28]} ({e['hours_until']:.0f}h{', overdue ' + format(e['overdue_ratio'], '.1f') + 'x' if e['overdue_ratio'] > 5 else ''})"
            for e in capped
        )
        print(
            f"Scraping {len(capped)}/{total_due} due games "
            f"({len(close_picks)} closest + {len(catchup_picks)} catch-up): {games}",
            file=sys.stderr,
        )

    return capped


def fetch_event_prices(url: str) -> dict | None:
    """
    Fetch a StubHub event page and extract:
    - lowPrice from JSON-LD (global minimum)
    - totalListings from embedded data
    - per-section prices from sourceRowKey + rawMinPrice
    - sectionId → sectionName mapping

    Returns dict with keys: low_price, total_listings, section_prices
    or None on failure.
    """
    full_url = url if "?" in url else url + "?quantity=2"
    if "quantity=" not in full_url:
        full_url += "&quantity=2" if "?" in full_url else "?quantity=2"

    req = urllib.request.Request(full_url, headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"error": "404", "detail": "Event page not found on StubHub"}
        return {"error": str(e.code), "detail": str(e.reason)}
    except Exception as e:
        return {"error": "network", "detail": str(e)}

    # WAF check: blocked pages are tiny
    if len(html) < 10000:
        return {"error": "waf", "detail": f"Page too small ({len(html)} bytes), likely WAF block"}

    result = {"low_price": None, "total_listings": None, "section_prices": {}}

    # Extract lowPrice from JSON-LD
    ld_blocks = re.findall(
        r'<script[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>',
        html, re.DOTALL,
    )
    for block in ld_blocks:
        try:
            data = json.loads(block.strip())
            offers = data.get("offers", {})
            if offers.get("lowPrice"):
                result["low_price"] = float(offers["lowPrice"])
        except (json.JSONDecodeError, ValueError):
            pass

    # Search ALL script blocks for listing data (not just the biggest —
    # different venues put data in different scripts)
    scripts = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL)
    all_scripts = "\n".join(scripts)

    # Extract totalListings
    tl_match = re.search(r'"totalListings"\s*:\s*(\d+)', all_scripts)
    if tl_match:
        result["total_listings"] = int(tl_match.group(1))

    # Build sectionId → sectionName map
    section_names = {}
    for m in re.finditer(
        r'"sectionId"\s*:\s*(\d+)\s*,\s*"sectionName"\s*:\s*"([^"]*)"', all_scripts
    ):
        section_names[m.group(1)] = m.group(2)

    # Extract per-row prices via sourceRowKey (format: venueConfigId_sectionId_rowId)
    # Match sourceRowKey and rawMinPrice separately, then pair by proximity.
    section_min_prices: dict[str, float] = {}
    for m in re.finditer(r'"sourceRowKey"\s*:\s*"\d+_(\d+)_\d+"', all_scripts):
        sec_id = m.group(1)
        # Look for rawMinPrice within the next 500 chars
        chunk = all_scripts[m.end() : m.end() + 500]
        price_match = re.search(r'"rawMinPrice"\s*:\s*(\d+\.?\d*)', chunk)
        if not price_match:
            continue
        price = float(price_match.group(1))
        sec_name = section_names.get(sec_id)
        if sec_name:
            if sec_name not in section_min_prices or price < section_min_prices[sec_name]:
                section_min_prices[sec_name] = price

    result["section_prices"] = section_min_prices
    return result


# "Cheap-end mixed-bag" categories: StubHub uses one section label to cover
# both real GA inventory and premium variants (suite passes, multi-game
# packages, hospitality bundles). When the cheap listings sell out, the only
# remaining listing in the category can spike 10-50× the real GA price, so
# we drop those snapshots rather than record fake floors.
#
# Members: cheap GA standing room (Yankees Pinstripe Pass, Fenway SRRD,
# generic GA), Fenway's Monster Standing deck (SRGM contaminated by
# premium variants), and World Cup national-team Supporters tiers (Value
# tier sells out → Premium Tier becomes the floor).
#
# Premium-by-design categories (Monster Seated, Floor/Courtside, Diamond
# Club, Crown Club, Chop House, Premium, etc.) are NOT in this set — they
# are supposed to be expensive.
SR_LIKE_CATEGORIES = {
    "Standing Room",
    "General Admission",
    "Supporters",
    "Monster Standing",
}
SR_OUTLIER_RATIO = 5.0

# Pattern-based category fallbacks. When a section_name has no explicit
# venue mapping, try these regexes (in order) before treating it as unmapped.
# First match wins. Used for tournament-style sections (World Cup national
# supporter blocks) whose team names change as the bracket fills, so a static
# enumeration in venues-config.json would go stale.
PATTERN_CATEGORY_FALLBACKS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bSupporters\b", re.IGNORECASE), "Supporters"),
]


def aggregate_by_category(
    conn: sqlite3.Connection,
    venue_slug: str,
    section_prices: dict[str, float],
) -> dict[str, dict]:
    """
    Map section prices to categories and compute per-category min price.
    Returns {category: {"lowest_price": float, "section_count": int, "best_section": str}}
    """
    if not venue_slug:
        return {}
    cat_map = dict(
        conn.execute(
            "SELECT section_name, category FROM section_categories WHERE venue_slug = ?",
            (venue_slug,),
        ).fetchall()
    )

    categories: dict[str, dict] = {}
    unmapped = []

    for section, price in section_prices.items():
        cat = cat_map.get(section)
        if not cat:
            for pat, fallback_cat in PATTERN_CATEGORY_FALLBACKS:
                if pat.search(section):
                    cat = fallback_cat
                    break
        if not cat:
            unmapped.append(section)
            continue
        if cat not in categories:
            categories[cat] = {"lowest_price": price, "section_count": 0, "best_section": section}
        if price < categories[cat]["lowest_price"]:
            categories[cat]["lowest_price"] = price
            categories[cat]["best_section"] = section
        categories[cat]["section_count"] += 1

    if unmapped:
        print(f"  Warning: {len(unmapped)} unmapped sections: {unmapped}", file=sys.stderr)

    # Drop SR/GA categories whose lowest_price exceeds SR_OUTLIER_RATIO * the
    # cheapest seated category. See SR_LIKE_CATEGORIES comment above.
    sr_in_play = SR_LIKE_CATEGORIES & categories.keys()
    others = {c: d for c, d in categories.items() if c not in SR_LIKE_CATEGORIES}
    if sr_in_play and others:
        cheapest_other = min(d["lowest_price"] for d in others.values())
        for sr_cat in list(sr_in_play):
            if categories[sr_cat]["lowest_price"] > SR_OUTLIER_RATIO * cheapest_other:
                print(
                    f"  Dropping outlier {sr_cat} ${categories[sr_cat]['lowest_price']:.0f} "
                    f"({categories[sr_cat]['lowest_price']/cheapest_other:.0f}x cheapest seated ${cheapest_other:.0f})",
                    file=sys.stderr,
                )
                del categories[sr_cat]

    return categories


def update_weather(conn: sqlite3.Connection) -> int:
    """
    Fetch weather forecasts from Open-Meteo for outdoor events within the
    next 7 days. Updates weather columns on the events table. Uses venue
    coordinates (from venues-config.json) so away games get the correct
    city's forecast.
    Returns count of events updated.
    """
    venues = load_venues()
    outdoor_venues = {
        v["slug"]: v for v in venues
        if not v.get("indoor", False) and v.get("latitude")
    }
    if not outdoor_venues:
        return 0

    now = datetime.now(timezone.utc)
    now_iso = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    cutoff = now + timedelta(days=7)
    cutoff_iso = cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")

    # Refresh weather for every outdoor event in the next 7 days every run.
    # Open-Meteo's underlying model only updates every 6-12h, so most calls
    # return the same numbers — but snapshotting always-fresh values is what
    # we want for the per-snapshot weather column. Free tier (~10K calls/day)
    # easily accommodates ~5-10 venues × 48 runs/day = ~240-480 calls.
    events = conn.execute("""
        SELECT id, venue_slug, event_datetime FROM events
        WHERE status != 'completed'
          AND event_datetime IS NOT NULL
          AND datetime(event_datetime) <= datetime(?)
          AND datetime(event_datetime) > datetime('now')
          AND venue_slug IN ({})
    """.format(",".join(f"'{s}'" for s in outdoor_venues)), (cutoff_iso,)).fetchall()

    if not events:
        return 0

    # Group events by venue (one API call per venue)
    by_venue: dict[str, list] = {}
    for eid, venue_slug, event_dt in events:
        if venue_slug not in by_venue:
            by_venue[venue_slug] = []
        by_venue[venue_slug].append((eid, event_dt))

    updated = 0
    for venue_slug, venue_events in by_venue.items():
        venue = outdoor_venues[venue_slug]
        lat = venue["latitude"]
        lon = venue["longitude"]

        url = (
            f"https://api.open-meteo.com/v1/forecast"
            f"?latitude={lat}&longitude={lon}"
            f"&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max"
            f"&forecast_days=7&temperature_unit=fahrenheit&timezone=auto"
        )

        try:
            req = urllib.request.Request(url)
            with urllib.request.urlopen(req, timeout=10) as resp:
                forecast = json.loads(resp.read().decode("utf-8"))
        except Exception:
            continue

        daily = forecast.get("daily", {})
        dates = daily.get("time", [])
        highs = daily.get("temperature_2m_max", [])
        lows = daily.get("temperature_2m_min", [])
        precip = daily.get("precipitation_probability_max", [])

        # Build date → weather map
        weather_map = {}
        for i, d in enumerate(dates):
            weather_map[d] = {
                "high": highs[i] if i < len(highs) else None,
                "low": lows[i] if i < len(lows) else None,
                "precip": precip[i] if i < len(precip) else None,
            }

        for eid, event_dt in venue_events:
            event_date = event_dt[:10]
            w = weather_map.get(event_date)
            if w:
                conn.execute("""
                    UPDATE events
                    SET weather_high = ?, weather_low = ?, weather_precip_pct = ?,
                        weather_updated_at = ?
                    WHERE id = ?
                """, (w["high"], w["low"], w["precip"], now_iso, eid))
                updated += 1

    conn.commit()
    return updated


def load_teams() -> list[dict]:
    """Load team config from the tickets group .claude/ directory."""
    # Inside container: /home/node/.claude/tickets-config.json
    # On host: data/sessions/tickets/.claude/tickets-config.json
    config_path = os.path.join(os.path.dirname(DB_PATH), "tickets-config.json")
    try:
        with open(config_path) as f:
            return json.load(f).get("teams", [])
    except Exception:
        return []


def load_venues() -> list[dict]:
    """Load venues registry from the tickets group .claude/ directory."""
    config_path = os.path.join(os.path.dirname(DB_PATH), "venues-config.json")
    try:
        with open(config_path) as f:
            return json.load(f).get("venues", [])
    except Exception:
        return []


def mark_completed_events(conn: sqlite3.Connection) -> int:
    """Mark past events as completed. Returns count of events archived.

    Includes pending events: a pending event that's already past its start
    time will never go active (StubHub never published a listing page for it),
    so it should be archived too.
    """
    cur = conn.execute("""
        UPDATE events SET status = 'completed'
        WHERE datetime(event_datetime) < datetime('now') AND status IN ('active', 'pending')
    """)
    conn.commit()
    return cur.rowcount


def main():
    if not os.path.exists(DB_PATH):
        print(json.dumps({"error": f"DB not found at {DB_PATH}"}))
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Archive completed events
    completed = mark_completed_events(conn)

    # Update weather BEFORE the scrape loop so each new price snapshot can be
    # written alongside the freshest forecast. (Prior order updated weather at
    # the end, leaving snapshots tagged with the previous run's forecast.)
    weather_updated = update_weather(conn)

    # Find due events
    due = get_due_events(conn)

    summary = {
        "timestamp": now_iso,
        "completed_events": completed,
        "due_count": len(due),
        "scraped": 0,
        "skipped_not_due": 0,
        "errors": 0,
        "error_details": [],
        "results": [],
        "weather_updated": weather_updated,
    }

    if not due:
        print(json.dumps(summary))
        conn.close()
        return

    REQUEST_DELAY = 7  # seconds between requests to avoid WAF (bumped 5→7 after cap=10 raised WAF rate)
    # After this many consecutive WAF blocks on the same event, mute it for
    # WAF_COOLDOWN_HOURS so the catch-up queue isn't permanently blocked by
    # one bad URL. Resets to 0 on any successful scrape.
    WAF_FAIL_THRESHOLD = 3
    WAF_COOLDOWN_HOURS = 6

    def record_waf_failure(event_id: int) -> None:
        new_count = (conn.execute(
            "SELECT consecutive_waf_count FROM events WHERE id = ?", (event_id,)
        ).fetchone() or [0])[0] + 1
        if new_count >= WAF_FAIL_THRESHOLD:
            mute_until = (datetime.now(timezone.utc) + timedelta(hours=WAF_COOLDOWN_HOURS)).strftime("%Y-%m-%dT%H:%M:%SZ")
            conn.execute(
                "UPDATE events SET consecutive_waf_count = ?, waf_muted_until = ? WHERE id = ?",
                (new_count, mute_until, event_id),
            )
        else:
            conn.execute(
                "UPDATE events SET consecutive_waf_count = ? WHERE id = ?",
                (new_count, event_id),
            )

    def record_scrape_success(event_id: int) -> None:
        conn.execute(
            "UPDATE events SET consecutive_waf_count = 0, waf_muted_until = NULL WHERE id = ?",
            (event_id,),
        )

    for i, event in enumerate(due):
        eid = event["id"]
        team = event["team_slug"]
        title = event["title"] or f"Event {eid}"

        if i > 0:
            time.sleep(REQUEST_DELAY)

        prices = fetch_event_prices(event["url"])

        if prices is None or "error" in prices:
            summary["errors"] += 1
            detail = prices.get("detail", "unknown") if prices else "fetch returned None"
            err_type = prices.get("error", "unknown") if prices else "unknown"
            summary["error_details"].append({
                "event_id": eid,
                "title": title,
                "error": err_type,
                "detail": detail,
            })
            # 404 means event not on StubHub yet — flip to pending
            if prices and prices.get("error") == "404":
                conn.execute(
                    "UPDATE events SET status = 'pending' WHERE id = ?", (eid,)
                )
                conn.commit()
            # WAF or network errors: bump the fail counter; auto-mute after threshold
            elif err_type in ("waf", "network") or err_type.startswith("5"):
                record_waf_failure(eid)
                conn.commit()
            continue

        section_prices = prices.get("section_prices", {})
        categories = aggregate_by_category(conn, event.get("venue_slug"), section_prices)

        if not categories:
            # No per-category data — skip this event entirely.
            # Don't write partial "Overall" data; try again next run.
            summary["errors"] += 1
            summary["error_details"].append({
                "event_id": eid,
                "title": title,
                "error": "no_sections",
                "detail": "Page loaded but no per-section pricing extracted (likely WAF or missing section data)",
            })
            # Treat no_sections like WAF for cooldown — usually a tiny placeholder page
            record_waf_failure(eid)
            conn.commit()
            continue

        # Successful scrape — clear cooldown / fail counter and flip status
        record_scrape_success(eid)
        conn.execute(
            "UPDATE events SET status = 'active' WHERE id = ? AND status = 'pending'",
            (eid,),
        )

        # Snapshot the event's current weather alongside the price reading so
        # historical correlations between forecast and price are preserved.
        # NULL for indoor venues / events outside the 7-day forecast window.
        weather_row = conn.execute(
            "SELECT weather_high, weather_low, weather_precip_pct FROM events WHERE id = ?",
            (eid,),
        ).fetchone() or (None, None, None)

        # Write snapshots — one row per category
        for cat, data in categories.items():
            conn.execute(
                """INSERT INTO price_snapshots
                   (event_id, category, polled_at, days_until, hours_until,
                    lowest_price, listing_count, best_section,
                    weather_high, weather_low, weather_precip_pct)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    eid,
                    cat,
                    now_iso,
                    round(event["days_until"], 2),
                    round(event["hours_until"], 2),
                    data["lowest_price"],
                    prices.get("total_listings"),
                    data.get("best_section"),
                    weather_row[0],
                    weather_row[1],
                    weather_row[2],
                ),
            )

        conn.commit()
        summary["scraped"] += 1
        summary["results"].append({
            "event_id": eid,
            "title": title,
            "hours_until": round(event["hours_until"], 1),
            "categories": {
                cat: {"price": round(data["lowest_price"], 2), "section": data.get("best_section")}
                for cat, data in sorted(categories.items(), key=lambda x: x[1]["lowest_price"])
            },
            "total_listings": prices.get("total_listings"),
        })

    print(json.dumps(summary))
    conn.close()


if __name__ == "__main__":
    main()
