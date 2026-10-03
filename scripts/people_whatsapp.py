"""
WhatsApp calls from an encrypted msgstore.db.crypt15 backup — calls only.

The backup is Daniel's entire WhatsApp history: a full msgstore.db.crypt15
plus daily msgstore-increment-N.db.crypt15 files holding the changes since.
This module decrypts the full backup **in memory** (sqlite3 deserialize — the
plaintext database never touches the disk), replays only the call_log / jid /
jid_map change sets from each increment onto it, reads the `call_log` table and
nothing else, and returns one-to-one calls as plain tuples. Messages are never
read, returned or stored.

Only the .crypt15 format (the 64-digit end-to-end key) is supported. Older
.crypt14 files were made with WhatsApp's device key and are ignored.

The key is the 64-digit end-to-end backup key, held in the macOS Keychain as
generic password `whatsapp-backup-key` and read with /usr/bin/security (which
created the item, so no access prompt). It is never printed, logged or written
anywhere: wa_crypt_tools' Key15.__str__ prints the raw key, so key objects must
never reach a log line or an exception message.

Host-only. Needs wa-crypt-tools (pinned in the people-call-sync venv) and
Python >= 3.11 for Connection.deserialize.
"""
from __future__ import annotations

import io
import json
import logging
import os
import re
import sqlite3
import subprocess
import zipfile
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


def _decrypt(path: str, key) -> bytes:
    """One .crypt15 file → its decompressed payload (SQLite for a full backup, ZIP for an increment)."""
    from wa_crypt_tools.lib.db.dbfactory import DatabaseFactory
    try:
        with open(path, "rb") as fh:
            db = DatabaseFactory.from_file(fh)
            decrypted = db.decrypt(key, fh.read())
    except Exception as exc:  # never let the library's message (or key repr) through
        raise BackupError(
            f"{os.path.basename(path)}: decryption failed ({type(exc).__name__}) — wrong key or damaged backup"
        ) from None
    # The library only *logs* an auth-tag mismatch, so validate the result here.
    try:
        return zlib.decompress(decrypted)
    except zlib.error:
        raise BackupError(
            f"{os.path.basename(path)}: decrypted data didn't decompress — wrong key or damaged backup"
        ) from None


def _key():
    try:
        from wa_crypt_tools.lib.key.keyfactory import KeyFactory  # noqa: F401
    except ImportError:
        raise BackupError("wa-crypt-tools is not installed in this Python") from None
    logging.getLogger("wa_crypt_tools").setLevel(logging.CRITICAL)
    return KeyFactory.from_hex(_read_key())


# What an increment contributes. Each increment is a ZIP of per-table change
# sets; these three are the only members ever opened. messages.bin and every
# other member (chats, receipts, media refs…) are never read.
_INCREMENT_TABLES = ("call_log", "jid", "jid_map")
_INCREMENT_MEMBER = re.compile(r"^(call_log|jid|jid_map)_modified_\d+\.json$")


def _apply_increment(conn: sqlite3.Connection, payload: bytes, name: str) -> None:
    if not payload.startswith(b"PK\x03\x04"):
        raise BackupError(f"{name}: increment is not a ZIP archive")
    with zipfile.ZipFile(io.BytesIO(payload)) as zf:
        for member in zf.namelist():
            m = _INCREMENT_MEMBER.match(member)
            if not m:
                continue
            table = m.group(1)
            rows = json.loads(zf.read(member)).get(table, [])
            cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
            for row in rows:
                keep = [k for k in row if k in cols]
                if not keep:
                    continue
                conn.execute(
                    f"INSERT OR REPLACE INTO {table} ({', '.join(keep)}) "
                    f"VALUES ({', '.join('?' * len(keep))})",
                    [row[k] for k in keep],
                )


def open_backup(path: str, increments: list[str] | None = None) -> sqlite3.Connection:
    """
    Decrypt a full backup into an in-memory SQLite connection, then replay its
    increments (in the order given) onto it — call_log / jid / jid_map rows
    only. Caller closes it. Nothing decrypted is ever written to disk.
    """
    key = _key()
    try:
        plain = _decrypt(path, key)
        if not plain.startswith(b"SQLite format 3\x00"):
            raise BackupError(f"{os.path.basename(path)}: not a full backup (decrypted data isn't SQLite)")
        conn = sqlite3.connect(":memory:")
        conn.deserialize(plain)
        del plain
        try:
            for inc in increments or []:
                _apply_increment(conn, _decrypt(inc, key), os.path.basename(inc))
        except Exception:
            conn.close()
            raise
        return conn
    finally:
        del key


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
