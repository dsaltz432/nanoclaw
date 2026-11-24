#!/usr/bin/env python3
from __future__ import annotations
"""
StubHub ticket price scraper for NanoClaw (DataDome-aware).

StubHub sits behind DataDome, so plain HTTP requests get 403'd. This script:
  - Runs a headless Playwright warmup before each scrape session (homepage +
    a team page) to earn a valid DataDome cookie. Retries once, and falls
    back to the cookie persisted at COOKIE_STORE_PATH if both attempts fail.
  - Fetches event pages with curl_cffi impersonating Chrome 131, so the TLS
    handshake and HTTP/2 frame ordering match the browser that minted the
    cookie.
  - Keeps ONE DataDome identity across runs (2026-11-24): the warmup is
    seeded with the persisted cookies, and is skipped entirely while the last
    warmup is < COOKIE_REUSE_MAX_AGE_MIN old (cookie_source "reused"). A 403
    on a reused cookie triggers one seeded warmup + retry. Two blocked fetches
    in a row end the run early (aborted_after_block). Before this, every run
    was a new cookieless visitor and every other run got 403'd.

DO NOT "fix" the Chrome/126 User-Agent in HEADERS to match impersonate=
"chrome131". It looks like an inconsistency and it is not. Measured
2026-08-25, both orderings, same event URL:
    UA Chrome/126 + impersonate chrome131 -> HTTP 200 (~750 KB)
    UA Chrome/131 + impersonate chrome131 -> HTTP 403 (774 B)
Changing it to 131 takes the scrape success rate to zero.

Tier logic, WAF muting, category aggregation, DB writes, weather and section
categories are unchanged from the pre-DataDome version.

See data/sessions/tickets/.claude/scraping-notes.md for the full history of
what was tried and why this is the surviving approach.
"""
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone

try:
    from curl_cffi import requests as curl_requests
except ImportError:  # host-side helpers import this module without curl_cffi
    curl_requests = None

# DB path: inside container it's /home/node/.claude/tickets.db
NANOCLAW_ROOT = os.environ.get(
    "NANOCLAW_ROOT", os.path.join(os.path.dirname(__file__), "..")
)
DB_PATH = os.environ.get(
    "TICKETS_DB",
    os.path.join(NANOCLAW_ROOT, "data/sessions/tickets/.claude/tickets.db"),
)
if os.path.exists("/home/node/.claude/tickets.db"):
    DB_PATH = "/home/node/.claude/tickets.db"

