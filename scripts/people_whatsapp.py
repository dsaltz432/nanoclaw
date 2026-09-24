"""
WhatsApp calls from an encrypted msgstore.db.crypt15 backup — calls only.

The backup is Daniel's entire WhatsApp history. This module decrypts it
**in memory** (sqlite3 deserialize — the plaintext database never touches the
disk), reads the `call_log` table and nothing else, and returns one-to-one
calls as plain tuples. Messages are never read, returned or stored.

The key is the 64-digit end-to-end backup key, held in the macOS Keychain as
generic password `whatsapp-backup-key` and read with /usr/bin/security (which
created the item, so no access prompt). It is never printed, logged or written
anywhere: wa_crypt_tools' Key15.__str__ prints the raw key, so key objects must
never reach a log line or an exception message.

Host-only. Needs wa-crypt-tools (pinned in the people-call-sync venv) and
Python >= 3.11 for Connection.deserialize.
"""
from __future__ import annotations

import logging
import re
import sqlite3
import subprocess
import zlib
from datetime import datetime
from typing import NamedTuple

KEYCHAIN_SERVICE = "whatsapp-backup-key"


class WhatsAppCall(NamedTuple):
    phone: str          # E.164, e.g. +12125550143
    started: datetime   # local naive
    direction: str      # "in" / "out"
    duration_s: int
    video: bool


class BackupError(Exception):
    """Decryption or format failure. Messages never include the key."""


def _read_key() -> str:
    try:
        out = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True, text=True, timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise BackupError(f"could not run /usr/bin/security: {type(exc).__name__}") from None
    if out.returncode != 0:
        raise BackupError(
            f"Keychain item '{KEYCHAIN_SERVICE}' not readable (security exit {out.returncode}); "
            "is the login keychain unlocked?"
        )
    hexkey = re.sub(r"\s", "", out.stdout).lower()
    if not re.fullmatch(r"[0-9a-f]{64}", hexkey):
        raise BackupError(f"Keychain item '{KEYCHAIN_SERVICE}' is not a 64-digit hex key")
    return hexkey


def open_backup(path: str) -> sqlite3.Connection:
    """Decrypt + decompress into an in-memory SQLite connection. Caller closes it."""
    try:
        from wa_crypt_tools.lib.db.dbfactory import DatabaseFactory
        from wa_crypt_tools.lib.key.keyfactory import KeyFactory
    except ImportError:
        raise BackupError("wa-crypt-tools is not installed in this Python") from None
    logging.getLogger("wa_crypt_tools").setLevel(logging.CRITICAL)

    key = KeyFactory.from_hex(_read_key())
    try:
        with open(path, "rb") as fh:
            db = DatabaseFactory.from_file(fh)
            encrypted = fh.read()
        decrypted = db.decrypt(key, encrypted)
    except Exception as exc:  # never let the library's message (or key repr) through
        raise BackupError(f"decryption failed ({type(exc).__name__}) — wrong key or damaged backup") from None
    finally:
        del key
    del encrypted

    # The library only *logs* an auth-tag mismatch, so validate the result here.
    try:
        plain = zlib.decompress(decrypted)
    except zlib.error:
        raise BackupError("decrypted data didn't decompress — wrong key or damaged backup") from None
    finally:
        del decrypted
    if not plain.startswith(b"SQLite format 3\x00"):
        raise BackupError("decrypted data is not a SQLite database")

    conn = sqlite3.connect(":memory:")
    conn.deserialize(plain)
    del plain
    return conn


# One-to-one calls only. Newer WhatsApp stores many contacts under a private
# "lid" jid; jid_map links it to the phone-number jid (server s.whatsapp.net).
# Group calls (group_jid_row_id set) are skipped: the other party isn't one person.
_CALLS_SQL = """
SELECT c.timestamp, c.from_me, c.duration, c.video_call,
       CASE WHEN j.server = 's.whatsapp.net' THEN j.user
            WHEN pj.server = 's.whatsapp.net' THEN pj.user END AS phone_user
FROM call_log c
JOIN jid j ON j._id = c.jid_row_id
LEFT JOIN jid_map m ON m.lid_row_id = j._id
LEFT JOIN jid pj ON pj._id = m.jid_row_id
WHERE COALESCE(c.group_jid_row_id, 0) = 0
  AND j.server IN ('s.whatsapp.net', 'lid')
"""


def calls(conn: sqlite3.Connection) -> tuple[list[WhatsAppCall], dict]:
    """Answered one-to-one calls, plus counts of what was skipped and why."""
    out: list[WhatsAppCall] = []
    skipped = {"unanswered": 0, "no phone number": 0}
    for ts_ms, from_me, duration, video, phone_user in conn.execute(_CALLS_SQL):
        if not duration or duration <= 0:
            skipped["unanswered"] += 1
            continue
        if not phone_user:
            skipped["no phone number"] += 1
            continue
        out.append(WhatsAppCall(
            phone="+" + str(phone_user),
            started=datetime.fromtimestamp(ts_ms / 1000).replace(microsecond=0),
            direction="out" if from_me else "in",
            duration_s=int(duration),
            video=bool(video),
        ))
    total = conn.execute("SELECT COUNT(*) FROM call_log").fetchone()[0]
    skipped["group or other"] = total - len(out) - sum(skipped.values())
    return out, skipped
