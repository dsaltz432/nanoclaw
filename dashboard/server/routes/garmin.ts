import { Router, Request, Response } from "express";
import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const nanoclawRoot = process.env.NANOCLAW_ROOT || path.resolve(__dirname, "../..");
const dataDir = path.join(nanoclawRoot, "data/sessions/fitness/.claude");
const credPath = path.join(dataDir, "garmin-credentials.json");

// ── Profile helpers ──────────────────────────────────────────────────────────

interface GarminProfile {
  email: string;
  display_name: string;
  full_name: string;
  slug: string;
  token_dir: string;
}

function makeSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";
}

function getProfiles(): GarminProfile[] {
  try {
    if (!fs.existsSync(credPath)) return [];
    const raw = JSON.parse(fs.readFileSync(credPath, "utf8"));
    const arr: GarminProfile[] = Array.isArray(raw) ? raw : [raw];
    return arr.map((p) => ({
      ...p,
      slug: p.slug || makeSlug(p.full_name || p.display_name || "default"),
    }));
  } catch {
    return [];
  }
}

function dbPathFor(slug: string): string {
  const perProfile = path.join(dataDir, `garmin-${slug}.db`);
  const legacy = path.join(dataDir, "garmin.db");
  if (fs.existsSync(perProfile)) return perProfile;
  if (fs.existsSync(legacy) && getProfiles().length <= 1) return legacy;
  return perProfile;
}

function getDb(slug: string): Database.Database | null {
  const dbPath = dbPathFor(slug);
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
}

function resolveProfile(req: Request): string {
  const profile = req.query.profile as string | undefined;
  if (profile) return profile;
  const profiles = getProfiles();
  return profiles[0]?.slug ?? "default";
}

const router = Router();

// GET /api/garmin/profiles — list all profiles with stats
router.get("/api/garmin/profiles", (_req: Request, res: Response) => {
  const profiles = getProfiles();
  const result = profiles.map((p) => {
    const db = getDb(p.slug);
    if (!db) return { slug: p.slug, display_name: p.display_name, full_name: p.full_name, connected: false, day_count: 0, last_sync: null };
    try {
      const count = (db.prepare("SELECT COUNT(*) as n FROM daily_summary").get() as { n: number }).n;
      const lastSync = db.prepare("SELECT synced_at FROM sync_log ORDER BY synced_at DESC LIMIT 1").get() as { synced_at: string } | undefined;
      return { slug: p.slug, display_name: p.display_name, full_name: p.full_name, connected: true, day_count: count, last_sync: lastSync?.synced_at ?? null };
    } catch {
      return { slug: p.slug, display_name: p.display_name, full_name: p.full_name, connected: false, day_count: 0, last_sync: null };
    } finally {
      db.close();
    }
  });
  res.json(result);
});

