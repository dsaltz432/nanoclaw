#!/usr/bin/env python3
"""
Read and write contacts.db for the `people` group.

This is the only way the agent touches the DB: it parses the English, this
script does the SQL, so a mis-parse shows up as a wrong confirmation line rather
than a wrong row.

  people-log.py people                       list everyone, with rules
  people-log.py resolve "mom"                map a typed name to a person
  people-log.py log --person Mom --source in_person --at yesterday
  people-log.py log --person Dad --source phone --duration "20 min"
  people-log.py mute --person Mom --until 2w
  people-log.py unmute --person Mom
  people-log.py status                       last qualifying interaction per person
  people-log.py recent --person Mom --limit 20

Every subcommand takes --json for a machine-readable version, and --db PATH.

Exit codes: 0 ok · 1 error · 2 unknown person · 3 ambiguous name.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import datetime, timedelta

import people_common as pc

SOURCE_LABELS = {
    "phone": "call",
    "whatsapp": "WhatsApp call",
    "in_person": "in person",
    "manual": "manual note",
}

EXIT_UNKNOWN = 2
EXIT_AMBIGUOUS = 3


# ── Formatting ────────────────────────────────────────────────────────────────


def day_label(ts: str, now: datetime | None = None) -> str:
    ref = (now or pc.now_local()).date()
    day = pc.parse_ts(ts).date()
    delta = (ref - day).days
    if delta == 0:
        return "today"
    if delta == 1:
        return "yesterday"
    if day.year == ref.year:
        return day.strftime("%b %-d")
    return day.strftime("%b %-d, %Y")


def duration_label(seconds: int | None) -> str:
    if not seconds:
        return ""
    if seconds < 60:
        return f"{seconds} sec"
    minutes = round(seconds / 60)
    if minutes < 60:
        return f"{minutes} min"
    hours, rem = divmod(minutes, 60)
    return f"{hours}h{rem:02d}" if rem else f"{hours}h"


def rule_label(source: str, minimum: int | None) -> str:
    label = SOURCE_LABELS.get(source, source)
    return label if minimum is None else f"{label} ≥ {duration_label(minimum)}"


# ── Input parsing ─────────────────────────────────────────────────────────────


def parse_when(text: str | None) -> datetime:
    """
    --at accepts: now · today · yesterday · N days ago · YYYY-MM-DD ·
    YYYY-MM-DD HH:MM · a full ISO 8601 timestamp.

    A bare date becomes noon local, so nothing drifts across a day boundary.
    """
    now = pc.now_local()
    if not text or text.strip().lower() == "now":
        return now
    value = text.strip().lower()
    if value == "today":
        return now
    if value == "yesterday":
        return (now - timedelta(days=1)).replace(hour=12, minute=0, second=0)
    m = re.fullmatch(r"(\d+)\s*(?:days?|d)\s*ago", value)
    if m:
        return (now - timedelta(days=int(m.group(1)))).replace(hour=12, minute=0, second=0)
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        return datetime.fromisoformat(value).replace(hour=12)
    try:
        return pc.parse_ts(text)
    except ValueError as err:
        raise SystemExit(f"cannot read a date from {text!r} ({err})")


def parse_duration_seconds(text: str | None) -> int | None:
    """--duration accepts: 300 · 300s · 20 min · 1h · 1h30m · 1:05:00."""
    if text is None:
        return None
    value = text.strip().lower()
    if not value:
        return None
    if re.fullmatch(r"\d+", value):
        return int(value)
    m = re.fullmatch(r"(?:(\d+):)?(\d{1,2}):(\d{2})", value)
    if m:
        h, mnt, sec = (int(g or 0) for g in m.groups())
        return h * 3600 + mnt * 60 + sec
    total, matched = 0, False
    for amount, unit in re.findall(r"(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b", value):
        matched = True
        n = int(amount)
        if unit.startswith("h"):
            total += n * 3600
        elif unit.startswith("s"):
            total += n
        else:
            total += n * 60
    if not matched:
        raise SystemExit(f"cannot read a duration from {text!r} (try '20 min', '1h', '300s')")
    return total


def resolve_person(conn: sqlite3.Connection, name: str) -> sqlite3.Row:
    matches = pc.find_person_by_name(conn, name)
    if not matches:
        known = ", ".join(r["name"] for r in pc.get_people(conn)) or "(nobody yet)"
        print(f"unknown person: {name!r}. Known: {known}", file=sys.stderr)
        raise SystemExit(EXIT_UNKNOWN)
    if len(matches) > 1:
        options = ", ".join(r["name"] for r in matches)
        print(f"ambiguous: {name!r} could be {options}", file=sys.stderr)
        raise SystemExit(EXIT_AMBIGUOUS)
    return matches[0]


# ── Subcommands ───────────────────────────────────────────────────────────────


def cmd_people(conn, args) -> int:
    rows = []
    for person in pc.get_people(conn):
        rules = pc.rules_for(conn, person["id"])
        identifiers = conn.execute(
            "SELECT kind, value FROM identifiers WHERE person_id = ? ORDER BY kind, value",
            (person["id"],),
        ).fetchall()
        rows.append(
            {
                "id": person["id"],
                "name": person["name"],
                "threshold_days": person["threshold_days"],
                "notes": person["notes"],
                "identifiers": [dict(i) for i in identifiers],
                "rules": rules,
            }
        )
    if args.json:
        print(json.dumps(rows, indent=2))
        return 0
    if not rows:
        print("Nobody tracked yet. Add someone on the dashboard's People page (/people).")
        return 0
    for r in rows:
        counts = ", ".join(rule_label(s, m) for s, m in sorted(r["rules"].items())) or "nothing"
        print(f"{r['name']} — every {r['threshold_days']}d · counts: {counts}")
        for i in r["identifiers"]:
            print(f"    {i['kind']}: {i['value']}")
    return 0


def cmd_resolve(conn, args) -> int:
    person = resolve_person(conn, args.name)
    if args.json:
        print(json.dumps({"id": person["id"], "name": person["name"]}))
    else:
        print(person["name"])
    return 0


def cmd_log(conn, args) -> int:
    person = resolve_person(conn, args.person)
    if args.source not in pc.SOURCES:
        raise SystemExit(f"unknown source {args.source!r} (one of {', '.join(pc.SOURCES)})")
    if args.origin not in pc.ORIGINS:
        raise SystemExit(f"unknown origin {args.origin!r} (one of {', '.join(pc.ORIGINS)})")

    when = parse_when(args.at)
    if when > pc.now_local() + timedelta(minutes=5):
        raise SystemExit(f"{pc.fmt_ts(when)} is in the future — interactions are things that happened")
    duration = parse_duration_seconds(args.duration)

    try:
        cur = conn.execute(
            "INSERT INTO interactions (person_id, ts, source, direction, duration_s, note, "
            "origin, origin_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                person["id"],
                pc.fmt_ts(when),
                args.source,
                args.direction,
                duration,
                args.note,
                args.origin,
                args.origin_ref,
            ),
        )
    except sqlite3.IntegrityError as err:
        if args.origin_ref and "origin_ref" in str(err):
            print(f"already recorded (origin_ref {args.origin_ref})")
            return 0
        raise
    conn.commit()

    rules = pc.rules_for(conn, person["id"])
    counts = pc.qualifies(rules, args.source, duration)
    label = SOURCE_LABELS.get(args.source, args.source)
    line = "Logged: " + ", ".join(
        [f"{label} with {person['name']}"]
        + ([duration_label(duration)] if duration else [])
        + [day_label(pc.fmt_ts(when))]
    )
    if not counts:
        rule = rules.get(args.source)
        why = (
            f"under {person['name']}'s minimum ({rule_label(args.source, rule)})"
            if args.source in rules
            else f"{label} doesn't count for {person['name']}"
        )
        line += f" — recorded, but {why}"

    if args.json:
        print(
            json.dumps(
                {
                    "id": cur.lastrowid,
                    "person": person["name"],
                    "ts": pc.fmt_ts(when),
                    "source": args.source,
                    "duration_s": duration,
                    "qualifies": counts,
                    "line": line,
                }
            )
        )
    else:
        print(line)
    return 0


def cmd_mute(conn, args) -> int:
    person = resolve_person(conn, args.person)
    until = pc.mute_until(args.until)
    if until <= pc.now_local():
        raise SystemExit(f"{args.until!r} is not in the future")
    conn.execute(
        "INSERT INTO mutes (person_id, until, created_at) VALUES (?, ?, ?)",
        (person["id"], pc.fmt_ts(until), pc.fmt_ts(pc.now_local())),
    )
    conn.commit()
    line = f"Muted: {person['name']} until {until.date().strftime('%b %-d')}"
    print(json.dumps({"person": person["name"], "until": pc.fmt_ts(until), "line": line})
          if args.json else line)
    return 0


def cmd_unmute(conn, args) -> int:
    person = resolve_person(conn, args.person)
    cur = conn.execute(
        "DELETE FROM mutes WHERE person_id = ? AND until > ?",
        (person["id"], pc.fmt_ts(pc.now_local())),
    )
    conn.commit()
    line = (
        f"Unmuted: {person['name']}" if cur.rowcount else f"{person['name']} was not muted"
    )
    print(json.dumps({"person": person["name"], "cleared": cur.rowcount, "line": line})
          if args.json else line)
    return 0


def cmd_status(conn, args) -> int:
    rows = [pc.person_status(conn, p) for p in pc.get_people(conn)]
    # Most overdue first — the order the nudge needs.
    rows.sort(key=lambda r: (-(r["days_since"] or 10_000) if r["overdue"] else 0, r["name"]))
    if args.json:
        print(json.dumps(rows, indent=2))
        return 0
    if not rows:
        print("Nobody tracked yet.")
        return 0
    for r in rows:
        last = (
            f"{SOURCE_LABELS.get(r['last_source'], r['last_source'])}, "
            f"{day_label(r['last_ts'])}"
            if r["last_ts"]
            else "never"
        )
        since = "—" if r["days_since"] is None else f"{r['days_since']}d"
        muted = f" [muted until {pc.parse_ts(r['muted_until']).date()}]" if r["muted_until"] else ""
        print(
            f"{r['name']}: {since} since ({last}) · threshold {r['threshold_days']}d "
            f"· {r['status']}{muted}"
        )
    return 0


def cmd_recent(conn, args) -> int:
    person = resolve_person(conn, args.person)
    rules = pc.rules_for(conn, person["id"])
    rows = conn.execute(
        "SELECT * FROM interactions WHERE person_id = ? ORDER BY ts DESC LIMIT ?",
        (person["id"], args.limit),
    ).fetchall()
    out = [
        {**dict(r), "qualifies": pc.qualifies(rules, r["source"], r["duration_s"])} for r in rows
    ]
    if args.json:
        print(json.dumps(out, indent=2))
        return 0
    for r in out:
        mark = "·" if r["qualifies"] else "○"
        extra = f" {duration_label(r['duration_s'])}" if r["duration_s"] else ""
        note = f" — {r['note']}" if r["note"] else ""
        print(f"{mark} {r['ts'][:16]}  {SOURCE_LABELS.get(r['source'], r['source'])}{extra}"
              f" [{r['origin']}]{note}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Read and write the people contacts.db")
    ap.add_argument("--db", help="Path to contacts.db")
    ap.add_argument("--json", action="store_true", help="Machine-readable output")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("people", help="List everyone tracked")

    p_resolve = sub.add_parser("resolve", help="Map a typed name to a person")
    p_resolve.add_argument("name")

    p_log = sub.add_parser("log", help="Record an interaction")
    p_log.add_argument("--person", required=True)
    p_log.add_argument("--source", required=True, choices=list(pc.SOURCES))
    p_log.add_argument("--at", help="now (default) · yesterday · 2026-09-14 · full ISO 8601")
    p_log.add_argument("--duration", help="'20 min' · '1h' · '300s' · 300")
    p_log.add_argument("--direction", default="n/a", choices=list(pc.DIRECTIONS))
    p_log.add_argument("--note", help="What was said in chat, verbatim")
    p_log.add_argument("--origin", default="telegram", choices=list(pc.ORIGINS))
    p_log.add_argument("--origin-ref", help="Stable id for idempotent re-ingest")

    p_mute = sub.add_parser("mute", help="Stop nudging about someone for a while")
    p_mute.add_argument("--person", required=True)
    p_mute.add_argument("--until", required=True, help="2w · 10d · 2026-10-31")

    p_unmute = sub.add_parser("unmute", help="Clear an active mute")
    p_unmute.add_argument("--person", required=True)

    sub.add_parser("status", help="Last qualifying interaction per person")

    p_recent = sub.add_parser("recent", help="Recent interactions for one person")
    p_recent.add_argument("--person", required=True)
    p_recent.add_argument("--limit", type=int, default=20)

    args = ap.parse_args()
    conn = pc.connect(args.db, create=False)
    try:
        return {
            "people": cmd_people,
            "resolve": cmd_resolve,
            "log": cmd_log,
            "mute": cmd_mute,
            "unmute": cmd_unmute,
            "status": cmd_status,
            "recent": cmd_recent,
        }[args.cmd](conn, args)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
