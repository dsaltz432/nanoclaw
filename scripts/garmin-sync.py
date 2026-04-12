#!/usr/bin/env python3
"""
Garmin Connect full data sync.
Pulls all available health metrics and stores them per-profile in garmin-{slug}.db.

Usage:
  python3 scripts/garmin-sync.py                          # sync all profiles, last 30 days
  python3 scripts/garmin-sync.py --profile daniel-saltz   # sync one profile
  python3 scripts/garmin-sync.py --full                   # sync all history (first run)
  python3 scripts/garmin-sync.py --days 7                 # sync last N days
  python3 scripts/garmin-sync.py --date 2026-01-01        # sync single date
"""
import argparse
import json
import os
import re
import sqlite3
import sys
import time
from datetime import date, datetime, timedelta

from garminconnect import Garmin

NANOCLAW_ROOT = os.environ.get("NANOCLAW_ROOT", os.path.join(os.path.dirname(__file__), ".."))
# DATA_DIR is where credentials, tokens, and DBs live. Inside the container,
# .claude is mounted at /home/node/.claude. Override via GARMIN_DATA_DIR if needed.
DATA_DIR = os.environ.get(
    "GARMIN_DATA_DIR",
    os.path.join(NANOCLAW_ROOT, "data/sessions/fitness/.claude"),
)
CRED_PATH = os.path.join(DATA_DIR, "garmin-credentials.json")

# Browser-like user agent — Garmin blocks the default garth mobile app agent
BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)


# ── Credential helpers ────────────────────────────────────────────────────────

def make_slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "default"


def load_credentials() -> list:
    """Load credentials array, handling legacy single-object format."""
    if not os.path.exists(CRED_PATH):
        return []
    with open(CRED_PATH) as f:
        raw = json.load(f)
    if isinstance(raw, dict):
        if "slug" not in raw:
            raw["slug"] = make_slug(raw.get("full_name") or raw.get("display_name") or "default")
        if "token_dir" not in raw:
            raw["token_dir"] = os.path.join(DATA_DIR, "garmin-tokens")
        return [raw]
    return raw


def db_path_for(slug: str) -> str:
    """Return per-profile DB path. Falls back to legacy garmin.db for single-profile."""
    per_profile = os.path.join(DATA_DIR, f"garmin-{slug}.db")
    legacy = os.path.join(DATA_DIR, "garmin.db")
    if os.path.exists(per_profile):
        return per_profile
    if os.path.exists(legacy) and len(load_credentials()) <= 1:
        return legacy
    return per_profile


# ── Database setup ────────────────────────────────────────────────────────────

