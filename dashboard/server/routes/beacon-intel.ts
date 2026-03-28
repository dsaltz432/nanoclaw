import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot = process.env.NANOCLAW_ROOT || path.resolve(__dirname, "../..");
const dbPath =
  process.env.BEACON_INTEL_DB ||
  path.join(nanoclawRoot, "store", "beacon-intel.db");

function getDb(): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

function hasTable(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return !!row;
}

const router = Router();

router.get("/api/beacon-intel/events", (req: Request, res: Response) => {
  try {
    const db = getDb();
    if (!db || !hasTable(db, "events")) return void res.json([]);

    const { category, date_from, date_to } = req.query;
    let sql = "SELECT * FROM events WHERE 1=1";
    const params: (string | number)[] = [];

    if (category && category !== "all") {
      sql += " AND category = ?";
      params.push(category as string);
    }
    if (date_from) {
      sql += " AND date_start >= ?";
      params.push(date_from as string);
    }
    if (date_to) {
      sql += " AND date_start <= ?";
      params.push(date_to as string);
    }
    sql += " ORDER BY date_start ASC";

    const events = db.prepare(sql).all(...params);
    res.json(events);
  } catch (err) {
    console.error("Beacon Intel events error:", err);
    res.json([]);
  }
});

router.get("/api/beacon-intel/venues", (_req: Request, res: Response) => {
  try {
    const db = getDb();
    if (!db || !hasTable(db, "venues")) return void res.json([]);
    const venues = db
      .prepare("SELECT * FROM venues ORDER BY city, name")
      .all();
    res.json(venues);
  } catch (err) {
    console.error("Beacon Intel venues error:", err);
    res.json([]);
  }
});

router.get("/api/beacon-intel/news", (_req: Request, res: Response) => {
  try {
    const db = getDb();
    if (!db || !hasTable(db, "news")) return void res.json([]);
    const news = db
      .prepare(
        "SELECT * FROM news ORDER BY published_at DESC LIMIT 100"
      )
      .all();
    res.json(news);
  } catch (err) {
    console.error("Beacon Intel news error:", err);
    res.json([]);
  }
});

router.get("/api/beacon-intel/meta", (_req: Request, res: Response) => {
  try {
    const db = getDb();
    if (!db || !hasTable(db, "metadata"))
      return void res.json({ last_updated: null, db_exists: !!db });

    const meta = db
      .prepare("SELECT value FROM metadata WHERE key = 'last_updated'")
      .get() as { value: string } | undefined;
    res.json({ last_updated: meta?.value || null, db_exists: true });
  } catch (err) {
    console.error("Beacon Intel meta error:", err);
    res.json({ last_updated: null, db_exists: false });
  }
});

export default router;