// GET /api/garmin/status — sync status and data availability
router.get("/api/garmin/status", (req: Request, res: Response) => {
  const slug = resolveProfile(req);
  const db = getDb(slug);
  if (!db) return res.json({ connected: false, reason: "Database not found — run garmin-sync.py first" });

  const lastSync = db.prepare("SELECT * FROM sync_log ORDER BY synced_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  const summaryCount = (db.prepare("SELECT COUNT(*) as n FROM daily_summary").get() as { n: number }).n;
  const hrCount = (db.prepare("SELECT COUNT(*) as n FROM daily_heart_rate").get() as { n: number }).n;
  const hrvCount = (db.prepare("SELECT COUNT(*) as n FROM daily_hrv").get() as { n: number }).n;
  const actCount = (db.prepare("SELECT COUNT(*) as n FROM activity_metrics").get() as { n: number }).n;

  db.close();
  res.json({
    connected: true,
    last_sync: lastSync?.synced_at ?? null,
    counts: { daily_summary: summaryCount, heart_rate: hrCount, hrv: hrvCount, activities: actCount },
  });
});

// GET /api/garmin/overview?days=90 — high-level health metrics for the header
router.get("/api/garmin/overview", (req: Request, res: Response) => {
  const slug = resolveProfile(req);
  const db = getDb(slug);
  if (!db) return res.json(null);

  const days = Number(req.query.days ?? 90);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const avgRhr = db.prepare(`
    SELECT ROUND(AVG(resting_heart_rate), 1) as val FROM daily_heart_rate
    WHERE date >= ? AND resting_heart_rate > 0
  `).get(cutoff) as { val: number | null };

  const avgHrv = db.prepare(`
    SELECT ROUND(AVG(last_night), 1) as val FROM daily_hrv
    WHERE date >= ? AND last_night > 0
  `).get(cutoff) as { val: number | null };

  const avgSleep = db.prepare(`
    SELECT ROUND(AVG(sleep_time_seconds) / 3600.0, 1) as val FROM daily_sleep
    WHERE date >= ? AND sleep_time_seconds > 0
  `).get(cutoff) as { val: number | null };

  const avgSteps = db.prepare(`
    SELECT ROUND(AVG(total_steps)) as val FROM daily_summary
    WHERE date >= ? AND total_steps > 0
  `).get(cutoff) as { val: number | null };

  const avgStress = db.prepare(`
    SELECT ROUND(AVG(overall_stress_level)) as val FROM daily_stress
    WHERE date >= ? AND overall_stress_level > 0
  `).get(cutoff) as { val: number | null };

  const latestWeight = db.prepare(`
    SELECT weight_kg FROM body_composition ORDER BY date DESC LIMIT 1
  `).get() as { weight_kg: number } | undefined;

  db.close();
  res.json({
    avg_resting_hr: avgRhr?.val ?? null,
    avg_hrv: avgHrv?.val ?? null,
    avg_sleep_hours: avgSleep?.val ?? null,
    avg_steps: avgSteps?.val ?? null,
    avg_stress: avgStress?.val ?? null,
    latest_weight_kg: latestWeight?.weight_kg ?? null,
  });
});

// GET /api/garmin/heart-rate?days=90 — resting HR trend
router.get("/api/garmin/heart-rate", (req: Request, res: Response) => {
  const slug = resolveProfile(req);
  const db = getDb(slug);
  if (!db) return res.json([]);

  const days = Number(req.query.days ?? 90);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT date, resting_heart_rate, max_heart_rate, min_heart_rate
    FROM daily_heart_rate
    WHERE date >= ? AND resting_heart_rate > 0
    ORDER BY date
  `).all(cutoff);

  db.close();
  res.json(rows);
});

// GET /api/garmin/hrv?days=90 — HRV trend
router.get("/api/garmin/hrv", (req: Request, res: Response) => {
  const slug = resolveProfile(req);
  const db = getDb(slug);
  if (!db) return res.json([]);

  const days = Number(req.query.days ?? 90);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT date, last_night, weekly_avg, hrv_status, feedback_phrase
    FROM daily_hrv
    WHERE date >= ? AND last_night > 0
    ORDER BY date
  `).all(cutoff);

  db.close();
  res.json(rows);
});

// GET /api/garmin/sleep?days=90 — sleep trend (daily or aggregated)
router.get("/api/garmin/sleep", (req: Request, res: Response) => {
  const slug = resolveProfile(req);
  const db = getDb(slug);
  if (!db) return res.json([]);

  const days = Number(req.query.days ?? 90);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const agg = days > 180 ? "month" : days > 30 ? "week" : "day";
  const dateFmt = agg === "month"
    ? "strftime('%Y-%m-15', date)"
    : agg === "week"
    ? "strftime('%Y-%m-%d', date, 'weekday 0', '-6 days')"
    : "date";

  const rows = db.prepare(`
    SELECT ${dateFmt} as date,
      ROUND(AVG(sleep_time_seconds) / 3600.0, 2) as total_hours,
      ROUND(AVG(deep_sleep_seconds) / 3600.0, 2) as deep_hours,
      ROUND(AVG(light_sleep_seconds) / 3600.0, 2) as light_hours,
      ROUND(AVG(rem_sleep_seconds) / 3600.0, 2) as rem_hours,
      ROUND(AVG(awake_sleep_seconds) / 3600.0, 2) as awake_hours,
      ROUND(AVG(sleep_score)) as sleep_score,
      ROUND(AVG(average_heart_rate), 1) as average_heart_rate,
      ROUND(AVG(average_respiration_value), 1) as average_respiration_value,
      ROUND(AVG(average_spo2), 1) as average_spo2
    FROM daily_sleep
    WHERE date >= ? AND sleep_time_seconds > 0
    GROUP BY ${dateFmt}
    ORDER BY date
  `).all(cutoff);

  db.close();
  res.json(rows);
});

