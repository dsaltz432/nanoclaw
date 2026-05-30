#!/usr/bin/env node
/**
 * Refresh specific Strava activities by ID. Useful when you've edited or
 * deleted old activities on Strava — the normal incremental sync only fetches
 * *new* activities (after the last sync timestamp) and never re-checks old
 * ones, so renames/deletes of historical rides need a manual pull.
 *
 * Usage:
 *   By ID:    npx tsx scripts/strava-refresh-activities.ts <athlete_id> <activity_id> [activity_id ...]
 *   By date:  npx tsx scripts/strava-refresh-activities.ts <athlete_id> --since YYYY-MM-DD --until YYYY-MM-DD
 *
 * Behavior per ID:
 *   - HTTP 200 → upsert the row in `activities` table (covers rename, sport
 *                change, distance correction, etc.)
 *   - HTTP 404 → activity deleted on Strava → DELETE FROM activities + cascade
 *                from any activity_group_members rows.
 *   - other    → print error and skip.
 *
 * Date-range mode lists every activity Strava has whose `start_date` falls in
 * the window, then upserts each one. Useful for catching newly-uploaded
 * activities backdated to old trips (which the incremental sync misses
 * because it filters by start_date, not upload time).
 */
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const DB_PATH = path.join(REPO_ROOT, "data/sessions/fitness/.claude/strava.db");
const CRED_PATH = path.join(REPO_ROOT, "data/sessions/fitness/.claude/strava-credentials.json");

const [, , athleteIdArg, ...rest] = process.argv;
if (!athleteIdArg || rest.length === 0) {
  console.error("Usage:");
  console.error("  By ID:   npx tsx scripts/strava-refresh-activities.ts <athlete_id> <activity_id> [activity_id ...]");
  console.error("  By date: npx tsx scripts/strava-refresh-activities.ts <athlete_id> --since YYYY-MM-DD --until YYYY-MM-DD");
  process.exit(1);
}
const athleteId = Number(athleteIdArg);

let since: string | undefined;
let until: string | undefined;
const activityIds: number[] = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--since") since = rest[++i];
  else if (rest[i] === "--until") until = rest[++i];
  else activityIds.push(Number(rest[i]));
}
const dateMode = !!(since || until);
if (dateMode && activityIds.length > 0) {
  console.error("Pass either activity IDs *or* --since/--until, not both.");
  process.exit(1);
}
if (dateMode && (!since || !until)) {
  console.error("Date mode requires both --since and --until.");
  process.exit(1);
}

interface StravaCredential {
  athlete_id: number;
  athlete_name: string;
  client_id: string;
  client_secret: string;
  refresh_token: string;
  access_token?: string;
  token_expiry?: number;
}

const credsRaw = JSON.parse(fs.readFileSync(CRED_PATH, "utf8"));
const credentials: StravaCredential[] = Array.isArray(credsRaw) ? credsRaw : [credsRaw];
const credIdx = credentials.findIndex((c) => c.athlete_id === athleteId);
if (credIdx < 0) {
  console.error(`No credentials found for athlete_id=${athleteId}`);
  process.exit(1);
}
const cred = credentials[credIdx]!;

async function getFreshToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cred.access_token && cred.token_expiry && cred.token_expiry > now + 60) {
    return cred.access_token;
  }
  console.log("Refreshing access token…");
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
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json() as {
    access_token: string; refresh_token: string; expires_at: number;
  };
  cred.access_token = data.access_token;
  cred.refresh_token = data.refresh_token;
  cred.token_expiry = data.expires_at;
  credentials[credIdx] = cred;
  fs.writeFileSync(CRED_PATH, JSON.stringify(credentials, null, 2));
  return cred.access_token;
}

