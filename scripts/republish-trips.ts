#!/usr/bin/env node
/**
 * Republish every currently-published trip — but only if the rendered HTML
 * actually differs from the file on disk (hash compare). Safe to run any
 * time the renderer changes; calls that don't move the bytes are no-ops.
 *
 * Usage:   npx tsx scripts/republish-trips.ts
 * Output:  one line per trip — "updated" / "unchanged" / "first publish".
 *
 * The launchd `com.nanoclaw.trip-briefing-upload` watcher picks up any file
 * we write and pushes it to gs://strava-trips/ within seconds.
 */
import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { renderTripHtml, renderIndexHtml, type IndexTrip } from "../dashboard/server/lib/render-trip-html.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DB_PATH =
  process.env.STRAVA_DB ||
  path.join(REPO_ROOT, "data/sessions/fitness/.claude/strava.db");
const BRIEFINGS_DIR = path.join(REPO_ROOT, "data/trip-briefings");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function sha(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// Query DB for one trip's renderable data (mirrors buildTripDataForRender in
// dashboard/server/routes/strava.ts — kept inline so this script has no
// dependency on the Express server module).
function buildTripData(groupId: number) {
  const group = db
    .prepare("SELECT * FROM activity_groups WHERE id = ?")
    .get(groupId) as Record<string, unknown> | undefined;
  if (!group) return null;

  const members = db
    .prepare(
      `SELECT a.id, a.name, a.sport_type, a.start_date_local, a.timezone,
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
    .all(groupId) as {
      id: number; name: string; sport_type: string; start_date_local: string;
      distance: number | null; moving_time: number | null; elapsed_time: number | null;
      total_elevation_gain: number | null; average_heartrate: number | null;
      kilojoules: number | null; map_summary_polyline: string | null;
      leg_order: number;
    }[];

  let distance_m = 0, moving_time_s = 0, elapsed_time_s = 0, elevation_m = 0;
  let kilojoules = 0, hr_sum = 0, hr_w = 0;
  const sport_breakdown: Record<string, number> = {};
  for (const m of members) {
    distance_m += m.distance || 0;
    moving_time_s += m.moving_time || 0;
    elapsed_time_s += m.elapsed_time || 0;
    elevation_m += m.total_elevation_gain || 0;
    kilojoules += m.kilojoules || 0;
    if (m.average_heartrate && m.moving_time) {
      hr_sum += m.average_heartrate * m.moving_time;
      hr_w += m.moving_time;
    }
    sport_breakdown[m.sport_type] = (sport_breakdown[m.sport_type] || 0) + 1;
  }
  const avg_hr = hr_w ? Math.round(hr_sum / hr_w) : null;

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

  // Travel legs (trains, ferries, etc.). Table may not exist yet on databases
  // that haven't been touched by the server since the migration; tolerate that.
  let travelLegs: unknown[] = [];
  try {
    travelLegs = db
      .prepare(
        `SELECT id, mode, start_date, start_lat, start_lng, start_label,
                end_lat, end_lng, end_label, notes
           FROM activity_group_travel_legs
          WHERE group_id = ?
          ORDER BY start_date, id`
      )
      .all(groupId);
  } catch {
    travelLegs = [];
  }

  return {
    id: group.id as number,
    name: group.name as string,
    description: (group.description ?? null) as string | null,
    photos_url: (group.photos_url ?? null) as string | null,
    published_at: (group.published_at ?? null) as string | null,
    published_slug: (group.published_slug ?? null) as string | null,
    start_date: (group.start_date ?? null) as string | null,
    end_date: (group.end_date ?? null) as string | null,
    members,
    totals: { distance_m, moving_time_s, elapsed_time_s, elevation_m, kilojoules, avg_hr },
    sport_breakdown,
    legStreams,
    travelLegs,
  };
}

// Walk all currently-published trips
const published = db
  .prepare(
    "SELECT id, name, published_slug FROM activity_groups WHERE published_slug IS NOT NULL ORDER BY id"
  )
  .all() as { id: number; name: string; published_slug: string }[];

if (!fs.existsSync(BRIEFINGS_DIR)) fs.mkdirSync(BRIEFINGS_DIR, { recursive: true });

console.log(`Republish check — ${published.length} published trip(s)`);
console.log("─".repeat(72));

let updated = 0;
let unchanged = 0;
const indexTrips: IndexTrip[] = [];

for (const t of published) {
  const data = buildTripData(t.id);
  if (!data) {
    console.log(`  trip ${t.id}: ⚠ build failed`);
    continue;
  }
  const slug = data.published_slug || t.published_slug;
  const filePath = path.join(BRIEFINGS_DIR, `${slug}.html`);
  const newHtml = renderTripHtml(data);
  const newHash = sha(newHtml);
  const oldHash = fs.existsSync(filePath) ? sha(fs.readFileSync(filePath, "utf8")) : null;

  if (oldHash === newHash) {
    console.log(`  ${slug.padEnd(46)} unchanged`);
    unchanged++;
  } else {
    fs.writeFileSync(filePath, newHtml);
    // published_at only bumps when content actually changed
    const now = new Date().toISOString();
    db.prepare("UPDATE activity_groups SET published_at = ? WHERE id = ?").run(now, t.id);
    console.log(`  ${slug.padEnd(46)} ${oldHash ? "updated" : "first publish"}`);
    updated++;
  }

  // Collect for index regen (always uses fresh DB state)
  const totalsRow = db
    .prepare(
      `SELECT COUNT(m.activity_id) AS leg_count,
              COALESCE(SUM(a.distance), 0) AS total_distance_m,
              COALESCE(SUM(a.moving_time), 0) AS total_moving_time_s,
              COALESCE(SUM(a.total_elevation_gain), 0) AS total_elevation_m,
              GROUP_CONCAT(DISTINCT a.sport_type) AS sport_types_csv
       FROM activity_group_members m
       JOIN activities a ON a.id = m.activity_id
       WHERE m.group_id = ?`
    )
    .get(t.id) as {
      leg_count: number;
      total_distance_m: number;
      total_moving_time_s: number;
      total_elevation_m: number;
      sport_types_csv: string | null;
    };
  indexTrips.push({
    id: data.id,
    slug,
    name: data.name,
    start_date: data.start_date,
    end_date: data.end_date,
    leg_count: totalsRow.leg_count,
    total_distance_m: totalsRow.total_distance_m,
    total_moving_time_s: totalsRow.total_moving_time_s,
    total_elevation_m: totalsRow.total_elevation_m,
    sport_types: totalsRow.sport_types_csv ? totalsRow.sport_types_csv.split(",") : [],
    published_at:
      (db
        .prepare("SELECT published_at FROM activity_groups WHERE id = ?")
        .get(t.id) as { published_at: string }).published_at,
  });
}

// Regenerate index.html if its content changed
const newIndex = renderIndexHtml(indexTrips);
const indexPath = path.join(BRIEFINGS_DIR, "index.html");
const oldIndexHash = fs.existsSync(indexPath) ? sha(fs.readFileSync(indexPath, "utf8")) : null;
const newIndexHash = sha(newIndex);
if (oldIndexHash === newIndexHash) {
  console.log(`  ${"index.html".padEnd(46)} unchanged`);
} else {
  fs.writeFileSync(indexPath, newIndex);
  console.log(`  ${"index.html".padEnd(46)} ${oldIndexHash ? "updated" : "first publish"}`);
  updated++;
}

console.log("─".repeat(72));
console.log(`Result: ${updated} written, ${unchanged} unchanged.`);
if (updated > 0) {
  console.log(`The launchd watcher will upload changed files to gs://strava-trips/ within ~5 seconds.`);
}

db.close();
