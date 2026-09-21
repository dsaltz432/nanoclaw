"""
Shared Google Drive plumbing for drive-put.py, drive-list.py and drive-get.py:
token discovery, refresh-and-save, and folder listing.

Token location (first match wins):
  --token PATH
  $DRIVE_CREDENTIALS
  $GARMIN_DATA_DIR/drive-credentials.json
  <repo>/data/sessions/fitness/.claude/drive-credentials.json   (host)
  /home/node/.claude/drive-credentials.json                    (any group's container:
                                                                its own .claude)

Each group that uses Drive holds its own copy of the token in its own .claude/;
tokens are never shared between groups by mount.

Requires: google-auth (Python >= 3.10). Installed in the agent container image.
"""
import os
import sys
import tempfile

NANOCLAW_ROOT = os.environ.get("NANOCLAW_ROOT", os.path.join(os.path.dirname(__file__), ".."))
TOKEN_NAME = "drive-credentials.json"
# In the container scripts/ is mounted at /home/node/nanoclaw/scripts with no
# data/ beside it; the group's own .claude is at /home/node/.claude.
TOKEN_CANDIDATES = [
    os.path.join(NANOCLAW_ROOT, "data/sessions/fitness/.claude", TOKEN_NAME),
    os.path.join("/home/node/.claude", TOKEN_NAME),
]
SCOPES = ["https://www.googleapis.com/auth/drive"]
API = "https://www.googleapis.com/drive/v3/files"
UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files"
GOOGLE_DOC = "application/vnd.google-apps.document"
FOLDER = "application/vnd.google-apps.folder"

AUTH_HELP = """Drive token not found: {path}

Run the one-time consent flow (any machine with Python >= 3.10):
  pip install google-auth google-auth-oauthlib
  python3 scripts/drive-auth.py \\
      data/sessions/fitness/.claude/drive-client-secret.json \\
      data/sessions/fitness/.claude/drive-credentials.json

Sign in as dsaltzai@gmail.com in a browser where only that account is logged in;
on the "unverified app" screen choose Advanced → Go to NanoClaw Drive.
Then copy the token into every other group that holds one
(data/sessions/<group>/.claude/drive-credentials.json).
"""


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


def session_or_exit(cli_token: str | None):
    """Authorized session, or print why not and exit (2 = no token, 1 = no deps)."""
    tok = token_path(cli_token)
    if not os.path.exists(tok):
        print(AUTH_HELP.format(path=tok), file=sys.stderr)
        sys.exit(2)
    try:
        return load_session(tok)
    except ImportError:
        print("Missing dependency: pip install google-auth  (Python >= 3.10)", file=sys.stderr)
        sys.exit(1)


def q_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("'", "\\'")


def list_folder(session, folder_id: str, fields: str = "id, name, mimeType, createdTime") -> list[dict]:
    """Every non-trashed file directly in the folder, oldest first (all pages)."""
    files, page = [], None
    while True:
        params = {
            "q": f"'{q_escape(folder_id)}' in parents and trashed = false",
            "fields": f"nextPageToken, files({fields})",
            "orderBy": "createdTime",
            "pageSize": 1000,
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        }
        if page:
            params["pageToken"] = page
        r = session.get(API, params=params)
        r.raise_for_status()
        body = r.json()
        files += body.get("files", [])
        page = body.get("nextPageToken")
        if not page:
            return files