def init_db(conn):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS sync_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        synced_at TEXT NOT NULL,
        dates_synced INTEGER,
        errors INTEGER,
        notes TEXT
    );

    -- Daily summary: steps, calories, distance, active time, floors, intensity minutes
    CREATE TABLE IF NOT EXISTS daily_summary (
        date TEXT PRIMARY KEY,
        total_steps INTEGER,
        total_distance_meters REAL,
        active_calories INTEGER,
        bmr_calories INTEGER,
        total_kilocalories INTEGER,
        floors_ascended REAL,
        floors_descended REAL,
        intensity_minutes_goal INTEGER,
        moderate_intensity_minutes INTEGER,
        vigorous_intensity_minutes INTEGER,
        active_time_seconds INTEGER,
        sedentary_seconds INTEGER,
        sleeping_seconds INTEGER,
        highly_active_seconds INTEGER,
        active_seconds INTEGER,
        wellness_active_calories INTEGER,
        wellness_total_calories INTEGER,
        wellness_distance_meters REAL,
        average_steps_goal INTEGER,
        net_calorie_goal INTEGER,
        raw JSON
    );

    -- Daily heart rate
    CREATE TABLE IF NOT EXISTS daily_heart_rate (
        date TEXT PRIMARY KEY,
        resting_heart_rate INTEGER,
        max_heart_rate INTEGER,
        min_heart_rate INTEGER,
        last_7_days_avg_resting_hr REAL,
        raw JSON
    );

    -- HRV (Heart Rate Variability)
    CREATE TABLE IF NOT EXISTS daily_hrv (
        date TEXT PRIMARY KEY,
        weekly_avg INTEGER,
        last_night INTEGER,
        last_night_5min_high INTEGER,
        last_night_5min_low INTEGER,
        hrv_status TEXT,
        feedback_phrase TEXT,
        start_timestamp TEXT,
        end_timestamp TEXT,
        raw JSON
    );

    -- Sleep
    CREATE TABLE IF NOT EXISTS daily_sleep (
        date TEXT PRIMARY KEY,
        sleep_time_seconds INTEGER,
        nap_time_seconds INTEGER,
        deep_sleep_seconds INTEGER,
        light_sleep_seconds INTEGER,
        rem_sleep_seconds INTEGER,
        awake_sleep_seconds INTEGER,
        average_respiration_value REAL,
        lowest_respiration_value REAL,
        highest_respiration_value REAL,
        avg_sleep_stress REAL,
        sleep_score INTEGER,
        sleep_score_feedback TEXT,
        sleep_score_insight TEXT,
        average_spo2 REAL,
        lowest_spo2 REAL,
        average_heart_rate REAL,
        lowest_heart_rate REAL,
        raw JSON
    );

    -- Stress
    CREATE TABLE IF NOT EXISTS daily_stress (
        date TEXT PRIMARY KEY,
        overall_stress_level INTEGER,
        rest_stress_duration INTEGER,
        low_stress_duration INTEGER,
        medium_stress_duration INTEGER,
        high_stress_duration INTEGER,
        stress_qualifier TEXT,
        avg_waking_stress INTEGER,
        raw JSON
    );

    -- Respiration / breathing rate
    CREATE TABLE IF NOT EXISTS daily_respiration (
        date TEXT PRIMARY KEY,
        avg_waking_respiration_value REAL,
        highest_respiration_value REAL,
        lowest_respiration_value REAL,
        avg_sleep_respiration_value REAL,
        raw JSON
    );

    -- Blood oxygen (SpO2)
    CREATE TABLE IF NOT EXISTS daily_spo2 (
        date TEXT PRIMARY KEY,
        average_spo2 REAL,
        lowest_spo2 REAL,
        peak_spo2 REAL,
        raw JSON
    );

    -- Body battery (energy levels throughout day)
    CREATE TABLE IF NOT EXISTS daily_body_battery (
        date TEXT PRIMARY KEY,
        charged INTEGER,
        drained INTEGER,
        end_of_day_level INTEGER,
        raw JSON
    );

    -- Body composition (weight, BMI, body fat)
    CREATE TABLE IF NOT EXISTS body_composition (
        date TEXT PRIMARY KEY,
        weight_kg REAL,
        bmi REAL,
        body_fat_percent REAL,
        body_water_percent REAL,
        bone_mass_kg REAL,
        muscle_mass_kg REAL,
        visceral_fat_rating REAL,
        metabolic_age INTEGER,
        physique_rating INTEGER,
        raw JSON
    );

    -- Training readiness
    CREATE TABLE IF NOT EXISTS daily_training_readiness (
        date TEXT PRIMARY KEY,
        score INTEGER,
        score_qualifier TEXT,
        hrv_ratio_factor REAL,
        sleep_score_factor REAL,
        acclimation_factor REAL,
        recovery_time_factor REAL,
        acute_load_factor REAL,
        raw JSON
    );

    -- Hydration
    CREATE TABLE IF NOT EXISTS daily_hydration (
        date TEXT PRIMARY KEY,
        goal_ml INTEGER,
        total_intake_ml INTEGER,
        sweat_loss_ml INTEGER,
        raw JSON
    );

    -- Per-activity Garmin metrics (complements Strava activity data)
    CREATE TABLE IF NOT EXISTS activity_metrics (
        garmin_activity_id INTEGER PRIMARY KEY,
        activity_name TEXT,
        sport_type TEXT,
        start_time TEXT,
        duration_seconds INTEGER,
        distance_meters REAL,
        avg_hr INTEGER,
        max_hr INTEGER,
        recovery_heart_rate INTEGER,
        training_effect_aerobic REAL,
        training_effect_anaerobic REAL,
        training_stress_score REAL,
        vo2max_estimate REAL,
        lactate_threshold_hr INTEGER,
        avg_power_watts INTEGER,
        max_power_watts INTEGER,
        normalized_power_watts INTEGER,
        total_calories INTEGER,
        avg_cadence INTEGER,
        avg_speed_mps REAL,
        raw JSON
    );

    -- VO2 max estimates over time
    CREATE TABLE IF NOT EXISTS vo2max (
        date TEXT PRIMARY KEY,
        generic REAL,
        running REAL,
        cycling REAL,
        raw JSON
    );

    -- Endurance score
    CREATE TABLE IF NOT EXISTS daily_endurance_score (
        date TEXT PRIMARY KEY,
        overall_score INTEGER,
        classification INTEGER,
        raw JSON
    );

    -- Race predictions (based on fitness)
    CREATE TABLE IF NOT EXISTS race_predictions (
        date TEXT PRIMARY KEY,
        time_5k_seconds INTEGER,
        time_10k_seconds INTEGER,
        time_half_marathon_seconds INTEGER,
        time_marathon_seconds INTEGER,
        raw JSON
    );
    """)
    conn.commit()


# ── Garmin client ─────────────────────────────────────────────────────────────

def resolve_token_dir(cred: dict) -> str:
    """Resolve token_dir to an absolute path under DATA_DIR.
    Handles legacy absolute paths by extracting just the folder name and
    resolving it relative to the current DATA_DIR (so it works in containers)."""
    raw = cred.get("token_dir", "")
    if not raw:
        return os.path.join(DATA_DIR, f"garmin-tokens-{cred.get('slug', 'default')}")
    # If the folder already exists at the given path, use it
    if os.path.isdir(raw):
        return raw
    # Otherwise, extract the basename and resolve under DATA_DIR
    basename = os.path.basename(raw.rstrip("/"))
    return os.path.join(DATA_DIR, basename)


def get_client(cred: dict):
    """Create an authenticated Garmin client for a profile."""
    client = Garmin(email=cred["email"], password=cred["password"])

    # Override user agent — Garmin blocks the default mobile app agent
    # Must set on client.garth (not global garth.http.client) since Garmin() creates its own
    client.garth.sess.headers["User-Agent"] = BROWSER_UA

    token_dir = resolve_token_dir(cred)
    token_file = os.path.join(token_dir, "oauth1_token.json") if token_dir else ""
    if token_dir and os.path.exists(token_file):
        client.login(tokenstore=token_dir)
    else:
        client.login()

    if token_dir:
        os.makedirs(token_dir, exist_ok=True)
        client.garth.dump(token_dir)

    return client


# ── Safe fetch helpers ────────────────────────────────────────────────────────

def safe_get(fn, *args, label="", **kwargs):
    try:
        result = fn(*args, **kwargs)
        time.sleep(0.3)  # polite rate limiting
        return result
    except Exception as e:
        print(f"  [warn] {label}: {e}")
        return None


def j(val):
    """Serialize to JSON string for raw column."""
    return json.dumps(val) if val is not None else None


# ── Per-day sync ──────────────────────────────────────────────────────────────

def sync_day(client, conn, d: date):
    ds = d.isoformat()
    print(f"  {ds}...", end=" ", flush=True)
    synced = []

    # Daily summary
    summary = safe_get(client.get_user_summary, ds, label="summary")
    if summary:
        conn.execute("""
            INSERT OR REPLACE INTO daily_summary VALUES (
                ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
            )""", (
            ds,
            summary.get("totalSteps"),
            summary.get("totalDistanceMeters"),
            summary.get("activeKilocalories"),
            summary.get("bmrKilocalories"),
            summary.get("totalKilocalories"),
            summary.get("floorsAscended"),
            summary.get("floorsDescended"),
            summary.get("intensityMinutesGoal"),
            summary.get("moderateIntensityMinutes"),
            summary.get("vigorousIntensityMinutes"),
            summary.get("activeTimeSeconds"),
            summary.get("sedentarySeconds"),
            summary.get("sleepingSeconds"),
            summary.get("highlyActiveSeconds"),
            summary.get("activeSeconds"),
            summary.get("wellnessActiveKilocalories"),
            summary.get("wellnessTotalKilocalories"),
            summary.get("wellnessDistanceMeters"),
            summary.get("averageStepsGoal"),
            summary.get("netCalorieGoal"),
            j(summary),
        ))
        synced.append("summary")

    # Heart rate
    hr_data = safe_get(client.get_heart_rates, ds, label="heart_rate")
    if hr_data:
        conn.execute("""
            INSERT OR REPLACE INTO daily_heart_rate VALUES (?,?,?,?,?,?)
        """, (
            ds,
            hr_data.get("restingHeartRate"),
            hr_data.get("maxHeartRate"),
            hr_data.get("minHeartRate"),
            hr_data.get("lastSevenDaysAvgRestingHeartRate"),
            j(hr_data),
        ))
        synced.append("hr")

    # HRV
    hrv = safe_get(client.get_hrv_data, ds, label="hrv")
    if hrv:
        hrv_summary = hrv.get("hrvSummary", {}) or {}
        conn.execute("""
            INSERT OR REPLACE INTO daily_hrv VALUES (?,?,?,?,?,?,?,?,?,?)
        """, (
            ds,
            hrv_summary.get("weeklyAvg"),
            hrv_summary.get("lastNightAvg") or hrv_summary.get("lastNight"),
            hrv_summary.get("lastNight5MinHigh"),
            hrv_summary.get("lastNight5MinLow"),
            hrv_summary.get("status"),
            hrv_summary.get("feedbackPhrase"),
            hrv_summary.get("createTimeStamp") or hrv_summary.get("startTimestampLocal"),
            hrv_summary.get("endTimestampLocal"),
            j(hrv),
        ))
        synced.append("hrv")

    # Sleep
    sleep = safe_get(client.get_sleep_data, ds, label="sleep")
    if sleep:
        sd = sleep.get("dailySleepDTO", {}) or {}
        sleep_scores = sd.get("sleepScores", {}) or {}
        conn.execute("""
            INSERT OR REPLACE INTO daily_sleep VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, (
            ds,
            sd.get("sleepTimeSeconds"),
            sd.get("napTimeSeconds"),
            sd.get("deepSleepSeconds"),
            sd.get("lightSleepSeconds"),
            sd.get("remSleepSeconds"),
            sd.get("awakeSleepSeconds"),
            sd.get("averageRespirationValue"),
            sd.get("lowestRespirationValue"),
            sd.get("highestRespirationValue"),
            sd.get("avgSleepStress"),
            sleep_scores.get("overall", {}).get("value"),
            sd.get("sleepScoreFeedback"),
            sd.get("sleepScoreInsight"),
            sd.get("averageSpO2Value") or sleep.get("averageSpO2"),
            sd.get("lowestSpO2Value") or sleep.get("lowestSpO2"),
            sd.get("avgHeartRate") or sd.get("averageHeartRateValue"),
            sd.get("lowestHeartRate") or sd.get("lowestHeartRateValue"),
            j(sleep),
        ))
        synced.append("sleep")

    # Stress
    stress = safe_get(client.get_stress_data, ds, label="stress")
    if stress:
        conn.execute("""
            INSERT OR REPLACE INTO daily_stress VALUES (?,?,?,?,?,?,?,?,?)
        """, (
            ds,
            stress.get("overallStressLevel") or stress.get("avgStressLevel"),
            stress.get("restStressDuration"),
            stress.get("lowStressDuration"),
            stress.get("mediumStressDuration"),
            stress.get("highStressDuration"),
            stress.get("stressQualifier") or stress.get("maxStressLevel"),
            stress.get("avgWakingStressLevel") or stress.get("avgStressLevel"),
            j(stress),
        ))
        synced.append("stress")

    # Respiration
    resp = safe_get(client.get_respiration_data, ds, label="respiration")
    if resp:
        conn.execute("""
            INSERT OR REPLACE INTO daily_respiration VALUES (?,?,?,?,?,?)
        """, (
            ds,
            resp.get("avgWakingRespirationValue"),
            resp.get("highestRespirationValue"),
            resp.get("lowestRespirationValue"),
            resp.get("avgSleepRespirationValue"),
            j(resp),
        ))
        synced.append("respiration")

    # SpO2
    spo2 = safe_get(client.get_spo2_data, ds, label="spo2")
    if spo2:
        conn.execute("""
            INSERT OR REPLACE INTO daily_spo2 VALUES (?,?,?,?,?)
        """, (
            ds,
            spo2.get("averageSpO2"),
            spo2.get("lowestSpO2"),
            spo2.get("peakSpO2"),
            j(spo2),
        ))
        synced.append("spo2")

    # Body battery
    bb = safe_get(client.get_body_battery, ds, ds, label="body_battery")
    if bb and isinstance(bb, list) and bb:
        charged = sum(e.get("charged") or 0 for e in bb)
        drained = sum(e.get("drained") or 0 for e in bb)
        # End-of-day level from last non-null entry in bodyBatteryValuesArray
        end_level = None
        last_entry = bb[-1] if bb else {}
        vals_array = last_entry.get("bodyBatteryValuesArray", [])
        if vals_array and isinstance(vals_array, list):
            for v in reversed(vals_array):
                if isinstance(v, list) and len(v) >= 2 and v[-1] is not None:
                    end_level = v[-1]
                    break
        conn.execute("""
            INSERT OR REPLACE INTO daily_body_battery VALUES (?,?,?,?,?)
        """, (ds, charged, drained, end_level, j(bb)))
        synced.append("body_battery")

    # Hydration
    hydration = safe_get(client.get_hydration_data, ds, label="hydration")
    if hydration:
        conn.execute("""
            INSERT OR REPLACE INTO daily_hydration VALUES (?,?,?,?,?)
        """, (
            ds,
            hydration.get("goalInML") or hydration.get("goalAmountMl"),
            hydration.get("valueInML") or hydration.get("totalIntakeInMl"),
            hydration.get("sweatLossInML") or hydration.get("sweatLossInMl"),
            j(hydration),
        ))
        synced.append("hydration")

    # Training readiness — use first entry with validSleep=true, or just first
    tr = safe_get(client.get_training_readiness, ds, label="training_readiness")
    if tr and isinstance(tr, list) and tr:
        item = next((e for e in tr if e.get("validSleep")), tr[0])
        conn.execute("""
            INSERT OR REPLACE INTO daily_training_readiness VALUES (?,?,?,?,?,?,?,?,?)
        """, (
            ds,
            item.get("score"),
            item.get("level") or item.get("scoreQualifier"),
            item.get("hrvFactorPercent"),
            item.get("sleepScoreFactorPercent"),
            item.get("acwrFactorPercent"),
            item.get("recoveryTimeFactorPercent"),
            item.get("stressHistoryFactorPercent"),
            j(tr),
        ))
        synced.append("training_readiness")

    # Endurance score
    endurance = safe_get(client.get_endurance_score, ds, label="endurance_score")
    if endurance and endurance.get("overallScore"):
        conn.execute("""
            INSERT OR REPLACE INTO daily_endurance_score VALUES (?,?,?,?)
        """, (
            ds,
            endurance.get("overallScore"),
            endurance.get("classification"),
            j(endurance),
        ))
        synced.append("endurance")

    conn.commit()
    print(f"[{', '.join(synced) if synced else 'no data'}]")
    return len(synced)


