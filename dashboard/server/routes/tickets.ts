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
const venuesConfigPath = path.join(nanoclawRoot, "data/sessions/tickets/.claude/venues-config.json");

interface TeamConfig {
  slug: string;
  name: string;
  sport: string;
  color: string;
  home_venue?: string;
  home_venue_slug?: string;
  enabled?: boolean;
  // Either a performer URL (per-team page) or a grouping URL (tournament/event
  // group page like World Cup). Discovery picks based on which is present.
  stubhub_performer_url?: string;
  stubhub_grouping_url?: string;
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

// GET /api/tickets/events?include_past=1&game_type=home|away|all — events with latest per-category prices
router.get("/api/tickets/events", (req: Request, res: Response) => {
  const db = openDb();
  if (!db) return res.json([]);
  const includePast = req.query.include_past === "1";
  const gameType = (req.query.game_type as string | undefined) ?? "all";
  const gameFilter =
    gameType === "home"
      ? " AND is_home_game = 1"
      : gameType === "away"
        ? " AND (is_home_game = 0)"
        : "";
  try {
    // Get events
    const events = db
      .prepare(
        includePast
          ? `SELECT id, team_slug, team_name, sport, title, venue, venue_slug,
                event_datetime, stubhub_url, status, is_home_game,
                weather_high, weather_low, weather_precip_pct
           FROM events
           WHERE 1=1${gameFilter}
           ORDER BY CASE WHEN event_datetime IS NULL THEN 1 ELSE 0 END, datetime(event_datetime) ASC`
          : `SELECT id, team_slug, team_name, sport, title, venue, venue_slug,
                event_datetime, stubhub_url, status, is_home_game,
                weather_high, weather_low, weather_precip_pct
           FROM events
           WHERE status IN ('active', 'pending')
             AND (datetime(event_datetime) > datetime('now') OR event_datetime IS NULL)${gameFilter}
           ORDER BY CASE WHEN event_datetime IS NULL THEN 1 ELSE 0 END, datetime(event_datetime) ASC`
      )
      .all() as Array<{
      id: number;
      team_slug: string;
      team_name: string;
      sport: string;
      title: string;
      venue: string | null;
      venue_slug: string | null;
      event_datetime: string;
      stubhub_url: string | null;
      status: string;
      is_home_game: number | null;
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
                lowest_price, listing_count, best_section,
                weather_high, weather_low, weather_precip_pct
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

interface VenueConfig {
  slug: string;
  name: string;
  sport: string;
  home_team_slug?: string;
  indoor?: boolean;
  latitude?: number;
  longitude?: number;
  aliases?: string[];
  description?: string;
}

function loadVenues(): VenueConfig[] {
  try {
    const raw = JSON.parse(fs.readFileSync(venuesConfigPath, "utf8"));
    if (Array.isArray(raw.venues)) return raw.venues;
  } catch {}
  return [];
}

// GET /api/tickets/categories?venue=yankee-stadium — section categories with section lists
// Back-compat: ?team=<slug> resolves to that team's home venue.
router.get("/api/tickets/categories", (req: Request, res: Response) => {
  const db = openDb();
  if (!db) return res.json([]);
  try {
    let venue = req.query.venue as string | undefined;
    const team = req.query.team as string | undefined;

    // Back-compat: map team slug to its home venue
    if (!venue && team) {
      const venues = loadVenues();
      const match = venues.find((v) => v.home_team_slug === team);
      if (match) venue = match.slug;
    }

    if (!venue) {
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
         WHERE venue_slug = ? ORDER BY category, section_name`
      )
      .all(venue) as Array<{ category: string; section_name: string }>;
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

// GET /api/tickets/venues — venue registry (metadata only, no section lists)
router.get("/api/tickets/venues", (_req: Request, res: Response) => {
  res.json(loadVenues());
});


// GET /api/tickets/health — Pricer run health summary (24h + 7d) plus stale-event counts
const messagesDbPath = path.join(nanoclawRoot, "store/messages.db");
router.get("/api/tickets/health", (_req: Request, res: Response) => {
  const result: Record<string, unknown> = {};

  // Pricer run-log signals — look up task ID by name so this survives task re-creation
  try {
    const msgDb = new Database(messagesDbPath, { readonly: true });

    // Resolve the canonical Ticket Pricer task ID (non-manual, most recently created)
    const pricerTask = msgDb
      .prepare(
        `SELECT id FROM scheduled_tasks WHERE name = 'Ticket Pricer' AND id NOT LIKE '%-manual-%' ORDER BY created_at DESC LIMIT 1`
      )
      .get() as { id: string } | undefined;

    const pricerTaskId = pricerTask?.id ?? "__not_found__";

    const lastRun = msgDb
      .prepare(
        `SELECT run_at, status, duration_ms, substr(result, 1, 240) AS summary
           FROM task_run_logs WHERE task_id = ?
          ORDER BY run_at DESC LIMIT 1`
      )
      .get(pricerTaskId) as
      | { run_at: string; status: string; duration_ms: number; summary: string | null }
      | undefined;
    result.last_run = lastRun ?? null;

    // Recent failure tally — last 12 runs is two failed Pricer cycles (1h)
    result.recent_runs = msgDb
      .prepare(
        `SELECT run_at, status, duration_ms, substr(result, 1, 240) AS summary
           FROM task_run_logs WHERE task_id = ?
          ORDER BY run_at DESC LIMIT 12`
      )
      .all(pricerTaskId);

    msgDb.close();
  } catch (e) {
    result.run_log_error = String(e);
  }

  // Per-event signals (the actionable stuff)
  const db = openDb();
  if (db) {
    try {
      // Game-day events: should be polled every 30 min — flag any whose last
      // poll is more than 60 min old, or never polled
      result.game_day = db
        .prepare(
          `SELECT e.id, e.title, e.event_datetime,
                  ROUND((julianday(e.event_datetime) - julianday('now')) * 24, 1) AS hours_until,
                  (SELECT MAX(polled_at) FROM price_snapshots WHERE event_id = e.id) AS last_polled,
                  ROUND((julianday('now') - julianday((SELECT MAX(polled_at) FROM price_snapshots WHERE event_id = e.id))) * 24 * 60, 0) AS minutes_since_poll
             FROM events e
            WHERE e.status != 'completed'
              AND datetime(e.event_datetime) > datetime('now')
              AND (julianday(e.event_datetime) - julianday('now')) * 24 < 24
            ORDER BY e.event_datetime`
        )
        .all();

      // Recurring failure detection: events that are >3x past their tier
      // interval (or never polled). These are the ones that need attention.
      // Tier intervals (minutes): <1h=10, 1-6h=30, 6-24h=120, 1-7d=360,
      // 7-30d=1440, 30-90d=1440, >90d=10080.
      result.stuck_events = db
        .prepare(
          `WITH last_poll AS (
             SELECT event_id, MAX(polled_at) AS lp,
                    (julianday('now') - julianday(MAX(polled_at))) * 24 * 60 AS minutes_since
               FROM price_snapshots GROUP BY event_id
           ),
           classified AS (
             SELECT e.id, e.title, e.team_slug, e.venue_slug,
                    (julianday(e.event_datetime) - julianday('now')) * 24 AS h_until,
                    lp.minutes_since,
                    CASE
                      WHEN (julianday(e.event_datetime)-julianday('now'))*24 < 1 THEN 10
                      WHEN (julianday(e.event_datetime)-julianday('now'))*24 < 6 THEN 30
                      WHEN (julianday(e.event_datetime)-julianday('now'))*24 < 24 THEN 120
                      WHEN (julianday(e.event_datetime)-julianday('now'))*24 < 168 THEN 360
                      WHEN (julianday(e.event_datetime)-julianday('now'))*24 < 720 THEN 1440
                      WHEN (julianday(e.event_datetime)-julianday('now'))*24 < 2160 THEN 1440
                      ELSE 10080
                    END AS interval_min
               FROM events e
               LEFT JOIN last_poll lp ON lp.event_id = e.id
              WHERE e.status != 'completed'
                AND datetime(e.event_datetime) > datetime('now')
                AND e.stubhub_url IS NOT NULL
           )
           SELECT id, title, team_slug, venue_slug,
                  ROUND(h_until, 1) AS hours_until,
                  ROUND(minutes_since / NULLIF(interval_min, 0), 1) AS overdue_ratio,
                  CASE WHEN minutes_since IS NULL THEN 'never' ELSE 'overdue' END AS kind
             FROM classified
            WHERE (minutes_since IS NULL OR minutes_since > 3 * interval_min)
            ORDER BY (minutes_since IS NULL) DESC, overdue_ratio DESC NULLS LAST
            LIMIT 20`
        )
        .all();

      // Counts (cheap sanity numbers)
      result.counts = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM events WHERE status != 'completed' AND datetime(event_datetime) > datetime('now')) AS active_or_pending,
             (SELECT COUNT(*) FROM events e WHERE e.status != 'completed' AND datetime(e.event_datetime) > datetime('now') AND NOT EXISTS (SELECT 1 FROM price_snapshots WHERE event_id=e.id)) AS never_polled,
             (SELECT COUNT(DISTINCT event_id) FROM price_snapshots WHERE datetime(polled_at) > datetime('now','-60 minutes')) AS events_polled_60min`
        )
        .get();
    } catch (e) {
      result.events_error = String(e);
    }
  }

  res.json(result);
});


// GET /api/tickets/errors-timeseries?hours=N — bucketed run counts (success / WAF / failed)
// Buckets are sized so each window returns ~24-30 data points: enough resolution
// to see trends without rendering hundreds of bars.
router.get("/api/tickets/errors-timeseries", (req: Request, res: Response) => {
  const hours = Math.max(1, Math.min(720, parseInt(String(req.query.hours ?? "24"), 10) || 24));
  // Pick a bucket size that gives ~24-36 buckets across the window.
  const bucketMinutes =
    hours <= 3 ? 10
      : hours <= 12 ? 30
        : hours <= 24 ? 60
          : hours <= 72 ? 180
            : hours <= 168 ? 360 // 1w → 6h buckets (28 points)
              : hours <= 720 ? 1440 // 1mo → 1d (30 points)
                : 1440;
  const bucketSeconds = bucketMinutes * 60;

  try {
    const msgDb = new Database(messagesDbPath, { readonly: true });
    const cutoffIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();

    // Resolve Ticket Pricer task ID by name
    const pricerTask2 = msgDb
      .prepare(`SELECT id FROM scheduled_tasks WHERE name = 'Ticket Pricer' AND id NOT LIKE '%-manual-%' ORDER BY created_at DESC LIMIT 1`)
      .get() as { id: string } | undefined;
    const pricerTaskId2 = pricerTask2?.id ?? "__not_found__";

    // Pull raw run rows; we parse scraped/errors counts from the result text
    // in JS rather than SQL because the run summaries are free-form.
    const rawRuns = msgDb
      .prepare(
        `SELECT
           (CAST(strftime('%s', run_at) AS INTEGER) / ${bucketSeconds}) * ${bucketSeconds} AS bucket_ts,
           result, status
         FROM task_run_logs
         WHERE task_id = ? AND run_at > ?
         ORDER BY bucket_ts ASC`
      )
      .all(pricerTaskId2, cutoffIso) as Array<{
        bucket_ts: number; result: string | null; status: string;
      }>;

    // Parse "N scraped" / "scraped: N" and "N errors" / "errors: N" patterns.
    // We aggregate at event-level (not run-level) so a run with 6/7 success
    // counts as 6 successes + 1 failure, not "1 failed run".
    const parseCount = (text: string, ...patterns: RegExp[]): number => {
      for (const re of patterns) {
        const m = text.match(re);
        if (m) {
          for (let i = 1; i < m.length; i++) {
            if (m[i] != null) return parseInt(m[i], 10);
          }
        }
      }
      return 0;
    };

    const bucketed = new Map<number, { runs: number; events_scraped: number; events_failed: number }>();
    for (const r of rawRuns) {
      const txt = r.result ?? "";
      const scraped = parseCount(txt, /scraped:\s*(\d+)/i, /(\d+)\s+(?:events?\s+)?scraped/i);
      const errors = parseCount(txt, /errors:\s*(\d+)/i, /(\d+)\s+(?:WAF\s+)?errors?/i);
      const b = bucketed.get(r.bucket_ts) ?? { runs: 0, events_scraped: 0, events_failed: 0 };
      b.runs += 1;
      b.events_scraped += scraped;
      // Treat task-level failure (status != success) as 1 failed event so the
      // catastrophic-run case still shows up in the chart.
      b.events_failed += errors + (r.status !== "success" && scraped === 0 && errors === 0 ? 1 : 0);
      bucketed.set(r.bucket_ts, b);
    }

    const buckets = Array.from(bucketed.entries())
      .sort(([a], [b]) => a - b)
      .map(([bucket_ts, v]) => ({ bucket_ts, ...v }));

    msgDb.close();
    res.json({ bucket_minutes: bucketMinutes, hours, buckets });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});


// GET /api/tickets/export/snapshots.csv — all price snapshots joined with event info
router.get("/api/tickets/export/snapshots.csv", (_req: Request, res: Response) => {
  const db = openDb();
  if (!db) {
    res.setHeader("Content-Type", "text/csv");
    return res.send("snapshot_id,event_id,team_slug,team_name,sport,title,venue,event_datetime,status,is_home_game,weather_high,weather_low,weather_precip_pct,category,polled_at,days_until,hours_until,lowest_price,listing_count,best_section\n");
  }
  try {
    const rows = db
      .prepare(
        // Weather columns come from price_snapshots (per-snapshot forecast)
        // for rows captured after the per-snapshot weather change. Older rows
        // fall back to the event's current forecast via COALESCE so the CSV
        // never has gaps for historical data even though it loses snapshot-
        // time fidelity for those.
        `SELECT ps.id as snapshot_id, ps.event_id,
                e.team_slug, e.team_name, e.sport,
                e.title, e.venue, e.event_datetime, e.status, e.is_home_game,
                COALESCE(ps.weather_high, e.weather_high) AS weather_high,
                COALESCE(ps.weather_low, e.weather_low) AS weather_low,
                COALESCE(ps.weather_precip_pct, e.weather_precip_pct) AS weather_precip_pct,
                ps.category, ps.polled_at, ps.days_until, ps.hours_until,
                ps.lowest_price, ps.listing_count, ps.best_section
         FROM price_snapshots ps
         JOIN events e ON e.id = ps.event_id
         ORDER BY ps.polled_at ASC, ps.event_id, ps.category`
      )
      .all() as Array<Record<string, unknown>>;
    db.close();

    const header = "snapshot_id,event_id,team_slug,team_name,sport,title,venue,event_datetime,status,is_home_game,weather_high,weather_low,weather_precip_pct,category,polled_at,days_until,hours_until,lowest_price,listing_count,best_section\n";
    const csvRow = (r: Record<string, unknown>) =>
      [r.snapshot_id, r.event_id, r.team_slug, r.team_name, r.sport,
        `"${String(r.title ?? "").replace(/"/g, '""')}"`,
        r.venue != null ? `"${String(r.venue).replace(/"/g, '""')}"` : "",
        r.event_datetime ?? "", r.status ?? "",
        r.is_home_game ?? "",
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
