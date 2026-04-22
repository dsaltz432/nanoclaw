#!/usr/bin/env python3
from __future__ import annotations
"""
Shopping price tracker DB helper for NanoClaw.

Handles all SQLite operations for the shopping price tracker so the
container agent can focus on browsing and searching for prices.

Usage (inside container):
  python3 /home/node/nanoclaw/scripts/shopping-db.py <command> [args]

Usage (host-side, for testing):
  python3 scripts/shopping-db.py <command> [args]

Commands:
  init                  Create tables if they don't exist
  list                  List all active products (JSON to stdout)
  due                   List products due for a price check (JSON to stdout)
  add '<json>'          Insert a new product
  snapshot '<json>'     Insert a price snapshot
  update-checked <id>   Update last_checked timestamp for a product
  cached-urls <id>      List cached retailer URLs for a product (failure_count < 5)
  cache-url '<json>'    Upsert a retailer URL cache entry (success/failure tracking)

Outputs JSON to stdout for the calling agent to parse.
"""
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from urllib.parse import urlparse

# DB path: inside container it's /home/node/.claude/shopping.db
# On host, fall back to the shopping group's session dir.
NANOCLAW_ROOT = os.environ.get(
    "NANOCLAW_ROOT", os.path.join(os.path.dirname(__file__), "..")
)
DB_PATH = os.environ.get(
    "SHOPPING_DB",
    os.path.join(NANOCLAW_ROOT, "data/sessions/shopping/.claude/shopping.db"),
)
# Inside container, .claude is at /home/node/.claude
if os.path.exists("/home/node/.claude/shopping.db"):
    DB_PATH = "/home/node/.claude/shopping.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  source_url TEXT NOT NULL,
  image_url TEXT,
  category TEXT,
  match_tokens TEXT,
  exclude_tokens TEXT,
  status TEXT DEFAULT 'active',
  tracking_enabled INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  last_checked TEXT
);

CREATE TABLE IF NOT EXISTS price_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT,
  retailer_slug TEXT,
  retailer_display TEXT,
  price REAL NOT NULL,
  in_stock INTEGER DEFAULT 1,
  verified INTEGER DEFAULT 1,
  snapshot_source TEXT DEFAULT 'browser',
  polled_at TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_product_time
  ON price_snapshots(product_id, polled_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_product_source
  ON price_snapshots(product_id, source);

CREATE TABLE IF NOT EXISTS retailer_urls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  source TEXT NOT NULL,
  retailer_slug TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  source_product_id TEXT,
  last_success TEXT,
  last_failure TEXT,
  failure_count INTEGER DEFAULT 0,
  UNIQUE(product_id, retailer_slug),
  FOREIGN KEY (product_id) REFERENCES products(id)
);
"""


def url_to_retailer(url: str | None) -> tuple[str | None, str | None]:
    """Extract (retailer_slug, retailer_display) from a URL.
    e.g. 'https://www.crateandbarrel.com/foo' -> ('crateandbarrel', 'Crateandbarrel')
    """
    if not url:
        return None, None
    try:
        host = urlparse(url).hostname or ""
        host = host.lower().removeprefix("www.")
        # Get eTLD+1 (simplified: take second-to-last dot-segment)
        parts = host.split(".")
        if len(parts) >= 2:
            slug = parts[-2]  # e.g. 'crateandbarrel' from 'crateandbarrel.com'
        else:
            slug = parts[0]
        display = slug.capitalize()
        # Special display names
        display_map = {
            "amazon": "Amazon",
            "walmart": "Walmart",
            "target": "Target",
            "bestbuy": "Best Buy",
            "ebay": "eBay",
            "crateandbarrel": "Crate & Barrel",
            "zojirushi": "Zojirushi",
            "williams-sonoma": "Williams-Sonoma",
            "kohls": "Kohl's",
            "wayfair": "Wayfair",
        }
        display = display_map.get(slug, display)
        return slug, display
    except Exception:
        return None, None


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = sqlite3.Row
    return conn


def cmd_init():
    """Create tables if they don't exist."""
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = get_conn()
    conn.executescript(SCHEMA)
    conn.commit()
    conn.close()
    print(json.dumps({"ok": True, "db_path": DB_PATH}))