def sync_activities(client, conn, start_date: date):
    """Sync Garmin activity metrics."""
    print("\nSyncing activity metrics...")
    start = 0
    limit = 100
    count = 0
    cutoff = start_date.isoformat()

    while True:
        activities = safe_get(client.get_activities, start, limit, label=f"activities[{start}]")
        if not activities:
            break

        batch_done = False
        for act in activities:
            start_time = act.get("startTimeLocal", "")
            if start_time[:10] < cutoff:
                batch_done = True
                break

            aid = act.get("activityId")
            if not aid:
                continue

            conn.execute("""
                INSERT OR REPLACE INTO activity_metrics VALUES (
                    ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
                )""", (
                aid,
                act.get("activityName"),
                act.get("activityType", {}).get("typeKey") if act.get("activityType") else None,
                start_time,
                act.get("duration"),
                act.get("distance"),
                act.get("averageHR"),
                act.get("maxHR"),
                act.get("recoveryHeartRate"),
                act.get("aerobicTrainingEffect"),
                act.get("anaerobicTrainingEffect"),
                act.get("trainingStressScore"),
                act.get("vO2MaxValue"),
                act.get("lactateThresholdHeartRate"),
                act.get("avgPower"),
                act.get("maxPower"),
                act.get("normPower"),
                act.get("calories"),
                act.get("averageCadence"),
                act.get("averageSpeed"),
                j(act),
            ))
            count += 1

        conn.commit()
        if batch_done or len(activities) < limit:
            break
        start += limit

    print(f"  Synced {count} activities")


