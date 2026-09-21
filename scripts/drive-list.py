#!/usr/bin/env python3
"""
List the files directly in a Google Drive folder, oldest first.

Usage:
  python3 scripts/drive-list.py <folder-id> [--json] [--token PATH]

Default output: one tab-separated line per file — createdTime, id, mimeType, name.
--json prints [{"id", "name", "mimeType", "createdTime"}, ...] instead.

Read-only: never moves, renames, or deletes anything.
Token discovery and refresh: see drive_common.py.
"""
import argparse
import json
import sys

from drive_common import list_folder, session_or_exit


def main() -> int:
    ap = argparse.ArgumentParser(description="List files in a Drive folder")
    ap.add_argument("folder_id")
    ap.add_argument("--json", action="store_true", help="Print JSON instead of TSV")
    ap.add_argument("--token", help="Path to drive-credentials.json")
    args = ap.parse_args()

    session = session_or_exit(args.token)
    try:
        files = list_folder(session, args.folder_id)
    except Exception as e:  # noqa: BLE001 — report, don't trace
        print(f"Drive list failed: {e}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(files, indent=2, ensure_ascii=False))
    else:
        for f in files:
            print(f"{f['createdTime']}\t{f['id']}\t{f['mimeType']}\t{f['name']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
