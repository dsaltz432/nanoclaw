#!/usr/bin/env python3
# Patch the Health Watchdog prompt (2026-11-14): add the Home Assistant backstop.
#   1. Check 1: add com.nanoclaw.ha-probe to the expected launchd labels.
#   2. New check 13: relay FINDING lines from health-probe/home-assistant/status.txt.
# Saves the current prompt to groups/telegram_ops/watchdog-prompt.bak-<date>.md first.
# Idempotent: exits without changes if check 13 is already present.

import datetime
import pathlib
import sqlite3
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DB = ROOT / "store" / "messages.db"

conn = sqlite3.connect(str(DB))
cur = conn.cursor()
cur.execute("SELECT id, prompt FROM scheduled_tasks WHERE name = 'Health Watchdog'")
row = cur.fetchone()
if not row:
    sys.exit("ERROR: no Health Watchdog row found")
task_id, prompt = row

if "### 13. Home Assistant" in prompt:
    sys.exit("already patched — nothing to do")

backup = ROOT / "groups" / "telegram_ops" / f"watchdog-prompt.bak-{datetime.date.today()}-pre-ha.md"
backup.write_text(prompt)
print(f"backed up current prompt to {backup}")

OLD_LABEL = "- `com.nanoclaw.ff-live`         (interval; PID \"-\" with exit 0 is fine)"
NEW_LABEL = OLD_LABEL + "\n- `com.nanoclaw.ha-probe`       (interval, every 30 min; PID \"-\" with exit 0 is fine)"
if OLD_LABEL not in prompt:
    sys.exit("ERROR: ff-live label marker not found")
prompt = prompt.replace(OLD_LABEL, NEW_LABEL, 1)

CHECK13 = """### 13. Home Assistant (backstop)

The host job `com.nanoclaw.ha-probe` pulls a read-only status bundle from the
Home Assistant Green every 30 min and applies FIXED rules to it. You only relay
what those rules decided. Do not read `bundle.txt`, do not interpret Home
Assistant logs, and do not add findings of your own — open-ended log review is
the separate "Home Assistant Triage" task's job.

Read `home-assistant/status.txt` with read_probe (i.e.
`/workspace/extra/health-probe/home-assistant/status.txt`).

- File missing or empty -> HIGH ("Home Assistant probe output missing — is
  com.nanoclaw.ha-probe running?"). Finding key: `ha-probe-missing`. Two-run
  confirmation applies.
- `probe_at=` older than 75 minutes -> HIGH ("Home Assistant probe is stale:
  last run <probe_at>"). Finding key: `ha-probe-stale`. Two-run confirmation applies.
- Each line `FINDING|<severity>|<key>|<message>` -> alert at that severity
  (`critical` -> Critical, `high` -> High), quoting `<message>` verbatim. The
  finding key is `<key>` exactly as written. Normal dedupe: re-alert only if it
  clears and recurs, or 24 hours pass.
- Exception: keys `ha-unreachable` and `ha-error` mean the Mac could not reach
  or read the Green this run — a Wi-Fi blip or a reboot looks the same. Treat
  them under two-run confirmation like a missing probe file.
- No FINDING lines and a fresh `probe_at` -> Home Assistant is fine; say nothing.

For any Home Assistant alert, end the bullet with: "_(diagnose from the laptop
with the home-assistant skill; no automatic fixes)_".

## Alert message format"""

OLD_FMT = "## Alert message format"
if prompt.count(OLD_FMT) != 1:
    sys.exit("ERROR: alert-format marker not found exactly once")
prompt = prompt.replace(OLD_FMT, CHECK13, 1)

cur.execute("UPDATE scheduled_tasks SET prompt = ? WHERE id = ?", (prompt, task_id))
conn.commit()
print(f"patched {task_id}: prompt now {len(prompt)} chars")
