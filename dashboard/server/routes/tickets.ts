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
  "data/sessions/tickets/.claude/tickets.db"
);
const configPath = path.join(nanoclawRoot, "data/tickets-config.json");

interface TeamConfig {
  slug: string;
  name: string;
  sport: string;
  color: string;
  stubhub_performer_url: string;
}

function loadTeams(): TeamConfig[] {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (Array.isArray(raw.teams) && raw.teams.length > 0) return raw.teams;
  } catch {}
  return [
    {
      slug: "new-york-yankees",
      name: "Yankees",
      sport: "MLB",
      color: "#003087",
      stubhub_performer_url:
        "https://www.stubhub.com/new-york-yankees-tickets/performer/5650/",
    },
    {
      slug: "new-york-liberty",
      name: "Liberty",
      sport: "WNBA",
      color: "#6eceb2",
      stubhub_performer_url:
        "https://www.stubhub.com/new-york-liberty-tickets/performer/1085577/",
    },
    {
      slug: "new-york-jets",
      name: "Jets",
      sport: "NFL",
      color: "#125740",
      stubhub_performer_url:
        "https://www.stubhub.com/new-york-jets-tickets/performer/4587/",
    },
  ];
}

function openDb(): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

const router = Router();

// GET /api/tickets/events — upcoming active events with latest per-category prices
router.get("/api/tickets/events", (_req: Request, res: Response) => {
  const db = openDb();
  if (!db) return res.json([]);
  try {
    // Get events
    const events = db
      .prepare(
        `SELECT id, team_slug, team_name, sport, title, venue,
              event_datetime, stubhub_url, status,
              weather_high, weather_low, weather_precip_pct
       FROM events
       WHERE status IN ('active', 'pending')
         AND (event_datetime > datetime('now') OR event_datetime IS NULL)
       ORDER BY CASE WHEN event_datetime IS NULL THEN 1 ELSE 0 END, event_datetime ASC`
      )
      .all() as Array<{
      id: number;
      team_slug: string;
      team_name: string;
      sport: string;
      title: string;
      venue: string | null;
      event_datetime: string;
      stubhub_url: string | null;
      status: string;
    }>;

    // Get latest snapshot per event per category
    const latestSnaps = db
      .prepare(
        `SELECT ps.event_id, ps.category, ps.lowest_price, ps.listing_count,
              ps.polled_at, ps.days_until, ps.hours_until, ps.best_section
       FROM price_snapshots ps
       INNER JOIN (
         SELECT event_id, category, MAX(polled_at) as max_polled
         FROM price_snapshots
         GROUP BY event_id, category
       ) latest ON ps.event_id = latest.event_id
         AND ps.category = latest.category
         AND ps.polled_at = latest.max_polled
       ORDER BY ps.event_id, ps.lowest_price`
      )
      .all() as Array<{
      event_id: number;
      category: string;
      lowest_price: number;
      listing_count: number;
      polled_at: string;
      days_until: number;
      hours_until: number;
      best_section: string | null;
    }>;

    db.close();

    // Group snapshots by event
    const snapsByEvent = new Map<
      number,
      Array<{
        category: string;
        lowest_price: number;
        listing_count: number;
        polled_at: string;
        best_section: string | null;
      }>
    >();
    for (const s of latestSnaps) {
      if (!snapsByEvent.has(s.event_id)) snapsByEvent.set(s.event_id, []);
      snapsByEvent.get(s.event_id)!.push(s);
    }

    const result = events.map((e) => {
      const snaps = snapsByEvent.get(e.id) || [];
      const overall_lowest = snaps.length
        ? Math.min(...snaps.map((s) => s.lowest_price))
        : null;
      return {
        ...e,
        categories: snaps,
        overall_lowest,
        listing_count: snaps[0]?.listing_count ?? null,
        polled_at: snaps[0]?.polled_at ?? null,
      };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/tickets/events/:id/history — price history per category for one event
router.get(
  "/api/tickets/events/:id/history",
  (req: Request, res: Response) => {
    const db = openDb();
    if (!db) return res.json([]);
    try {
      const rows = db
        .prepare(
          `SELECT category, polled_at, days_until, hours_until,
                lowest_price, listing_count, best_section
         FROM price_snapshots
         WHERE event_id = ?
         ORDER BY polled_at ASC, category`
        )
        .all(req.params.id as string);
      db.close();
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  }
);

// GET /api/tickets/teams — team list from config
router.get("/api/tickets/teams", (_req: Request, res: Response) => {
  res.json(loadTeams());
});

// GET /api/tickets/categories?team=new-york-yankees — section categories with section lists
router.get("/api/tickets/categories", (req: Request, res: Response) => {
  const db = openDb();
  if (!db) return res.json([]);
  try {
    const team = req.query.team as string | undefined;
    if (!team) {
      const rows = db
        .prepare(
          `SELECT DISTINCT category FROM section_categories ORDER BY category`
        )
        .all();
      db.close();
      return res.json(rows.map((r: any) => r.category));
    }

    const rows = db
      .prepare(
        `SELECT category, section_name FROM section_categories
         WHERE team_slug = ? ORDER BY category, section_name`
      )
      .all(team) as Array<{ category: string; section_name: string }>;
    db.close();

    // Group sections by category
    const grouped: Record<string, string[]> = {};
    for (const r of rows) {
      if (!grouped[r.category]) grouped[r.category] = [];
      grouped[r.category].push(r.section_name);
    }

    res.json(
      Object.entries(grouped).map(([category, sections]) => ({
        category,
        sections,
        count: sections.length,
      }))
    );
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


export default router;
