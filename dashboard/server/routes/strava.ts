import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "crypto";
import { renderTripHtml, renderIndexHtml, IndexTrip } from "../lib/render-trip-html.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot = process.env.NANOCLAW_ROOT || path.resolve(__dirname, "../..");
const dbPath =
  process.env.STRAVA_DB ||
  path.join(nanoclawRoot, "data/sessions/fitness/.claude/strava.db");
const credPath = path.join(
  nanoclawRoot,
  "data/sessions/fitness/.claude/strava-credentials.json"
);

interface StravaCredential {
  athlete_id: number;
  athlete_name: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  access_token?: string;
  token_expiry?: number;
  show_streak?: boolean;
}

function getDb(): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

function getDbWrite(): Database.Database | null {
  if (!fs.existsSync(dbPath)) return null;
  try {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
  } catch {
    return null;
  }
}

function ensureGroupTables(): void {
  const db = getDbWrite();
  if (!db) return;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS activity_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        athlete_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        start_date TEXT,
        end_date TEXT,
        -- Stored as ISO 8601 UTC (e.g. "2026-05-25T20:18:20.123Z"). SQLite's
        -- CURRENT_TIMESTAMP returns space-separated UTC which JS Date parses
        -- inconsistently across browsers; strftime gives us a portable string.
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        published_slug TEXT,
        published_at TEXT
      );

      CREATE TABLE IF NOT EXISTS activity_group_members (
        group_id INTEGER NOT NULL,
        activity_id INTEGER NOT NULL,
        leg_order INTEGER NOT NULL,
        PRIMARY KEY (group_id, activity_id),
        FOREIGN KEY (group_id) REFERENCES activity_groups(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_group_members_activity
        ON activity_group_members(activity_id);

      CREATE TABLE IF NOT EXISTS activity_streams (
        activity_id INTEGER PRIMARY KEY,
        time_json TEXT,
        distance_json TEXT,
        altitude_json TEXT,
        heartrate_json TEXT,
        velocity_json TEXT,
        latlng_json TEXT,
        fetched_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      -- Non-Strava transit segments (trains, ferries, etc.). Rendered as
      -- dashed lines on the trip map and as interleaved rows in the legs
      -- table, but excluded from totals, sport breakdown, and profile chart.
      CREATE TABLE IF NOT EXISTS activity_group_travel_legs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL REFERENCES activity_groups(id) ON DELETE CASCADE,
        mode TEXT NOT NULL,            -- 'train' | 'ferry' | 'plane' | 'bus' | 'car'
        start_date TEXT NOT NULL,      -- ISO local date — drives ordering
        start_lat REAL NOT NULL,
        start_lng REAL NOT NULL,
        start_label TEXT,
        end_lat REAL NOT NULL,
        end_lng REAL NOT NULL,
        end_label TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_travel_legs_group
        ON activity_group_travel_legs(group_id);
    `);
    // Idempotent migrations. better-sqlite3 bundles a recent SQLite that
    // supports ALTER TABLE DROP COLUMN (3.35+), so failures here are real bugs
    // worth surfacing rather than silently swallowing.
    const cols = db
      .prepare("PRAGMA table_info(activity_groups)")
      .all() as { name: string }[];
    const colNames = new Set(cols.map((c) => c.name));
    if (colNames.has("kind")) {
      db.exec("ALTER TABLE activity_groups DROP COLUMN kind");
    }
    if (colNames.has("color")) {
      db.exec("ALTER TABLE activity_groups DROP COLUMN color");
    }
    if (!colNames.has("published_slug")) {
      db.exec("ALTER TABLE activity_groups ADD COLUMN published_slug TEXT");
    }
    if (!colNames.has("published_at")) {
      db.exec("ALTER TABLE activity_groups ADD COLUMN published_at TEXT");
    }
    if (!colNames.has("photos_url")) {
      db.exec("ALTER TABLE activity_groups ADD COLUMN photos_url TEXT");
    }
    // Normalize legacy SQLite-format timestamps ("2026-05-25 20:18:20") to
    // ISO 8601 with Z suffix. New rows already use the strftime default; this
    // catches rows inserted before the format switch.
    db.exec(`
      UPDATE activity_groups
         SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
       WHERE created_at IS NOT NULL AND created_at NOT LIKE '%T%Z';
      UPDATE activity_groups
         SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at)
       WHERE updated_at IS NOT NULL AND updated_at NOT LIKE '%T%Z';
      UPDATE activity_streams
         SET fetched_at = strftime('%Y-%m-%dT%H:%M:%fZ', fetched_at)
       WHERE fetched_at IS NOT NULL AND fetched_at NOT LIKE '%T%Z';
    `);

    // Rewrite column defaults: SQLite has no ALTER COLUMN SET DEFAULT, so we
    // recreate the table when its stored defaults still reference the legacy
    // CURRENT_TIMESTAMP. Detect via sqlite_master and skip if already rewritten.
    //
    // CRITICAL: foreign_keys must be disabled around the rebuild, otherwise
    // DROP TABLE fires `ON DELETE CASCADE` on any tables that reference this
    // one (e.g. activity_group_members → activity_groups), nuking child rows
    // before the rename completes. See SQLite docs:
    //   https://sqlite.org/lang_altertable.html#otheralter
    function rewriteIfLegacy(table: string, ddl: string, copyCols: string) {
      const row = db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table) as { sql: string } | undefined;
      if (!row || !row.sql.includes("CURRENT_TIMESTAMP")) return;
      db.pragma("foreign_keys = OFF");
      try {
        db.exec(`
          BEGIN;
          CREATE TABLE ${table}__new ${ddl};
          INSERT INTO ${table}__new (${copyCols}) SELECT ${copyCols} FROM ${table};
          DROP TABLE ${table};
          ALTER TABLE ${table}__new RENAME TO ${table};
          COMMIT;
        `);
        // Sanity check: no dangling references after the rewrite.
        const violations = db.prepare("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error(
            `Foreign-key violations after rewriting ${table}: ${JSON.stringify(violations)}`
          );
        }
      } finally {
        db.pragma("foreign_keys = ON");
      }
    }
    rewriteIfLegacy(
      "activity_groups",
      `(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        athlete_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        start_date TEXT,
        end_date TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        published_slug TEXT,
        published_at TEXT,
        photos_url TEXT
      )`,
      "id, athlete_id, name, description, start_date, end_date, created_at, updated_at, published_slug, published_at, photos_url"
    );
    rewriteIfLegacy(
      "activity_streams",
      `(
        activity_id INTEGER PRIMARY KEY,
        time_json TEXT,
        distance_json TEXT,
        altitude_json TEXT,
        heartrate_json TEXT,
        velocity_json TEXT,
        latlng_json TEXT,
        fetched_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
      "activity_id, time_json, distance_json, altitude_json, heartrate_json, velocity_json, latlng_json, fetched_at"
    );
  } finally {
    db.close();
  }
}

ensureGroupTables();

function getCredentials(): StravaCredential[] {
  try {
    if (!fs.existsSync(credPath)) return [];
    const raw = JSON.parse(fs.readFileSync(credPath, "utf8"));
    return Array.isArray(raw) ? raw : [raw];
  } catch {
    return [];
  }
}