def sync_body_composition(client, conn, start_date: date, end_date: date):
    """Sync body composition (weight) data."""
    print("Syncing body composition...")
    data = safe_get(client.get_body_composition, start_date.isoformat(), end_date.isoformat(), label="body_comp")
    if not data:
        return
    entries = data.get("dateWeightList", []) or []
    for entry in entries:
        d = entry.get("calendarDate") or entry.get("date")
        if not d:
            continue
        conn.execute("""
            INSERT OR REPLACE INTO body_composition VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """, (
            d,
            entry.get("weight") / 1000 if entry.get("weight") else None,  # grams -> kg
            entry.get("bmi"),
            entry.get("bodyFat"),
            entry.get("bodyWater"),
            entry.get("boneMass") / 1000 if entry.get("boneMass") else None,
            entry.get("muscleMass") / 1000 if entry.get("muscleMass") else None,
            entry.get("visceralFat"),
            entry.get("metabolicAge"),
            entry.get("physiqueRating"),
            j(entry),
        ))
    conn.commit()
    print(f"  Synced {len(entries)} body composition entries")



def sync_vo2max(client, conn, dates: list):
    """Sync VO2 max estimates using the maxmet daily endpoint."""
    if not dates:
        return
    print("\nSyncing VO2 max...")
    start_ds = dates[0].isoformat()
    end_ds = min(dates[-1], date.today()).isoformat()
    data = safe_get(
        client.connectapi,
        f"/metrics-service/metrics/maxmet/daily/{start_ds}/{end_ds}",
        label="vo2max",
    )
    if not data or not isinstance(data, list):
        print("  No VO2 max data")
        return
    count = 0
    for entry in data:
        generic_data = entry.get("generic") or {}
        cycling_data = entry.get("cycling") or {}
        running_data = entry.get("running") or {}
        # Use the most specific date from the nested objects
        d = (generic_data.get("calendarDate")
             or cycling_data.get("calendarDate")
             or running_data.get("calendarDate"))
        if not d:
            continue
        generic = generic_data.get("vo2MaxPreciseValue")
        running = running_data.get("vo2MaxPreciseValue")
        cycling = cycling_data.get("vo2MaxPreciseValue")
        if generic or running or cycling:
            conn.execute("""
                INSERT OR REPLACE INTO vo2max VALUES (?,?,?,?,?)
            """, (d, generic, running, cycling, j(entry)))
            count += 1
    conn.commit()
    print(f"  Synced VO2 max for {count} days")


