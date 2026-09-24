#!/usr/bin/env python3
"""
One-time backfill of past contact into contacts.db, from exports already on the
phone. Run by hand on the Mac; nothing schedules it.

  # Android call log, exported with SMS Backup & Restore
  python3 scripts/people-backfill.py calls ~/Downloads/calls-20260921.xml --dry-run

  # WhatsApp call history as CSV (Date,Time,Direction,Call Type,Duration,Duration (seconds))
  python3 scripts/people-backfill.py whatsapp-calls --person Dad ~/Downloads/dad-calls.csv --dry-run

  # Keep a private copy (outside the repo) and replay it after adding someone
  python3 scripts/people-backfill.py calls ~/Downloads/calls-20260921.xml --save
  python3 scripts/people-backfill.py rescan

Drop --dry-run to write. Re-running is harmless: every row carries
origin='backfill' and origin_ref = a stable hash of (source, person, ts,
duration), so a row already present is skipped, not duplicated. Input files are
only read, never moved or deleted.

What is stored — metadata only, as everywhere else in this feature:
  calls.xml   answered incoming/outgoing calls with a tracked number → `phone`
              (missed, rejected, blocked and 0-second calls are skipped)
  call CSV    each answered WhatsApp call, with its duration          → `whatsapp`
              (missed and 0-second calls are skipped)

WhatsApp *messages* are out of scope entirely: there is no chat-export mode.
(One existed briefly and recorded "a day messages were exchanged"; it was
removed and its rows deleted on 2026-09-21. Chat exports carry no call history
either, so they had nothing else to offer.)

The Android call log may be capped (often ~500 entries, device-dependent), so
calls.xml may not reach far back; the Sep 2026 export held 2,224 calls to 2018. WhatsApp exports reach back as far as the chat does.

Stdlib only.
"""
from __future__ import annotations

import argparse
import contextlib
import csv
import hashlib
import io
import json
import os
import shutil
import sqlite3
import sys
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import people_common as pc  # noqa: E402

# SMS Backup & Restore call types (android.provider.CallLog.Calls.TYPE)
CALL_IN, CALL_OUT = "1", "2"

# History starts here: older data was too sparse to be worth keeping, and was
# removed on 2026-09-21. Anything earlier is skipped (and counted) unless
# --since says otherwise, so a re-run can't quietly bring it back.
DEFAULT_SINCE = "2025-01-01"

# Saved exports, so a person added later can be matched against history already
# collected (`--save` stores, `rescan` replays). Deliberately OUTSIDE the repo:
# the main group mounts the repo read-only, and the people group mounts its own
# .claude/ — a call log names everyone Daniel has ever called, so it must be
# readable by no container at all. ~/.config/nanoclaw is the host-only place
# this project already uses for that (mount allowlist, health-check URL).
ARCHIVE = os.environ.get(
    "PEOPLE_EXPORTS", os.path.expanduser("~/.config/nanoclaw/people-exports")
)
ARCHIVE_CALLS = os.path.join(ARCHIVE, "calls")            # calls-*.xml, any contact
ARCHIVE_WA = os.path.join(ARCHIVE, "whatsapp-calls")     # p<person id>__<name>.csv
ARCHIVE_WA_BACKUPS = os.path.join(ARCHIVE, "whatsapp-backups")  # encrypted msgstore *.crypt15


def _private_dir(path: str) -> None:
    os.makedirs(path, mode=0o700, exist_ok=True)
    os.chmod(path, 0o700)
    os.chmod(ARCHIVE, 0o700)


def save_export(src: str, dest_dir: str, name: str) -> str:
    """Copy an export into the archive (mode 600). The original is left alone."""
    _private_dir(dest_dir)
    dest = os.path.join(dest_dir, name)
    shutil.copyfile(os.path.expanduser(src), dest)
    os.chmod(dest, 0o600)
    return dest
CALL_TYPE_NAMES = {
    "1": "incoming", "2": "outgoing", "3": "missed", "4": "voicemail",
    "5": "rejected", "6": "blocked", "7": "answered elsewhere",
}


def origin_ref(source: str, person_id: int, ts: str, duration: int | None) -> str:
    """Stable across re-runs and renames (keyed on person id, not name)."""
    key = f"{source}|{person_id}|{ts}|{'' if duration is None else duration}"
    return "bf:" + hashlib.sha256(key.encode()).hexdigest()[:32]