async function getFreshToken(cred: StravaCredential): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cred.access_token && cred.token_expiry && cred.token_expiry > now + 60) {
    return cred.access_token;
  }
  const res = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: cred.client_id,
      client_secret: cred.client_secret,
      refresh_token: cred.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json() as { access_token: string; refresh_token: string; expires_at: number };
  // Save updated tokens back
  const creds = getCredentials().map((c) =>
    c.athlete_id === cred.athlete_id
      ? { ...c, access_token: data.access_token, refresh_token: data.refresh_token, token_expiry: data.expires_at }
      : c
  );
  fs.writeFileSync(credPath, JSON.stringify(creds, null, 2));
  return data.access_token;
}

const router = Router();

// GET /api/strava/athletes — profiles with aggregate stats
router.get("/api/strava/athletes", (_req: Request, res: Response) => {
  const creds = getCredentials();
  const db = getDb();

  if (!db) {
    // Return shells from credentials file (before first sync)
    return res.json(
      creds.map((c) => ({
        athlete_id: c.athlete_id,
        name: c.athlete_name,
        username: null,
        profile_pic: null,
        city: null,
        state: null,
        country: null,
        sex: null,
        last_sync: null,
        activities_synced: 0,
        total_activities: 0,
        total_distance_m: 0,
        total_moving_time_s: 0,
        total_elevation_m: 0,
        show_streak: c.show_streak !== false,
      }))
    );
  }

  const rows = db
    .prepare(
      `
    SELECT
      a.id AS athlete_id,
      a.name,
      a.username,
      a.profile_pic,
      a.city,
      a.state,
      a.country,
      a.sex,
      sl.last_sync,
      sl.activities_synced,
      COUNT(act.id)                       AS total_activities,
      COALESCE(SUM(act.distance), 0)      AS total_distance_m,
      COALESCE(SUM(act.moving_time), 0)   AS total_moving_time_s,
      COALESCE(SUM(act.total_elevation_gain), 0) AS total_elevation_m
    FROM athletes a
    LEFT JOIN sync_log sl ON sl.athlete_id = a.id
    LEFT JOIN activities act ON act.athlete_id = a.id
    GROUP BY a.id
    ORDER BY a.name
  `
    )
    .all() as Record<string, unknown>[];

  db.close();

  // Merge show_streak from credentials
  const credMap = new Map(creds.map((c) => [c.athlete_id, c]));
  const enriched = (rows as Record<string, unknown>[]).map((r) => {
    const cred = credMap.get(r.athlete_id as number);
    return { ...r, show_streak: cred ? cred.show_streak !== false : true };
  });
  res.json(enriched);
});

// GET /api/strava/activities — filtered & paginated
router.get("/api/strava/activities", (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json([]);

  const {
    athlete_id,
    type,
    limit = "30",
    offset = "0",
    search,
    date_from,
    date_to,
  } = req.query;

  let sql = `SELECT * FROM activities WHERE 1=1`;
  const params: (string | number)[] = [];

  if (athlete_id) {
    sql += ` AND athlete_id = ?`;
    params.push(Number(athlete_id));
  }
  if (type && type !== "all") {
    sql += ` AND sport_type = ?`;
    params.push(String(type));
  }
  if (search) {
    sql += ` AND (name LIKE ? OR description LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`);
  }
  if (date_from) {
    sql += ` AND start_date_local >= ?`;
    params.push(String(date_from));
  }
  if (date_to) {
    sql += ` AND start_date_local <= ?`;
    params.push(String(date_to));
  }

  sql += ` ORDER BY start_date_local DESC LIMIT ? OFFSET ?`;
  params.push(Number(limit), Number(offset));

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  db.close();
  res.json(rows);
});

// GET /api/strava/trends — weekly or monthly aggregates
router.get("/api/strava/trends", (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json([]);

  const { athlete_id, period = "week" } = req.query;

  const groupExpr =
    period === "month"
      ? `strftime('%Y-%m', start_date_local)`
      : period === "day"
      ? `substr(start_date_local, 1, 10)`
      : `strftime('%Y-%W', start_date_local)`;
  const dateFilter =
    period === "month"
      ? `datetime('now', '-12 months')`
      : period === "day"
      ? `datetime('now', '-60 days')`
      : `datetime('now', '-112 days')`; // 16 weeks

  let sql = `
    SELECT
      ${groupExpr}                              AS period,
      sport_type,
      ROUND(SUM(distance) / 1000.0, 2)         AS total_km,
      SUM(moving_time)                          AS total_seconds,
      COUNT(*)                                  AS count,
      ROUND(SUM(total_elevation_gain), 0)       AS total_elevation_m,
      ROUND(AVG(average_heartrate), 0)          AS avg_hr
    FROM activities
    WHERE datetime(start_date_local) >= ${dateFilter}
  `;
  const params: (string | number)[] = [];

  if (athlete_id) {
    sql += ` AND athlete_id = ?`;
    params.push(Number(athlete_id));
  }

  sql += ` GROUP BY period, sport_type ORDER BY period`;

  const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
  db.close();
  res.json(rows);
});

// GET /api/strava/stats — breakdown by sport type
router.get("/api/strava/stats", (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ by_type: [] });

  const { athlete_id } = req.query;
  const params: (string | number)[] = [];
  let where = ``;
  if (athlete_id) {
    where = `WHERE athlete_id = ?`;
    params.push(Number(athlete_id));
  }

  const byType = db
    .prepare(
      `
    SELECT
      sport_type,
      COUNT(*)                               AS count,
      ROUND(SUM(distance) / 1000.0, 1)      AS total_km,
      SUM(moving_time)                       AS total_seconds,
      ROUND(SUM(total_elevation_gain), 0)    AS total_elevation_m,
      ROUND(AVG(average_heartrate), 0)       AS avg_hr,
      MAX(distance)                          AS max_distance_m,
      MAX(start_date_local)                  AS last_activity
    FROM activities ${where}
    GROUP BY sport_type
    ORDER BY count DESC
  `
    )
    .all(...params) as Record<string, unknown>[];

  db.close();
  res.json({ by_type: byType });
});

// GET /api/strava/sport-types — distinct sport types (for filter pills)
router.get("/api/strava/sport-types", (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json([]);

  const { athlete_id } = req.query;
  const params: (string | number)[] = [];
  let where = ``;
  if (athlete_id) {
    where = `WHERE athlete_id = ?`;
    params.push(Number(athlete_id));
  }

  const rows = db
    .prepare(
      `SELECT DISTINCT sport_type FROM activities ${where} ORDER BY sport_type`
    )
    .all(...params) as Record<string, unknown>[];

  db.close();
  res.json(rows.map((r) => r.sport_type));
});

