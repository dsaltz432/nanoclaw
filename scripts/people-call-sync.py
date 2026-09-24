#!/usr/bin/env python3
"""
Nightly: ingest new phone and WhatsApp call backups from Drive into contacts.db.

Two sources, both dropped into Drive (`Agents/`) by scheduled jobs on the phone
at 3:30 AM ET:

  Call-Backups      calls-*.xml        SMS Backup & Restore — the Android call log
  Whatsapp-Backups  msgstore.db.crypt15 WhatsApp's encrypted database (full history)

Each run, launchd on the host (4:15 AM, 7:00 AM catch-up):

  1. lists both folders with a host-only copy of the dsaltzai Drive token;
  2. for each backup not ingested before — keyed by Drive id *and* content
     checksum, since the phone may overwrite the same file nightly — downloads
     it into the private archive (~/.config/nanoclaw/people-exports, 600);
  3. loads new answered calls with tracked numbers, from 2025 on, exactly as
     people-backfill.py does (idempotent; WhatsApp calls already imported from a
     call-history CSV are recognised and not duplicated);
  4. logs every call that is NEW since the last ingest — source, time,
     direction, length, person — plus one summary line per backup;
  5. records what it ingested and prunes the archive (each backup is a full
     history, so only the newest few are kept).

WhatsApp: calls only. The .crypt15 is decrypted in memory with the key from the
macOS Keychain (people_whatsapp.py); the plaintext database never touches disk
and no message is read. The *encrypted* file is kept, so messages for chosen
people could be extracted later if Daniel decides to.

Host-only by design. These backups name everyone Daniel talks to, so they never
pass through an agent container — this is a launchd job, not a scheduled task,
and its log lives outside the repo (which the main group mounts read-only).
Numbers that match nobody are counted, never listed.

It can't remove the backups from Drive: the phone uploads them as Daniel's main
account, and only the owner can trash a file. Retention there is the phone
apps' setting (last 10).

Usage:
  people-call-sync.py              # normal run (launchd)
  people-call-sync.py --dry-run    # show what would be ingested; write nothing

Requires the venv built by scripts/install-people-call-sync-plist.sh
(google-auth, requests, wa-crypt-tools; Python >= 3.11).
"""
from __future__ import annotations

import argparse
import contextlib
import importlib.util
import io
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from drive_common import API, session_or_exit  # noqa: E402
import people_common as pc  # noqa: E402

_spec = importlib.util.spec_from_file_location("people_backfill", os.path.join(HERE, "people-backfill.py"))
bf = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bf)  # type: ignore[union-attr]

# A host-only copy of the dsaltzai token. The people *container* deliberately
# has no Drive token: these folders hold full call logs, and nothing in the
# container needs Drive.
TOKEN = os.environ.get(
    "PEOPLE_DRIVE_TOKEN", os.path.expanduser("~/.config/nanoclaw/people-drive-credentials.json")
)
STATE = os.path.join(bf.ARCHIVE, "sync-state.json")
STALE_AFTER_H = 48  # warn when a source's newest backup is older than this

SOURCES = {
    "calls": {
        "folder": "Call-Backups",
        "label": "phone",
        "archive": bf.ARCHIVE_CALLS,
        "keep": 14,
        "wanted": lambda name: name.lower().startswith("calls") and name.lower().endswith(".xml"),
        # calls-YYYYMMDDhhmmss.xml is already unique and sortable
        "local_name": lambda f: os.path.basename(f["name"]),
    },
    "whatsapp": {
        "folder": "Whatsapp-Backups",
        "label": "WhatsApp",
        "archive": bf.ARCHIVE_WA_BACKUPS,
        "keep": 3,
        "wanted": lambda name: name.lower().endswith(".crypt15"),
        # always "msgstore.db.crypt15" on Drive: name it by Drive's timestamp
        "local_name": lambda f: "msgstore-{}.db.crypt15".format(
            f["modifiedTime"].replace("-", "").replace(":", "").split(".")[0] + "Z"),
    },
}


