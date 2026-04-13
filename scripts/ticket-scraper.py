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
    rows = conn.execute("""
        SELECT e.id, e.team_slug, e.stubhub_url, e.event_datetime, e.title,
               MAX(ps.polled_at) as last_polled
        FROM events e
        LEFT JOIN price_snapshots ps ON e.id = ps.event_id
        WHERE e.status != 'completed'
          AND (e.event_datetime > datetime('now') OR e.event_datetime IS NULL)
        GROUP BY e.id
        ORDER BY e.event_datetime
    """).fetchall()

    due = []
    for eid, team, url, event_dt, title, last_polled in rows:
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

        due.append({
            "id": eid,
            "team_slug": team,
            "url": url,
            "title": title,
            "hours_until": hours_until,
            "days_until": hours_until / 24,
        })

    # Sort by soonest game first, cap at 5 to avoid WAF throttling.
    # Remaining events will be picked up on the next 30-min run.
    due.sort(key=lambda e: e["hours_until"])
    return due[:5]


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


def aggregate_by_category(
    conn: sqlite3.Connection,
    team_slug: str,
    section_prices: dict[str, float],
) -> dict[str, dict]:
    """
    Map section prices to categories and compute per-category min price.
    Returns {category: {"lowest_price": float, "section_count": int, "best_section": str}}
    """
    cat_map = dict(
        conn.execute(
            "SELECT section_name, category FROM section_categories WHERE team_slug = ?",
            (team_slug,),
        ).fetchall()
    )

    categories: dict[str, dict] = {}
    unmapped = []

    for section, price in section_prices.items():
        cat = cat_map.get(section)
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

    return categories


def update_weather(conn: sqlite3.Connection) -> int:
    """
    Fetch weather forecasts from Open-Meteo for outdoor events within the
    next 7 days. Updates weather columns on the events table.
    Returns count of events updated.
    """
    teams = load_teams()
    outdoor_teams = {
        t["slug"]: t for t in teams
        if not t.get("indoor", False) and t.get("latitude")
    }
    if not outdoor_teams:
        return 0

    now = datetime.now(timezone.utc)
    cutoff = now + timedelta(days=7)
    cutoff_iso = cutoff.strftime("%Y-%m-%dT%H:%M:%SZ")

    # Find outdoor events in the next 7 days that haven't been updated today
    today = now.strftime("%Y-%m-%d")
    events = conn.execute("""
        SELECT id, team_slug, event_datetime FROM events
        WHERE status != 'completed'
          AND event_datetime IS NOT NULL
          AND event_datetime <= ?
          AND event_datetime > datetime('now')
          AND team_slug IN ({})
          AND (weather_updated_at IS NULL OR weather_updated_at < ?)
    """.format(",".join(f"'{s}'" for s in outdoor_teams)), (cutoff_iso, today)).fetchall()

    if not events:
        return 0

    # Group events by team (one API call per venue)
    by_team: dict[str, list] = {}
    for eid, team_slug, event_dt in events:
        if team_slug not in by_team:
            by_team[team_slug] = []
        by_team[team_slug].append((eid, event_dt))

    updated = 0
    for team_slug, team_events in by_team.items():
        team = outdoor_teams[team_slug]
        lat = team["latitude"]
        lon = team["longitude"]

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

        for eid, event_dt in team_events:
            event_date = event_dt[:10]
            w = weather_map.get(event_date)
            if w:
                conn.execute("""
                    UPDATE events
                    SET weather_high = ?, weather_low = ?, weather_precip_pct = ?,
                        weather_updated_at = ?
                    WHERE id = ?
                """, (w["high"], w["low"], w["precip"], today, eid))
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


def mark_completed_events(conn: sqlite3.Connection) -> int:
    """Mark past events as completed. Returns count of events archived."""
    cur = conn.execute("""
        UPDATE events SET status = 'completed'
        WHERE event_datetime < datetime('now') AND status = 'active'
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
    }

    if not due:
        # Still update weather even if no prices are due
        weather_updated = update_weather(conn)
        summary["weather_updated"] = weather_updated
        print(json.dumps(summary))
        conn.close()
        return

    REQUEST_DELAY = 5  # seconds between requests to avoid WAF

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
            continue

        section_prices = prices.get("section_prices", {})
        categories = aggregate_by_category(conn, team, section_prices)

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
            continue

        # Flip pending → active on successful scrape
        conn.execute(
            "UPDATE events SET status = 'active' WHERE id = ? AND status = 'pending'",
            (eid,),
        )

        # Write snapshots — one row per category
        for cat, data in categories.items():
            conn.execute(
                """INSERT INTO price_snapshots
                   (event_id, category, polled_at, days_until, hours_until,
                    lowest_price, listing_count, best_section)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    eid,
                    cat,
                    now_iso,
                    round(event["days_until"], 2),
                    round(event["hours_until"], 2),
                    data["lowest_price"],
                    prices.get("total_listings"),
                    data.get("best_section"),
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

    # Update weather for outdoor events in the next 7 days
    weather_updated = update_weather(conn)
    summary["weather_updated"] = weather_updated

    print(json.dumps(summary))
    conn.close()


if __name__ == "__main__":
    main()