def cmd_list():
    """List all active products."""
    if not os.path.exists(DB_PATH):
        print(json.dumps({"products": []}))
        return
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM products WHERE status = 'active' ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    print(json.dumps({"products": [dict(r) for r in rows]}))


def cmd_due():
    """List products due for a price check (tracking enabled, last checked > 6h ago or never)."""
    if not os.path.exists(DB_PATH):
        print(json.dumps({"due": []}))
        return
    conn = get_conn()
    rows = conn.execute("""
        SELECT * FROM products
        WHERE status = 'active'
          AND tracking_enabled = 1
          AND (last_checked IS NULL OR last_checked < datetime('now', '-5 hours'))
        ORDER BY last_checked ASC NULLS FIRST
    """).fetchall()
    conn.close()
    print(json.dumps({"due": [dict(r) for r in rows], "count": len(rows)}))


def cmd_add(json_str: str):
    """Insert a new product."""
    data = json.loads(json_str)
    name = data.get("name")
    source_url = data.get("source_url")
    if not name or not source_url:
        print(json.dumps({"error": "name and source_url are required"}))
        sys.exit(1)

    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = get_conn()
    conn.executescript(SCHEMA)

    cur = conn.execute(
        """INSERT INTO products (name, description, source_url, image_url, category, match_tokens, exclude_tokens)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (
            name,
            data.get("description"),
            source_url,
            data.get("image_url"),
            data.get("category"),
            data.get("match_tokens"),
            data.get("exclude_tokens"),
        ),
    )
    conn.commit()
    product_id = cur.lastrowid
    conn.close()
    print(json.dumps({"ok": True, "product_id": product_id}))


def cmd_snapshot(json_str: str):
    """Insert a price snapshot."""
    data = json.loads(json_str)
    product_id = data.get("product_id")
    source = data.get("source")
    price = data.get("price")
    if not product_id or not source or price is None:
        print(json.dumps({"error": "product_id, source, and price are required"}))
        sys.exit(1)

    if not os.path.exists(DB_PATH):
        print(json.dumps({"error": f"DB not found at {DB_PATH}"}))
        sys.exit(1)

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    source_url = data.get("source_url")

    # Auto-derive retailer identity from URL, with manual override
    r_slug = data.get("retailer_slug")
    r_display = data.get("retailer_display")
    if not r_slug:
        r_slug, r_display_auto = url_to_retailer(source_url)
        if not r_display:
            r_display = r_display_auto
    # Fall back to source name if no URL
    if not r_slug:
        r_slug = source.lower()
    if not r_display:
        r_display = data.get("retailer_display", source.capitalize())

    conn = get_conn()
    conn.execute(
        """INSERT INTO price_snapshots
           (product_id, source, source_url, retailer_slug, retailer_display,
            price, in_stock, verified, snapshot_source, polled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            product_id,
            source,
            source_url,
            r_slug,
            r_display,
            price,
            data.get("in_stock", 1),
            data.get("verified", 1),
            data.get("snapshot_source", "browser"),
            now_iso,
        ),
    )
    conn.commit()
    conn.close()
    print(json.dumps({"ok": True, "product_id": product_id, "source": source, "price": price, "retailer_slug": r_slug}))


def cmd_update_checked(product_id: str):
    """Update last_checked timestamp for a product."""
    if not os.path.exists(DB_PATH):
        print(json.dumps({"error": f"DB not found at {DB_PATH}"}))
        sys.exit(1)

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn = get_conn()
    conn.execute(
        "UPDATE products SET last_checked = ? WHERE id = ?",
        (now_iso, int(product_id)),
    )
    conn.commit()
    conn.close()
    print(json.dumps({"ok": True, "product_id": int(product_id), "last_checked": now_iso}))