def log(msg: str) -> None:
    print(f"{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  {msg}", flush=True)


# ── State ─────────────────────────────────────────────────────────────────────


def load_state() -> dict:
    try:
        with open(STATE) as fh:
            state = json.load(fh)
    except FileNotFoundError:
        state = {}
    if "sources" not in state:  # v1: {"folder_id", "ingested": {drive id: {...}}} — calls only
        state = {"sources": {"calls": {"folder_id": state.get("folder_id"),
                                        "done": state.get("ingested", {})}}}
    for key in SOURCES:
        state["sources"].setdefault(key, {"folder_id": None, "done": {}})
    return state


def save_state(state: dict) -> None:
    bf._private_dir(bf.ARCHIVE)
    tmp = STATE + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(state, fh, indent=2, sort_keys=True)
    os.chmod(tmp, 0o600)
    os.replace(tmp, STATE)


def done_key(f: dict) -> str:
    return f"{f['id']}:{f.get('md5Checksum', '')}"


def already_done(done: dict, f: dict) -> bool:
    if done_key(f) in done:
        return True
    # v1 entries were keyed by Drive id alone (calls-*.xml files, never rewritten)
    return f["id"] in done


# ── Drive ─────────────────────────────────────────────────────────────────────


def find_folder(session, name: str) -> str:
    q = (f"name = '{name}' and mimeType = 'application/vnd.google-apps.folder' "
         "and trashed = false")
    r = session.get(API, params={"q": q, "fields": "files(id,name)", "supportsAllDrives": "true",
                                 "includeItemsFromAllDrives": "true"})
    r.raise_for_status()
    files = r.json().get("files", [])
    if len(files) != 1:
        raise RuntimeError(f"expected exactly one '{name}' folder visible to dsaltzai, found {len(files)}")
    return files[0]["id"]


def list_backups(session, folder_id: str, wanted) -> list[dict]:
    out, token = [], None
    while True:
        params = {
            "q": f"'{folder_id}' in parents and trashed = false",
            "fields": "nextPageToken, files(id,name,size,createdTime,modifiedTime,md5Checksum)",
            "orderBy": "modifiedTime", "pageSize": 100,
            "supportsAllDrives": "true", "includeItemsFromAllDrives": "true",
        }
        if token:
            params["pageToken"] = token
        r = session.get(API, params=params)
        r.raise_for_status()
        body = r.json()
        out += [f for f in body.get("files", []) if wanted(f["name"])]
        token = body.get("nextPageToken")
        if not token:
            return out


def download(session, file_id: str, dest: str) -> None:
    bf._private_dir(os.path.dirname(dest))
    r = session.get(f"{API}/{file_id}", params={"alt": "media", "supportsAllDrives": "true"})
    r.raise_for_status()
    tmp = dest + ".part"
    with open(tmp, "wb") as fh:
        fh.write(r.content)
    os.chmod(tmp, 0o600)
    os.replace(tmp, dest)


def prune(archive: str, keep: int) -> None:
    if not os.path.isdir(archive):
        return
    files = sorted(f for f in os.listdir(archive) if not f.startswith("."))
    for old in files[:-keep]:
        os.remove(os.path.join(archive, old))
        log(f"archive: removed old backup {old} (keeping newest {keep})")


# ── Ingest ────────────────────────────────────────────────────────────────────


def fmt_len(seconds: int | None) -> str:
    if not seconds:
        return "—"
    m, s = divmod(seconds, 60)
    return f"{m}m{s:02d}s" if m < 60 else f"{m // 60}h{m % 60:02d}m"


