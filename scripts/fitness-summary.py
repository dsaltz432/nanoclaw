#!/usr/bin/env python3
"""
Nightly fitness summary → markdown. Numbers only: no advice, no interpretation.

Reads strava.db and garmin-<slug>.db from the fitness group's .claude dir and
the read-only training plan mount, and writes one markdown file. Every section
is independent: a failed query marks that section "unavailable", logs the error
to stderr, and the file is still written. Missing data prints "no data", never 0.

Windows are complete local days ending yesterday (the task runs at 02:00, when
"today" is empty): last 7 = yesterday-6 … yesterday, previous 7 = the 7 before.

Usage (fitness container):
  python3 /home/node/nanoclaw/scripts/fitness-summary.py \\
      --out /workspace/group/publish/fitness-summary.md

  --person "Daniel Saltz"   Strava athletes.name and Garmin profile (slugified)
  --data-dir DIR            default $GARMIN_DATA_DIR or /home/node/.claude
  --plan FILE               default /workspace/extra/training-plan.md
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import traceback
from datetime import date, datetime, timedelta

ACTIVE_DAY_MIN_S = 1200  # streak: an activity of >= 20 min moving time


# ── formatting ────────────────────────────────────────────────────────────────

def hm(seconds) -> str:
    if seconds is None:
        return "no data"
    m = int(round(seconds / 60))
    return f"{m // 60}h{m % 60:02d}"


def km(meters) -> str:
    return "no data" if meters is None else f"{meters / 1000:.1f} km"


def num(v, fmt="{:.0f}", unit="") -> str:
    return "no data" if v is None else fmt.format(v) + unit


def iso(d: date) -> str:
    return d.isoformat()


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


# ── data access ───────────────────────────────────────────────────────────────

def ro(path: str) -> sqlite3.Connection:
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


class Strava:
    def __init__(self, path: str, person: str):
        self.db = ro(path)
        row = self.db.execute("SELECT id FROM athletes WHERE name = ?", (person,)).fetchone()
        if not row:
            raise LookupError(f"no Strava athlete named {person!r}")
        self.athlete = row[0]

    def window(self, start: date, end: date) -> list[tuple]:
        """Activities with start_date_local in [start, end] (inclusive days)."""
        return self.db.execute(
            """SELECT name, sport_type, moving_time, distance, total_elevation_gain,
                      achievement_count, substr(start_date_local, 1, 10)
               FROM activities
               WHERE athlete_id = ? AND substr(start_date_local, 1, 10) BETWEEN ? AND ?""",
            (self.athlete, iso(start), iso(end)),
        ).fetchall()

    def active_dates(self) -> set[str]:
        # Same rule as dashboard GET /api/strava/streak: only activities with
        # >= 20 min moving time count, and a day is active if they sum >= 20 min.
        rows = self.db.execute(
            """SELECT substr(start_date_local, 1, 10), SUM(moving_time) FROM activities
               WHERE athlete_id = ? AND moving_time >= ? GROUP BY 1""",
            (self.athlete, ACTIVE_DAY_MIN_S),
        ).fetchall()
        return {d for d, s in rows if s and s >= ACTIVE_DAY_MIN_S}


def totals(rows: list[tuple]) -> dict:
    """Sums over a window; distance/elevation None when nothing recorded them."""
    dist = [r[3] for r in rows if r[3]]
    elev = [r[4] for r in rows if r[4]]
    return {
        "n": len(rows),
        "moving": sum(r[2] or 0 for r in rows) if rows else None,
        "distance": sum(dist) if dist else None,
        "elevation": sum(elev) if elev else None,
    }


# ── sections ──────────────────────────────────────────────────────────────────

def sec_strava_compare(st: Strava, y: date) -> list[str]:
    cur = st.window(y - timedelta(days=6), y)
    prev = st.window(y - timedelta(days=13), y - timedelta(days=7))
    c, p = totals(cur), totals(prev)
    out = [
        f"## Last 7 days vs previous 7 (Strava)",
        "",
        f"| | {iso(y - timedelta(days=6))} – {iso(y)} | {iso(y - timedelta(days=13))} – {iso(y - timedelta(days=7))} |",
        "|---|---|---|",
        f"| Activities | {c['n']} | {p['n']} |",
        f"| Moving time | {hm(c['moving']) if cur else 'no data'} | {hm(p['moving']) if prev else 'no data'} |",
        f"| Elevation | {num(c['elevation'], unit=' m')} | {num(p['elevation'], unit=' m')} |",
    ]
    sports = sorted({r[1] or "Unknown" for r in cur + prev})
    for s in sports:
        cd = [r[3] for r in cur if (r[1] or "Unknown") == s and r[3]]
        pd = [r[3] for r in prev if (r[1] or "Unknown") == s and r[3]]
        if not cd and not pd:
            continue  # sport without distance (weights, workouts)
        out.append(
            f"| Distance — {s} | {km(sum(cd)) if cd else 'no data'} | {km(sum(pd)) if pd else 'no data'} |"
        )
    return out


def sport_label(sport: str | None) -> str:
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", sport or "Unknown")


def by_type(rows: list[tuple]) -> str:
    """'Soccer 3 · 2h40, Walk 4 · 1h55' — count and moving time per sport, most time first."""
    agg: dict[str, list] = {}
    for r in rows:
        a = agg.setdefault(sport_label(r[1]), [0, 0])
        a[0] += 1
        a[1] += r[2] or 0
    return ", ".join(
        f"{s} {n} · {hm(t)}" for s, (n, t) in sorted(agg.items(), key=lambda kv: (-kv[1][1], kv[0]))
    ) or "no data"


def trend_table(st: Strava, title: str, periods: list[tuple[date, date]]) -> list[str]:
    out = [
        f"## {title}",
        "",
        "| Period | Activities | Moving time | Distance | Elevation | By type (count · time) |",
        "|---|---|---|---|---|---|",
    ]
    for start, end in periods:
        rows = st.window(start, end)
        t = totals(rows)
        out.append(
            f"| {iso(start)} – {iso(end)} | {t['n']} | "
            f"{hm(t['moving']) if rows else 'no data'} | {km(t['distance'])} | "
            f"{num(t['elevation'], unit=' m')} | {by_type(rows)} |"
        )
    return out


def periods(y: date, n: int, days: int) -> list[tuple[date, date]]:
    """n consecutive periods of `days` days ending yesterday, oldest first."""
    return [
        (y - timedelta(days=days * i + days - 1), y - timedelta(days=days * i))
        for i in range(n - 1, -1, -1)
    ]


def sec_strava_trend(st: Strava, y: date) -> list[str]:
    return trend_table(st, "4-week trend, by week (Strava)", periods(y, 4, 7))


def sec_strava_trend_12w(st: Strava, y: date) -> list[str]:
    return trend_table(st, "12-week trend, 4-week periods (Strava)", periods(y, 3, 28))


def body_battery_day(raw: str) -> dict:
    """Peak/low/end from the value series plus charged/drained, all from raw.
    The charged/drained columns hold 0 on days with no reading; raw holds null."""
    try:
        day = json.loads(raw)[0]
        vals = [v[1] for v in (day.get("bodyBatteryValuesArray") or [])
                if isinstance(v, list) and len(v) > 1 and v[1] is not None]
    except (ValueError, TypeError, AttributeError, IndexError, KeyError):
        return {}
    return {
        "peak": max(vals) if vals else None,
        "low": min(vals) if vals else None,
        "end": vals[-1] if vals else None,
        "charged": day.get("charged"),
        "drained": day.get("drained"),
    }


def garmin_avg(db, sql_value: str, table: str, start: date, end: date):
    """Average of positive values; (avg, n_days). Garmin stores 0 for 'no reading'."""
    rows = db.execute(
        f"SELECT {sql_value} FROM {table} WHERE date BETWEEN ? AND ?", (iso(start), iso(end))
    ).fetchall()
    vals = [r[0] for r in rows if r[0] is not None and r[0] > 0]
    return (sum(vals) / len(vals), len(vals)) if vals else (None, 0)


def sec_garmin(path: str, y: date) -> list[str]:
    db = ro(path)
    w7 = (y - timedelta(days=6), y)
    w28 = (y - timedelta(days=27), y)
    out = [
        "## Garmin — 7-day avg vs 28-day avg",
        "",
        "| Metric | 7-day avg | 28-day avg |",
        "|---|---|---|",
    ]
    metrics = [
        ("Resting HR", "resting_heart_rate", "daily_heart_rate", lambda v: num(v, unit=" bpm")),
        ("HRV (overnight)", "last_night", "daily_hrv", lambda v: num(v, unit=" ms")),
        ("Sleep duration", "sleep_time_seconds", "daily_sleep", hm),
        ("Training readiness", "score", "daily_training_readiness", num),
    ]

    def cell(avg, n, fmt, days):
        return "no data" if avg is None else f"{fmt(avg)} (n={n}/{days})"

    for label, col, table, fmt in metrics:
        a7, n7 = garmin_avg(db, col, table, *w7)
        a28, n28 = garmin_avg(db, col, table, *w28)
        out.append(f"| {label} | {cell(a7, n7, fmt, 7)} | {cell(a28, n28, fmt, 28)} |")

    row = db.execute(
        "SELECT date, generic FROM vo2max WHERE generic IS NOT NULL AND generic > 0 "
        "ORDER BY date DESC LIMIT 1"
    ).fetchone()
    out += ["", f"Latest VO2 max: {f'{row[1]:.1f} ({row[0]})' if row else 'no data'}"]
    return out


def sec_body_battery(path: str, y: date) -> list[str]:
    db = ro(path)

    def days(start, end):
        rows = db.execute(
            "SELECT raw FROM daily_body_battery WHERE date BETWEEN ? AND ?", (iso(start), iso(end))
        ).fetchall()
        return [body_battery_day(raw) for (raw,) in rows if raw]

    def avg(ds, key, span):
        vals = [d[key] for d in ds if d.get(key) is not None]
        return "no data" if not vals else f"{sum(vals) / len(vals):.0f} (n={len(vals)}/{span})"

    d7 = days(y - timedelta(days=6), y)
    d28 = days(y - timedelta(days=27), y)
    out = [
        "## Body battery — 7-day avg vs 28-day avg (Garmin)",
        "",
        "| | 7-day avg | 28-day avg |",
        "|---|---|---|",
    ]
    for label, key in (
        ("Daily peak", "peak"),
        ("Daily low", "low"),
        ("End of day", "end"),
        ("Charged", "charged"),
        ("Drained", "drained"),
    ):
        out.append(f"| {label} | {avg(d7, key, 7)} | {avg(d28, key, 28)} |")
    return out


def sec_plan(path: str) -> list[str]:
    with open(path) as f:
        text = f.read()
    out = ["## Training plan (quoted from training-plan.md)", ""]

    block = re.search(r"^\s*\**(?:current block|block)\**\s*[:—-]\s*(.+)$", text, re.I | re.M)
    week = re.search(r"\bweek\s+(\d+)\s+of\s+(\d+)\b", text, re.I)
    out.append(f"- Block: {block.group(1).strip() if block else 'not specified in training-plan.md'}")
    out.append(
        f"- Week: {f'{week.group(1)} of {week.group(2)}' if week else 'not specified in training-plan.md'}"
    )

    # This week's targets: the "Weekly Quotas" table, verbatim.
    m = re.search(r"^##\s+Weekly Quotas\s*$\n(.*?)(?=^#|\Z)", text, re.M | re.S)
    table = [l for l in (m.group(1).splitlines() if m else []) if l.startswith("|")]
    if table:
        out += ["- This week's targets (Weekly Quotas):", ""] + [f"> {l}" for l in table]
    else:
        out.append("- This week's targets: not specified in training-plan.md")
    return out


def sec_streak(st: Strava, today: date) -> list[str]:
    # Mirrors dashboard GET /api/strava/streak: consecutive Sun–Sat weeks with
    # >= 3 active days; the current week counts once it has any active day.
    active = st.active_dates()
    week_start = today - timedelta(days=(today.weekday() + 1) % 7)  # Sunday

    def count(ws):
        return sum(iso(ws + timedelta(days=i)) in active for i in range(7))

    streak, ws = 0, week_start
    prev = ws - timedelta(days=7)
    if count(ws) > 0 or count(prev) >= 3:
        if count(ws) > 0:
            streak = 1
        ws = prev
        while count(ws) >= 3:
            streak += 1
            ws -= timedelta(days=7)
    return [
        "## Streak",
        "",
        f"- {streak} week{'s' if streak != 1 else ''} "
        "(consecutive Sun–Sat weeks with ≥3 days of ≥20 min moving time; dashboard definition)",
    ]


def sec_notable(st: Strava, y: date) -> list[str]:
    rows = st.window(y - timedelta(days=6), y)
    out = ["## Notable, last 7 days", ""]
    timed = [r for r in rows if r[2]]
    if timed:
        r = max(timed, key=lambda r: r[2])
        dist = f", {km(r[3])}" if r[3] else ""
        out.append(f"- Longest activity: {r[0]} ({r[1]}, {r[6]}) — {hm(r[2])}{dist}")
    else:
        out.append("- Longest activity: no data")
    ach = [r for r in rows if r[5]]
    if ach:
        out.append(
            "- Strava achievements (achievement_count; strava.db does not store PRs separately): "
            + "; ".join(f"{r[0]} ({r[6]}): {r[5]}" for r in ach)
        )
    else:
        out.append("- Strava achievements: none recorded")
    return out


# ── main ──────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--out", required=True)
    ap.add_argument("--person", default="Daniel Saltz")
    ap.add_argument("--data-dir", default=os.environ.get("GARMIN_DATA_DIR", "/home/node/.claude"))
    ap.add_argument("--plan", default="/workspace/extra/training-plan.md")
    args = ap.parse_args()

    now = datetime.now().astimezone()
    today = now.date()
    y = today - timedelta(days=1)
    first = args.person.split()[0]
    lines = [f"# Fitness summary — {first} — generated {now.isoformat(timespec='seconds')}", ""]
    failures = 0

    strava = None
    try:
        strava = Strava(os.path.join(args.data_dir, "strava.db"), args.person)
    except Exception as e:  # noqa: BLE001 — every section degrades independently
        strava_err = e

    def section(title, fn, *a, needs_strava=False):
        nonlocal failures
        try:
            if needs_strava and strava is None:
                raise strava_err
            body = fn(*a)
        except Exception as e:  # noqa: BLE001
            failures += 1
            print(f"[fitness-summary] {title}: {type(e).__name__}: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            body = [f"## {title}", "", "unavailable"]
        lines.extend(body + [""])

    section("Last 7 days vs previous 7 (Strava)", lambda: sec_strava_compare(strava, y), needs_strava=True)
    section("4-week trend, by week (Strava)", lambda: sec_strava_trend(strava, y), needs_strava=True)
    section("12-week trend, 4-week periods (Strava)", lambda: sec_strava_trend_12w(strava, y), needs_strava=True)
    section(
        "Garmin — 7-day avg vs 28-day avg",
        sec_garmin,
        os.path.join(args.data_dir, f"garmin-{slugify(args.person)}.db"),
        y,
    )
    section(
        "Body battery — 7-day avg vs 28-day avg (Garmin)",
        sec_body_battery,
        os.path.join(args.data_dir, f"garmin-{slugify(args.person)}.db"),
        y,
    )
    section("Training plan", sec_plan, args.plan)
    section("Streak", lambda: sec_streak(strava, today), needs_strava=True)
    section("Notable, last 7 days", lambda: sec_notable(strava, y), needs_strava=True)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    tmp = args.out + ".tmp"
    with open(tmp, "w") as f:
        f.write("\n".join(lines).rstrip() + "\n")
    os.replace(tmp, args.out)
    print(f"wrote {args.out} ({len(lines)} lines, {failures} section(s) unavailable)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