def cmd_cached_urls(product_id: str):
    """List cached retailer URLs for a product where failure_count < 5."""
    if not os.path.exists(DB_PATH):
        print(json.dumps({"urls": []}))
        return
    conn = get_conn()
    rows = conn.execute(
        """SELECT source, retailer_slug, canonical_url, source_product_id,
                  last_success, last_failure, failure_count
           FROM retailer_urls
           WHERE product_id = ? AND failure_count < 5
           ORDER BY last_success DESC NULLS LAST""",
        (int(product_id),),
    ).fetchall()
    conn.close()
    print(json.dumps({"urls": [dict(r) for r in rows], "count": len(rows)}))


def cmd_cache_url(json_str: str):
    """Upsert a retailer URL cache entry. On success: reset failure_count. On failure: increment."""
    data = json.loads(json_str)
    product_id = data.get("product_id")
    source = data.get("source")
    canonical_url = data.get("canonical_url")
    success = data.get("success", 1)

    if not product_id or not source or not canonical_url:
        print(json.dumps({"error": "product_id, source, and canonical_url are required"}))
        sys.exit(1)

    if not os.path.exists(DB_PATH):
        print(json.dumps({"error": f"DB not found at {DB_PATH}"}))
        sys.exit(1)

    # Derive retailer_slug from URL or use explicit value
    r_slug = data.get("retailer_slug")
    if not r_slug:
        r_slug, _ = url_to_retailer(canonical_url)
    if not r_slug:
        r_slug = source.lower()

    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    conn = get_conn()

    if success:
        conn.execute(
            """INSERT INTO retailer_urls (product_id, source, retailer_slug, canonical_url, source_product_id, last_success, failure_count)
               VALUES (?, ?, ?, ?, ?, ?, 0)
               ON CONFLICT(product_id, retailer_slug) DO UPDATE SET
                 canonical_url = excluded.canonical_url,
                 source_product_id = COALESCE(excluded.source_product_id, source_product_id),
                 last_success = excluded.last_success,
                 failure_count = 0""",
            (product_id, source, r_slug, canonical_url, data.get("source_product_id"), now_iso),
        )
    else:
        conn.execute(
            """INSERT INTO retailer_urls (product_id, source, retailer_slug, canonical_url, source_product_id, last_failure, failure_count)
               VALUES (?, ?, ?, ?, ?, ?, 1)
               ON CONFLICT(product_id, retailer_slug) DO UPDATE SET
                 last_failure = ?,
                 failure_count = failure_count + 1""",
            (product_id, source, r_slug, canonical_url, data.get("source_product_id"), now_iso, now_iso),
        )

    conn.commit()
    conn.close()
    action = "success" if success else "failure"
    print(json.dumps({"ok": True, "product_id": product_id, "retailer_slug": r_slug, "action": action}))


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: shopping-db.py <command> [args]"}))
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "init":
        cmd_init()
    elif cmd == "list":
        cmd_list()
    elif cmd == "due":
        cmd_due()
    elif cmd == "add":
        if len(sys.argv) < 3:
            print(json.dumps({"error": "add requires a JSON argument"}))
            sys.exit(1)
        cmd_add(sys.argv[2])
    elif cmd == "snapshot":
        if len(sys.argv) < 3:
            print(json.dumps({"error": "snapshot requires a JSON argument"}))
            sys.exit(1)
        cmd_snapshot(sys.argv[2])
    elif cmd == "update-checked":
        if len(sys.argv) < 3:
            print(json.dumps({"error": "update-checked requires a product_id"}))
            sys.exit(1)
        cmd_update_checked(sys.argv[2])
    elif cmd == "cached-urls":
        if len(sys.argv) < 3:
            print(json.dumps({"error": "cached-urls requires a product_id"}))
            sys.exit(1)
        cmd_cached_urls(sys.argv[2])
    elif cmd == "cache-url":
        if len(sys.argv) < 3:
            print(json.dumps({"error": "cache-url requires a JSON argument"}))
            sys.exit(1)
        cmd_cache_url(sys.argv[2])
    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