class Writer:
    """Collects rows, inserts them idempotently, and keeps per-person tallies."""

    def __init__(self, conn: sqlite3.Connection, dry_run: bool, since: str):
        self.conn = conn
        self.dry_run = dry_run
        self.since = since
        self.too_old = 0
        # Every row actually inserted this run, for callers that log them
        # (people-call-sync.py): (name, ts, source, direction, duration_s).
        self.new_rows: list[tuple[str, str, str, str, int | None]] = []
        self.added: dict[str, Counter] = defaultdict(Counter)
        self.present: dict[str, Counter] = defaultdict(Counter)
        self.span: dict[str, list[str]] = {}

    def add(self, person: sqlite3.Row, ts: str, source: str, direction: str,
            duration: int | None) -> None:
        if ts < self.since:
            self.too_old += 1
            return
        ref = origin_ref(source, person["id"], ts, duration)
        cur = self.conn.execute(
            "INSERT INTO interactions (person_id, ts, source, direction, duration_s, note, "
            "origin, origin_ref) VALUES (?, ?, ?, ?, ?, NULL, 'backfill', ?) "
            "ON CONFLICT(origin_ref) DO NOTHING",
            (person["id"], ts, source, direction, duration, ref),
        )
        name = person["name"]
        (self.added if cur.rowcount else self.present)[name][source] += 1
        if cur.rowcount:
            self.new_rows.append((name, ts, source, direction, duration))
        lo, hi = self.span.get(name, [ts, ts])
        self.span[name] = [min(lo, ts), max(hi, ts)]

    def finish(self) -> None:
        if self.dry_run:
            self.conn.rollback()
        else:
            self.conn.commit()

    def report(self) -> None:
        verb = "would add" if self.dry_run else "added"
        if self.too_old:
            print(f"\nskipped {self.too_old} matched entries before {self.since} (--since to change)")
        names = sorted(set(self.added) | set(self.present), key=str.lower)
        if not names:
            print("\nNothing matched a tracked person.")
            return
        print()
        for name in names:
            parts = [f"{n} {pc_label(s)}" for s, n in sorted(self.added[name].items())]
            line = f"{name}: {verb} " + (", ".join(parts) if parts else "nothing new")
            already = sum(self.present[name].values())
            if already:
                line += f" · {already} already recorded"
            lo, hi = self.span[name]
            line += f" · {lo[:10]} → {hi[:10]}"
            print(line)
        if self.dry_run:
            print("\nDry run — nothing written. Drop --dry-run to write.")


def pc_label(source: str) -> str:
    return {
        "phone": "calls",
        "whatsapp": "WhatsApp calls",
    }.get(source, source)


# ── calls.xml ─────────────────────────────────────────────────────────────────


def backfill_calls(conn: sqlite3.Connection, path: str, writer: Writer, show: int) -> dict:
    """Load one calls.xml. Prints a report; returns the same counts as a dict."""
    skipped: Counter = Counter()
    unmatched: Counter = Counter()
    unmatched_names: dict[str, str] = {}
    total = 0
    now = pc.now_local()

    for _, el in ET.iterparse(os.path.expanduser(path), events=("end",)):
        if el.tag != "call":
            continue
        total += 1
        call_type = el.get("type", "")
        duration = int(el.get("duration") or 0)
        raw_number = el.get("number", "")
        date_ms = el.get("date", "")
        name_on_phone = el.get("contact_name") or ""
        el.clear()

        if call_type not in (CALL_IN, CALL_OUT):
            skipped[CALL_TYPE_NAMES.get(call_type, f"type {call_type}")] += 1
            continue
        if duration <= 0:
            skipped["not answered (0 s)"] += 1
            continue
        try:
            when = datetime.fromtimestamp(int(date_ms) / 1000).replace(microsecond=0)
        except (TypeError, ValueError):
            skipped["unreadable date"] += 1
            continue
        if when > now:
            skipped["in the future"] += 1
            continue

        person = pc.match_identifier(conn, "phone_number", raw_number)
        if person is None:
            key = pc.normalize_phone(raw_number) or "(hidden number)"
            unmatched[key] += 1
            if name_on_phone and name_on_phone != "(Unknown)":
                unmatched_names[key] = name_on_phone
            continue

        writer.add(person, pc.fmt_ts(when), "phone",
                   "in" if call_type == CALL_IN else "out", duration)

    print(f"calls.xml: {total} calls read")
    for reason, n in skipped.most_common():
        print(f"  skipped {n} {reason}")
    if unmatched and show <= 0:
        print(f"  {sum(unmatched.values())} answered calls with {len(unmatched)} numbers "
              "that match nobody (not stored)")
    elif unmatched:
        print(f"  {sum(unmatched.values())} answered calls with {len(unmatched)} numbers "
              "that match nobody (not stored). Most frequent:")
        for number, n in unmatched.most_common(show):
            label = f"  ({unmatched_names[number]})" if number in unmatched_names else ""
            print(f"    {n:4d}  {number}{label}")
        if len(unmatched) > show:
            print(f"    … and {len(unmatched) - show} more (--show-unmatched N for more)")
        print("  To track one, add the number to that person on the dashboard's People page, "
              "then re-run.")
    return {
        "read": total,
        "skipped": dict(skipped),
        "unmatched_calls": sum(unmatched.values()),
        "unmatched_numbers": len(unmatched),
    }


