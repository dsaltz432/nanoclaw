#!/usr/bin/env python3
# One-time patch for the Health Watchdog prompt:
#   1. Dashboard exit 143 (SIGTERM) → never alert (was "LOW unless persistent")
#   2. Service error logs → only scan files whose mtime is within the last 60 min,
#      since Node stack traces lack per-line timestamps and stale tracebacks
#      would otherwise trigger false-positive alerts.

import sqlite3
import sys
import pathlib

DB = pathlib.Path(__file__).resolve().parent.parent / "store" / "messages.db"

conn = sqlite3.connect(str(DB))
cur = conn.cursor()
cur.execute("SELECT prompt FROM scheduled_tasks WHERE name = 'Health Watchdog'")
row = cur.fetchone()
if not row:
    sys.exit("ERROR: no Health Watchdog row found")
prompt = row[0]
before = len(prompt)

OLD_EXIT = "Exception: exit 143 (SIGTERM, graceful restart) is LOW — only alert if it persists across two consecutive runs."
NEW_EXIT = "Exception: exit 143 (SIGTERM, graceful restart) — do NOT alert. 143 is normal launchctl behavior (e.g. kickstart/reload) and is not actionable."
if OLD_EXIT not in prompt:
    sys.exit("ERROR: exit-143 marker not found (patch may already be applied)")
prompt = prompt.replace(OLD_EXIT, NEW_EXIT)

OLD_HEAD = "Tail the last 50 lines of each:"
NEW_HEAD = "For each of these files:"
if OLD_HEAD not in prompt:
    sys.exit("ERROR: logs-head marker not found")
prompt = prompt.replace(OLD_HEAD, NEW_HEAD, 1)

OLD_TAIL = "Look for entries timestamped within the last 60 min. Anything containing `Error:`, `Exception:`, `Fatal`, `ERROR ` -> HIGH alert. Cite the actual line."
NEW_TAIL = (
    "**First check the file's mtime** (e.g. `stat -c %Y <file>` on Linux, or "
    "`find <file> -mmin -60`). **Skip the file entirely if it has not been "
    "modified in the last 60 minutes.** Node.js stack traces and similar dumps "
    "don't carry per-line timestamps, so file mtime is the only reliable "
    "freshness signal. A multi-month-old traceback in a never-rotated log is "
    "not a current problem — do NOT alert on it.\n\n"
    "For files whose mtime is within the last 60 min, tail the last 50 lines "
    "and alert HIGH on anything containing `Error:`, `Exception:`, `Fatal`, or "
    "`ERROR `. Cite the actual line."
)
if OLD_TAIL not in prompt:
    sys.exit("ERROR: logs-tail marker not found")
prompt = prompt.replace(OLD_TAIL, NEW_TAIL)

cur.execute(
    "UPDATE scheduled_tasks SET prompt = ? WHERE name = 'Health Watchdog'",
    (prompt,),
)
conn.commit()
print(f"len {before} -> {len(prompt)} ({len(prompt)-before:+d}), updated rows: {cur.rowcount}")
conn.close()
