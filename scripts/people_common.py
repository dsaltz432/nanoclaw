"""
Shared plumbing for the `people` group: contacts.db schema, name/phone matching,
and the rules that decide whether an interaction counts.

Used by people-log.py (the agent), people-backfill.py and people-call-sync.py (host). The dashboard re-implements `qualifies` / `person_status` in
TypeScript (dashboard/server/routes/people.ts) — keep the two in step.

DB location (first match wins):
  --db PATH
  $PEOPLE_DB
  /home/node/.claude/contacts.db                          (inside the container)
  <repo>/data/sessions/people/.claude/contacts.db         (on the host)

Only metadata is ever stored: who, when, which channel, how long. No message
content, and no contact who is not in `people`.

People are added, edited and removed on the dashboard's People page, which
writes this same DB. There is no config file: contacts.db is the only store.

Stdlib only — nothing here needs a package the agent container lacks.
"""
from __future__ import annotations

import os
import re
import sqlite3
from datetime import datetime, timedelta

NANOCLAW_ROOT = os.environ.get(
    "NANOCLAW_ROOT", os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
)
DB_NAME = "contacts.db"
DB_CANDIDATES = [
    os.path.join("/home/node/.claude", DB_NAME),
    os.path.join(NANOCLAW_ROOT, "data/sessions/people/.claude", DB_NAME),
]

# Sources anything may write. 'whatsapp_message' is retired: WhatsApp messages
# are out of scope, so nothing writes it and no rule can name it. It stays in
# the schema's CHECK lists only so the table needn't be rebuilt; mirrored in
# dashboard/server/routes/people.ts.
SOURCES = ("phone", "whatsapp", "in_person", "manual")
DIRECTIONS = ("in", "out", "n/a")
ORIGINS = ("sheet", "telegram", "dashboard", "backfill")
IDENTIFIER_KINDS = ("phone_number", "whatsapp_name")

# Phone numbers with no country code are assumed to be in this region.
DEFAULT_COUNTRY_CODE = os.environ.get("PEOPLE_COUNTRY_CODE", "1")

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS people (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  threshold_days INTEGER NOT NULL,
  notes          TEXT,
  sort_order     INTEGER          -- position on the People page (drag to reorder); NULL = end
);

-- A person can have several: two phone numbers, a WhatsApp display name that
-- differs from the name used here, etc.
CREATE TABLE IF NOT EXISTS identifiers (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL CHECK (kind IN ('phone_number','whatsapp_name')),
  value     TEXT NOT NULL,
  UNIQUE (kind, value)
);

-- "Counts as an interaction" per person. A source with no row here never
-- counts, however many interactions of that source are recorded.
-- min_duration_s NULL = no minimum (in person, manual).
CREATE TABLE IF NOT EXISTS rules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id      INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  source         TEXT NOT NULL CHECK (
                   source IN ('phone','whatsapp','whatsapp_message','in_person','manual')),
  min_duration_s INTEGER,
  UNIQUE (person_id, source)
);

-- Every interaction that was captured, whether or not it qualifies. The rules
-- are applied at read time, so changing a threshold re-reads history rather
-- than rewriting it.
CREATE TABLE IF NOT EXISTS interactions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  ts         TEXT NOT NULL,   -- local naive ISO 8601, seconds precision
  source     TEXT NOT NULL CHECK (
               source IN ('phone','whatsapp','whatsapp_message','in_person','manual')),
  direction  TEXT NOT NULL CHECK (direction IN ('in','out','n/a')),
  duration_s INTEGER,
  note       TEXT,
  origin     TEXT NOT NULL CHECK (origin IN ('sheet','telegram','dashboard','backfill')),
  origin_ref TEXT UNIQUE      -- sheet row id / backfill hash; NULL for hand entries
);

CREATE INDEX IF NOT EXISTS idx_interactions_person_ts
  ON interactions(person_id, ts DESC);

CREATE TABLE IF NOT EXISTS mutes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id  INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  until      TEXT NOT NULL,   -- local naive ISO 8601
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mutes_person ON mutes(person_id, until DESC);