// GET /api/garmin/sleep/:date — single-day sleep detail
router.get("/api/garmin/sleep/:date", (req: Request, res: Response) => {
  const slug = resolveProfile(req);
  const db = getDb(slug);
  if (!db) return res.json(null);

  const row = db.prepare(`
    SELECT date,
      ROUND(sleep_time_seconds / 3600.0, 2) as total_hours,
      ROUND(deep_sleep_seconds / 3600.0, 2) as deep_hours,
      ROUND(light_sleep_seconds / 3600.0, 2) as light_hours,
      ROUND(rem_sleep_seconds / 3600.0, 2) as rem_hours,
      ROUND(awake_sleep_seconds / 3600.0, 2) as awake_hours,
      sleep_score, sleep_score_feedback, sleep_score_insight,
      average_heart_rate, lowest_heart_rate,
      average_respiration_value, lowest_respiration_value, highest_respiration_value,
      average_spo2, lowest_spo2, avg_sleep_stress
    FROM daily_sleep
    WHERE date = ? AND sleep_time_seconds > 0
  `).get(req.params.date);

  db.close();
  res.json(row ?? null);
});

// GET /api/garmin/stress?days=90 — stress trend
router.get("/api/garmin/stress", (req: Request, res: Response) => {
  const slug = resolveProfile(req);
  const db = getDb(slug);
  if (!db) return res.json([]);

  const days = Number(req.query.days ?? 90);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT date, overall_stress_level, avg_waking_stress, stress_qualifier,
      rest_stress_duration, low_stress_duration, medium_stress_duration, high_stress_duration
    FROM daily_stress
    WHERE date >= ? AND overall_stress_level > 0
    ORDER BY date
  `).all(cutoff);

  db.close();
  res.json(rows);
});

// GET /api/garmin/steps?days=90 — steps & activity trend
router.get("/api/garmin/steps", (req: Request, res: Response) => {
  const slug = resolveProfile(req);
  const db = getDb(slug);
  if (!db) return res.json([]);

  const days = Number(req.query.days ?? 90);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT date, total_steps, total_distance_meters,
      active_calories, total_kilocalories,
      moderate_intensity_minutes, vigorous_intensity_minutes,
      floors_ascended, highly_active_seconds, active_seconds
    FROM daily_summary
    WHERE date >= ? AND total_steps IS NOT NULL
    ORDER BY date
  `).all(cutoff);

  db.close();
  res.json(rows);
});

