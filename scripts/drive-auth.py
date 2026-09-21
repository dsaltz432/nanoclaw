#!/usr/bin/env python3
"""
Google Drive one-time consent flow for NanoClaw's Drive publishing.

Exchanges the "NanoClaw Drive" Desktop-app OAuth client for a refresh token
scoped to https://www.googleapis.com/auth/drive, and writes it to a token file
that scripts/drive-put.py loads.

Self-contained: needs only the client-secret JSON and this file, so it can be
run on a different machine than NanoClaw. Copy the resulting token file to
data/sessions/fitness/.claude/drive-credentials.json afterwards.

Usage:
  python3 scripts/drive-auth.py <client-secret.json> <output-token.json> [--no-browser]

  # On the NanoClaw host:
  python3 scripts/drive-auth.py \\
      data/sessions/fitness/.claude/drive-client-secret.json \\
      data/sessions/fitness/.claude/drive-credentials.json

Requires: pip install google-auth google-auth-oauthlib   (Python >= 3.10)
"""
import argparse
import os
import sys

SCOPES = ["https://www.googleapis.com/auth/drive"]
EXPECTED_ACCOUNT = "dsaltzai@gmail.com"

INSTRUCTIONS = f"""
──────────────────────────────────────────────────────────────────────
 Google Drive consent for NanoClaw
──────────────────────────────────────────────────────────────────────
 1. Use a browser where ONLY {EXPECTED_ACCOUNT} is signed in
    (a fresh Chrome profile or a private window signed in to just that
    account). If another Google account is logged in, Google may pick it.
 2. Sign in as {EXPECTED_ACCOUNT}.
 3. You'll see "Google hasn't verified this app". Click
    Advanced → Go to NanoClaw Drive (unsafe). This is expected: it's
    our own unpublished OAuth client.
 4. Grant "See, edit, create, and delete all of your Google Drive files".
 5. The browser shows "The authentication flow has completed" and this
    script writes the token file.
──────────────────────────────────────────────────────────────────────
"""


def main() -> int:
    ap = argparse.ArgumentParser(description="One-time Google Drive OAuth consent")
    ap.add_argument("client_secret", help="Path to the Desktop-app client secret JSON")
    ap.add_argument("output", help="Where to write the token (drive-credentials.json)")
    ap.add_argument(
        "--no-browser",
        action="store_true",
        help="Don't auto-open a browser; print the URL to open manually",
    )
    args = ap.parse_args()

    try:
        from google.auth.transport.requests import AuthorizedSession
        from google_auth_oauthlib.flow import InstalledAppFlow
    except ImportError:
        print(
            "Missing dependencies. Install with:\n"
            "  pip install google-auth google-auth-oauthlib   (Python >= 3.10)",
            file=sys.stderr,
        )
        return 1

    if not os.path.exists(args.client_secret):
        print(f"Client secret not found: {args.client_secret}", file=sys.stderr)
        return 1

    print(INSTRUCTIONS)

    flow = InstalledAppFlow.from_client_secrets_file(args.client_secret, SCOPES)
    # prompt=consent guarantees a refresh token even if this client was
    # authorized before; login_hint pre-selects the right account.
    creds = flow.run_local_server(
        port=0,
        open_browser=not args.no_browser,
        prompt="consent",
        login_hint=EXPECTED_ACCOUNT,
        authorization_prompt_message="Open this URL in the browser signed in as "
        f"{EXPECTED_ACCOUNT}:\n\n{{url}}\n",
        success_message="NanoClaw Drive: authentication complete. You can close this tab.",
    )

    if not creds.refresh_token:
        print("No refresh token returned — re-run the flow.", file=sys.stderr)
        return 1

    # Confirm which account actually granted access before saving.
    about = AuthorizedSession(creds).get(
        "https://www.googleapis.com/drive/v3/about", params={"fields": "user"}
    )
    about.raise_for_status()
    email = about.json().get("user", {}).get("emailAddress", "")
    if email.lower() != EXPECTED_ACCOUNT:
        print(
            f"\nAuthorized as {email!r}, not {EXPECTED_ACCOUNT}. Token NOT saved.\n"
            f"Re-run in a browser where only {EXPECTED_ACCOUNT} is signed in.",
            file=sys.stderr,
        )
        return 1

    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(creds.to_json())

    print(f"\nAuthorized as {email}. Token written to {args.output}")
    print(
        "If you ran this on another machine, copy that file to the NanoClaw host at\n"
        "  data/sessions/fitness/.claude/drive-credentials.json"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