-- One row per person per nudge run that listed them, so "three Sundays
-- running" is a fact rather than a guess. Written by the People check task.
CREATE TABLE IF NOT EXISTS nudges (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  run_date TEXT NOT NULL,     -- YYYY-MM-DD of the run
  streak   INTEGER NOT NULL,  -- consecutive runs this person has been listed
  UNIQUE (person_id, run_date)
);
"""


# ── DB ────────────────────────────────────────────────────────────────────────


def db_path(cli_value: str | None = None) -> str:
    explicit = cli_value or os.environ.get("PEOPLE_DB")
    if explicit:
        return explicit
    for candidate in DB_CANDIDATES:
        if os.path.exists(candidate):
            return candidate
    # Nothing yet: create it where this machine would expect it.
    return DB_CANDIDATES[0] if os.path.isdir("/home/node/.claude") else DB_CANDIDATES[1]


def connect(path: str | None = None, create: bool = True) -> sqlite3.Connection:
    resolved = db_path(path)
    if not create and not os.path.exists(resolved):
        raise SystemExit(
            f"contacts.db not found at {resolved}\n"
            "Add someone first on the dashboard's People page (/people)."
        )
    os.makedirs(os.path.dirname(resolved), exist_ok=True)
    conn = sqlite3.connect(resolved)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    if create:
        conn.executescript(SCHEMA)
        conn.commit()
    migrate(conn)
    return conn


def migrate(conn: sqlite3.Connection) -> None:
    """Bring an older contacts.db up to SCHEMA. Mirrored in people.ts (migrate)."""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(people)")}
    if not cols:
        return
    if "sort_order" not in cols:
        conn.execute("ALTER TABLE people ADD COLUMN sort_order INTEGER")
    # Anyone without a position goes after everyone placed, alphabetically — so
    # the page's order is always total and a new person lands at the bottom.
    # Row by row on purpose: a single UPDATE would read its own half-done writes.
    top = conn.execute("SELECT COALESCE(MAX(sort_order), -1) FROM people").fetchone()[0]
    unplaced = conn.execute(
        "SELECT id FROM people WHERE sort_order IS NULL ORDER BY name COLLATE NOCASE, id"
    ).fetchall()
    for offset, row in enumerate(unplaced, start=1):
        conn.execute("UPDATE people SET sort_order = ? WHERE id = ?", (top + offset, row[0]))
    conn.commit()


# ── Time ──────────────────────────────────────────────────────────────────────
#
# Everything is stored as local naive ISO 8601 ("2026-09-21T18:30:00"). Inputs
# may carry an offset; it is converted to local time and then
# dropped, so "days since" and the dashboard's day strip agree without either
# side knowing about time zones.


def now_local() -> datetime:
    return datetime.now().replace(microsecond=0)


def parse_ts(value: str) -> datetime:
    """Parse an ISO 8601 timestamp (offset optional, trailing Z allowed) as local."""
    text = value.strip()
    if text.endswith(("Z", "z")):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is not None:
        dt = dt.astimezone().replace(tzinfo=None)
    return dt.replace(microsecond=0)


def fmt_ts(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat()


def days_since(ts: str, today: datetime | None = None) -> int:
    """Whole days between the interaction's calendar day and today's."""
    ref = (today or now_local()).date()
    return (ref - parse_ts(ts).date()).days


# ── Phone numbers ─────────────────────────────────────────────────────────────


def normalize_phone(raw: str | None) -> str | None:
    """
    Best-effort E.164. Returns None for anything that is not a dialable number
    (blocked/unknown caller, a name, an empty cell).

    +1 (212) 555-0143  -> +12125550143
    2125550143         -> +12125550143   (DEFAULT_COUNTRY_CODE)
    012125550143       -> +12125550143   (international prefix stripped)
    """
    if not raw:
        return None
    text = raw.strip()
    if not text or text.lower() in {"unknown", "private", "restricted", "blocked", "-1", "-2"}:
        return None
    plus = text.startswith("+")
    digits = re.sub(r"\D", "", text)
    if not digits:
        return None
    if plus:
        return "+" + digits
    # 00 / 011 international prefixes
    if digits.startswith("00"):
        return "+" + digits[2:]
    if digits.startswith("011") and len(digits) > 11:
        return "+" + digits[3:]
    if len(digits) == 10:
        return "+" + DEFAULT_COUNTRY_CODE + digits
    if len(digits) == 11 and digits.startswith(DEFAULT_COUNTRY_CODE):
        return "+" + digits
    # Short codes and anything else: keep the digits, flagged by their shape.
    return "+" + digits


# ── Lookups ───────────────────────────────────────────────────────────────────


def get_people(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """In the order Daniel arranged them on the People page; unplaced people last, by name."""
    return conn.execute(
        "SELECT * FROM people ORDER BY sort_order IS NULL, sort_order, name COLLATE NOCASE"
    ).fetchall()


def find_person_by_name(conn: sqlite3.Connection, name: str) -> list[sqlite3.Row]:
    """
    Resolve a name typed in chat. Exact (case-insensitive) wins outright;
    otherwise every prefix match is returned so the caller can ask rather than
    guess. An empty list means unknown.
    """
    needle = name.strip()
    if not needle:
        return []
    exact = conn.execute(
        "SELECT * FROM people WHERE name = ? COLLATE NOCASE", (needle,)
    ).fetchall()
    if exact:
        return exact
    return conn.execute(
        "SELECT * FROM people WHERE name LIKE ? COLLATE NOCASE ORDER BY name",
        (needle + "%",),
    ).fetchall()


def match_identifier(conn: sqlite3.Connection, kind: str, value: str) -> sqlite3.Row | None:
    """
    Map a captured contact string to a person.

    phone_number:  normalized to E.164 on both sides, then compared.
    whatsapp_name: exact match first, then case-insensitive.
    """
    if kind == "phone_number":
        normalized = normalize_phone(value)
        if not normalized:
            return None
        return conn.execute(
            "SELECT p.* FROM people p JOIN identifiers i ON i.person_id = p.id "
            "WHERE i.kind = 'phone_number' AND i.value = ?",
            (normalized,),
        ).fetchone()

    exact = conn.execute(
        "SELECT p.* FROM people p JOIN identifiers i ON i.person_id = p.id "
        "WHERE i.kind = ? AND i.value = ?",
        (kind, value.strip()),
    ).fetchone()
    if exact:
        return exact
    return conn.execute(
        "SELECT p.* FROM people p JOIN identifiers i ON i.person_id = p.id "
        "WHERE i.kind = ? AND i.value = ? COLLATE NOCASE",
        (kind, value.strip()),
    ).fetchone()


# ── Rules ─────────────────────────────────────────────────────────────────────


def rules_for(conn: sqlite3.Connection, person_id: int) -> dict[str, int | None]:
    return {
        r["source"]: r["min_duration_s"]
        for r in conn.execute(
            "SELECT source, min_duration_s FROM rules WHERE person_id = ?", (person_id,)
        )
    }


def qualifies(rules: dict[str, int | None], source: str, duration_s: int | None) -> bool:
    """
    An interaction counts when the person has a rule for its source and the call
    was at least as long as that rule's minimum. No rule for the source = does
    not count, however many interactions of that source are stored.
    A minimum with no recorded duration does not count — it cannot be shown to
    have been met.
    """
    if source not in rules:
        return False
    minimum = rules[source]
    if minimum is None or minimum <= 0:
        return True
    return duration_s is not None and duration_s >= minimum


def last_qualifying(conn: sqlite3.Connection, person_id: int) -> sqlite3.Row | None:
    rules = rules_for(conn, person_id)
    rows = conn.execute(
        "SELECT * FROM interactions WHERE person_id = ? ORDER BY ts DESC", (person_id,)
    )
    for row in rows:
        if qualifies(rules, row["source"], row["duration_s"]):
            return row
    return None


def active_mute(conn: sqlite3.Connection, person_id: int, now: datetime | None = None) -> str | None:
    ref = fmt_ts(now or now_local())
    row = conn.execute(
        "SELECT until FROM mutes WHERE person_id = ? AND until > ? ORDER BY until DESC LIMIT 1",
        (person_id, ref),
    ).fetchone()
    return row["until"] if row else None


DUE_SOON_DAYS = 3  # within this many days of the threshold


def person_status(
    conn: sqlite3.Connection, person: sqlite3.Row, now: datetime | None = None
) -> dict:
    """One person's standing. Mirrored in dashboard/server/routes/people.ts."""
    ref = now or now_local()
    last = last_qualifying(conn, person["id"])
    since = days_since(last["ts"], ref) if last else None
    muted_until = active_mute(conn, person["id"], ref)
    overdue = since is not None and since > person["threshold_days"]
    if last is None:
        # Never recorded: overdue, but with nothing to report a date for.
        overdue = True

    if muted_until:
        status = "muted"
    elif overdue:
        status = "overdue"
    elif since is not None and since > person["threshold_days"] - DUE_SOON_DAYS:
        status = "due_soon"
    else:
        status = "ok"

    return {
        "id": person["id"],
        "name": person["name"],
        "threshold_days": person["threshold_days"],
        "notes": person["notes"],
        "last_ts": last["ts"] if last else None,
        "last_source": last["source"] if last else None,
        "days_since": since,
        "muted_until": muted_until,
        "overdue": overdue and not muted_until,
        "status": status,
    }


def parse_duration_to_days(text: str) -> int:
    """'2w' / '10d' / '1m' / '3' (days) → days. Raises ValueError otherwise."""
    m = re.fullmatch(r"\s*(\d+)\s*([dwmy]?)\s*", text, re.IGNORECASE)
    if not m:
        raise ValueError(f"cannot read a duration from {text!r} (try 2w, 10d, 1m)")
    n = int(m.group(1))
    unit = (m.group(2) or "d").lower()
    return n * {"d": 1, "w": 7, "m": 30, "y": 365}[unit]


def mute_until(text: str, now: datetime | None = None) -> datetime:
    """Either an absolute YYYY-MM-DD or a relative '2w'."""
    ref = now or now_local()
    try:
        return datetime.fromisoformat(text.strip()).replace(microsecond=0)
    except ValueError:
        return ref + timedelta(days=parse_duration_to_days(text))
