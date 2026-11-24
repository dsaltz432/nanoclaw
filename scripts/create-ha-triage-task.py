#!/usr/bin/env python3
# Create (or refresh the prompt of) the "Home Assistant Triage" scheduled task
# in the telegram_ops group, next to the Health Watchdog. Added 2026-11-14.
#
#   /usr/bin/python3 scripts/create-ha-triage-task.py            # create / update prompt
#   /usr/bin/python3 scripts/create-ha-triage-task.py --run-now  # also make it due now (test)
#
# The prompt lives in groups/telegram_ops/ha-triage-prompt.md (edit there, re-run).
# silent=1: only explicit send_message calls reach the chat (docs/message-delivery.md).

import datetime
import pathlib
import sqlite3
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DB = ROOT / "store" / "messages.db"
PROMPT = (ROOT / "groups" / "telegram_ops" / "ha-triage-prompt.md").read_text()
NAME = "Home Assistant Triage"
CRON = "0 7,19 * * *"   # local time (task scheduler uses system TZ)

conn = sqlite3.connect(str(DB))
cur = conn.cursor()

cur.execute("SELECT chat_jid FROM scheduled_tasks WHERE name = 'Health Watchdog'")
row = cur.fetchone()
if not row:
    sys.exit("ERROR: Health Watchdog not found — need its chat_jid")
chat_jid = row[0]

now = datetime.datetime.now(datetime.timezone.utc)
iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%S.000Z")

cur.execute("SELECT id FROM scheduled_tasks WHERE name = ?", (NAME,))
existing = cur.fetchone()
if existing:
    task_id = existing[0]
    cur.execute("UPDATE scheduled_tasks SET prompt = ? WHERE id = ?", (PROMPT, task_id))
    print(f"updated prompt of {task_id}")
else:
    task_id = f"ha-triage-{int(now.timestamp())}"
    # Next 07:00 or 19:00 local; the scheduler recomputes from the cron after each run.
    local = datetime.datetime.now().astimezone()
    cands = [local.replace(hour=h, minute=0, second=0, microsecond=0) + datetime.timedelta(days=d)
             for d in (0, 1) for h in (7, 19)]
    nxt = min(c for c in cands if c > local).astimezone(datetime.timezone.utc)
    cur.execute(
        """INSERT INTO scheduled_tasks
           (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
            next_run, status, created_at, context_mode, name, silent)
           VALUES (?, 'telegram_ops', ?, ?, 'cron', ?, ?, 'active', ?, 'isolated', ?, 1)""",
        (task_id, chat_jid, PROMPT, CRON, iso(nxt), iso(now), NAME),
    )
    print(f"created {task_id}, first run {iso(nxt)}")

if "--run-now" in sys.argv:
    cur.execute("UPDATE scheduled_tasks SET next_run = ? WHERE id = ?", (iso(now), task_id))
    print("marked due now")

conn.commit()
