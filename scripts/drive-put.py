#!/usr/bin/env python3
"""
Upsert a local file into a Google Drive folder by name.

Looks for `name = X and '<folder>' in parents and trashed = false`; updates that
file's content if found, otherwise creates it. Uses the refresh token written by
scripts/drive-auth.py, refreshing the access token automatically and saving it
back when it changes.

Usage:
  python3 scripts/drive-put.py <local-file> <folder-id> [--name NAME] [--mime text/markdown]

Token discovery and refresh: see drive_common.py.

Requires: google-auth (Python >= 3.10). Installed in the agent container image.
"""
import argparse
import json
import mimetypes
import os
import sys
import uuid

from drive_common import API, UPLOAD_API, q_escape, session_or_exit

mimetypes.add_type("text/markdown", ".md")


def multipart(metadata: dict, content: bytes, mime: str) -> tuple[bytes, str]:
    boundary = f"nanoclaw-{uuid.uuid4().hex}"
    body = (
        f"--{boundary}\r\n"
        "Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{json.dumps(metadata)}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {mime}\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--\r\n".encode()
    return body, f"multipart/related; boundary={boundary}"


def main() -> int:
    ap = argparse.ArgumentParser(description="Upsert a local file into a Drive folder by name")
    ap.add_argument("local_file")
    ap.add_argument("folder_id")
    ap.add_argument("--name", help="Name in Drive (default: local basename)")
    ap.add_argument("--mime", help="MIME type (default: guessed; .md → text/markdown)")
    ap.add_argument("--token", help="Path to drive-credentials.json")
    args = ap.parse_args()

    session = session_or_exit(args.token)

    name = args.name or os.path.basename(args.local_file)
    mime = args.mime or mimetypes.guess_type(name)[0] or "application/octet-stream"
    with open(args.local_file, "rb") as f:
        content = f.read()

    common = {"supportsAllDrives": "true"}
    r = session.get(
        API,
        params={
            **common,
            "includeItemsFromAllDrives": "true",
            "q": f"name = '{q_escape(name)}' and '{q_escape(args.folder_id)}' in parents "
            "and trashed = false",
            "fields": "files(id, modifiedTime)",
            "orderBy": "modifiedTime desc",
        },
    )
    r.raise_for_status()
    matches = r.json().get("files", [])
    if len(matches) > 1:
        print(
            f"warning: {len(matches)} files named {name!r} in folder; updating newest "
            f"({matches[0]['id']})",
            file=sys.stderr,
        )

    if matches:
        file_id = matches[0]["id"]
        body, ctype = multipart({"mimeType": mime}, content, mime)
        r = session.patch(
            f"{UPLOAD_API}/{file_id}",
            params={**common, "uploadType": "multipart", "fields": "id, name, webViewLink"},
            data=body,
            headers={"Content-Type": ctype},
        )
        action = "updated"
    else:
        body, ctype = multipart(
            {"name": name, "parents": [args.folder_id], "mimeType": mime}, content, mime
        )
        r = session.post(
            UPLOAD_API,
            params={**common, "uploadType": "multipart", "fields": "id, name, webViewLink"},
            data=body,
            headers={"Content-Type": ctype},
        )
        action = "created"

    if not r.ok:
        print(f"Drive upload failed ({r.status_code}): {r.text[:500]}", file=sys.stderr)
        return 1
    f = r.json()
    print(f"{action} {f['name']} ({f['id']}) {f.get('webViewLink', '')}".rstrip())
    return 0


if __name__ == "__main__":
    sys.exit(main())
