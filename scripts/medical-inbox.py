#!/usr/bin/env python3
"""
Medical inbox triage for the nightly ingest proposal: which inbox files are
pending, and how many nights each has been proposed. Deterministic so the
agent never has to judge "processed" or count nights itself.

Ledger rule (from the medical repo's .claude/skills/ingest-updates/SKILL.md):
a file is PROCESSED iff its exact title appears in PROJECT-NOTES.md's
"5. Changelog" section; everything else is PENDING. Whitespace is normalized
before matching (changelog lines wrap mid-title); nothing else is.

Kinds: Google Docs are "note"s. Everything else (photos, PDFs) is an "original"
— a source document that accompanies a note. Originals never trigger a Telegram
message on their own; they are reported in the proposal file.

Night counting: a state file records each date a pending title was proposed
(one entry per local date, so reruns the same day don't count twice). Titles
no longer pending are dropped. Per note:
  night 1–5  telegram = "list"
  night 6    telegram = "announce-drop"  (say once that it's leaving Telegram)
  night 7+   telegram = "omit"           (proposal file only)

Titles passed via --exclude (already in the open ingest PR, or in a PR that was
closed unmerged) are counted as "claimed", never as pending.

Read-only on Drive and on the repo. Writes only the state file.

Usage (medical container):
  python3 /home/node/nanoclaw/scripts/medical-inbox.py \\
      --inbox <folder-id> --notes /workspace/extra/repo/PROJECT-NOTES.md \\
      [--state /workspace/group/state/proposal-nights.json] [--no-record]

Prints one JSON object. Exit 1 if the inbox can't be listed or the changelog
section can't be found (the ledger is then unknowable — propose nothing).
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime

from drive_common import GOOGLE_DOC, FOLDER, list_folder, session_or_exit

LIST_NIGHTS = 5


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def changelog(path: str) -> str:
    with open(path) as f:
        text = f.read()
    m = re.search(r"^##\s*5\.\s*Changelog\s*$(.*?)(?=^##\s|\Z)", text, re.M | re.S)
    if not m:
        raise LookupError(f'no "## 5. Changelog" section in {path}')
    return norm(m.group(1))


def load_state(path: str) -> dict:
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_state(path: str, state: dict) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False, sort_keys=True)
    os.replace(tmp, path)


def telegram_state(night: int) -> str:
    if night <= LIST_NIGHTS:
        return "list"
    return "announce-drop" if night == LIST_NIGHTS + 1 else "omit"


def main() -> int:
    ap = argparse.ArgumentParser(description="Pending medical inbox notes + night counts")
    ap.add_argument("--inbox", required=True, help="Drive folder ID of Agents/inbox/pending")
    ap.add_argument("--notes", required=True, help="Path to the repo's PROJECT-NOTES.md")
    ap.add_argument("--state", default="/workspace/group/state/proposal-nights.json")
    ap.add_argument("--no-record", action="store_true", help="Don't update the night ledger")
    ap.add_argument("--exclude", help="JSON file: list of titles already claimed (open PR or "
                    "rejected); reported as claimed, never as pending")
    ap.add_argument("--token", help="Path to drive-credentials.json")
    args = ap.parse_args()

    today = datetime.now().astimezone().date().isoformat()
    try:
        log = changelog(args.notes)
    except (OSError, LookupError) as e:
        print(json.dumps({"error": f"changelog unreadable: {e}"}))
        return 1

    session = session_or_exit(args.token)
    try:
        files = [f for f in list_folder(session, args.inbox) if f["mimeType"] != FOLDER]
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"error": f"inbox list failed: {e}"}))
        return 1

    claimed = set()
    if args.exclude:
        with open(args.exclude) as fh:
            claimed = {norm(t) for t in json.load(fh)}
    unprocessed = [f for f in files if norm(f["name"]) not in log]
    pending = [f for f in unprocessed if norm(f["name"]) not in claimed]
    state = load_state(args.state)
    new_state = {}
    for f in pending:
        dates = sorted(set(state.get(f["name"], [])) | {today})
        new_state[f["name"]] = dates
        f["kind"] = "note" if f["mimeType"] == GOOGLE_DOC else "original"
        f["night"] = len(dates)
        f["first_proposed"] = dates[0]
        f["telegram"] = telegram_state(f["night"]) if f["kind"] == "note" else "omit"
    if not args.no_record:
        save_state(args.state, new_state)

    notes = [f for f in pending if f["kind"] == "note"]
    print(json.dumps({
        "date": today,
        "inbox_files": len(files),
        "processed": len(files) - len(unprocessed),
        "claimed": len(unprocessed) - len(pending),
        "pending_notes": len(notes),
        "pending_originals": len(pending) - len(notes),
        "should_message": any(f["telegram"] in ("list", "announce-drop") for f in notes),
        "pending": pending,
    }, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
