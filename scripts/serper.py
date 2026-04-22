#!/usr/bin/env python3
from __future__ import annotations
"""
Minimal Serper.dev API wrapper for NanoClaw.

Usage:
  python3 serper.py shopping "<query>"

Reads SERPER_API_KEY from environment. Outputs raw JSON to stdout.
On failure, prints {"error": "..."} and exits 1.
"""
import json
import os
import sys
import urllib.request

API_KEY = os.environ.get("SERPER_API_KEY", "")
BASE_URL = "https://google.serper.dev"
TIMEOUT = 15


def shopping(query: str) -> None:
    if not API_KEY:
        print(json.dumps({"error": "SERPER_API_KEY environment variable is not set"}))
        sys.exit(1)

    payload = json.dumps({"q": query}).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE_URL}/shopping",
        data=payload,
        headers={
            "X-API-KEY": API_KEY,
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
            # Strip imageUrl fields to avoid flooding the agent context
            # (base64 images can be 20KB+ each, 40 results = 800KB+)
            for item in raw.get("shopping", []):
                item.pop("imageUrl", None)
            print(json.dumps(raw))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace") if e.fp else ""
        print(json.dumps({"error": f"HTTP {e.code}: {e.reason}", "detail": body[:500]}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: serper.py shopping \"<query>\""}))
        sys.exit(1)

    cmd = sys.argv[1]
    query = sys.argv[2]

    if cmd == "shopping":
        shopping(query)
    else:
        print(json.dumps({"error": f"Unknown command: {cmd}. Supported: shopping"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