async function fetchActivity(token: string, id: number) {
  const res = await fetch(`https://www.strava.com/api/v3/activities/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: res.ok ? await res.json() : await res.text() };
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const upsert = db.prepare(`
  INSERT OR REPLACE INTO activities (
    id, athlete_id, name, type, sport_type, start_date, start_date_local,
    timezone, distance, moving_time, elapsed_time, total_elevation_gain,
    average_speed, max_speed, average_heartrate, max_heartrate,
    average_watts, weighted_average_watts, kilojoules, suffer_score,
    kudos_count, comment_count, achievement_count, trainer, commute,
    manual, private, flagged, workout_type, gear_id, description,
    map_summary_polyline
  ) VALUES (
    @id, @athlete_id, @name, @type, @sport_type, @start_date, @start_date_local,
    @timezone, @distance, @moving_time, @elapsed_time, @total_elevation_gain,
    @average_speed, @max_speed, @average_heartrate, @max_heartrate,
    @average_watts, @weighted_average_watts, @kilojoules, @suffer_score,
    @kudos_count, @comment_count, @achievement_count, @trainer, @commute,
    @manual, @private, @flagged, @workout_type, @gear_id, @description,
    @map_summary_polyline
  )
`);

const deleteActivity = db.prepare("DELETE FROM activities WHERE id = ?");
const deleteMembership = db.prepare("DELETE FROM activity_group_members WHERE activity_id = ?");

const token = await getFreshToken();

function upsertSummary(a: Record<string, any>) {
  upsert.run({
    id: a.id, athlete_id: athleteId, name: a.name, type: a.type,
    sport_type: a.sport_type, start_date: a.start_date,
    start_date_local: a.start_date_local, timezone: a.timezone,
    distance: a.distance ?? null, moving_time: a.moving_time ?? null,
    elapsed_time: a.elapsed_time ?? null,
    total_elevation_gain: a.total_elevation_gain ?? null,
    average_speed: a.average_speed ?? null, max_speed: a.max_speed ?? null,
    average_heartrate: a.average_heartrate ?? null,
    max_heartrate: a.max_heartrate ?? null,
    average_watts: a.average_watts ?? null,
    weighted_average_watts: a.weighted_average_watts ?? null,
    kilojoules: a.kilojoules ?? null, suffer_score: a.suffer_score ?? null,
    kudos_count: a.kudos_count ?? null, comment_count: a.comment_count ?? null,
    achievement_count: a.achievement_count ?? null,
    trainer: a.trainer ? 1 : 0, commute: a.commute ? 1 : 0,
    manual: a.manual ? 1 : 0, private: a.private ? 1 : 0,
    flagged: a.flagged ? 1 : 0, workout_type: a.workout_type ?? null,
    gear_id: a.gear_id ?? null, description: a.description ?? null,
    map_summary_polyline: a.map?.summary_polyline ?? null,
  });
}

if (dateMode) {
  const sinceTs = Math.floor(new Date(since!).getTime() / 1000);
  const untilTs = Math.floor(new Date(until!).getTime() / 1000) + 86400; // inclusive end-day
  console.log(`Listing activities ${since} → ${until} (athlete ${athleteId})…`);
  let page = 1;
  let total = 0;
  while (true) {
    const url = new URL("https://www.strava.com/api/v3/athlete/activities");
    url.searchParams.set("after", String(sinceTs));
    url.searchParams.set("before", String(untilTs));
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`List failed: ${res.status} ${await res.text()}`);
    }
    const batch = await res.json() as Record<string, any>[];
    if (batch.length === 0) break;
    for (const a of batch) {
      upsertSummary(a);
      total++;
      console.log(`  ✓ ${a.id} "${a.name}" (${(a.distance / 1000).toFixed(1)} km, ${a.start_date_local.slice(0, 10)})`);
    }
    if (batch.length < 100) break;
    page++;
  }
  console.log(`\nUpserted ${total} activit${total === 1 ? "y" : "ies"}.`);
  db.close();
  process.exit(0);
}

for (const id of activityIds) {
  console.log(`\n--- Activity ${id} ---`);
  const { status, body } = await fetchActivity(token, id);
  if (status === 200) {
    const a = body as Record<string, any>;
    upsertSummary(a);
    console.log(`  ✓ upserted: "${a.name}" (${(a.distance / 1000).toFixed(1)} km, ${a.sport_type})`);
  } else if (status === 404) {
    const memberCount = (
      db.prepare("SELECT COUNT(*) as c FROM activity_group_members WHERE activity_id = ?").get(id) as { c: number }
    ).c;
    deleteMembership.run(id);
    const r = deleteActivity.run(id);
    console.log(
      `  ✓ deleted locally (was in ${memberCount} trip${memberCount === 1 ? "" : "s"}); rows removed: ${r.changes}`
    );
  } else {
    console.log(`  ✗ unexpected status ${status}: ${String(body).slice(0, 200)}`);
  }
}

db.close();
console.log("\nDone.");
