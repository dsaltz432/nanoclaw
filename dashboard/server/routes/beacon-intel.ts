import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot = process.env.NANOCLAW_ROOT || path.resolve(__dirname, "../..");
const dbPath =
  process.env.BEACON_INTEL_DB ||
  path.join(nanoclawRoot, "data/sessions/telegram_main/.claude/beacon.db");
const geoCachePath = path.join(nanoclawRoot, "data/beacon-geocache.json");

// ── Geocoding ───────────────────────────────────────────────────────────────

type GeoCache = Record<string, { lat: number; lng: number } | null>;
let geoCache: GeoCache | null = null;
let geocodingInProgress = false;

function loadGeoCache(): GeoCache {
  if (geoCache) return geoCache;
  try {
    geoCache = JSON.parse(fs.readFileSync(geoCachePath, "utf8"));
  } catch {
    geoCache = {};
  }
  return geoCache!;
}

function saveGeoCache(cache: GeoCache) {
  geoCache = cache;
  try {
    fs.writeFileSync(geoCachePath, JSON.stringify(cache, null, 2));
  } catch {}
}

async function geocodeAddress(address: string): Promise<{ lat: number; lng: number } | null> {
  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1&countrycodes=us`;
    const resp = await fetch(url, {
      headers: { "User-Agent": "NanoClaw-Dashboard/1.0" },
    });
    const data = (await resp.json()) as { lat: string; lon: string }[];
    if (data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  } catch {}
  return null;
}

async function geocodeVenuesBackground(
  venues: { id: string; name: string; address: string | null }[]
) {
  if (geocodingInProgress) return;
  geocodingInProgress = true;
  const cache = loadGeoCache();
  let updated = false;

  for (const v of venues) {
    if (cache[v.id] !== undefined) continue;
    if (!v.address) {
      cache[v.id] = null;
      updated = true;
      continue;
    }
    const coords = await geocodeAddress(v.address);
    cache[v.id] = coords;
    updated = true;
    if (coords) await new Promise((r) => setTimeout(r, 1100)); // Nominatim: 1 req/sec
  }

  if (updated) saveGeoCache(cache);
  geocodingInProgress = false;
}

// ── DB helpers ──────────────────────────────────────────────────────────────

function getDb(): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

// ── Type mappings ────────────────────────────────────────────────────────────

const TYPE_TO_CATEGORY: Record<string, { category: string; emoji: string }> = {
  music_event:     { category: "music",     emoji: "🎵" },
  farmers_market:  { category: "market",    emoji: "🌿" },
  food_truck:      { category: "market",    emoji: "🌿" },
  outdoor_event:   { category: "outdoor",   emoji: "🥾" },
  festival:        { category: "festival",  emoji: "🎉" },
  community_event: { category: "community", emoji: "🏘" },
  sports:          { category: "community", emoji: "🏘" },
};

const EVENT_TYPES = Object.keys(TYPE_TO_CATEGORY);

const CATEGORY_TO_TYPES: Record<string, string[]> = {
  music:     ["music_event"],
  market:    ["farmers_market", "food_truck"],
  outdoor:   ["outdoor_event"],
  festival:  ["festival"],
  community: ["community_event", "sports"],
};

const NEWS_TYPES = ["news", "restaurant_opening", "restaurant_closing", "restaurant_special"];

const TYPE_TO_NEWS_CATEGORY: Record<string, string> = {
  news:                 "news",
  restaurant_opening:   "opening",
  restaurant_closing:   "closing",
  restaurant_special:   "news",
};

// ── Routes ───────────────────────────────────────────────────────────────────

const router = Router();

router.get("/api/beacon-intel/events", (req: Request, res: Response) => {
  try {
    const db = getDb();
    if (!db) return void res.json([]);

    const { category, date_from, date_to } = req.query;

    let types: string[];
    if (category && category !== "all" && CATEGORY_TO_TYPES[category as string]) {
      types = CATEGORY_TO_TYPES[category as string];
    } else {
      types = EVENT_TYPES;
    }

    const placeholders = types.map(() => "?").join(", ");
    let sql = `SELECT * FROM items WHERE archived = 0 AND type IN (${placeholders})`;
    const params: (string | number)[] = [...types];

    const today = new Date().toISOString().slice(0, 10);
    const effectiveDateFrom = date_from && (date_from as string) > today ? date_from as string : today;
    sql += " AND date >= ?"; params.push(effectiveDateFrom);
    if (date_to) { sql += " AND date <= ?"; params.push(date_to as string); }
    sql += " ORDER BY date ASC";

    const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
    const events = rows.map((row) => {
      const mapped = TYPE_TO_CATEGORY[row.type as string] || { category: "community", emoji: "📅" };
      return {
        id: row.id,
        title: row.title,
        category: mapped.category,
        emoji: mapped.emoji,
        date_start: row.date,
        date_end: null,
        time: row.time ?? null,
        location: row.location,
        url: row.url,
        description: row.description,
        sources: row.sources ?? null,
      };
    });

    res.json(events);
  } catch (err) {
    console.error("Beacon Intel events error:", err);
    res.json([]);
  }
});

router.get("/api/beacon-intel/venues", (_req: Request, res: Response) => {
  try {
    const db = getDb();
    if (!db) return void res.json([]);

    const rows = db
      .prepare("SELECT * FROM venues WHERE active = 1 ORDER BY city, name")
      .all() as Record<string, unknown>[];

    // Get venue names that appear in active event item locations
    const eventTypePlaceholders = EVENT_TYPES.map(() => "?").join(", ");
    const eventLocations = (
      db
        .prepare(
          `SELECT location FROM items WHERE archived = 0 AND type IN (${eventTypePlaceholders})`
        )
        .all(...EVENT_TYPES) as { location: string | null }[]
    )
      .map((r) => (r.location || "").toLowerCase());

    const cache = loadGeoCache();

    // Kick off background geocoding for any uncached venues
    const uncached = rows.filter(
      (v) => cache[(v.id as string)] === undefined
    ) as { id: string; name: string; address: string | null }[];
    if (uncached.length > 0) geocodeVenuesBackground(uncached);

    const venues = rows.map((row) => {
      // Check if any event location references this venue (fuzzy name match)
      const nameSlug = (row.name as string).toLowerCase().split(/[,@(]/)[0].trim();
      const has_events = eventLocations.some((loc) => loc.includes(nameSlug));

      const coords = cache[row.id as string];

      return {
        id: row.id,
        name: row.name,
        city: row.city,
        type_badge: row.type,
        address: row.address,
        lat: coords?.lat ?? null,
        lng: coords?.lng ?? null,
        website: row.website,
        description: row.description || row.known_for,
        has_events,
      };
    });

    res.json(venues);
  } catch (err) {
    console.error("Beacon Intel venues error:", err);
    res.json([]);
  }
});

router.get("/api/beacon-intel/news", (req: Request, res: Response) => {
  try {
    const db = getDb();
    if (!db) return void res.json([]);

    const showDiscarded = req.query.discarded === "1";
    const placeholders = NEWS_TYPES.map(() => "?").join(", ");

    // Check if discarded column exists (added via migration)
    const hasDiscardedCol = (
      db.prepare("PRAGMA table_info(items)").all() as { name: string }[]
    ).some((c) => c.name === "discarded");

    const discardedFilter = hasDiscardedCol
      ? showDiscarded
        ? "AND discarded = 1"
        : "AND discarded = 0"
      : "";

    const rows = db
      .prepare(
        `SELECT * FROM items WHERE archived = 0 AND type IN (${placeholders}) ${discardedFilter} ORDER BY added DESC LIMIT 100`
      )
      .all(...NEWS_TYPES) as Record<string, unknown>[];

    const news = rows.map((row) => ({
      id: row.id,
      title: row.title,
      source: row.source,
      url: row.url,
      published_at: row.added,
      category: TYPE_TO_NEWS_CATEGORY[row.type as string] || "news",
      discarded: row.discarded === 1,
    }));

    res.json(news);
  } catch (err) {
    console.error("Beacon Intel news error:", err);
    res.json([]);
  }
});

router.get("/api/beacon-intel/meta", (_req: Request, res: Response) => {
  try {
    const db = getDb();
    if (!db) return void res.json({ last_updated: null, db_exists: false });

    const row = db
      .prepare("SELECT MAX(added) as last_updated FROM items")
      .get() as { last_updated: string | null } | undefined;

    res.json({ last_updated: row?.last_updated || null, db_exists: true });
  } catch (err) {
    console.error("Beacon Intel meta error:", err);
    res.json({ last_updated: null, db_exists: false });
  }
});

export default router;