// GET /api/strava/activity/:id — full detail for one activity
router.get("/api/strava/activity/:id", (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.status(404).json({ error: "no data" });

  const row = db
    .prepare(
      `SELECT
        id, athlete_id, name, type, sport_type,
        start_date_local, timezone,
        distance, moving_time, elapsed_time, total_elevation_gain,
        average_speed, max_speed,
        average_heartrate, max_heartrate,
        average_watts, weighted_average_watts, kilojoules, suffer_score,
        kudos_count, comment_count, achievement_count,
        trainer, commute, manual, workout_type,
        gear_id, description,
        map_summary_polyline
      FROM activities WHERE id = ?`
    )
    .get(Number(req.params.id));

  db.close();
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

// GET /api/strava/activity/:id/streams — time-series HR, elevation, pace
router.get("/api/strava/activity/:id/streams", async (req: Request, res: Response) => {
  const activityId = Number(req.params.id);
  const db = getDb();
  if (!db) return res.status(404).json({ error: "no data" });

  // Look up which athlete owns this activity
  const row = db.prepare("SELECT athlete_id FROM activities WHERE id = ?").get(activityId) as { athlete_id: number } | undefined;
  db.close();
  if (!row) return res.status(404).json({ error: "activity not found" });

  const creds = getCredentials();
  const cred = creds.find((c) => c.athlete_id === row.athlete_id);
  if (!cred) return res.status(401).json({ error: "no credentials for athlete" });

  try {
    const token = await getFreshToken(cred);
    const streamsRes = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=heartrate,altitude,velocity_smooth,distance,time&key_by_type=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!streamsRes.ok) {
      return res.status(streamsRes.status).json({ error: "Strava API error" });
    }
    const streams = await streamsRes.json() as Record<string, { data: number[] }>;
    res.json({
      time: streams.time?.data ?? null,
      distance: streams.distance?.data ?? null,
      heartrate: streams.heartrate?.data ?? null,
      altitude: streams.altitude?.data ?? null,
      velocity_smooth: streams.velocity_smooth?.data ?? null,
    });
  } catch {
    res.status(500).json({ error: "Failed to fetch streams" });
  }
});

// GET /api/strava/streak — current weekly streak (weeks with ≥3 active days)
router.get("/api/strava/streak", (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json({ streak: 0 });

  const { athlete_id } = req.query;
  const params: (string | number)[] = [];
  let where = `WHERE moving_time >= 1200`;
  if (athlete_id) {
    where += ` AND athlete_id = ?`;
    params.push(Number(athlete_id));
  }

  const rows = db
    .prepare(
      `SELECT substr(start_date_local, 1, 10) AS date, moving_time
       FROM activities
       ${where}
       ORDER BY date DESC`
    )
    .all(...params) as { date: string; moving_time: number }[];

  db.close();

  // Group total seconds by date
  const byDate = new Map<string, number>();
  for (const r of rows) {
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + r.moving_time);
  }
  const activeDates = new Set(
    [...byDate.entries()].filter(([, s]) => s >= 1200).map(([d]) => d)
  );

  // Walk backwards week by week (Sun–Sat)
  const now = new Date();
  const todayDow = now.getDay(); // 0=Sun
  // Start of current week (Sunday)
  const curWeekStart = new Date(now);
  curWeekStart.setDate(now.getDate() - todayDow);
  curWeekStart.setHours(0, 0, 0, 0);

  const toDateStr = (d: Date) => d.toISOString().slice(0, 10);

  function countActiveDaysInWeek(weekStart: Date): number {
    let count = 0;
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart);
      d.setDate(weekStart.getDate() + i);
      if (activeDates.has(toDateStr(d))) count++;
    }
    return count;
  }

  let streak = 0;
  let weekStart = new Date(curWeekStart);

  // Current week: if it has any active day, treat as alive (don't require ≥3 yet)
  const curWeekActive = countActiveDaysInWeek(weekStart);
  const prevWeekStart = new Date(weekStart);
  prevWeekStart.setDate(weekStart.getDate() - 7);
  const prevWeekActive = countActiveDaysInWeek(prevWeekStart);

  if (curWeekActive > 0 || prevWeekActive >= 3) {
    // Count current week as alive if it has activity OR prev week qualifies
    if (curWeekActive > 0) {
      streak = 1;
      weekStart = prevWeekStart;
    } else {
      weekStart = prevWeekStart;
    }
    // Walk back through completed weeks
    while (true) {
      const active = countActiveDaysInWeek(weekStart);
      if (active >= 3) {
        streak++;
        weekStart = new Date(weekStart);
        weekStart.setDate(weekStart.getDate() - 7);
      } else {
        break;
      }
    }
  }

  res.json({ streak });
});

// GET /api/strava/calendar — days with ≥20 min of activity per month, with individual activities
router.get("/api/strava/calendar", (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json([]);

  const { athlete_id, year, month, start_date, end_date } = req.query;

  const now = new Date();
  const params: (string | number)[] = [];
  let where: string;

  if (start_date && end_date) {
    // Date range mode (used when calendar shows overflow days from adjacent months)
    where = `WHERE substr(start_date_local, 1, 10) >= ? AND substr(start_date_local, 1, 10) <= ?`;
    params.push(String(start_date), String(end_date));
  } else {
    const y = year ? Number(year) : now.getFullYear();
    const m = month ? Number(month) : now.getMonth() + 1;
    const monthStr = `${y}-${String(m).padStart(2, "0")}`;
    where = `WHERE start_date_local LIKE ?`;
    params.push(`${monthStr}-%`);
  }

  if (athlete_id) {
    where += ` AND athlete_id = ?`;
    params.push(Number(athlete_id));
  }

  const rows = db
    .prepare(
      `SELECT
        id,
        substr(start_date_local, 1, 10) AS date,
        name,
        sport_type,
        moving_time,
        distance
      FROM activities
      ${where}
      ORDER BY date, start_date_local`
    )
    .all(...params) as {
      id: number;
      date: string;
      name: string;
      sport_type: string;
      moving_time: number;
      distance: number;
    }[];

  db.close();

  // Group by date
  const byDate = new Map<
    string,
    { id: number; name: string; sport_type: string; moving_time: number; distance: number }[]
  >();
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate
      .get(r.date)!
      .push({
        id: r.id,
        name: r.name,
        sport_type: r.sport_type,
        moving_time: r.moving_time,
        distance: r.distance,
      });
  }

  const result = Array.from(byDate.entries()).map(([date, activities]) => {
    const total_seconds = activities.reduce((s, a) => s + a.moving_time, 0);
    return {
      date,
      total_seconds,
      active: total_seconds >= 1200,
      sport_types: [...new Set(activities.map((a) => a.sport_type))],
      activities,
    };
  });

  res.json(result);
});

const ncDbPath =
  process.env.NANOCLAW_DB ||
  path.join(nanoclawRoot, "store", "messages.db");
const askResponseDir = path.join(
  nanoclawRoot,
  "data/sessions/fitness/.claude"
);