def ingest(conn, key: str, path: str, dry_run: bool) -> tuple[int, str | None]:
    """Load one backup. Returns (new calls, error)."""
    src = SOURCES[key]
    writer = bf.Writer(conn, dry_run, bf.DEFAULT_SINCE)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            if key == "calls":
                stats = bf.backfill_calls(conn, path, writer, show=0)
            else:
                stats = bf.backfill_whatsapp_backup(conn, path, writer)
    except BaseException:
        conn.rollback()
        raise
    if stats.get("error"):
        conn.rollback()
        return 0, stats["error"]
    writer.finish()

    verb = "would add" if dry_run else "new"
    extra = ""
    if key == "whatsapp":
        extra = f" · {sum(writer.present[n]['whatsapp'] for n in writer.present)} already recorded"
    # calls.xml: every call in the log; WhatsApp: answered one-to-one calls only.
    read = "calls in the log" if key == "calls" else "answered calls"
    log(f"{src['label']} · {os.path.basename(path)}: {stats['read']} {read} · "
        f"{len(writer.new_rows)} {verb}{extra} · "
        f"{stats['unmatched_calls']} with untracked numbers (not stored)")
    for name, ts, _source, direction, duration in sorted(writer.new_rows, key=lambda r: r[1]):
        arrow = {"in": "←", "out": "→"}.get(direction, "·")
        log(f"  {verb}: {src['label']:<8} {ts.replace('T', ' ')}  {arrow} {direction:<3}  "
            f"{fmt_len(duration):>7}  {name}")
    return len(writer.new_rows), None


def main() -> int:
    ap = argparse.ArgumentParser(description="Ingest new call backups from Drive")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--db")
    args = ap.parse_args()

    session = session_or_exit(TOKEN)
    state = load_state()
    conn = pc.connect(args.db, create=False)
    scratch = tempfile.TemporaryDirectory() if args.dry_run else None
    total_new, failures = 0, 0

    for key, src in SOURCES.items():
        st = state["sources"][key]
        try:
            st["folder_id"] = st.get("folder_id") or find_folder(session, src["folder"])
            backups = list_backups(session, st["folder_id"], src["wanted"])
        except Exception as exc:
            log(f"ERROR {src['label']}: can't read Drive folder {src['folder']}: {exc}")
            failures += 1
            continue

        if not backups:
            log(f"WARN {src['label']}: no backups in {src['folder']} — is the phone's scheduled backup running?")
            continue
        newest = backups[-1]
        age_h = (datetime.now(timezone.utc) - datetime.fromisoformat(
            newest["modifiedTime"].replace("Z", "+00:00"))).total_seconds() / 3600
        if age_h > STALE_AFTER_H:
            log(f"WARN {src['label']}: newest backup is {age_h:.0f}h old — "
                "the phone's scheduled backup may have stopped")

        todo = [f for f in backups if not already_done(st["done"], f)]
        # A WhatsApp backup is the whole history: only the newest pending one matters.
        if key == "whatsapp":
            todo = todo[-1:]
        if not todo:
            log(f"{src['label']}: nothing new ({len(backups)} on Drive, all ingested)")
            continue

        for f in todo:
            dest_dir = scratch.name if scratch else src["archive"]
            dest = os.path.join(dest_dir, src["local_name"](f))
            try:
                download(session, f["id"], dest)
                n, error = ingest(conn, key, dest, args.dry_run)
            except Exception as exc:
                log(f"ERROR {src['label']} · {f['name']}: {type(exc).__name__}: {exc}")
                failures += 1
                continue
            if error:
                log(f"ERROR {src['label']} · {f['name']}: {error}")
                failures += 1
                continue
            total_new += n
            if not args.dry_run:
                st["done"][done_key(f)] = {
                    "name": f["name"], "modified": f["modifiedTime"],
                    "ingested_at": datetime.now().isoformat(timespec="seconds"),
                    "new_calls": n,
                }
        if not args.dry_run:
            prune(src["archive"], src["keep"])

    if args.dry_run:
        log(f"dry run — {total_new} calls would be added; nothing written, state unchanged")
    else:
        save_state(state)
        log(f"done: {total_new} new calls" + (f", {failures} error(s)" if failures else ""))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
