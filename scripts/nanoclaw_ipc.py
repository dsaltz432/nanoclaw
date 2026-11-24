"""Send a Telegram message from a HOST script through NanoClaw's IPC queue.

Agents send with the send_message MCP tool, which writes a JSON file into
data/ipc/<group>/messages/; the NanoClaw process polls that directory every
second, checks the group is allowed to message the chat, and delivers it.
Host jobs that run without an agent (tickets-pricer.py, watchdog.py) drop the
same file, so their messages arrive exactly like an agent's would.

Same atomic write as container/agent-runner/src/ipc-mcp-stdio.ts: write a .tmp
then rename, because the poller only picks up *.json.
"""
from __future__ import annotations

import json
import os
import random
import string
import time

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def send_message(group_folder: str, chat_jid: str, text: str) -> str:
    d = os.path.join(PROJECT_ROOT, "data", "ipc", group_folder, "messages")
    os.makedirs(d, exist_ok=True)
    name = "%d-%s.json" % (int(time.time() * 1000),
                           "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6)))
    path = os.path.join(d, name)
    with open(path + ".tmp", "w") as f:
        json.dump({"type": "message", "chatJid": chat_jid, "text": text,
                   "groupFolder": group_folder,
                   "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, f, indent=2)
    os.rename(path + ".tmp", path)
    return name


def group_jid(group_folder: str) -> str:
    """The chat a group is registered to (registered_groups.jid)."""
    import sqlite3
    db = os.path.join(PROJECT_ROOT, "store", "messages.db")
    conn = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=10)
    try:
        row = conn.execute("SELECT jid FROM registered_groups WHERE folder = ?", (group_folder,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise RuntimeError("group %s is not registered" % group_folder)
    return row[0]
