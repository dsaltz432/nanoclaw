import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot = process.env.NANOCLAW_ROOT || path.resolve(__dirname, "../..");
const dbPath = path.join(nanoclawRoot, "data/sessions/telegram_tickets/.claude/tickets.db");
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
  // Fallback defaults
  return [
    { slug: "new-york-yankees", name: "Yankees", sport: "MLB", color: "#003087", stubhub_performer_url: "https://www.stubhub.com/new-york-yankees-tickets/performer/5650/" },
    { slug: "new-york-liberty", name: "Liberty",  sport: "WNBA", color: "#6eceb2", stubhub_performer_url: "https://www.stubhub.com/new-york-liberty-tickets/performer/1085577/" },
    { slug: "new-york-jets",    name: "Jets",     sport: "NFL",  color: "#125740", stubhub_performer_url: "https://www.stubhub.com/new-york-jets-tickets/performer/4587/" },
  ];
}

// ── DB init ───────────────────────────────────────────────────────────────────

function initDb(): Database.Database {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id             TEXT PRIMARY KEY,
      team_slug      TEXT NOT NULL,
      team_name      TEXT NOT NULL,
      sport          TEXT NOT NULL,
      title          TEXT NOT NULL,
      venue          TEXT,
      event_datetime TEXT NOT NULL,
      stubhub_url    TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS price_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id      TEXT NOT NULL REFERENCES events(id),
      polled_at     TEXT NOT NULL DEFAULT (datetime('now')),
      days_until    INTEGER NOT NULL,
      hours_until   REAL NOT NULL,
      lowest_price  REAL,
      listing_count INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_snap_event ON price_snapshots(event_id, polled_at);
  `);
  // Migrate: add stubhub_url if missing
  try { db.exec(`ALTER TABLE events ADD COLUMN stubhub_url TEXT`); } catch {}
  // Migrate: drop median_price column isn't needed (SQLite can't drop columns easily, just ignore it)
  return db;
}

// Initialise on startup
initDb().close();

// ── Auth helper ───────────────────────────────────────────────────────────────

function getIngestToken(): string | null {
  try {
    if (!fs.existsSync(configPath)) return null;
    return JSON.parse(fs.readFileSync(configPath, "utf8")).ingestToken ?? null;
  } catch { return null; }
}

function checkIngestToken(req: Request): boolean {
  const token = getIngestToken();
  if (!token) return false;
  const auth = req.headers.authorization ?? "";
  return auth === `Bearer ${token}`;
}

// ── Tier logic ────────────────────────────────────────────────────────────────

const SCRAPE_TIERS: Array<{ maxHours: number; intervalHours: number }> = [
  { maxHours: 6,    intervalHours: 10 / 60 }, // < 6h:      every 10 min
  { maxHours: 24,   intervalHours: 0.5 },      // 6–24h:     every 30 min
  { maxHours: 168,  intervalHours: 2 },         // 1–7d:      every 2h
  { maxHours: 720,  intervalHours: 6 },         // 7–30d:     every 6h
  { maxHours: 2160, intervalHours: 24 },        // 30–90d:    every 24h
  { maxHours: Infinity, intervalHours: 168 },   // >90d:      weekly
];

function intervalForHours(hoursUntil: number): number {
  for (const tier of SCRAPE_TIERS) {
    if (hoursUntil < tier.maxHours) return tier.intervalHours;
  }
  return 168;
}

// ── Routes ────────────────────────────────────────────────────────────────────

const router = Router();

// GET /api/tickets/events — upcoming events with latest price
router.get("/api/tickets/events", (_req: Request, res: Response) => {
  if (!fs.existsSync(dbPath)) return res.json([]);
  try {
    const db = new Database(dbPath, { readonly: true });
    const now = new Date().toISOString().slice(0, 19);
    const rows = db.prepare(`
      SELECT
        e.id, e.team_slug, e.team_name, e.sport, e.title, e.venue,
        e.event_datetime, e.stubhub_url,
        s.polled_at, s.days_until, s.hours_until,
        s.lowest_price, s.listing_count
      FROM events e
      LEFT JOIN price_snapshots s ON s.id = (
        SELECT id FROM price_snapshots
        WHERE event_id = e.id
        ORDER BY polled_at DESC LIMIT 1
      )
      WHERE e.event_datetime > ?
      ORDER BY e.event_datetime ASC
    `).all(now);
    db.close();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/tickets/due — events due for scraping based on tier logic
// Returns only events that need a fresh price snapshot right now.
router.get("/api/tickets/due", (_req: Request, res: Response) => {
  if (!fs.existsSync(dbPath)) return res.json([]);
  try {
    const db = new Database(dbPath, { readonly: true });
    const now = new Date();
    const nowIso = now.toISOString().slice(0, 19);

    const rows = db.prepare(`
      SELECT
        e.id, e.team_slug, e.team_name, e.sport, e.title, e.venue,
        e.event_datetime, e.stubhub_url,
        s.polled_at, s.hours_until as last_hours_until
      FROM events e
      LEFT JOIN price_snapshots s ON s.id = (
        SELECT id FROM price_snapshots
        WHERE event_id = e.id
        ORDER BY polled_at DESC LIMIT 1
      )
      WHERE e.event_datetime > ?
      ORDER BY e.event_datetime ASC
    `).all(nowIso) as Array<{
      id: string; team_slug: string; team_name: string; sport: string;
      title: string; venue: string | null; event_datetime: string;
      stubhub_url: string | null; polled_at: string | null; last_hours_until: number | null;
    }>;
    db.close();

    const due = rows
      .map((row) => {
        const eventDt = new Date(row.event_datetime + (row.event_datetime.endsWith("Z") ? "" : "Z"));
        const hoursUntil = (eventDt.getTime() - now.getTime()) / 3_600_000;
        const interval = intervalForHours(hoursUntil);
        let isDue: boolean;
        if (!row.polled_at) {
          isDue = true;
        } else {
          const lastPolled = new Date(row.polled_at);
          const ageHours = (now.getTime() - lastPolled.getTime()) / 3_600_000;
          isDue = ageHours >= interval;
        }
        return { ...row, hours_until: Math.round(hoursUntil * 10) / 10, interval_hours: interval, is_due: isDue };
      })
      .filter((r) => r.is_due);

    res.json(due);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/tickets/events/:id/history
router.get("/api/tickets/events/:id/history", (req: Request, res: Response) => {
  if (!fs.existsSync(dbPath)) return res.json([]);
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(`
      SELECT polled_at, days_until, hours_until, lowest_price, listing_count
      FROM price_snapshots
      WHERE event_id = ?
      ORDER BY polled_at ASC
    `).all(req.params.id);
    db.close();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/tickets/teams
router.get("/api/tickets/teams", (_req: Request, res: Response) => {
  res.json(loadTeams());
});

// GET /api/tickets/ingest-token — return token for scheduled task config (auth required)
router.get("/api/tickets/ingest-token", (_req: Request, res: Response) => {
  res.json({ token: getIngestToken(), endpoint: "http://host.docker.internal:3100/api/tickets/ingest" });
});

// POST /api/tickets/ingest — browser scraper posts results here (bearer token auth)
// Accepts: { events: [{ stubhub_id, team_slug, title, venue, event_datetime, stubhub_url, lowest_price, listing_count }] }
router.post("/api/tickets/ingest", (req: Request, res: Response) => {
  if (!checkIngestToken(req)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const events = req.body?.events as IngestEvent[] | undefined;
  if (!Array.isArray(events) || events.length === 0) {
    return res.status(400).json({ error: "events array required" });
  }

  try {
    const db = initDb();
    const now = new Date();

    const upsertEvent = db.prepare(`
      INSERT INTO events (id, team_slug, team_name, sport, title, venue, event_datetime, stubhub_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        venue = excluded.venue,
        stubhub_url = excluded.stubhub_url
    `);

    const insertSnap = db.prepare(`
      INSERT INTO price_snapshots (event_id, polled_at, days_until, hours_until, lowest_price, listing_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;
    const errors: string[] = [];

    db.transaction(() => {
      for (const ev of events) {
        try {
          const team = loadTeams().find((t) => t.slug === ev.team_slug);
          if (!team) { errors.push(`Unknown team: ${ev.team_slug}`); continue; }

          const eventDt = new Date(ev.event_datetime);
          const hoursUntil = (eventDt.getTime() - now.getTime()) / 3600000;
          if (hoursUntil <= 0) continue; // skip past events

          upsertEvent.run(
            ev.stubhub_id, team.slug, team.name, team.sport,
            ev.title, ev.venue ?? null, ev.event_datetime, ev.stubhub_url ?? null,
          );

          if (ev.lowest_price != null) {
            // Divide by 2: scraper sends the qty=2 total lowPrice, we store per-ticket
            const perTicket = Math.round((ev.lowest_price / 2) * 100) / 100;
            insertSnap.run(
              ev.stubhub_id,
              now.toISOString(),
              Math.floor(hoursUntil / 24),
              Math.round(hoursUntil * 10) / 10,
              perTicket,
              ev.listing_count ?? null,
            );
            inserted++;
          }
        } catch (err) {
          errors.push(`${ev.stubhub_id}: ${String(err)}`);
        }
      }
    })();

    db.close();
    res.json({ inserted, errors });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// GET /api/tickets/insights — "best time to buy" aggregate
router.get("/api/tickets/insights", (req: Request, res: Response) => {
  if (!fs.existsSync(dbPath)) return res.json([]);
  try {
    const db = new Database(dbPath, { readonly: true });
    const teamSlug = (req.query.team as string | undefined)?.replace(/'/g, "");
    const whereTeam = teamSlug && teamSlug !== "all" ? `AND e.team_slug = '${teamSlug}'` : "";

    const rows = db.prepare(`
      SELECT
        CASE
          WHEN s.days_until < 1  THEN 'Same day'
          WHEN s.days_until < 3  THEN '1-2 days'
          WHEN s.days_until < 7  THEN '3-6 days'
          WHEN s.days_until < 14 THEN '1-2 weeks'
          WHEN s.days_until < 30 THEN '2-4 weeks'
          ELSE '1+ month'
        END as window,
        CASE
          WHEN s.days_until < 1  THEN 0
          WHEN s.days_until < 3  THEN 1
          WHEN s.days_until < 7  THEN 2
          WHEN s.days_until < 14 THEN 3
          WHEN s.days_until < 30 THEN 4
          ELSE 5
        END as window_order,
        ROUND(AVG(s.lowest_price), 2) as avg_lowest,
        COUNT(*) as sample_count
      FROM price_snapshots s
      JOIN events e ON e.id = s.event_id
      WHERE s.lowest_price IS NOT NULL ${whereTeam}
      GROUP BY window_order
      ORDER BY window_order
    `).all();
    db.close();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

export default router;

// ── Types ─────────────────────────────────────────────────────────────────────

interface IngestEvent {
  stubhub_id: string;
  team_slug: string;
  title: string;
  venue?: string;
  event_datetime: string;  // ISO UTC
  stubhub_url?: string;
  lowest_price?: number;   // per ticket, pre-fee
  listing_count?: number;
}
