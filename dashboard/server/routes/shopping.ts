import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot =
  process.env.NANOCLAW_ROOT || path.resolve(__dirname, "../..");
const dbPath = path.join(
  nanoclawRoot,
  "data/sessions/shopping/.claude/shopping.db"
);

function openDb(): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

function openWritableDb(): Database.Database | null {
  // Create parent dirs if needed
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  try {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    // Create tables if they don't exist
    db.exec(`
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
    `);
    return db;
  } catch {
    return null;
  }
}

// Fetch og: meta tags from a URL for product metadata
async function fetchMetadata(
  url: string
): Promise<{ title?: string; description?: string; image?: string }> {
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(10000),
    });
    const html = await resp.text();
    const ogTitle =
      html.match(
        /<meta\s+(?:property|name)=["']og:title["']\s+content=["']([^"']+)["']/i
      )?.[1] ??
      html.match(
        /<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:title["']/i
      )?.[1] ??
      html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1];
    const ogDesc =
      html.match(
        /<meta\s+(?:property|name)=["']og:description["']\s+content=["']([^"']+)["']/i
      )?.[1] ??
      html.match(
        /<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:description["']/i
      )?.[1];
    const ogImage =
      html.match(
        /<meta\s+(?:property|name)=["']og:image["']\s+content=["']([^"']+)["']/i
      )?.[1] ??
      html.match(
        /<meta\s+content=["']([^"']+)["']\s+(?:property|name)=["']og:image["']/i
      )?.[1];
    return {
      title: ogTitle?.trim(),
      description: ogDesc?.trim(),
      image: ogImage?.trim(),
    };
  } catch {
    return {};
  }
}

const router = Router();

// GET /api/shopping/products — all active products with latest prices per source
router.get("/api/shopping/products", (_req: Request, res: Response) => {
  const db = openDb();
  if (!db) return res.json([]);
  try {
    const products = db
      .prepare(
        `SELECT id, name, description, source_url, image_url, category,
                status, tracking_enabled, created_at, last_checked
         FROM products
         WHERE status = 'active'
         ORDER BY created_at DESC`
      )
      .all() as Array<{
      id: number;
      name: string;
      description: string | null;
      source_url: string;
      image_url: string | null;
      category: string | null;
      status: string;
      tracking_enabled: number;
      created_at: string;
      last_checked: string | null;
    }>;

    // Get latest snapshot per product per retailer_slug
    const latestSnaps = db
      .prepare(
        `SELECT ps.product_id, ps.source, ps.source_url,
                ps.retailer_slug, ps.retailer_display,
                ps.price, ps.in_stock, ps.verified,
                ps.snapshot_source, ps.polled_at
         FROM price_snapshots ps
         INNER JOIN (
           SELECT product_id, COALESCE(retailer_slug, source) as rslug,
                  MAX(polled_at) as max_polled
           FROM price_snapshots
           GROUP BY product_id, rslug
         ) latest ON ps.product_id = latest.product_id
           AND COALESCE(ps.retailer_slug, ps.source) = latest.rslug
           AND ps.polled_at = latest.max_polled
         ORDER BY ps.product_id, ps.price`
      )
      .all() as Array<{
      product_id: number;
      source: string;
      source_url: string | null;
      retailer_slug: string | null;
      retailer_display: string | null;
      price: number;
      in_stock: number;
      verified: number;
      snapshot_source: string | null;
      polled_at: string;
    }>;

    db.close();

    // Group snapshots by product
    const snapsByProduct = new Map<
      number,
      Array<{
        source: string;
        source_url: string | null;
        retailer_slug: string | null;
        retailer_display: string | null;
        price: number;
        in_stock: number;
        verified: number;
        snapshot_source: string | null;
        polled_at: string;
      }>
    >();
    for (const s of latestSnaps) {
      if (!snapsByProduct.has(s.product_id))
        snapsByProduct.set(s.product_id, []);
      snapsByProduct.get(s.product_id)!.push(s);
    }

    const result = products.map((p) => {
      const prices = snapsByProduct.get(p.id) || [];
      const inStockPrices = prices.filter((s) => s.in_stock);
      const best =
        inStockPrices.length > 0
          ? inStockPrices.reduce((a, b) => (a.price < b.price ? a : b))
          : prices.length > 0
            ? prices.reduce((a, b) => (a.price < b.price ? a : b))
            : null;
      return {
        ...p,
        prices,
        best_price: best?.price ?? null,
        best_source: best?.source ?? null,
        best_source_url: best?.source_url ?? null,
        best_retailer_display: best?.retailer_display ?? null,
      };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/shopping/products/:id/history — full price history for one product
router.get(
  "/api/shopping/products/:id/history",
  (req: Request, res: Response) => {
    const db = openDb();
    if (!db) return res.json([]);
    try {
      const rows = db
        .prepare(
          `SELECT source, source_url, retailer_slug, retailer_display,
                  price, in_stock, verified, snapshot_source, polled_at
           FROM price_snapshots
           WHERE product_id = ?
           ORDER BY polled_at ASC, source`
        )
        .all(req.params.id as string);
      db.close();
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  }
);

// POST /api/shopping/products — add a new product
router.post("/api/shopping/products", async (req: Request, res: Response) => {
  const { name, description, source_url, image_url, category } = req.body;
  if (!source_url) {
    return res.status(400).json({ error: "source_url is required" });
  }

  const db = openWritableDb();
  if (!db) return res.status(500).json({ error: "Could not open database" });

  try {
    const productName = name || "Unnamed Product";
    const stmt = db.prepare(
      `INSERT INTO products (name, description, source_url, image_url, category)
       VALUES (?, ?, ?, ?, ?)`
    );
    const result = stmt.run(
      productName,
      description || null,
      source_url,
      image_url || null,
      category || null
    );
    db.close();
    res.json({
      id: result.lastInsertRowid,
      name: productName,
      description: description || null,
      source_url,
      image_url: image_url || null,
      category: category || null,
      status: "active",
      tracking_enabled: 0,
      created_at: new Date().toISOString(),
      last_checked: null,
      prices: [],
      best_price: null,
      best_source: null,
      best_source_url: null,
    });
  } catch (e) {
    db.close();
    res.status(500).json({ error: String(e) });
  }
});

// POST /api/shopping/products/parse-url — fetch metadata from a URL
router.post(
  "/api/shopping/products/parse-url",
  async (req: Request, res: Response) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "url is required" });
    const meta = await fetchMetadata(url);
    res.json(meta);
  }
);

// PATCH /api/shopping/products/:id — update product fields
router.patch("/api/shopping/products/:id", (req: Request, res: Response) => {
  const db = openWritableDb();
  if (!db) return res.status(500).json({ error: "Could not open database" });

  try {
    const { tracking_enabled, status, name, description } = req.body;
    const updates: string[] = [];
    const values: unknown[] = [];

    if (tracking_enabled !== undefined) {
      updates.push("tracking_enabled = ?");
      values.push(tracking_enabled ? 1 : 0);
    }
    if (status !== undefined) {
      updates.push("status = ?");
      values.push(status);
    }
    if (name !== undefined) {
      updates.push("name = ?");
      values.push(name);
    }
    if (description !== undefined) {
      updates.push("description = ?");
      values.push(description);
    }

    if (updates.length === 0) {
      db.close();
      return res.status(400).json({ error: "No fields to update" });
    }

    values.push(req.params.id);
    db.prepare(
      `UPDATE products SET ${updates.join(", ")} WHERE id = ?`
    ).run(...values);
    db.close();
    res.json({ ok: true, id: Number(req.params.id) });
  } catch (e) {
    db.close();
    res.status(500).json({ error: String(e) });
  }
});

// DELETE /api/shopping/products/:id — soft delete
router.delete("/api/shopping/products/:id", (req: Request, res: Response) => {
  const db = openWritableDb();
  if (!db) return res.status(500).json({ error: "Could not open database" });

  try {
    db.prepare("UPDATE products SET status = 'removed' WHERE id = ?").run(
      req.params.id
    );
    db.close();
    res.json({ ok: true, id: Number(req.params.id) });
  } catch (e) {
    db.close();
    res.status(500).json({ error: String(e) });
  }
});

export default router;
