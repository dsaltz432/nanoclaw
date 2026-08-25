#!/usr/bin/env python3
"""
StubHub event discovery for NanoClaw (DataDome-aware).

Finds upcoming home and away events for tracked teams and inserts them into
tickets.db so the Pricer has something to poll.

Why this replaces the old agent-driven flow:
  - The previous approach drove `agent-browser`, which DataDome blocks
    outright (HTTP 403 + CAPTCHA). Playwright launched with the same stealth
    flags and User-Agent as ticket-scraper.py loads the same pages at 200.
  - Server-rendered HTML only exposes the next ~4 games; the rest hydrates
    client-side, so a plain HTTP fetch is not enough. We need a real browser.
  - The old prompt parsed card text with a date regex that no longer matches
    StubHub's current DOM, so it would have mis-parsed even when unblocked.

What it reads, and why that is stable:
  - event id + calendar date come from the URL slug
    (".../<team>-<city>-tickets-<M>-<D>-<YYYY>/event/<id>/"), which is far
    more stable than card text.
  - venue resolves from the URL's team slug via venues-config home_team_slug,
    falling back to scanning the card text for a known venue alias. The
    fallback matters for shared arenas — the Lynx play in Target Center, which
    is registered to the Timberwolves.
  - the venue's IANA tz converts the venue-local clock to true UTC. Storing
    venue-local time labeled as UTC is the exact bug tickets-backfill-event-tz.py
    had to clean up; do not reintroduce it.

Performer pages also carry a recommendation carousel of unrelated events
(other teams, esports, college football). Those cards are prefixed
"#<n> Followed Follow" and are dropped.

Usage:
  python3 scripts/tickets-discovery.py            # write to the DB
  python3 scripts/tickets-discovery.py --dry-run  # print, touch nothing
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

# Share the scraper's User-Agent. It is deliberately Chrome/126 — see the
# "DO NOT fix the User-Agent" note in ticket-scraper.py before changing it.
_SCRAPER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ticket-scraper.py")
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Safari/537.36"
)
try:
    with open(_SCRAPER) as _f:
        _m = re.search(r'"(Mozilla/5\.0[^"]*)"\s*\n\s*"([^"]*)"\s*\n\s*"([^"]*)"', _f.read())
    if _m:
        USER_AGENT = "".join(_m.groups())
except Exception:
    pass

DB_PATH = os.environ.get("TICKETS_DB")
if not DB_PATH:
    if os.path.exists("/home/node/.claude/tickets.db"):
        DB_PATH = "/home/node/.claude/tickets.db"
    else:
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
        DB_PATH = os.path.join(root, "data/sessions/tickets/.claude/tickets.db")

CONFIG_DIR = os.path.dirname(DB_PATH)

EVENT_URL_RE = re.compile(
    r"stubhub\.com/(?P<slug>[a-z0-9-]+?)-tickets-"
    r"(?P<mo>\d{1,2})-(?P<day>\d{1,2})-(?P<year>\d{4})/event/(?P<id>\d+)"
)
TIME_RE = re.compile(r"(\d{1,2}):(\d{2})\s*(AM|PM)", re.I)
CAROUSEL_RE = re.compile(r"^#\d+\s+Followed")
DATE_PREFIX_RE = re.compile(r"^[A-Z][a-z]{2}\s+\d{1,2}\s+[A-Z][a-z]{2}\s+")

# Listings that are not games.
SKIP_MARKERS = (
    "season tickets",
    "parking",
    "stadium tour",
    "hospitality",
    "pregame",
)

EXTRACT_JS = """() => {
  const seen = {}, out = [];
  document.querySelectorAll('a[href*="/event/"]').forEach(a => {
    const u = a.href.split('?')[0];
    const m = u.match(/\\/event\\/(\\d+)/);
    if (!m || seen[m[1]]) return;
    seen[m[1]] = 1;
    const card = a.closest('[class*="EventCard"],[class*="event-card"],li,article')
              || a.parentElement;
    out.push({url: u, text: (card ? card.innerText : a.innerText).replace(/\\s+/g,' ').slice(0,300)});
  });
  return out;
}"""


def load_json(name: str, key: str) -> list[dict]:
    try:
        with open(os.path.join(CONFIG_DIR, name)) as f:
            return json.load(f).get(key, [])
    except Exception as e:
        print(f"  Warning: could not read {name}: {e}", file=sys.stderr)
        return []


def build_venue_lookups(venues: list[dict]):
    by_team = {v["home_team_slug"]: v for v in venues if v.get("home_team_slug")}
    aliases = []
    for v in venues:
        for a in {v.get("name"), *(v.get("aliases") or [])}:
            if a:
                aliases.append((a.lower(), v))
    # longest alias first so "Gateway Center Arena @ College Park" wins over
    # the bare "Gateway Center Arena"
    aliases.sort(key=lambda x: -len(x[0]))
    return by_team, aliases


def resolve_venue(url_slug: str, card_text: str, by_team, aliases):
    """Venue from the URL's team slug, else by scanning text for an alias."""
    parts = url_slug.split("-")
    for n in range(len(parts), 0, -1):
        candidate = "-".join(parts[:n])
        if candidate in by_team:
            return by_team[candidate]
    low = card_text.lower()
    for alias, venue in aliases:
        if alias in low:
            return venue
    return None


