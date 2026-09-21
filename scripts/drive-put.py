#!/usr/bin/env python3
"""
Upsert a local file into a Google Drive folder by name.

Looks for `name = X and '<folder>' in parents and trashed = false`; updates that
file's content if found, otherwise creates it. Uses the refresh token written by
scripts/drive-auth.py, refreshing the access token automatically and saving it
back when it changes.

Usage:
  python3 scripts/drive-put.py <local-file> <folder-id> [--name NAME] [--mime text/markdown]

Token location (first match wins):
  --token PATH
  $DRIVE_CREDENTIALS
  $GARMIN_DATA_DIR/drive-credentials.json
  <repo>/data/sessions/fitness/.claude/drive-credentials.json   (host)
  /home/node/.claude/drive-credentials.json                    (fitness container)

Requires: google-auth (Python >= 3.10). Installed in the agent container image.
"""
import argparse
import json
import mimetypes
import os
import sys
import tempfile
import uuid

NANOCLAW_ROOT = os.environ.get("NANOCLAW_ROOT", os.path.join(os.path.dirname(__file__), ".."))
TOKEN_NAME = "drive-credentials.json"
# In the container scripts/ is mounted at /home/node/nanoclaw/scripts with no
# data/ beside it; the fitness group's .claude is at /home/node/.claude.
TOKEN_CANDIDATES = [
    os.path.join(NANOCLAW_ROOT, "data/sessions/fitness/.claude", TOKEN_NAME),
    os.path.join("/home/node/.claude", TOKEN_NAME),
]
SCOPES = ["https://www.googleapis.com/auth/drive"]
API = "https://www.googleapis.com/drive/v3/files"
UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files"

AUTH_HELP = """Drive token not found: {path}

Run the one-time consent flow (any machine with Python >= 3.10):
  pip install google-auth google-auth-oauthlib
  python3 scripts/drive-auth.py \\
      data/sessions/fitness/.claude/drive-client-secret.json \\
      data/sessions/fitness/.claude/drive-credentials.json

Sign in as dsaltzai@gmail.com in a browser where only that account is logged in;
on the "unverified app" screen choose Advanced → Go to NanoClaw Drive.
"""

mimetypes.add_type("text/markdown", ".md")


def token_path(cli_value: str | None) -> str:
    explicit = cli_value or os.environ.get("DRIVE_CREDENTIALS")
    if explicit:
        return explicit
    if os.environ.get("GARMIN_DATA_DIR"):
        return os.path.join(os.environ["GARMIN_DATA_DIR"], TOKEN_NAME)
    return next((p for p in TOKEN_CANDIDATES if os.path.exists(p)), TOKEN_CANDIDATES[0])


def save_token(path: str, creds) -> None:
    """Atomically rewrite the token file, keeping it owner-only."""
    d = os.path.dirname(os.path.abspath(path))
    fd, tmp = tempfile.mkstemp(dir=d, prefix=".drive-credentials.")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(creds.to_json())
        os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def load_session(path: str):
    from google.auth.transport.requests import AuthorizedSession, Request
    from google.oauth2.credentials import Credentials

    creds = Credentials.from_authorized_user_file(path, SCOPES)
    if not creds.valid:
        before = creds.token
        creds.refresh(Request())
        if creds.token != before:
            save_token(path, creds)
    return AuthorizedSession(creds)


def q_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("'", "\\'")


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

    tok = token_path(args.token)
    if not os.path.exists(tok):
        print(AUTH_HELP.format(path=tok), file=sys.stderr)
        return 2

    try:
        session = load_session(tok)
    except ImportError:
        print("Missing dependency: pip install google-auth  (Python >= 3.10)", file=sys.stderr)
        return 1

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
