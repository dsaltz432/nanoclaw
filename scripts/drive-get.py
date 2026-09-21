#!/usr/bin/env python3
"""
Print one Google Drive file's text to stdout.

- Google Docs are exported as text/plain.
- Other text types (text/*, JSON, XML, markdown) are downloaded as-is.
- Anything else (images, PDFs, other binaries) is NOT downloaded: prints a one-line
  "original present" report with name, type and size, and exits 0.

Usage:
  python3 scripts/drive-get.py <file-id> [--token PATH]

Read-only. Token discovery and refresh: see drive_common.py.
"""
import argparse
import sys

from drive_common import API, GOOGLE_DOC, session_or_exit

TEXT_TYPES = {"application/json", "application/xml", "text/markdown"}


def is_text(mime: str) -> bool:
    return mime.startswith("text/") or mime in TEXT_TYPES


def main() -> int:
    ap = argparse.ArgumentParser(description="Print a Drive file's text")
    ap.add_argument("file_id")
    ap.add_argument("--token", help="Path to drive-credentials.json")
    args = ap.parse_args()

    session = session_or_exit(args.token)
    meta = session.get(
        f"{API}/{args.file_id}",
        params={"fields": "id, name, mimeType, size, createdTime", "supportsAllDrives": "true"},
    )
    if not meta.ok:
        print(f"Drive metadata failed ({meta.status_code}): {meta.text[:300]}", file=sys.stderr)
        return 1
    m = meta.json()
    mime = m["mimeType"]

    if mime == GOOGLE_DOC:
        r = session.get(f"{API}/{args.file_id}/export", params={"mimeType": "text/plain"})
    elif is_text(mime):
        r = session.get(
            f"{API}/{args.file_id}", params={"alt": "media", "supportsAllDrives": "true"}
        )
    else:
        size = f"{int(m['size']):,} bytes" if m.get("size") else "size unknown"
        print(
            f"[original present — not downloaded] {m['name']} ({mime}, {size}, "
            f"created {m.get('createdTime', '?')}, id {m['id']})"
        )
        return 0

    if not r.ok:
        print(f"Drive download failed ({r.status_code}): {r.text[:300]}", file=sys.stderr)
        return 1
    # Docs export carries a UTF-8 BOM.
    sys.stdout.write(r.content.decode("utf-8-sig", errors="replace"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