// POST /api/strava/ask — submit a question; returns { task_id }
router.post("/api/strava/ask", (req: Request, res: Response) => {
  const { question, athlete_id } = req.body as {
    question?: string;
    athlete_id?: number;
  };
  if (!question?.trim()) return res.status(400).json({ error: "question required" });

  const taskId = `strava-ask-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const responseFile = `/home/node/.claude/${taskId}.json`;
  const hostResponseFile = path.join(askResponseDir, `${taskId}.json`);

  const athleteFilter = athlete_id
    ? `AND athlete_id = ${Number(athlete_id)}`
    : "";

  const prompt = `You are answering a question about Strava fitness activity data stored in a local SQLite database.

## Database
\`/home/node/.claude/strava.db\` — use Python sqlite3 module.

## Question
${question}

## Instructions
1. Query the strava.db to get relevant data. Useful queries:
   - Summary by sport type: SELECT sport_type, COUNT(*) as count, ROUND(SUM(distance)/1000,1) AS total_km, ROUND(SUM(moving_time)/3600.0,2) AS total_hours FROM activities WHERE 1=1 ${athleteFilter} GROUP BY sport_type ORDER BY count DESC
   - Recent activities: SELECT name, sport_type, start_date_local, ROUND(distance/1000,2) AS km, ROUND(moving_time/60) AS minutes FROM activities WHERE 1=1 ${athleteFilter} ORDER BY start_date_local DESC LIMIT 20
   - Run more specific queries as needed to answer the question accurately.

2. Answer the question concisely in plain text (2-4 sentences max). Include specific numbers.

3. Write ONLY this JSON to \`${responseFile}\`:
\`\`\`json
{"answer": "your answer here"}
\`\`\`

Do not send any messages. Just write the file and exit.`;

  try {
    const ncDb = new Database(ncDbPath);
    const nextRun = new Date(Date.now() + 2000).toISOString();
    ncDb
      .prepare(
        `INSERT INTO scheduled_tasks
          (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, next_run, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        taskId,
        "fitness",
        "tg:-5113982013",
        prompt,
        "once",
        nextRun,
        "isolated",
        nextRun,
        "active",
        new Date().toISOString()
      );
    ncDb.close();
    res.json({ task_id: taskId, response_file: hostResponseFile });
  } catch (e) {
    res.status(500).json({ error: "Failed to schedule ask task" });
  }
});

// GET /api/strava/ask/:taskId — poll for answer
router.get("/api/strava/ask/:taskId", (req: Request, res: Response) => {
  const taskId = req.params.taskId as string;
  if (!taskId.startsWith("strava-ask-")) {
    return res.status(400).json({ error: "invalid task id" });
  }
  const hostResponseFile = path.join(askResponseDir, `${taskId}.json`);
  if (fs.existsSync(hostResponseFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(hostResponseFile, "utf8")) as {
        answer?: string;
      };
      // Clean up
      fs.unlinkSync(hostResponseFile);
      return res.json({ status: "done", answer: data.answer ?? "No answer." });
    } catch {
      return res.json({ status: "done", answer: "Error reading response." });
    }
  }
  res.json({ status: "pending" });
});

// ── Grouped Activities (Trips) ────────────────────────────────────────────────

// Fetch + cache streams for every uncached member of a group. Used to prefetch
// in the background after create/edit so the detail view loads instantly.
async function prefetchGroupStreams(groupId: number): Promise<void> {
  const db = getDbWrite();
  if (!db) return;
  try {
    const members = db
      .prepare(
        `SELECT m.activity_id, a.athlete_id
         FROM activity_group_members m
         JOIN activities a ON a.id = m.activity_id
         WHERE m.group_id = ?`
      )
      .all(groupId) as { activity_id: number; athlete_id: number }[];

    const creds = getCredentials();
    const credByAthlete = new Map(creds.map((c) => [c.athlete_id, c]));
    const selectStream = db.prepare(
      "SELECT 1 FROM activity_streams WHERE activity_id = ?"
    );
    const insertStream = db.prepare(
      `INSERT OR REPLACE INTO activity_streams
         (activity_id, time_json, distance_json, altitude_json,
          heartrate_json, velocity_json, latlng_json, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`
    );

    await Promise.all(
      members.map(async (m) => {
        if (selectStream.get(m.activity_id)) return;
        const cred = credByAthlete.get(m.athlete_id);
        if (!cred) return;
        try {
          const token = await getFreshToken(cred);
          const r = await fetch(
            `https://www.strava.com/api/v3/activities/${m.activity_id}/streams?keys=heartrate,altitude,velocity_smooth,distance,time,latlng&key_by_type=true`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          if (!r.ok) return;
          const streams = (await r.json()) as Record<
            string,
            { data: unknown[] } | undefined
          >;
          const toJson = (k: string) =>
            streams[k]?.data ? JSON.stringify(streams[k]!.data) : null;
          insertStream.run(
            m.activity_id,
            toJson("time"),
            toJson("distance"),
            toJson("altitude"),
            toJson("heartrate"),
            toJson("velocity_smooth"),
            toJson("latlng")
          );
        } catch {
          // swallow — the detail-view endpoint will retry on-demand
        }
      })
    );
  } finally {
    db.close();
  }
}

interface GroupRow {
  id: number;
  athlete_id: number;
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
  published_slug: string | null;
  published_at: string | null;
  photos_url: string | null;
}

interface TravelLegRow {
  id: number;
  mode: string;
  start_date: string;
  start_lat: number;
  start_lng: number;
  start_label: string | null;
  end_lat: number;
  end_lng: number;
  end_label: string | null;
  notes: string | null;
}

const TRAVEL_MODES = new Set(["train", "ferry", "plane", "bus", "car"]);

// Recompute a trip's start_date/end_date as the min/max across both rides and
// travel legs. Travel legs at the edges of the trip (e.g. a final ferry to
// Dubrovnik on Jul 10 when the last ride was Jul 9) shouldn't fall outside
// the trip's visible date range.
function recalcTripDates(db: Database.Database, groupId: number): void {
  const row = db.prepare(`
    WITH dates AS (
      SELECT substr(a.start_date_local, 1, 10) AS d
        FROM activity_group_members m
        JOIN activities a ON a.id = m.activity_id
       WHERE m.group_id = ?
      UNION ALL
      SELECT substr(start_date, 1, 10) AS d
        FROM activity_group_travel_legs
       WHERE group_id = ?
    )
    SELECT MIN(d) AS start_date, MAX(d) AS end_date FROM dates
  `).get(groupId, groupId) as { start_date: string | null; end_date: string | null };
  // Don't overwrite with NULLs when a trip has neither rides nor travel legs
  // (which would be unusual). Leave whatever was there.
  if (row.start_date && row.end_date) {
    db.prepare(
      "UPDATE activity_groups SET start_date = ?, end_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
    ).run(row.start_date, row.end_date, groupId);
  }
}

// GET /api/strava/groups?athlete_id=
router.get("/api/strava/groups", (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.json([]);

  const { athlete_id } = req.query;
  const params: (string | number)[] = [];
  let where = "";
  if (athlete_id) {
    where = "WHERE g.athlete_id = ?";
    params.push(Number(athlete_id));
  }

  const groups = db
    .prepare(
      `SELECT
        g.id, g.athlete_id, g.name, g.description,
        g.start_date, g.end_date, g.created_at, g.updated_at,
        g.published_slug, g.published_at, g.photos_url,
        COUNT(m.activity_id)                            AS leg_count,
        COALESCE(SUM(a.distance), 0)                    AS total_distance_m,
        COALESCE(SUM(a.moving_time), 0)                 AS total_moving_time_s,
        COALESCE(SUM(a.elapsed_time), 0)                AS total_elapsed_time_s,
        COALESCE(SUM(a.total_elevation_gain), 0)        AS total_elevation_m,
        GROUP_CONCAT(DISTINCT a.sport_type)             AS sport_types
      FROM activity_groups g
      LEFT JOIN activity_group_members m ON m.group_id = g.id
      LEFT JOIN activities a              ON a.id = m.activity_id
      ${where}
      GROUP BY g.id
      ORDER BY COALESCE(g.start_date, '0') DESC, g.id DESC`
    )
    .all(...params) as (GroupRow & {
      leg_count: number;
      total_distance_m: number;
      total_moving_time_s: number;
      total_elapsed_time_s: number;
      total_elevation_m: number;
      sport_types: string | null;
    })[];

  // Polylines per group (for mini-map thumbnails)
  const polylinesByGroup: Record<number, string[]> = {};
  if (groups.length) {
    const ids = groups.map((g) => g.id);
    const placeholders = ids.map(() => "?").join(",");
    const polyRows = db
      .prepare(
        `SELECT m.group_id, a.map_summary_polyline
         FROM activity_group_members m
         JOIN activities a ON a.id = m.activity_id
         WHERE m.group_id IN (${placeholders})
         ORDER BY m.leg_order`
      )
      .all(...ids) as { group_id: number; map_summary_polyline: string | null }[];
    for (const r of polyRows) {
      if (!r.map_summary_polyline) continue;
      (polylinesByGroup[r.group_id] ||= []).push(r.map_summary_polyline);
    }
  }

  db.close();
  res.json(
    groups.map((g) => ({
      ...g,
      sport_types: g.sport_types ? g.sport_types.split(",") : [],
      polylines: polylinesByGroup[g.id] || [],
    }))
  );
});