def to_utc(year: int, month: int, day: int, card_text: str, tz_name: str | None) -> str | None:
    """Combine the URL's date with the card's clock time, in the venue's tz."""
    tm = TIME_RE.search(card_text)
    if not tm:
        return None
    hour, minute, mer = int(tm.group(1)), int(tm.group(2)), tm.group(3).upper()
    if mer == "PM" and hour != 12:
        hour += 12
    if mer == "AM" and hour == 12:
        hour = 0
    try:
        naive = datetime(year, month, day, hour, minute)
    except ValueError:
        return None
    if tz_name and ZoneInfo:
        try:
            local = naive.replace(tzinfo=ZoneInfo(tz_name))
            return local.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        except Exception:
            pass
    return None


def clean_title(card_text: str) -> str:
    """Take the segment before the clock time, minus the leading date tokens."""
    tm = TIME_RE.search(card_text)
    head = card_text[: tm.start()] if tm else card_text
    head = DATE_PREFIX_RE.sub("", head).strip()
    head = re.sub(r"\s+Home$", "", head).strip()
    return head[:200] or card_text[:200]


def collect_for_team(page, team: dict) -> list[dict]:
    url = team.get("stubhub_performer_url")
    if not url:
        return []
    resp = page.goto(url, wait_until="domcontentloaded", timeout=45000)
    status = resp.status if resp else 0
    if status != 200:
        print(f"  {team['slug']}: HTTP {status}", file=sys.stderr)
        return []
    time.sleep(6)  # let the grid hydrate
    for _ in range(4):
        page.mouse.wheel(0, 4000)
        time.sleep(1.5)
    return page.evaluate(EXTRACT_JS)


def main() -> None:
    dry_run = "--dry-run" in sys.argv

    if not os.path.exists(DB_PATH):
        print(json.dumps({"error": f"DB not found at {DB_PATH}"}))
        sys.exit(1)

    teams = [t for t in load_json("tickets-config.json", "teams") if t.get("enabled")]
    venues = load_json("venues-config.json", "venues")
    if not teams:
        print(json.dumps({"error": "no enabled teams in tickets-config.json"}))
        sys.exit(1)
    by_team, aliases = build_venue_lookups(venues)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print(json.dumps({"error": "playwright not installed"}))
        sys.exit(1)

    import sqlite3

    conn = sqlite3.connect(DB_PATH)
    summary = {
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "dry_run": dry_run,
        "teams": [],
        "inserted": 0,
        "already_known": 0,
        "unresolved_venue": [],
        "errors": [],
    }

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
            user_agent=USER_AGENT,
            viewport={"width": 1280, "height": 900},
            locale="en-US",
        )
        page = ctx.new_page()
        page.add_init_script(
            "Object.defineProperty(navigator,'webdriver',{get:()=>undefined})"
        )
        # Same warmup the scraper uses: the homepage clears DataDome's JS
        # challenge before we touch a performer page.
        page.goto("https://www.stubhub.com/", wait_until="domcontentloaded", timeout=30000)
        time.sleep(2)

        for team in teams:
            slug = team["slug"]
            stats = {"team": slug, "seen": 0, "games": 0, "inserted": 0}
            try:
                cards = collect_for_team(page, team)
            except Exception as e:
                summary["errors"].append({"team": slug, "error": str(e)[:200]})
                summary["teams"].append(stats)
                continue

            stats["seen"] = len(cards)
            for card in cards:
                text = card["text"]
                if CAROUSEL_RE.match(text):
                    continue  # recommendation carousel, not this team's schedule
                if any(s in text.lower() for s in SKIP_MARKERS):
                    continue
                m = EVENT_URL_RE.search(card["url"])
                if not m:
                    continue

                eid = int(m.group("id"))
                url_slug = m.group("slug")
                is_home = 1 if url_slug.startswith(slug) else 0
                venue = resolve_venue(url_slug, text, by_team, aliases)
                venue_slug = venue["slug"] if venue else None
                venue_name = venue["name"] if venue else None
                event_dt = to_utc(
                    int(m.group("year")), int(m.group("mo")), int(m.group("day")),
                    text, venue.get("tz") if venue else None,
                )
                if venue is None:
                    summary["unresolved_venue"].append(
                        {"event_id": eid, "url_slug": url_slug, "text": text[:90]}
                    )

                stats["games"] += 1
                existing = conn.execute(
                    "SELECT 1 FROM events WHERE id = ?", (eid,)
                ).fetchone()
                if existing:
                    summary["already_known"] += 1
                    continue

                if dry_run:
                    print(
                        f"  WOULD INSERT {eid} home={is_home} {event_dt} "
                        f"{venue_slug} :: {clean_title(text)[:60]}",
                        file=sys.stderr,
                    )
                else:
                    conn.execute(
                        """INSERT OR IGNORE INTO events
                           (id, team_slug, team_name, sport, title, venue, venue_slug,
                            event_datetime, stubhub_url, status, is_home_game)
                           VALUES (?,?,?,?,?,?,?,?,?,'pending',?)""",
                        (eid, slug, team.get("name"), team.get("sport"),
                         clean_title(text), venue_name, venue_slug,
                         event_dt, card["url"], is_home),
                    )
                stats["inserted"] += 1
                summary["inserted"] += 1

            if not dry_run:
                conn.execute(
                    """INSERT OR REPLACE INTO team_discovery_log
                       (team_slug, last_discovered_at) VALUES (?, ?)""",
                    (slug, datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")),
                )
                conn.commit()
            summary["teams"].append(stats)
            time.sleep(5)

        browser.close()

    conn.close()
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
