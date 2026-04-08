import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import crypto from "crypto";

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
        "telegram_main",
        "tg:8684529481",
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

export default router;