// GET /api/strava/groups/:id — full detail with members and aggregates
router.get("/api/strava/groups/:id", (req: Request, res: Response) => {
  const db = getDb();
  if (!db) return res.status(404).json({ error: "no data" });

  const id = Number(req.params.id);
  const group = db
    .prepare("SELECT * FROM activity_groups WHERE id = ?")
    .get(id) as GroupRow | undefined;
  if (!group) {
    db.close();
    return res.status(404).json({ error: "not found" });
  }

  const members = db
    .prepare(
      `SELECT
         a.id, a.name, a.sport_type, a.start_date_local, a.timezone,
         a.distance, a.moving_time, a.elapsed_time, a.total_elevation_gain,
         a.average_heartrate, a.max_heartrate, a.average_speed, a.max_speed,
         a.average_watts, a.kilojoules, a.suffer_score,
         a.map_summary_polyline, a.description,
         m.leg_order
       FROM activity_group_members m
       JOIN activities a ON a.id = m.activity_id
       WHERE m.group_id = ?
       ORDER BY m.leg_order, a.start_date_local`
    )
    .all(id) as {
      id: number;
      name: string;
      sport_type: string;
      start_date_local: string;
      distance: number | null;
      moving_time: number | null;
      elapsed_time: number | null;
      total_elevation_gain: number | null;
      average_heartrate: number | null;
      kilojoules: number | null;
      map_summary_polyline: string | null;
      leg_order: number;
    }[];

  const travel_legs = db
    .prepare(
      `SELECT id, mode, start_date, start_lat, start_lng, start_label,
              end_lat, end_lng, end_label, notes
         FROM activity_group_travel_legs
        WHERE group_id = ?
        ORDER BY start_date, id`
    )
    .all(id) as TravelLegRow[];

  db.close();

  let distance_m = 0,
    moving_time_s = 0,
    elapsed_time_s = 0,
    elevation_m = 0,
    kilojoules = 0,
    hr_weighted_sum = 0,
    hr_weight = 0;
  const sport_breakdown: Record<string, number> = {};
  for (const m of members) {
    distance_m += m.distance || 0;
    moving_time_s += m.moving_time || 0;
    elapsed_time_s += m.elapsed_time || 0;
    elevation_m += m.total_elevation_gain || 0;
    kilojoules += m.kilojoules || 0;
    if (m.average_heartrate && m.moving_time) {
      hr_weighted_sum += m.average_heartrate * m.moving_time;
      hr_weight += m.moving_time;
    }
    sport_breakdown[m.sport_type] = (sport_breakdown[m.sport_type] || 0) + 1;
  }
  const avg_hr = hr_weight ? Math.round(hr_weighted_sum / hr_weight) : null;
  const calories = kilojoules ? Math.round(kilojoules * 0.239) : 0;

  res.json({
    ...group,
    members,
    travel_legs,
    totals: {
      distance_m,
      moving_time_s,
      elapsed_time_s,
      elevation_m,
      kilojoules,
      avg_hr,
      calories,
    },
    sport_breakdown,
  });
});

