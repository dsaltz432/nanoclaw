#!/usr/bin/env python3
"""
Garmin Connect authentication setup.
Run this once per person to authenticate and save tokens.
Supports multiple profiles (run once for you, once for your wife, etc).

Usage: python3 scripts/garmin-auth.py
"""
import json
import os
import re
import sys

from garminconnect import Garmin

NANOCLAW_ROOT = os.environ.get("NANOCLAW_ROOT", os.path.join(os.path.dirname(__file__), ".."))
DATA_DIR = os.path.join(NANOCLAW_ROOT, "data/sessions/fitness/.claude")
CRED_PATH = os.path.join(DATA_DIR, "garmin-credentials.json")

# Browser-like user agent — Garmin blocks the default garth mobile app agent
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


def make_slug(name: str) -> str:
    """Convert a name like 'Daniel Saltz' to 'daniel-saltz'."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "default"


def load_credentials() -> list:
    """Load credentials array, handling legacy single-object format."""
    if not os.path.exists(CRED_PATH):
        return []
    with open(CRED_PATH) as f:
        raw = json.load(f)
    if isinstance(raw, dict):
        # Legacy single-profile format — wrap in array and derive slug
        if "slug" not in raw:
            raw["slug"] = make_slug(raw.get("full_name") or raw.get("display_name") or "default")
        if "token_dir" not in raw:
            raw["token_dir"] = os.path.join(DATA_DIR, "garmin-tokens")
        return [raw]
    return raw


def save_credentials(creds: list):
    os.makedirs(os.path.dirname(CRED_PATH), exist_ok=True)
    with open(CRED_PATH, "w") as f:
        json.dump(creds, f, indent=2)


def token_dir_for(slug: str) -> str:
    return os.path.join(DATA_DIR, f"garmin-tokens-{slug}")


def main():
    print("=== Garmin Connect Authentication ===\n")

    existing = load_credentials()

    if existing:
        print(f"Existing profiles ({len(existing)}):")
        for i, c in enumerate(existing):
            print(f"  {i + 1}. {c.get('full_name', 'unknown')} ({c.get('email', '?')})")
        print()
        choice = input("Add new profile or re-auth existing? [new / 1-N]: ").strip().lower()

        if choice == "new" or choice == "":
            email = input("Garmin email: ").strip()
            password = input("Garmin password: ").strip()
        else:
            try:
                idx = int(choice) - 1
                entry = existing[idx]
                email = entry["email"]
                password = entry["password"]
                print(f"Re-authenticating {entry.get('full_name', email)}...")
            except (ValueError, IndexError):
                print("Invalid choice.")
                sys.exit(1)
    else:
        email = input("Garmin email: ").strip()
        password = input("Garmin password: ").strip()

    print("\nConnecting to Garmin Connect...")
    print("(You may be prompted for a 2FA code if MFA is enabled on your account)\n")

    try:
        client = Garmin(email=email, password=password)

        # Override user agent — Garmin blocks the default mobile app agent
        # Must set on client.garth (not global garth.http.client) since Garmin() creates its own
        client.garth.sess.headers["User-Agent"] = BROWSER_UA

        # Check if this email already has saved tokens
        match = next((c for c in existing if c.get("email") == email), None)
        token_dir = match.get("token_dir") if match else None
        token_file = os.path.join(token_dir, "oauth1_token.json") if token_dir else ""

        if token_dir and os.path.exists(token_file):
            print("Resuming from saved tokens...")
            client.login(tokenstore=token_dir)
        else:
            client.login()

        full_name = client.get_full_name()
        display_name = client.display_name
        slug = make_slug(full_name or display_name or email.split("@")[0])

        # Set up per-profile token dir
        profile_token_dir = token_dir if token_dir else token_dir_for(slug)
        os.makedirs(profile_token_dir, exist_ok=True)
        client.garth.dump(profile_token_dir)

        print(f"\n✓ Authenticated as: {full_name} (@{display_name})")

        # Build credential entry
        cred = {
            "email": email,
            "password": password,
            "display_name": display_name,
            "full_name": full_name,
            "slug": slug,
            "token_dir": os.path.basename(profile_token_dir.rstrip("/")),
        }

        # Upsert into credentials array
        updated = [c for c in existing if c.get("email") != email]
        updated.append(cred)
        save_credentials(updated)

        print(f"✓ Credentials saved to: {CRED_PATH}")
        print(f"✓ Tokens saved to: {profile_token_dir}/")

        # Quick data test
        print("\nTesting data access...")
        from datetime import date
        today = date.today().isoformat()
        hr = client.get_heart_rates(today)
        resting = hr.get("restingHeartRate") if hr else None
        print(f"✓ Today's resting HR: {resting or 'not yet recorded'}")

        summary = client.get_user_summary(today)
        steps = summary.get("totalSteps") if summary else None
        print(f"✓ Today's steps: {steps:,}" if steps else "✓ Today's steps: not yet recorded")

        print(f"\n✓ Authentication complete!")
        print(f"  Run 'python3 scripts/garmin-sync.py --profile {slug} --full' to pull all historical data.")
        if len(updated) > 1:
            print(f"  Or 'python3 scripts/garmin-sync.py --full' to sync all {len(updated)} profiles.")

    except Exception as e:
        print(f"\n✗ Authentication failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
