#!/usr/bin/env python3
# Patch the Health Watchdog prompt (2026-11-14): quiet false alarms in check 8.
#   - ff-content.* rows (third-party expert sites) get two-run confirmation for
#     job-stale / job-nolog, like missing probe files.
#   - A FAIL: state in the 5th field is not a finding on its own; only age is.
# The ffballers Tuesday window and the sqlite busy timeout live in heartbeat.sh.
# Saves the current prompt to groups/telegram_ops/watchdog-prompt.bak-<date>-pre-ff-noise.md.
# Idempotent: exits without changes if already applied.

import datetime
import pathlib
import sqlite3
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DB = ROOT / "store" / "messages.db"
MARKER = "**`ff-content.*` rows get two-run confirmation.**"

conn = sqlite3.connect(str(DB))
cur = conn.cursor()
cur.execute("SELECT id, prompt FROM scheduled_tasks WHERE name = 'Health Watchdog'")
row = cur.fetchone()
if not row:
    sys.exit("ERROR: no Health Watchdog row found")
task_id, prompt = row

if MARKER in prompt:
    sys.exit("already patched — nothing to do")

ANCHOR = """- `kind=event` -> **never alert**. These are WatchPaths-triggered and are
  idle by design; both have legitimately been dormant for months."""
if prompt.count(ANCHOR) != 1:
    sys.exit("ERROR: check-8 kind=event anchor not found exactly once")

ADDITION = ANCHOR + """
- """ + MARKER + """ For `job-stale:ff-content.*` and
  `job-nolog:ff-content.*`: the first run that sees it records the key in
  `pending{}` and sends nothing; the next run alerts if it is still stale or
  missing, and drops it silently if it recovered. These rows scrape third-party
  sites, and every one of them that alerted between 2026-10-20 and 11-10 was a
  near miss that cleared by itself: one 502 put draftsharks 4 minutes over its
  limit, daily rankings ran a few minutes late, a locked database read showed
  as `age_min=-1 query-failed`. A parser that is really broken stays stale and
  still alerts 30 minutes later. Plain `com.nanoclaw.*` jobs keep first-sight
  alerting.
- The 5th field (`ok` or `FAIL:<error>`) only NAMES the fault inside a stale
  alert. A row whose `age_min` is within `max_age_min` is fine even if its
  latest run says `FAIL:` — the adapter retries on its own schedule, and if it
  keeps failing the age rule catches it. Never alert on `FAIL:` alone.
- `max_age_min` already includes known windows (e.g. ffballers rankings on
  Tuesday mornings, set by the heartbeat). Trust the number in the row."""

backup = ROOT / "groups" / "telegram_ops" / f"watchdog-prompt.bak-{datetime.date.today()}-pre-ff-noise.md"
backup.write_text(prompt)
print(f"backed up current prompt to {backup}")

prompt = prompt.replace(ANCHOR, ADDITION, 1)
cur.execute("UPDATE scheduled_tasks SET prompt = ? WHERE id = ?", (prompt, task_id))
conn.commit()
print(f"patched {task_id}: prompt now {len(prompt)} chars")