# ── WhatsApp encrypted backup (msgstore.db.crypt15) ───────────────────────────
#
# Calls only: people_whatsapp decrypts in memory and hands back call tuples;
# no message is ever read. Needs the people-call-sync venv (wa-crypt-tools,
# Python >= 3.11); under any other Python this is skipped with a note.

# The same call imported twice — once from a call-history CSV, once from a
# backup — must not become two rows. Measured against the Sep 2026 exports, the
# CSV's time is the start cut to the minute (occasionally the end), and past an
# hour its length is truncated ("1 hr 11 min" for 71m29s). So: an existing
# WhatsApp row for the person, anywhere within this call's span ± SLACK, whose
# length matches (± 2 s) or is that truncation. A dropped call and a quick
# redial differ in length, so both are kept.
SAME_CALL_SLACK_S = 120


def _already_have_whatsapp_call(conn: sqlite3.Connection, person_id: int, ts: str,
                                duration: int) -> bool:
    rows = conn.execute(
        "SELECT duration_s FROM interactions WHERE person_id = ? AND source = 'whatsapp' "
        # strftime returns TEXT, which never compares numerically: cast.
        "AND CAST(strftime('%s', ts) AS INTEGER) "
        "BETWEEN CAST(strftime('%s', ?) AS INTEGER) - ? AND CAST(strftime('%s', ?) AS INTEGER) + ? + ?",
        (person_id, ts, SAME_CALL_SLACK_S, ts, duration, SAME_CALL_SLACK_S),
    ).fetchall()
    for (existing,) in rows:
        if existing is None:
            continue
        if abs(existing - duration) <= 2:
            return True
        if duration >= 3600 and existing % 60 == 0 and 0 <= duration - existing < 3600:
            return True  # "1 hr" / "1 hr 11 min": minutes (or more) dropped
    return False


def backfill_whatsapp_backup(conn: sqlite3.Connection, path: str, writer: Writer) -> dict:
    """Load answered one-to-one WhatsApp calls with tracked numbers from one backup."""
    try:
        import people_whatsapp as pw
    except ImportError as exc:
        print(f"skipped {os.path.basename(path)}: {exc}")
        return {"read": 0, "skipped": {"unavailable": 1}, "unmatched_calls": 0}
    try:
        db = pw.open_backup(path)
    except pw.BackupError as exc:
        print(f"skipped {os.path.basename(path)}: {exc}")
        return {"read": 0, "skipped": {"undecryptable": 1}, "unmatched_calls": 0, "error": str(exc)}
    try:
        found, skipped = pw.calls(db)
    finally:
        db.close()

    unmatched = 0
    for call in found:
        person = pc.match_identifier(conn, "phone_number", call.phone)
        if person is None:
            unmatched += 1
            continue
        ts = pc.fmt_ts(call.started)
        if ts >= writer.since and _already_have_whatsapp_call(conn, person["id"], ts, call.duration_s):
            writer.present[person["name"]]["whatsapp"] += 1
            continue
        writer.add(person, ts, "whatsapp", call.direction, call.duration_s)

    print(f"{os.path.basename(path)}: {len(found)} answered one-to-one WhatsApp calls · "
          f"{unmatched} with untracked numbers (not stored) · skipped "
          + ", ".join(f"{n} {why}" for why, n in skipped.items() if n))
    return {"read": len(found), "skipped": skipped, "unmatched_calls": unmatched}