def sync_race_predictions(client, conn, start_date: date, end_date: date):
    """Sync race predictions."""
    print("Syncing race predictions...")
    data = safe_get(
        client.get_race_predictions,
        start_date.isoformat(), end_date.isoformat(), "daily",
        label="race_predictions",
    )
    if not data:
        # Try latest only
        data = safe_get(client.get_race_predictions, label="race_predictions_latest")
        if data:
            data = [data] if isinstance(data, dict) else data
    if not data or not isinstance(data, list):
        print("  No race prediction data")
        return
    count = 0
    for entry in data:
        d = entry.get("calendarDate") or entry.get("date")
        if not d:
            continue
        conn.execute("""
            INSERT OR REPLACE INTO race_predictions VALUES (?,?,?,?,?,?)
        """, (
            d,
            entry.get("time5K"),
            entry.get("time10K"),
            entry.get("timeHalfMarathon"),
            entry.get("timeMarathon"),
            j(entry),
        ))
        count += 1
    conn.commit()
    print(f"  Synced {count} race prediction entries")


# ── Per-profile sync ─────────────────────────────────────────────────────────

def sync_profile(cred: dict, args):
    """Sync all data for a single Garmin profile."""
    slug = cred.get("slug", "default")
    name = cred.get("full_name") or cred.get("email")
    db_path = db_path_for(slug)

    print(f"\n{'=' * 60}")
    print(f"Syncing profile: {name} ({slug})")
    print(f"DB: {db_path}")
    print(f"{'=' * 60}")

    # Connect
    print("Connecting to Garmin Connect...")
    client = get_client(cred)
    print("✓ Connected\n")

    # Date range
    today = date.today()
    if args.start and args.end:
        start = date.fromisoformat(args.start)
        end = date.fromisoformat(args.end)
        dates = [start + timedelta(days=i) for i in range((end - start).days + 1)]
        print(f"Syncing range: {len(dates)} days from {start} to {end}")
    elif args.date:
        dates = [date.fromisoformat(args.date)]
    elif args.full:
        start = date(2015, 1, 1)
        dates = [start + timedelta(days=i) for i in range((today - start).days + 1)]
        print(f"Full sync: {len(dates)} days from {start} to {today}")
    else:
        start = today - timedelta(days=args.days - 1)
        dates = [start + timedelta(days=i) for i in range(args.days)]
        print(f"Syncing last {args.days} days ({start} to {today})")

    # Init DB
    conn = sqlite3.connect(db_path)
    init_db(conn)

    # Sync daily metrics
    print("\nSyncing daily metrics:")
    errors = 0
    for d in dates:
        if d > today:
            continue
        try:
            sync_day(client, conn, d)
        except Exception as e:
            print(f"  ERROR on {d}: {e}")
            errors += 1

    # Sync activities
    start_date = dates[0] if dates else today - timedelta(days=30)
    sync_activities(client, conn, start_date)

    # Sync body composition
    end_date = dates[-1] if dates else today
    sync_body_composition(client, conn, start_date, end_date)

    # Sync VO2 max and race predictions
    sync_vo2max(client, conn, dates)
    sync_race_predictions(client, conn, start_date, end_date)

    # Log sync
    conn.execute("""
        INSERT INTO sync_log (synced_at, dates_synced, errors, notes)
        VALUES (?, ?, ?, ?)
    """, (datetime.utcnow().isoformat(), len(dates), errors, f"days={args.days if not args.full else 'full'}"))
    conn.commit()
    conn.close()

    print(f"\n✓ Sync complete for {name}. DB: {db_path}")
    if errors:
        print(f"  {errors} errors encountered (some data may be missing for those days)")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Sync Garmin Connect data")
    parser.add_argument("--full", action="store_true", help="Sync all history from 2015")
    parser.add_argument("--days", type=int, default=30, help="Sync last N days (default: 30)")
    parser.add_argument("--date", type=str, help="Sync a specific date (YYYY-MM-DD)")
    parser.add_argument("--start", type=str, help="Start date for range sync (YYYY-MM-DD, use with --end)")
    parser.add_argument("--end", type=str, help="End date for range sync (YYYY-MM-DD, use with --start)")
    parser.add_argument("--profile", type=str, help="Sync only this profile slug (default: all)")
    args = parser.parse_args()

    credentials = load_credentials()
    if not credentials:
        print("ERROR: No Garmin credentials found. Run garmin-auth.py first.", file=sys.stderr)
        sys.exit(1)

    # Filter to specific profile if requested
    if args.profile:
        credentials = [c for c in credentials if c.get("slug") == args.profile]
        if not credentials:
            print(f"ERROR: No profile found with slug '{args.profile}'", file=sys.stderr)
            available = [c.get("slug", "?") for c in load_credentials()]
            print(f"Available profiles: {', '.join(available)}", file=sys.stderr)
            sys.exit(1)

    print(f"Syncing {len(credentials)} profile(s): {', '.join(c.get('full_name', c.get('slug', '?')) for c in credentials)}")

    for cred in credentials:
        sync_profile(cred, args)

    print(f"\n✓ All done!")


if __name__ == "__main__":
    main()