// GET /api/garmin/body-battery?days=30 — body battery band data (peak + end_of_day)
router.get("/api/garmin/body-battery", (req: Request, res: Response) => {
  const slug = resolveProfile(req);
  const db = getDb(slug);
  if (!db) return res.json([]);

  const days = Number(req.query.days ?? 30);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const agg = days > 180 ? "month" : days > 30 ? "week" : "day";

  // Fetch raw rows and extract peak from bodyBatteryValuesArray
  const raw = db.prepare(`
    SELECT date, end_of_day_level, raw
    FROM daily_body_battery
    WHERE date >= ? AND end_of_day_level IS NOT NULL
    ORDER BY date
  `).all(cutoff) as { date: string; end_of_day_level: number; raw: string }[];

  db.close();

  // Extract daily peak from raw JSON
  const daily = raw.map((r) => {
    let peak = r.end_of_day_level;
    try {
      const parsed = JSON.parse(r.raw);
      const entry = Array.isArray(parsed) ? parsed[0] : parsed;
      const arr: [number, number][] = entry?.bodyBatteryValuesArray ?? [];
      const valid = arr.map((x) => x[1]).filter((v): v is number => v != null);
      if (valid.length) peak = Math.max(...valid);
    } catch {}
    return { date: r.date, peak, end_of_day: r.end_of_day_level };
  });

  if (agg === "day") return res.json(daily);

  // Aggregate into weekly or monthly buckets
  const buckets = new Map<string, { peak: number[]; end_of_day: number[] }>();
  for (const d of daily) {
    const dt = new Date(d.date + "T12:00:00");
    let key: string;
    if (agg === "month") {
      key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-15`;
    } else {
      // Start of ISO week (Monday)
      const day = dt.getDay() || 7;
      const mon = new Date(dt);
      mon.setDate(dt.getDate() - day + 1);
      key = mon.toISOString().slice(0, 10);
    }
    if (!buckets.has(key)) buckets.set(key, { peak: [], end_of_day: [] });
    const b = buckets.get(key)!;
    b.peak.push(d.peak);
    b.end_of_day.push(d.end_of_day);
  }

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const result = Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, b]) => ({ date, peak: Math.round(avg(b.peak)), end_of_day: Math.round(avg(b.end_of_day)) }));

  res.json(result);
});

// GET /api/garmin/weight?days=365 — weight trend
router.get("/api/garmin/weight", (req: Request, res: Response) => {
  const slug = resolveProfile(req);
  const db = getDb(slug);
  if (!db) return res.json([]);

  const days = Number(req.query.days ?? 365);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT date, weight_kg, bmi, body_fat_percent, muscle_mass_kg
    FROM body_composition
    WHERE date >= ? AND weight_kg IS NOT NULL
    ORDER BY date
  `).all(cutoff);

  db.close();
  res.json(rows);
});

// GET /api/garmin/activities?days=90 — Garmin activity metrics with recovery HR
router.get("/api/garmin/activities", (req: Request, res: Response) => {
  const slug = resolveProfile(req);
  const db = getDb(slug);
  if (!db) return res.json([]);

  const days = Number(req.query.days ?? 90);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT garmin_activity_id, activity_name, sport_type, start_time,
      duration_seconds, avg_hr, max_hr, recovery_heart_rate,
      training_effect_aerobic, training_effect_anaerobic,
      training_stress_score, vo2max_estimate, total_calories
    FROM activity_metrics
    WHERE start_time >= ? AND recovery_heart_rate IS NOT NULL
    ORDER BY start_time DESC
  `).all(cutoff);

  db.close();
  res.json(rows);
});

// GET /api/garmin/trend?metric=resting_hr&days=30 — unified trend for any metric
router.get("/api/garmin/trend", (req: Request, res: Response) => {
  const slug = resolveProfile(req);
  const db = getDb(slug);
  if (!db) return res.json([]);

  const days = Number(req.query.days ?? 30);
  const metric = req.query.metric as string ?? "resting_hr";
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  // Aggregate based on range: daily ≤30d, weekly ≤180d, monthly >180d
  const agg = days > 180 ? "month" : days > 30 ? "week" : "day";
  const dateFmt = agg === "month" ? "strftime('%Y-%m-15', date)" : agg === "week" ? "strftime('%Y-%m-%d', date, 'weekday 0', '-6 days')" : "date";

  type Row = { date: string; value: number };

  const queries: Record<string, () => Row[]> = {
    resting_hr: () => (db!.prepare(`
      SELECT ${dateFmt} as date, ROUND(AVG(resting_heart_rate), 1) as value
      FROM daily_heart_rate WHERE date >= ? AND resting_heart_rate > 0
      GROUP BY ${dateFmt} ORDER BY date
    `).all(cutoff) as Row[]),

    steps: () => (db!.prepare(`
      SELECT ${dateFmt} as date, ROUND(AVG(total_steps)) as value
      FROM daily_summary WHERE date >= ? AND total_steps > 0
      GROUP BY ${dateFmt} ORDER BY date
    `).all(cutoff) as Row[]),

    intensity_minutes: () => (db!.prepare(`
      SELECT ${dateFmt} as date,
        ROUND(AVG(moderate_intensity_minutes + vigorous_intensity_minutes * 2)) as value
      FROM daily_summary WHERE date >= ? AND moderate_intensity_minutes IS NOT NULL
      GROUP BY ${dateFmt} ORDER BY date
    `).all(cutoff) as Row[]),

    hrv: () => (db!.prepare(`
      SELECT ${dateFmt} as date, ROUND(AVG(last_night), 1) as value
      FROM daily_hrv WHERE date >= ? AND last_night > 0
      GROUP BY ${dateFmt} ORDER BY date
    `).all(cutoff) as Row[]),

    endurance_score: () => (db!.prepare(`
      SELECT ${dateFmt} as date, ROUND(AVG(overall_score), 1) as value
      FROM daily_endurance_score WHERE date >= ? AND overall_score > 0
      GROUP BY ${dateFmt} ORDER BY date
    `).all(cutoff) as Row[]),

    respiration: () => (db!.prepare(`
      SELECT ${dateFmt} as date, ROUND(AVG(avg_waking_respiration_value), 1) as value
      FROM daily_respiration WHERE date >= ? AND avg_waking_respiration_value > 0
      GROUP BY ${dateFmt} ORDER BY date
    `).all(cutoff) as Row[]),

    vo2max: () => (db!.prepare(`
      SELECT ${dateFmt.replace(/\bdate\b/g, "substr(start_time,1,10)")} as date,
        ROUND(AVG(vo2max_estimate), 1) as value
      FROM activity_metrics
      WHERE substr(start_time,1,10) >= ? AND vo2max_estimate IS NOT NULL AND vo2max_estimate > 0
      GROUP BY ${dateFmt.replace(/\bdate\b/g, "substr(start_time,1,10)")} ORDER BY date
    `).all(cutoff) as Row[]),

    body_battery: () => (db!.prepare(`
      SELECT ${dateFmt} as date, ROUND(AVG(end_of_day_level), 1) as value
      FROM daily_body_battery WHERE date >= ? AND end_of_day_level IS NOT NULL
      GROUP BY ${dateFmt} ORDER BY date
    `).all(cutoff) as Row[]),

    sleep_duration: () => (db!.prepare(`
      SELECT ${dateFmt} as date, ROUND(AVG(sleep_time_seconds) / 3600.0, 2) as value
      FROM daily_sleep WHERE date >= ? AND sleep_time_seconds > 0
      GROUP BY ${dateFmt} ORDER BY date
    `).all(cutoff) as Row[]),
  };

  const queryFn = queries[metric];
  if (!queryFn) { db.close(); return res.status(400).json({ error: "Unknown metric" }); }

  try {
    const rows = queryFn();
    db.close();
    res.json(rows);
  } catch (err) {
    db.close();
    console.error("Trend query failed:", err);
    res.status(500).json({ error: "Query failed" });
  }
});

// GET /api/garmin/metric-ranges — earliest available date per metric
router.get("/api/garmin/metric-ranges", (req: Request, res: Response) => {
  const slug = resolveProfile(req);
  const db = getDb(slug);
  if (!db) return res.json({});

  const queries: Record<string, string> = {
    resting_hr:        "SELECT MIN(date) FROM daily_heart_rate WHERE resting_heart_rate > 0",
    steps:             "SELECT MIN(date) FROM daily_summary WHERE total_steps > 0",
    intensity_minutes: "SELECT MIN(date) FROM daily_summary WHERE moderate_intensity_minutes IS NOT NULL",
    hrv:               "SELECT MIN(date) FROM daily_hrv WHERE last_night > 0",
    endurance_score:   "SELECT MIN(date) FROM daily_endurance_score WHERE overall_score > 0",
    respiration:       "SELECT MIN(date) FROM daily_respiration WHERE avg_waking_respiration_value > 0",
    vo2max:            "SELECT MIN(substr(start_time,1,10)) FROM activity_metrics WHERE vo2max_estimate > 0",
    body_battery:      "SELECT MIN(date) FROM daily_body_battery WHERE end_of_day_level IS NOT NULL",
    sleep_duration:    "SELECT MIN(date) FROM daily_sleep WHERE sleep_time_seconds > 0",
  };

  const result: Record<string, string | null> = {};
  for (const [metric, q] of Object.entries(queries)) {
    try {
      const row = db.prepare(q).get() as { "MIN(date)": string | null } | undefined;
      result[metric] = row ? Object.values(row)[0] : null;
    } catch { result[metric] = null; }
  }
  db.close();
  res.json(result);
});

// GET /api/garmin/recovery-trend?days=180 — recovery HR over time
router.get("/api/garmin/recovery-trend", (req: Request, res: Response) => {
  const slug = resolveProfile(req);
  const db = getDb(slug);
  if (!db) return res.json([]);

  const days = Number(req.query.days ?? 180);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const rows = db.prepare(`
    SELECT substr(start_time, 1, 10) as date, sport_type,
      avg_hr, max_hr, recovery_heart_rate,
      (max_hr - recovery_heart_rate) as hrr_drop,
      training_effect_aerobic
    FROM activity_metrics
    WHERE start_time >= ?
      AND recovery_heart_rate IS NOT NULL
      AND max_hr > recovery_heart_rate
    ORDER BY start_time
  `).all(cutoff);

  db.close();
  res.json(rows);
});

export default router;