# ── WhatsApp call-history CSV ─────────────────────────────────────────────────
#
# One row per call, one file per person:
#   Date,Time,Direction,Call Type,Duration,Duration (seconds)
#   2026-08-30,6:03 PM,Outgoing,Voice,16 min 6 sec,966
# Column names are matched case-insensitively; Time may be 12h or 24h. The
# CSV carries no contact, which is why --person is required.


def _col(header: list[str], *names: str) -> str | None:
    lowered = {h.strip().lower(): h for h in header}
    for n in names:
        if n in lowered:
            return lowered[n]
    return None


def _parse_csv_ts(date_text: str, time_text: str) -> datetime:
    date_text, time_text = date_text.strip(), time_text.strip().replace("\u202f", " ")
    for fmt in ("%Y-%m-%d %I:%M %p", "%Y-%m-%d %I:%M:%S %p", "%Y-%m-%d %H:%M",
                "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(f"{date_text} {time_text}", fmt)
        except ValueError:
            continue
    raise ValueError(f"unreadable date/time: {date_text} {time_text}")


def backfill_whatsapp_calls(conn: sqlite3.Connection, person: sqlite3.Row, paths: list[str],
                            writer: Writer) -> None:
    now = pc.now_local()
    for path in paths:
        full = os.path.expanduser(path)
        name = os.path.basename(full)
        with open(full, encoding="utf-8-sig", newline="") as fh:
            reader = csv.DictReader(fh)
            header = reader.fieldnames or []
            c_date = _col(header, "date")
            c_time = _col(header, "time")
            c_dir = _col(header, "direction")
            c_secs = _col(header, "duration (seconds)", "duration_s", "seconds")
            if not (c_date and c_time and c_dir and c_secs):
                raise SystemExit(
                    f"{name}: expected columns Date, Time, Direction and Duration (seconds); "
                    f"found {', '.join(header) or 'none'}"
                )
            added = skipped = unreadable = 0
            for row in reader:
                direction_text = (row.get(c_dir) or "").strip().lower()
                secs_text = (row.get(c_secs) or "").strip()
                if direction_text.startswith(("missed", "declined", "rejected")) or \
                        secs_text in ("", "0"):
                    skipped += 1
                    continue
                try:
                    when = _parse_csv_ts(row[c_date], row[c_time])
                    duration = int(float(secs_text))
                except (ValueError, TypeError):
                    unreadable += 1
                    continue
                if when > now:
                    unreadable += 1
                    continue
                direction = ("in" if direction_text.startswith("in")
                             else "out" if direction_text.startswith("out") else "n/a")
                writer.add(person, pc.fmt_ts(when), "whatsapp", direction, duration)
                added += 1
        print(f"{name}: {added} answered calls"
              f"{f' · {skipped} missed/unanswered skipped' if skipped else ''}"
              f"{f' · {unreadable} unreadable rows skipped' if unreadable else ''}")


# ── main ──────────────────────────────────────────────────────────────────────


def resolve(conn: sqlite3.Connection, name: str) -> sqlite3.Row:
    matches = pc.find_person_by_name(conn, name)
    known = ", ".join(p["name"] for p in pc.get_people(conn))
    if not matches:
        print(f"unknown person: {name!r}. Known: {known}", file=sys.stderr)
        raise SystemExit(2)
    if len(matches) > 1:
        print(f"ambiguous: {name!r} could be {', '.join(p['name'] for p in matches)}",
              file=sys.stderr)
        raise SystemExit(3)
    return matches[0]


def rescan(conn: sqlite3.Connection, writer: Writer) -> None:
    """Replay every saved export. Only matches not already stored are added."""
    calls = sorted(
        os.path.join(ARCHIVE_CALLS, f) for f in os.listdir(ARCHIVE_CALLS)
        if f.endswith(".xml")
    ) if os.path.isdir(ARCHIVE_CALLS) else []
    for path in calls:
        backfill_calls(conn, path, writer, show=0)

    if os.path.isdir(ARCHIVE_WA):
        for f in sorted(os.listdir(ARCHIVE_WA)):
            if not f.endswith(".csv") or "__" not in f or not f.startswith("p"):
                continue
            try:
                person_id = int(f[1:f.index("__")])
            except ValueError:
                continue
            person = conn.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
            if person is None:
                continue  # that person was removed; their CSV names nobody else
            backfill_whatsapp_calls(conn, person, [os.path.join(ARCHIVE_WA, f)], writer)

    # Each WhatsApp backup is the full history, so the newest one is enough.
    backups = sorted(
        f for f in os.listdir(ARCHIVE_WA_BACKUPS) if f.endswith(".crypt15")
    ) if os.path.isdir(ARCHIVE_WA_BACKUPS) else []
    if backups:
        backfill_whatsapp_backup(conn, os.path.join(ARCHIVE_WA_BACKUPS, backups[-1]), writer)

    if not calls and not os.path.isdir(ARCHIVE_WA) and not backups:
        print(f"No saved exports in {ARCHIVE}. Save one with --save.")


def main() -> int:
    ap = argparse.ArgumentParser(description="One-time backfill of past phone and WhatsApp calls")
    ap.add_argument("--db", help="contacts.db path (default: see people_common.py)")
    ap.add_argument("--dry-run", action="store_true", help="Parse and report; write nothing")
    ap.add_argument("--since", default=DEFAULT_SINCE, metavar="YYYY-MM-DD",
                    help=f"Skip anything earlier (default {DEFAULT_SINCE})")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_calls = sub.add_parser("calls", help="SMS Backup & Restore calls.xml")
    p_calls.add_argument("file")
    p_calls.add_argument("--show-unmatched", type=int, default=25, metavar="N",
                         help="How many unmatched numbers to list (default 25)")

    p_wac = sub.add_parser("whatsapp-calls", help="WhatsApp call history .csv (one person)")
    p_wac.add_argument("--person", required=True, help="Tracked person the calls were with")
    p_wac.add_argument("files", nargs="+")

    p_rescan = sub.add_parser("rescan", help="Replay every saved export (after adding a person)")
    p_rescan.add_argument("--json", action="store_true",
                          help="Print only a JSON summary (used by the dashboard)")

    for p in (p_calls, p_wac):
        p.add_argument("--save", action="store_true",
                       help=f"Also keep a private copy in {ARCHIVE} for later rescans")

    for p in (p_calls, p_wac, p_rescan):  # accept --dry-run / --db after the subcommand too
        p.add_argument("--dry-run", action="store_true", default=argparse.SUPPRESS)
        p.add_argument("--db", default=argparse.SUPPRESS)

    args = ap.parse_args()
    conn = pc.connect(args.db, create=False)
    if not pc.get_people(conn):
        raise SystemExit("Nobody tracked yet. Add people on the dashboard's People page first.")
    if not (args.cmd == "rescan" and args.json):
        print(f"contacts.db: {pc.db_path(args.db)}")

    try:
        since = datetime.fromisoformat(args.since).strftime("%Y-%m-%d")
    except ValueError:
        raise SystemExit(f"--since must be YYYY-MM-DD, not {args.since!r}")
    writer = Writer(conn, args.dry_run, since)
    quiet = args.cmd == "rescan" and args.json
    try:
        with contextlib.redirect_stdout(io.StringIO()) if quiet else contextlib.nullcontext():
            if args.cmd == "calls":
                backfill_calls(conn, args.file, writer, args.show_unmatched)
            elif args.cmd == "whatsapp-calls":
                person = resolve(conn, args.person)
                backfill_whatsapp_calls(conn, person, args.files, writer)
            else:
                rescan(conn, writer)
    except BaseException:
        conn.rollback()
        raise
    writer.finish()

    if quiet:
        print(json.dumps({
            "added": {name: sum(c.values()) for name, c in writer.added.items() if c},
            "dry_run": args.dry_run,
        }))
        return 0
    writer.report()

    if getattr(args, "save", False) and not args.dry_run:
        if args.cmd == "calls":
            dest = save_export(args.file, ARCHIVE_CALLS, os.path.basename(args.file))
        else:
            for f in args.files:
                dest = save_export(f, ARCHIVE_WA, f"p{person['id']}__{os.path.basename(f)}")
        print(f"\nSaved a private copy for later rescans: {os.path.dirname(dest)}")

    if not args.dry_run:
        print()
        for person in pc.get_people(conn):
            st = pc.person_status(conn, person)
            last = f"{st['last_ts'][:10]} ({st['last_source']})" if st["last_ts"] else "never"
            print(f"  {st['name']}: last {last} · {st['status']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