// POST /api/strava/groups — create
router.post("/api/strava/groups", (req: Request, res: Response) => {
  const db = getDbWrite();
  if (!db) return res.status(500).json({ error: "db unavailable" });

  const { athlete_id, name, description, activity_ids } =
    (req.body || {}) as {
      athlete_id?: number;
      name?: string;
      description?: string;
      activity_ids?: number[];
    };

  if (
    !athlete_id ||
    !name?.trim() ||
    !Array.isArray(activity_ids) ||
    activity_ids.length < 1
  ) {
    db.close();
    return res
      .status(400)
      .json({ error: "athlete_id, name, activity_ids[] required" });
  }

  try {
    const placeholders = activity_ids.map(() => "?").join(",");
    const owned = db
      .prepare(
        `SELECT id, start_date_local FROM activities
         WHERE id IN (${placeholders}) AND athlete_id = ?
         ORDER BY start_date_local`
      )
      .all(...activity_ids, athlete_id) as {
        id: number;
        start_date_local: string;
      }[];

    if (owned.length !== activity_ids.length) {
      db.close();
      return res
        .status(400)
        .json({ error: "some activities not found or not owned by athlete" });
    }

    const startDate = owned[0].start_date_local.substr(0, 10);
    const endDate = owned[owned.length - 1].start_date_local.substr(0, 10);

    const tx = db.transaction((): number => {
      const r = db
        .prepare(
          `INSERT INTO activity_groups
             (athlete_id, name, description, start_date, end_date)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          athlete_id,
          name.trim(),
          description ?? null,
          startDate,
          endDate
        );
      // recalcTripDates is a no-op here (no travel legs yet on create) but
      // future-proofs the path if a "create with travel legs" flow is ever
      // added — and keeps the start/end_date logic in one place.
      const groupId = Number(r.lastInsertRowid);
      const insertMember = db.prepare(
        `INSERT INTO activity_group_members (group_id, activity_id, leg_order)
         VALUES (?, ?, ?)`
      );
      owned.forEach((m, i) => insertMember.run(groupId, m.id, i));
      return groupId;
    });
    const newId = tx();
    db.close();
    res.json({ id: newId });
    // Background: prefetch streams so the detail-view chart loads instantly
    prefetchGroupStreams(newId).catch(() => {});
  } catch (e) {
    db.close();
    res
      .status(500)
      .json({ error: e instanceof Error ? e.message : "failed to create trip" });
  }
});

// PATCH /api/strava/groups/:id — partial update (name/description/members)
router.patch("/api/strava/groups/:id", (req: Request, res: Response) => {
  const db = getDbWrite();
  if (!db) return res.status(500).json({ error: "db unavailable" });

  const id = Number(req.params.id);
  const existing = db
    .prepare("SELECT * FROM activity_groups WHERE id = ?")
    .get(id) as GroupRow | undefined;
  if (!existing) {
    db.close();
    return res.status(404).json({ error: "not found" });
  }

  const { name, description, photos_url, activity_ids } = (req.body || {}) as {
    name?: string;
    description?: string | null;
    photos_url?: string | null;
    activity_ids?: number[];
  };

  try {
    const tx = db.transaction(() => {
      const updates: string[] = [];
      const params: (string | number | null)[] = [];

      if (name !== undefined) {
        if (!name.trim()) throw new Error("name cannot be empty");
        updates.push("name = ?");
        params.push(name.trim());
      }
      if (description !== undefined) {
        updates.push("description = ?");
        params.push(description);
      }
      if (photos_url !== undefined) {
        const trimmed = photos_url == null ? null : photos_url.trim() || null;
        updates.push("photos_url = ?");
        params.push(trimmed);
      }

      if (Array.isArray(activity_ids)) {
        if (activity_ids.length < 1) throw new Error("activity_ids cannot be empty");
        const placeholders = activity_ids.map(() => "?").join(",");
        const owned = db
          .prepare(
            `SELECT id, start_date_local FROM activities
             WHERE id IN (${placeholders}) AND athlete_id = ?
             ORDER BY start_date_local`
          )
          .all(...activity_ids, existing.athlete_id) as {
            id: number;
            start_date_local: string;
          }[];
        if (owned.length !== activity_ids.length)
          throw new Error("some activities not found or not owned by athlete");
        db.prepare("DELETE FROM activity_group_members WHERE group_id = ?").run(id);
        const insertMember = db.prepare(
          `INSERT INTO activity_group_members (group_id, activity_id, leg_order)
           VALUES (?, ?, ?)`
        );
        owned.forEach((m, i) => insertMember.run(id, m.id, i));
      }

      if (updates.length) {
        updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
        params.push(id);
        db.prepare(
          `UPDATE activity_groups SET ${updates.join(", ")} WHERE id = ?`
        ).run(...params);
      }
      // Recompute the trip date range from the live membership (rides +
      // travel legs). Cheap query; runs after any field update so it covers
      // both the metadata-only case and the membership-change case.
      recalcTripDates(db, id);
    });
    tx();
    db.close();
    res.json({ ok: true });

    // Auto-republish hook: if this trip is already published, keep its public
    // URL in sync with the edit. For metadata-only changes (name/description),
    // republish immediately. For membership changes, wait for the prefetch so
    // newly-added legs land in the published chart on the first render.
    const membersChanged = Array.isArray(activity_ids);
    if (membersChanged) {
      prefetchGroupStreams(id)
        .then(() => {
          try { republishGroup(id, { mustExist: true }); } catch {}
        })
        .catch(() => {});
    } else {
      // Fire-and-forget — published_at update isn't critical-path
      try { republishGroup(id, { mustExist: true }); } catch {}
    }
  } catch (e) {
    db.close();
    res
      .status(400)
      .json({ error: e instanceof Error ? e.message : "update failed" });
  }
});

// DELETE /api/strava/groups/:id
router.delete("/api/strava/groups/:id", (req: Request, res: Response) => {
  const db = getDbWrite();
  if (!db) return res.status(500).json({ error: "db unavailable" });
  const id = Number(req.params.id);
  const r = db.prepare("DELETE FROM activity_groups WHERE id = ?").run(id);
  db.close();
  if (r.changes === 0) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

// ── Publish to public bucket ──────────────────────────────────────────────────

const PUBLIC_BUCKET = "strava-trips";
const TRIP_BRIEFINGS_DIR = path.join(nanoclawRoot, "data/trip-briefings");
const TRIP_BRIEFINGS_TOMBSTONE_DIR = path.join(TRIP_BRIEFINGS_DIR, ".tombstone");

function slugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "trip";
}

function generateSlug(name: string): string {
  const random = crypto.randomBytes(6).toString("base64url").slice(0, 8);
  return `${slugFromName(name)}-${random}`;
}

// Re-render and persist the public index page listing every currently-published
// trip. Called after every publish/unpublish so the index always reflects truth.
function regenerateIndex(db: Database.Database): void {
  const rows = db
    .prepare(
      `SELECT g.id, g.published_slug, g.name, g.start_date, g.end_date,
              g.published_at,
              COUNT(m.activity_id)                            AS leg_count,
              COALESCE(SUM(a.distance), 0)                    AS total_distance_m,
              COALESCE(SUM(a.moving_time), 0)                 AS total_moving_time_s,
              COALESCE(SUM(a.total_elevation_gain), 0)        AS total_elevation_m,
              GROUP_CONCAT(DISTINCT a.sport_type)             AS sport_types_csv
       FROM activity_groups g
       LEFT JOIN activity_group_members m ON m.group_id = g.id
       LEFT JOIN activities a              ON a.id = m.activity_id
       WHERE g.published_slug IS NOT NULL
       GROUP BY g.id`
    )
    .all() as {
      id: number;
      published_slug: string;
      name: string;
      start_date: string | null;
      end_date: string | null;
      published_at: string;
      leg_count: number;
      total_distance_m: number;
      total_moving_time_s: number;
      total_elevation_m: number;
      sport_types_csv: string | null;
    }[];

  const trips: IndexTrip[] = rows.map((r) => ({
    id: r.id,
    slug: r.published_slug,
    name: r.name,
    start_date: r.start_date,
    end_date: r.end_date,
    leg_count: r.leg_count,
    total_distance_m: r.total_distance_m,
    total_moving_time_s: r.total_moving_time_s,
    total_elevation_m: r.total_elevation_m,
    sport_types: r.sport_types_csv ? r.sport_types_csv.split(",") : [],
    published_at: r.published_at,
  }));

  const html = renderIndexHtml(trips);
  if (!fs.existsSync(TRIP_BRIEFINGS_DIR))
    fs.mkdirSync(TRIP_BRIEFINGS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TRIP_BRIEFINGS_DIR, "index.html"), html);
}

// Gather every piece of data needed to render the public HTML
export function buildTripDataForRender(db: Database.Database, groupId: number) {
  const group = db
    .prepare("SELECT * FROM activity_groups WHERE id = ?")
    .get(groupId) as GroupRow | undefined;
  if (!group) return null;

  const members = db
    .prepare(
      `SELECT a.id, a.name, a.sport_type, a.start_date_local,
         a.distance, a.moving_time, a.elapsed_time, a.total_elevation_gain,
         a.average_heartrate, a.map_summary_polyline,
         m.leg_order
       FROM activity_group_members m
       JOIN activities a ON a.id = m.activity_id
       WHERE m.group_id = ?
       ORDER BY m.leg_order, a.start_date_local`
    )
    .all(groupId) as {
      id: number; name: string; sport_type: string; start_date_local: string;
      distance: number | null; moving_time: number | null; elapsed_time: number | null;
      total_elevation_gain: number | null; average_heartrate: number | null;
      map_summary_polyline: string | null; leg_order: number;
    }[];

  // Aggregates
  let distance_m = 0, moving_time_s = 0, elapsed_time_s = 0, elevation_m = 0;
  let hr_weighted_sum = 0, hr_weight = 0;
  const sport_breakdown: Record<string, number> = {};
  for (const m of members) {
    distance_m += m.distance || 0;
    moving_time_s += m.moving_time || 0;
    elapsed_time_s += m.elapsed_time || 0;
    elevation_m += m.total_elevation_gain || 0;
    if (m.average_heartrate && m.moving_time) {
      hr_weighted_sum += m.average_heartrate * m.moving_time;
      hr_weight += m.moving_time;
    }
    sport_breakdown[m.sport_type] = (sport_breakdown[m.sport_type] || 0) + 1;
  }
  const avg_hr = hr_weight ? Math.round(hr_weighted_sum / hr_weight) : null;

  // Streams (cached) for the profile chart
  const streamRows = db
    .prepare(
      `SELECT m.activity_id, a.name, a.sport_type, a.start_date_local,
              s.distance_json, s.altitude_json, s.heartrate_json, s.velocity_json
       FROM activity_group_members m
       JOIN activities a ON a.id = m.activity_id
       LEFT JOIN activity_streams s ON s.activity_id = m.activity_id
       WHERE m.group_id = ?
       ORDER BY m.leg_order`
    )
    .all(groupId) as {
      activity_id: number; name: string; sport_type: string; start_date_local: string;
      distance_json: string | null; altitude_json: string | null;
      heartrate_json: string | null; velocity_json: string | null;
    }[];

  const legStreams = streamRows.map((r) => ({
    activity_id: r.activity_id,
    name: r.name,
    sport_type: r.sport_type,
    start_date_local: r.start_date_local,
    distance: r.distance_json ? JSON.parse(r.distance_json) : null,
    altitude: r.altitude_json ? JSON.parse(r.altitude_json) : null,
    heartrate: r.heartrate_json ? JSON.parse(r.heartrate_json) : null,
    velocity: r.velocity_json ? JSON.parse(r.velocity_json) : null,
  }));

  const travelLegs = db
    .prepare(
      `SELECT id, mode, start_date, start_lat, start_lng, start_label,
              end_lat, end_lng, end_label, notes
         FROM activity_group_travel_legs
        WHERE group_id = ?
        ORDER BY start_date, id`
    )
    .all(groupId) as TravelLegRow[];

  return {
    group,
    tripData: {
      id: group.id,
      name: group.name,
      description: group.description,
      photos_url: group.photos_url,
      published_at: group.published_at,
      start_date: group.start_date,
      end_date: group.end_date,
      members,
      totals: { distance_m, moving_time_s, elapsed_time_s, elevation_m, avg_hr },
      sport_breakdown,
      legStreams,
      travelLegs,
    },
  };
}

// GET /api/strava/groups/:id/preview — render the SAME HTML that publish would
// emit, but return it directly without persisting/uploading. Lets you test the
// public page locally before clicking Publish.
router.get(
  "/api/strava/groups/:id/preview",
  (req: Request, res: Response) => {
    const db = getDb();
    if (!db) return res.status(500).json({ error: "db unavailable" });
    const id = Number(req.params.id);

    const data = buildTripDataForRender(db, id);
    db.close();
    if (!data) return res.status(404).send("Trip not found");

    try {
      const html = renderTripHtml(data.tripData);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      // Discourage caching during local iteration
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.send(html);
    } catch (e) {
      res.status(500).send(
        `<pre>Preview render failed: ${e instanceof Error ? e.message : "unknown"}</pre>`
      );
    }
  }
);

// Shared publish/republish: renders HTML, writes the bucket-watched file,
// updates `published_slug` + `published_at`, and regenerates index.html.
// `mustExist=true` means "only republish if already published" — used by the
// auto-republish hook in PATCH so we don't accidentally publish a draft trip.
function republishGroup(
  id: number,
  opts: { mustExist?: boolean } = {}
): { slug: string; published_at: string; url: string } | null {
  const db = getDbWrite();
  if (!db) return null;
  try {
    const data = buildTripDataForRender(db, id);
    if (!data) return null;
    if (opts.mustExist && !data.group.published_slug) return null;

    const slug = data.group.published_slug || generateSlug(data.group.name);
    const html = renderTripHtml(data.tripData);
    if (!fs.existsSync(TRIP_BRIEFINGS_DIR))
      fs.mkdirSync(TRIP_BRIEFINGS_DIR, { recursive: true });
    fs.writeFileSync(path.join(TRIP_BRIEFINGS_DIR, `${slug}.html`), html);
    const now = new Date().toISOString();
    db.prepare(
      "UPDATE activity_groups SET published_slug = ?, published_at = ? WHERE id = ?"
    ).run(slug, now, id);
    regenerateIndex(db);
    return {
      slug,
      published_at: now,
      url: `https://storage.googleapis.com/${PUBLIC_BUCKET}/${slug}.html`,
    };
  } finally {
    db.close();
  }
}

// POST /api/strava/groups/:id/publish — initial publish (idempotent: re-publishes if already)
router.post(
  "/api/strava/groups/:id/publish",
  (req: Request, res: Response) => {
    const id = Number(req.params.id);
    try {
      const result = republishGroup(id);
      if (!result) return res.status(404).json({ error: "not found" });
      res.json(result);
    } catch (e) {
      res.status(500).json({
        error: e instanceof Error ? e.message : "publish failed",
      });
    }
  }
);

// DELETE /api/strava/groups/:id/publish — unpublish (local file + remote)
router.delete(
  "/api/strava/groups/:id/publish",
  (req: Request, res: Response) => {
    const db = getDbWrite();
    if (!db) return res.status(500).json({ error: "db unavailable" });
    const id = Number(req.params.id);

    const group = db
      .prepare("SELECT published_slug FROM activity_groups WHERE id = ?")
      .get(id) as { published_slug: string | null } | undefined;
    if (!group) {
      db.close();
      return res.status(404).json({ error: "not found" });
    }
    if (!group.published_slug) {
      db.close();
      return res.json({ ok: true, message: "was not published" });
    }

    try {
      // Remove local file
      const localPath = path.join(TRIP_BRIEFINGS_DIR, `${group.published_slug}.html`);
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
      // Drop a tombstone so the watcher script removes the remote copy too
      if (!fs.existsSync(TRIP_BRIEFINGS_TOMBSTONE_DIR))
        fs.mkdirSync(TRIP_BRIEFINGS_TOMBSTONE_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(TRIP_BRIEFINGS_TOMBSTONE_DIR, `${group.published_slug}.html`),
        ""
      );

      db.prepare(
        "UPDATE activity_groups SET published_slug = NULL, published_at = NULL WHERE id = ?"
      ).run(id);
      regenerateIndex(db);
      db.close();
      res.json({ ok: true });
    } catch (e) {
      db.close();
      res.status(500).json({
        error: e instanceof Error ? e.message : "unpublish failed",
      });
    }
  }
);

// ── Travel legs (non-Strava transit segments on a trip map) ───────────────────

interface TravelLegInput {
  mode?: string;
  start_date?: string;
  start_lat?: number;
  start_lng?: number;
  start_label?: string | null;
  end_lat?: number;
  end_lng?: number;
  end_label?: string | null;
  notes?: string | null;
}

function validateTravelLeg(
  body: TravelLegInput,
  { partial = false } = {}
): { error: string } | { values: {
  mode: string;
  start_date: string;
  start_lat: number;
  start_lng: number;
  start_label: string | null;
  end_lat: number;
  end_lng: number;
  end_label: string | null;
  notes: string | null;
} } {
  const required: (keyof TravelLegInput)[] = [
    "mode", "start_date", "start_lat", "start_lng", "end_lat", "end_lng",
  ];
  if (!partial) {
    for (const k of required) {
      if (body[k] === undefined || body[k] === null || body[k] === "") {
        return { error: `${k} is required` };
      }
    }
  }
  if (body.mode !== undefined && !TRAVEL_MODES.has(body.mode)) {
    return {
      error: `mode must be one of: ${Array.from(TRAVEL_MODES).join(", ")}`,
    };
  }
  for (const k of ["start_lat", "end_lat"] as const) {
    if (body[k] !== undefined && (typeof body[k] !== "number" || Math.abs(body[k]!) > 90)) {
      return { error: `${k} must be a number in [-90, 90]` };
    }
  }
  for (const k of ["start_lng", "end_lng"] as const) {
    if (body[k] !== undefined && (typeof body[k] !== "number" || Math.abs(body[k]!) > 180)) {
      return { error: `${k} must be a number in [-180, 180]` };
    }
  }
  if (body.start_date !== undefined && !/^\d{4}-\d{2}-\d{2}/.test(body.start_date)) {
    return { error: "start_date must be ISO YYYY-MM-DD" };
  }
  return {
    values: {
      mode: body.mode!,
      start_date: body.start_date!.slice(0, 10),
      start_lat: body.start_lat!,
      start_lng: body.start_lng!,
      start_label: body.start_label?.trim() || null,
      end_lat: body.end_lat!,
      end_lng: body.end_lng!,
      end_label: body.end_label?.trim() || null,
      notes: body.notes?.trim() || null,
    },
  };
}

// POST /api/strava/groups/:id/travel-legs — create
router.post(
  "/api/strava/groups/:id/travel-legs",
  (req: Request, res: Response) => {
    const db = getDbWrite();
    if (!db) return res.status(500).json({ error: "db unavailable" });
    const groupId = Number(req.params.id);

    const group = db
      .prepare("SELECT id, published_slug FROM activity_groups WHERE id = ?")
      .get(groupId) as { id: number; published_slug: string | null } | undefined;
    if (!group) {
      db.close();
      return res.status(404).json({ error: "trip not found" });
    }

    const v = validateTravelLeg(req.body || {});
    if ("error" in v) {
      db.close();
      return res.status(400).json({ error: v.error });
    }

    try {
      const result = db
        .prepare(
          `INSERT INTO activity_group_travel_legs
             (group_id, mode, start_date, start_lat, start_lng, start_label,
              end_lat, end_lng, end_label, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          groupId, v.values.mode, v.values.start_date,
          v.values.start_lat, v.values.start_lng, v.values.start_label,
          v.values.end_lat, v.values.end_lng, v.values.end_label,
          v.values.notes
        );
      recalcTripDates(db, groupId);
      db.close();
      res.json({ id: result.lastInsertRowid, ...v.values });
      try { republishGroup(groupId, { mustExist: true }); } catch {}
    } catch (e) {
      db.close();
      res.status(500).json({
        error: e instanceof Error ? e.message : "insert failed",
      });
    }
  }
);

// PATCH /api/strava/groups/:id/travel-legs/:tlid — partial update
router.patch(
  "/api/strava/groups/:id/travel-legs/:tlid",
  (req: Request, res: Response) => {
    const db = getDbWrite();
    if (!db) return res.status(500).json({ error: "db unavailable" });
    const groupId = Number(req.params.id);
    const tlid = Number(req.params.tlid);

    const existing = db
      .prepare(
        "SELECT * FROM activity_group_travel_legs WHERE id = ? AND group_id = ?"
      )
      .get(tlid, groupId) as TravelLegRow | undefined;
    if (!existing) {
      db.close();
      return res.status(404).json({ error: "travel leg not found" });
    }

    const merged: TravelLegInput = {
      mode: req.body?.mode ?? existing.mode,
      start_date: req.body?.start_date ?? existing.start_date,
      start_lat: req.body?.start_lat ?? existing.start_lat,
      start_lng: req.body?.start_lng ?? existing.start_lng,
      start_label: req.body?.start_label !== undefined ? req.body.start_label : existing.start_label,
      end_lat: req.body?.end_lat ?? existing.end_lat,
      end_lng: req.body?.end_lng ?? existing.end_lng,
      end_label: req.body?.end_label !== undefined ? req.body.end_label : existing.end_label,
      notes: req.body?.notes !== undefined ? req.body.notes : existing.notes,
    };
    const v = validateTravelLeg(merged);
    if ("error" in v) {
      db.close();
      return res.status(400).json({ error: v.error });
    }

    try {
      db.prepare(
        `UPDATE activity_group_travel_legs
            SET mode = ?, start_date = ?,
                start_lat = ?, start_lng = ?, start_label = ?,
                end_lat = ?, end_lng = ?, end_label = ?,
                notes = ?
          WHERE id = ? AND group_id = ?`
      ).run(
        v.values.mode, v.values.start_date,
        v.values.start_lat, v.values.start_lng, v.values.start_label,
        v.values.end_lat, v.values.end_lng, v.values.end_label,
        v.values.notes,
        tlid, groupId
      );
      recalcTripDates(db, groupId);
      db.close();
      res.json({ id: tlid, ...v.values });
      try { republishGroup(groupId, { mustExist: true }); } catch {}
    } catch (e) {
      db.close();
      res.status(500).json({
        error: e instanceof Error ? e.message : "update failed",
      });
    }
  }
);

// DELETE /api/strava/groups/:id/travel-legs/:tlid
router.delete(
  "/api/strava/groups/:id/travel-legs/:tlid",
  (req: Request, res: Response) => {
    const db = getDbWrite();
    if (!db) return res.status(500).json({ error: "db unavailable" });
    const groupId = Number(req.params.id);
    const tlid = Number(req.params.tlid);
    const r = db
      .prepare(
        "DELETE FROM activity_group_travel_legs WHERE id = ? AND group_id = ?"
      )
      .run(tlid, groupId);
    if (r.changes > 0) {
      recalcTripDates(db, groupId);
    }
    db.close();
    if (r.changes === 0) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
    try { republishGroup(groupId, { mustExist: true }); } catch {}
  }
);

// GET /api/strava/export.csv — all activities as CSV
router.get("/api/strava/export.csv", (req: Request, res: Response) => {
  const db = getDb();
  if (!db) {
    res.setHeader("Content-Type", "text/csv");
    return res.send("id,athlete_id,name,sport_type,start_date_local,distance_km,moving_time_min,elapsed_time_min,total_elevation_gain_m,average_speed_kmh,max_speed_kmh,average_heartrate,max_heartrate,average_watts,kilojoules,average_cadence,suffer_score,kudos_count,trainer,commute\n");
  }

  try {
    const athleteId = req.query.athlete_id ? Number(req.query.athlete_id) : null;
    const where = athleteId ? `WHERE athlete_id = ${athleteId}` : "";

    const rows = db.prepare(`
      SELECT id, athlete_id, name, sport_type, start_date_local,
        ROUND(distance / 1000.0, 3)          AS distance_km,
        ROUND(moving_time / 60.0, 1)         AS moving_time_min,
        ROUND(elapsed_time / 60.0, 1)        AS elapsed_time_min,
        total_elevation_gain                 AS total_elevation_gain_m,
        ROUND(average_speed * 3.6, 3)        AS average_speed_kmh,
        ROUND(max_speed * 3.6, 3)            AS max_speed_kmh,
        average_heartrate, max_heartrate,
        average_watts, kilojoules,
        suffer_score, kudos_count, trainer, commute
      FROM activities
      ${where}
      ORDER BY start_date_local ASC
    `).all() as Array<Record<string, unknown>>;
    db.close();

    const header = "id,athlete_id,name,sport_type,start_date_local,distance_km,moving_time_min,elapsed_time_min,total_elevation_gain_m,average_speed_kmh,max_speed_kmh,average_heartrate,max_heartrate,average_watts,kilojoules,suffer_score,kudos_count,trainer,commute\n";
    const fmt = (v: unknown) => v == null ? "" : String(v);
    const csvRow = (r: Record<string, unknown>) => [
      r.id, r.athlete_id,
      `"${String(r.name ?? "").replace(/"/g, '""')}"`,
      r.sport_type, r.start_date_local,
      fmt(r.distance_km), fmt(r.moving_time_min), fmt(r.elapsed_time_min),
      fmt(r.total_elevation_gain_m), fmt(r.average_speed_kmh), fmt(r.max_speed_kmh),
      fmt(r.average_heartrate), fmt(r.max_heartrate),
      fmt(r.average_watts), fmt(r.kilojoules),
      fmt(r.suffer_score), fmt(r.kudos_count), fmt(r.trainer), fmt(r.commute),
    ].join(",");

    const today = new Date().toISOString().slice(0, 10);
    const suffix = athleteId ? `-${athleteId}` : "";
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="strava${suffix}-${today}.csv"`);
    res.send(header + rows.map(csvRow).join("\n") + "\n");
  } catch (e) {
    db.close();
    res.status(500).json({ error: String(e) });
  }
});

export default router;