COOKIE_STORE_PATH = os.path.join(
    os.path.dirname(DB_PATH), "stubhub-cookies.json"
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

# Module-level cookie dict populated by refresh_cookies_via_playwright()
_session_cookies: dict = {}
# Set when an event fetch returned a newer datadome cookie; saved at run end.
_cookies_rotated = False

# Reuse the persisted cookie instead of running the Playwright warmup while
# the last warmup is younger than this. A 403 on the reused cookie triggers a
# (seeded) warmup and one retry, so a dead cookie costs one request.
COOKIE_REUSE_MAX_AGE_MIN = 120

# Stop the run after this many consecutive blocked fetches (403/429/WAF page).
# A blocked run is all-or-nothing in practice; firing the rest at 7s spacing
# only adds load while the IP's budget is already spent.
BLOCK_ABORT_AFTER = 2
BLOCK_ERRORS = {"403", "429", "waf"}

# Scrape tier: how often to poll based on hours until event
# Minutes of slack on each tier interval; see get_due_events.
POLL_GRACE_MIN = 5

TIERS = [
    (6, 10),        # <6h: every 10 min
    (24, 30),       # 6-24h: every 30 min
    (48, 60),       # 24-48h: every 1h
    (168, 120),     # 2-7d: every 2h
    (720, 360),     # 7-30d: every 6h
    (2160, 1440),   # 30-90d: every 24h
    (float("inf"), 10080),  # >90d: weekly
]


# ---------------------------------------------------------------------------
# Cookie management
# ---------------------------------------------------------------------------

def load_cookie_store() -> tuple[dict, datetime | None]:
    """Persisted cookies plus when the Playwright warmup last ran.
    ({}, None) on any failure."""
    try:
        with open(COOKIE_STORE_PATH) as f:
            data = json.load(f)
    except Exception:
        return {}, None
    acquired = None
    try:
        acquired = datetime.strptime(
            data.get("acquired_at", ""), "%Y-%m-%dT%H:%M:%SZ"
        ).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        pass
    return data.get("cookies", {}) or {}, acquired


def load_cookies() -> dict:
    """Load persisted cookies from disk. Returns empty dict on any failure."""
    return load_cookie_store()[0]


def save_cookies(cookies: dict, acquired_at: str | None = None) -> None:
    """Persist cookies to disk. acquired_at is the time of the last Playwright
    warmup; pass the old value through when only DataDome rotated the cookie
    on an event fetch, so the warmup age keeps counting."""
    data = {
        "cookies": cookies,
        "acquired_at": acquired_at
        or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    os.makedirs(os.path.dirname(COOKIE_STORE_PATH), exist_ok=True)
    with open(COOKIE_STORE_PATH, "w") as f:
        json.dump(data, f)


def refresh_cookies_via_playwright(seed: dict | None = None) -> dict:
    """
    Launch a headless Chromium session, visit StubHub homepage + Yankees
    team page to acquire a validated DataDome cookie, then save and return
    the full cookie dict.

    seed: cookies from the previous session, loaded into the browser first so
    the warmup refreshes the SAME DataDome identity instead of minting a new
    visitor. Until 2026-11-24 every run started cookieless, i.e. a brand-new
    device from the same IP every 30 min, and from Nov 9 every other run was
    403'd. See scraping-notes.md, "Nov 2026: alternating 403s".

    Returns empty dict on failure (scraper falls back to cookieless requests).
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("  Warning: playwright not installed, skipping cookie refresh", file=sys.stderr)
        return {}

    print("  Refreshing StubHub cookies via Playwright...", file=sys.stderr)
    t0 = time.time()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                executable_path="/usr/bin/chromium",
                args=[
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-blink-features=AutomationControlled",
                ],
            )
            ctx = browser.new_context(
                user_agent=HEADERS["User-Agent"],
                viewport={"width": 1280, "height": 800},
                locale="en-US",
            )
            if seed:
                try:
                    ctx.add_cookies([
                        {"name": k, "value": v, "domain": ".stubhub.com", "path": "/"}
                        for k, v in seed.items()
                    ])
                except Exception as e:  # a bad seed must not cost the warmup
                    print(f"  Warning: could not seed cookies: {e}", file=sys.stderr)
            page = ctx.new_page()
            page.add_init_script(
                "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
            )

            page.goto(
                "https://www.stubhub.com/",
                wait_until="domcontentloaded",
                timeout=30000,
            )
            time.sleep(2)
            page.goto(
                "https://www.stubhub.com/new-york-yankees-tickets/",
                wait_until="domcontentloaded",
                timeout=30000,
            )
            time.sleep(2)

            raw = ctx.cookies()
            # Keep all stubhub.com cookies (DataDome, session, auth tokens)
            cookies = {
                c["name"]: c["value"]
                for c in raw
                if "stubhub" in c.get("domain", "")
            }
            browser.close()

        elapsed = time.time() - t0
        has_dd = "datadome" in cookies
        print(
            f"  Cookie refresh done ({elapsed:.1f}s): {len(cookies)} cookies, "
            f"datadome={'yes' if has_dd else 'MISSING'}",
            file=sys.stderr,
        )
        if cookies:
            # Persisting is a best-effort cache write. A failure here (missing
            # dir, read-only mount) must never discard a cookie we just earned.
            try:
                save_cookies(cookies)
            except Exception as e:
                print(f"  Warning: could not persist cookies: {e}", file=sys.stderr)
        return cookies

    except Exception as e:
        print(f"  Cookie refresh failed: {e}", file=sys.stderr)
        return {}


# ---------------------------------------------------------------------------
# Scrape tier / due-event logic (unchanged from original)
# ---------------------------------------------------------------------------

def get_poll_interval_minutes(hours_until: float) -> int:
    for threshold, interval in TIERS:
        if hours_until < threshold:
            return interval
    return 10080


def get_due_events(conn: sqlite3.Connection) -> list[dict]:
    now = datetime.now(timezone.utc)
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
            cleaned = last_polled.replace("Z", "")
            if "+" not in cleaned and "-" not in cleaned[10:]:
                cleaned += "+00:00"
            last_time = datetime.fromisoformat(cleaned)
            if last_time.tzinfo is None:
                last_time = last_time.replace(tzinfo=timezone.utc)
            minutes_since = (now - last_time).total_seconds() / 60
            # Grace: runs fire on the :00/:30 clock but polled_at is stamped
            # a little after the run starts (warmup + fetch). Without slack an
            # event polled at :00:40 is 20s short of due at the next :00:01
            # tick and waits an extra 30 min every cycle — 60-min tier events
            # were being polled every 90. (2026-11-24, when the pricer moved
            # from an agent task to scripts/tickets-pricer.py.)
            if minutes_since < interval - POLL_GRACE_MIN:
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


# ---------------------------------------------------------------------------
# Fetch — curl_cffi with DataDome cookies + Chrome TLS fingerprint
# ---------------------------------------------------------------------------

def fetch_event_prices(url: str) -> dict | None:
    """
    Fetch a StubHub event page and extract per-section pricing.
    Uses curl_cffi with Chrome 131 TLS impersonation and the DataDome
    cookie acquired by refresh_cookies_via_playwright().
    """
    full_url = url if "?" in url else url + "?quantity=2"
    if "quantity=" not in full_url:
        full_url += "&quantity=2" if "?" in full_url else "?quantity=2"

    if curl_requests is None:
        return {"error": "network", "detail": "curl_cffi not installed"}

    try:
        resp = curl_requests.get(
            full_url,
            impersonate="chrome131",
            cookies=_session_cookies,
            headers=HEADERS,
            timeout=20,
        )
        if resp.status_code == 404:
            return {"error": "404", "detail": "Event page not found on StubHub"}
        if resp.status_code != 200:
            return {"error": str(resp.status_code), "detail": f"HTTP {resp.status_code}"}
        html = resp.text
        # DataDome rotates its cookie via Set-Cookie on good responses; keep
        # the newest one like a browser would. Only from a 200: the cookie on
        # a 403 is a challenge cookie and must not replace a working one.
        global _cookies_rotated
        try:
            new_dd = resp.cookies.get("datadome")
        except Exception:  # e.g. CookieConflict across domains
            new_dd = None
        if new_dd and new_dd != _session_cookies.get("datadome"):
            _session_cookies["datadome"] = new_dd
            _cookies_rotated = True
    except Exception as e:
        return {"error": "network", "detail": str(e)}

    # DataDome / WAF check: real pages are large
    if len(html) < 10000:
        return {"error": "waf", "detail": f"Page too small ({len(html)} bytes), likely WAF block"}

    result = {"low_price": None, "total_listings": None, "section_prices": {}}

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

    scripts = re.findall(r'<script[^>]*>(.*?)</script>', html, re.DOTALL)
    all_scripts = "\n".join(scripts)

    tl_match = re.search(r'"totalListings"\s*:\s*(\d+)', all_scripts)
    if tl_match:
        result["total_listings"] = int(tl_match.group(1))

    section_names = {}
    for m in re.finditer(
        r'"sectionId"\s*:\s*(\d+)\s*,\s*"sectionName"\s*:\s*"([^"]*)"', all_scripts
    ):
        section_names[m.group(1)] = m.group(2)

    section_min_prices: dict[str, float] = {}
    for m in re.finditer(r'"sourceRowKey"\s*:\s*"\d+_(\d+)_\d+"', all_scripts):
        sec_id = m.group(1)
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


# ---------------------------------------------------------------------------
# Category aggregation (unchanged)
# ---------------------------------------------------------------------------

SR_LIKE_CATEGORIES = {
    "Standing Room",
    "General Admission",
    "Supporters",
    "Monster Standing",
}
SR_OUTLIER_RATIO = 5.0

PATTERN_CATEGORY_FALLBACKS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\bSupporters\b", re.IGNORECASE), "Supporters"),
]


def aggregate_by_category(
    conn: sqlite3.Connection,
    venue_slug: str,
    section_prices: dict[str, float],
) -> dict[str, dict]:
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


# ---------------------------------------------------------------------------
# Weather (unchanged)
# ---------------------------------------------------------------------------

def update_weather(conn: sqlite3.Connection) -> int:
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
    config_path = os.path.join(os.path.dirname(DB_PATH), "tickets-config.json")
    try:
        with open(config_path) as f:
            return json.load(f).get("teams", [])
    except Exception:
        return []


def load_venues() -> list[dict]:
    config_path = os.path.join(os.path.dirname(DB_PATH), "venues-config.json")
    try:
        with open(config_path) as f:
            return json.load(f).get("venues", [])
    except Exception:
        return []


def mark_completed_events(conn: sqlite3.Connection) -> int:
    cur = conn.execute("""
        UPDATE events SET status = 'completed'
        WHERE datetime(event_datetime) < datetime('now') AND status IN ('active', 'pending')
    """)
    conn.commit()
    return cur.rowcount


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    global _session_cookies

    if not os.path.exists(DB_PATH):
        print(json.dumps({"error": f"DB not found at {DB_PATH}"}))
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    completed = mark_completed_events(conn)
    weather_updated = update_weather(conn)
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
        "cookie_refresh": False,
    }

    if not due:
        print(json.dumps(summary))
        conn.close()
        return

    stored, warmed_at = load_cookie_store()

    def warmup() -> None:
        """Seeded Playwright warmup -> _session_cookies + summary fields.
        Two attempts: the warmup is a real browser load and can time out on a
        slow page. A single blip used to leave us cookieless -> all 403s."""
        global _session_cookies
        seed = dict(_session_cookies or stored)
        fresh: dict = {}
        for attempt in (1, 2):
            fresh = refresh_cookies_via_playwright(seed=seed)
            if fresh.get("datadome"):
                break
            if attempt == 1:
                print("  Warmup produced no datadome cookie, retrying...", file=sys.stderr)
                time.sleep(5)
        summary["cookie_refresh"] = bool(fresh.get("datadome"))
        if summary["cookie_refresh"]:
            _session_cookies = fresh
            summary["cookie_source"] = "playwright"
        # Fall back to the last cookie we persisted. DataDome cookies outlive a
        # single 30-min tick, so a stale-but-valid cookie beats sending none.
        elif seed.get("datadome"):
            print("  Falling back to persisted cookies from disk", file=sys.stderr)
            _session_cookies = seed
            summary["cookie_source"] = "disk"
        else:
            _session_cookies = {}
            summary["cookie_source"] = "none"

    # Reuse the persisted DataDome identity while the last warmup is recent;
    # warm up (seeded with it) only when it is old or gets a 403.
    age_min = (
        (datetime.now(timezone.utc) - warmed_at).total_seconds() / 60
        if warmed_at else None
    )
    _session_cookies = {}
    if stored.get("datadome") and age_min is not None and age_min < COOKIE_REUSE_MAX_AGE_MIN:
        print(f"  Reusing persisted cookies (warmup {age_min:.0f} min ago)", file=sys.stderr)
        _session_cookies = dict(stored)
        summary["cookie_source"] = "reused"
    else:
        warmup()
    summary["cookie_age_min"] = round(age_min) if age_min is not None else None

    REQUEST_DELAY = 7
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

    consecutive_blocks = 0
    for i, event in enumerate(due):
        eid = event["id"]
        team = event["team_slug"]
        title = event["title"] or f"Event {eid}"

        if i > 0:
            time.sleep(REQUEST_DELAY)

        prices = fetch_event_prices(event["url"])
        blocked = bool(prices) and prices.get("error") in BLOCK_ERRORS

        # A reused cookie that gets blocked: warm up once (seeded, so the same
        # identity) and retry this event before treating it as a block.
        if blocked and summary["cookie_source"] == "reused":
            print("  Reused cookie blocked; warming up and retrying", file=sys.stderr)
            warmup()
            summary["rewarmed_after_block"] = True
            if summary["cookie_refresh"]:
                time.sleep(REQUEST_DELAY)
                prices = fetch_event_prices(event["url"])
                blocked = bool(prices) and prices.get("error") in BLOCK_ERRORS

        consecutive_blocks = consecutive_blocks + 1 if blocked else 0

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
            if prices and prices.get("error") == "404":
                conn.execute(
                    "UPDATE events SET status = 'pending' WHERE id = ?", (eid,)
                )
                conn.commit()
            elif err_type in ("waf", "network") or err_type.startswith("5"):
                record_waf_failure(eid)
                conn.commit()
            if consecutive_blocks >= BLOCK_ABORT_AFTER:
                left = len(due) - i - 1
                summary["aborted_after_block"] = True
                summary["skipped_after_block"] = left
                print(
                    f"  {consecutive_blocks} blocked fetches in a row; stopping, "
                    f"{left} event(s) left for the next run",
                    file=sys.stderr,
                )
                break
            continue

        section_prices = prices.get("section_prices", {})
        categories = aggregate_by_category(conn, event.get("venue_slug"), section_prices)

        if not categories:
            summary["errors"] += 1
            summary["error_details"].append({
                "event_id": eid,
                "title": title,
                "error": "no_sections",
                "detail": "Page loaded but no per-section pricing extracted (likely WAF or missing section data)",
            })
            record_waf_failure(eid)
            conn.commit()
            continue

        record_scrape_success(eid)
        conn.execute(
            "UPDATE events SET status = 'active' WHERE id = ? AND status = 'pending'",
            (eid,),
        )

        weather_row = conn.execute(
            "SELECT weather_high, weather_low, weather_precip_pct FROM events WHERE id = ?",
            (eid,),
        ).fetchone() or (None, None, None)

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

    # Persist a cookie DataDome rotated during the run, keeping the warmup
    # timestamp so COOKIE_REUSE_MAX_AGE_MIN still forces a periodic warmup.
    if _cookies_rotated and _session_cookies.get("datadome"):
        _, last_warm = load_cookie_store()
        try:
            save_cookies(
                _session_cookies,
                acquired_at=last_warm.strftime("%Y-%m-%dT%H:%M:%SZ") if last_warm else None,
            )
            summary["cookie_rotated"] = True
        except Exception as e:
            print(f"  Warning: could not persist rotated cookie: {e}", file=sys.stderr)

    print(json.dumps(summary))
    conn.close()


if __name__ == "__main__":
    main()
