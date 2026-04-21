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
const configPath = path.join(nanoclawRoot, "data/sessions/tickets/.claude/tickets-config.json");

interface TeamConfig {
  slug: string;
  name: string;
  sport: string;
  color: string;
  enabled?: boolean;
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

// GET /api/tickets/events?include_past=1 — events with latest per-category prices
router.get("/api/tickets/events", (req: Request, res: Response) => {
  const db = openDb();
  if (!db) return res.json([]);
  const includePast = req.query.include_past === "1";
  try {
    // Get events
    const events = db
      .prepare(
        includePast
          ? `SELECT id, team_slug, team_name, sport, title, venue,
                event_datetime, stubhub_url, status,
                weather_high, weather_low, weather_precip_pct
           FROM events
           ORDER BY CASE WHEN event_datetime IS NULL THEN 1 ELSE 0 END, event_datetime ASC`
          : `SELECT id, team_slug, team_name, sport, title, venue,
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

// PATCH /api/tickets/teams/:slug/toggle — enable/disable a team
router.patch(
  "/api/tickets/teams/:slug/toggle",
  (req: Request, res: Response) => {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
      const team = raw.teams?.find(
        (t: TeamConfig) => t.slug === (req.params.slug as string)
      );
      if (!team) return res.status(404).json({ error: "Team not found" });

      team.enabled = !team.enabled;
      fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n");
      res.json({ slug: team.slug, enabled: team.enabled });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  }
);

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


// GET /api/tickets/export/snapshots.csv — all price snapshots joined with event info
router.get("/api/tickets/export/snapshots.csv", (_req: Request, res: Response) => {
  const db = openDb();
  if (!db) {
    res.setHeader("Content-Type", "text/csv");
    return res.send("snapshot_id,event_id,team_slug,team_name,sport,title,venue,event_datetime,status,weather_high,weather_low,weather_precip_pct,category,polled_at,days_until,hours_until,lowest_price,listing_count,best_section\n");
  }
  try {
    const rows = db
      .prepare(
        `SELECT ps.id as snapshot_id, ps.event_id,
                e.team_slug, e.team_name, e.sport,
                e.title, e.venue, e.event_datetime, e.status,
                e.weather_high, e.weather_low, e.weather_precip_pct,
                ps.category, ps.polled_at, ps.days_until, ps.hours_until,
                ps.lowest_price, ps.listing_count, ps.best_section
         FROM price_snapshots ps
         JOIN events e ON e.id = ps.event_id
         ORDER BY ps.polled_at ASC, ps.event_id, ps.category`
      )
      .all() as Array<Record<string, unknown>>;
    db.close();

    const header = "snapshot_id,event_id,team_slug,team_name,sport,title,venue,event_datetime,status,weather_high,weather_low,weather_precip_pct,category,polled_at,days_until,hours_until,lowest_price,listing_count,best_section\n";
    const csvRow = (r: Record<string, unknown>) =>
      [r.snapshot_id, r.event_id, r.team_slug, r.team_name, r.sport,
        `"${String(r.title ?? "").replace(/"/g, '""')}"`,
        r.venue != null ? `"${String(r.venue).replace(/"/g, '""')}"` : "",
        r.event_datetime ?? "", r.status ?? "",
        r.weather_high ?? "", r.weather_low ?? "", r.weather_precip_pct ?? "",
        r.category ?? "", r.polled_at ?? "", r.days_until ?? "", r.hours_until ?? "",
        r.lowest_price ?? "", r.listing_count ?? "",
        r.best_section != null ? `"${String(r.best_section).replace(/"/g, '""')}"` : ""
      ].join(",");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=\"tickets-snapshots.csv\"");
    res.send(header + rows.map(csvRow).join("\n") + "\n");
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;
