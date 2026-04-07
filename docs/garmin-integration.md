# Garmin Integration

Multi-profile Garmin Connect data sync and dashboard integration for NanoClaw.

## Quick Start

```bash
# Authenticate (run once per person)
python3 scripts/garmin-auth.py

# Sync all historical data
python3 scripts/garmin-sync.py --profile <slug> --full

# Daily sync (30 days default)
python3 scripts/garmin-sync.py
```

## Architecture

```
scripts/garmin-auth.py          # Interactive auth, saves tokens per profile
scripts/garmin-sync.py          # Pulls data from Garmin Connect API into SQLite
dashboard/server/routes/garmin.ts   # Express API serving data to dashboard
dashboard/src/pages/HealthPage.tsx  # React dashboard with profile tabs
```

### Multi-Profile Support

Credentials are stored as a JSON array in `data/sessions/telegram_main/.claude/garmin-credentials.json`. Each profile gets:
- Separate token directory: `garmin-tokens-{slug}/`
- Separate database: `garmin-{slug}.db`
- Dashboard tab when 2+ profiles exist

### Authentication

Garmin blocks the default `garminconnect` library user agent (`com.garmin.android.apps.connectmobile`), returning 429 on every request. The scripts override it with a browser-like user agent before any API calls:

```python
import garth
garth.http.client.sess.headers["User-Agent"] = BROWSER_UA
```

Token flow: `Garmin.login()` authenticates via garth SSO, then `client.garth.dump(token_dir)` persists OAuth tokens. Subsequent runs resume from saved tokens via `client.login(tokenstore=token_dir)`.

## Data Inventory

### Daily Metrics (synced per day)

| Table | Source API | Key Fields | Notes |
|-------|-----------|------------|-------|
| `daily_summary` | `get_user_summary()` | steps, distance, calories (active/BMR/total), floors up/down, intensity mins (moderate/vigorous), active time, sedentary time | Primary daily activity data |
| `daily_heart_rate` | `get_heart_rates()` | resting HR, max HR, min HR, 7-day avg resting HR | Also contains `heartRateValues` array with per-2-min readings all day (stored in raw JSON) |
| `daily_hrv` | `get_hrv_data()` | last night avg, weekly avg, 5-min high, status (LOW/UNBALANCED/BALANCED) | Key: `lastNightAvg` not `lastNight` |
| `daily_sleep` | `get_sleep_data()` | total/deep/REM/light/awake hours, sleep score, avg HR, respiration, feedback | HR key: `avgHeartRate` in `dailySleepDTO` |
| `daily_stress` | `get_stress_data()` | avg stress level, max stress level | API only returns `avgStressLevel` and `maxStressLevel` — no duration breakdown |
| `daily_respiration` | `get_respiration_data()` | waking avg, sleep avg, highest, lowest | Breathing rate in breaths/min |
| `daily_spo2` | `get_spo2_data()` | average, lowest, peak SpO2 | Requires Pulse Ox enabled on watch (Settings > Sensors > Pulse Oximeter) |
| `daily_body_battery` | `get_body_battery()` | charged, drained, end-of-day level | EOD level extracted from `bodyBatteryValuesArray[-1][-1]` |
| `daily_training_readiness` | `get_training_readiness()` | score, level, HRV/sleep/ACWR/recovery/stress factor percentages | Uses first entry with `validSleep=true`; keys: `hrvFactorPercent`, `sleepScoreFactorPercent`, `acwrFactorPercent`, `recoveryTimeFactorPercent`, `stressHistoryFactorPercent` |
| `daily_hydration` | `get_hydration_data()` | goal_ml, intake_ml, sweat_loss_ml | Intake requires manual logging in Garmin app; key: `goalInML` not `goalAmountMl` |
| `daily_endurance_score` | `get_endurance_score()` | overall score, classification | Fitness tracking number (e.g., 5,739 = Recreational) |

### Activity Metrics

| Table | Source API | Key Fields | Notes |
|-------|-----------|------------|-------|
| `activity_metrics` | `get_activities()` | name, sport type, duration, avg/max HR, aerobic/anaerobic training effect, calories | Recovery HR not available in list API (see below) |

### Periodic Metrics

| Table | Source API | Key Fields | Notes |
|-------|-----------|------------|-------|
| `vo2max` | `connectapi('/metrics-service/metrics/maxmet/daily/{start}/{end}')` | generic, running, cycling VO2 max | Only logs entries when value changes; `get_max_metrics()` uses wrong URL |
| `race_predictions` | `get_race_predictions()` | 5K, 10K, half marathon, marathon times (seconds) | Can fetch latest or daily range |
| `body_composition` | `get_body_composition()` | weight, BMI, body fat %, muscle mass | Requires paired smart scale |

### Sync Log

| Table | Purpose |
|-------|---------|
| `sync_log` | Tracks when syncs ran, how many days, error count |

## API Key Mismatches

Several Garmin API response keys differ from what the `garminconnect` library documentation suggests. These were discovered by inspecting raw JSON responses:

| Expected Key | Actual Key | Table |
|-------------|------------|-------|
| `lastNight` | `lastNightAvg` | daily_hrv |
| `overallStressLevel` | `avgStressLevel` | daily_stress |
| `avgWakingStressLevel` | `avgStressLevel` | daily_stress |
| `averageHeartRateValue` | `avgHeartRate` | daily_sleep |
| `bodyBatteryLevel` | `bodyBatteryValuesArray[-1][-1]` | daily_body_battery |
| `goalAmountMl` | `goalInML` | daily_hydration |
| `scoreQualifier` | `level` | daily_training_readiness |
| `hrvRatioFactor` | `hrvFactorPercent` | daily_training_readiness |

## Heart Rate Recovery (HRR) — Analysis

### The Problem

Garmin calculates recovery heart rate internally but does not expose it through any API endpoint:
- `get_activities()` — no `recoveryHeartRate` field in response
- `get_activity_details()` — returns time-series metrics but HR values are not populated (all zeros or body battery values at wrong index)
- `get_activity_evaluation()` — has `summaryDTO` with avg/max/min HR but no recovery
- `heartRateDTOs` in activity details — empty array

### The Solution: Cross-Reference Daily HR with Activity Windows

The daily heart rate endpoint (`get_heart_rates()`) returns `heartRateValues` — an array of `[timestamp_ms, hr_bpm]` readings taken every ~2 minutes throughout the entire day. This includes readings during and after activities.

**Verified example** (2026-03-31 soccer activity):
```
Peak:   190 bpm (during activity)
+2 min: 169 bpm (drop of 21)
+4 min: 138 bpm (drop of 52)
```

**Calculation approach:**
1. For each activity in `activity_metrics`, get the start time and duration to determine the activity window
2. Extract `heartRateValues` from the `daily_heart_rate.raw` JSON for that day
3. Find the peak HR within the activity window
4. Measure the HR at +2min and +4min after peak
5. HRR = peak HR - HR at +2min (standard clinical measurement)

**Advantages:**
- No extra API calls needed — data already in `daily_heart_rate.raw`
- Can be computed as a post-processing step after sync
- ~2min resolution matches the standard HRR measurement window

**Limitations:**
- 2-minute sampling means we get HRR at +2min, not +1min (some standards use 1-min)
- If the watch records HR less frequently, gaps may occur
- Very short activities might not have enough post-activity readings

### Not Available

| Metric | Status |
|--------|--------|
| Recovery HR from activity API | Not exposed by Garmin |
| Per-second HR during activities | `heartRateDTOs` is empty; `activityDetailMetrics` HR index contains body battery values |
| Acute/Chronic Training Load | Returns null from `get_training_status()` |
| Fitness Age | Returns null in VO2 max endpoint |

## Dashboard

The Health page (`/health`) displays all Garmin data with:
- Profile tabs (when 2+ profiles exist)
- Time range selector (30d / 90d / 6m / 1y)
- Overview cards: resting HR, HRV, sleep, steps, stress, weight
- Charts: HR trend, HRV trend, sleep stages, steps, stress
- Heart rate recovery table (when data available)
- Weight trend

API routes accept `?profile=<slug>` to query per-profile databases. Defaults to first profile.

## CLI Reference

```bash
# Auth
python3 scripts/garmin-auth.py              # Interactive: add or re-auth profiles

# Sync
python3 scripts/garmin-sync.py              # All profiles, last 30 days
python3 scripts/garmin-sync.py --full       # All profiles, full history from 2015
python3 scripts/garmin-sync.py --days 7     # All profiles, last 7 days
python3 scripts/garmin-sync.py --date 2026-04-01  # All profiles, single date
python3 scripts/garmin-sync.py --profile daniel-saltz          # One profile only
python3 scripts/garmin-sync.py --profile daniel-saltz --full   # One profile, full history
```

## File Locations

| File | Purpose |
|------|---------|
| `data/sessions/telegram_main/.claude/garmin-credentials.json` | Credentials array (email, password, slug, token_dir) |
| `data/sessions/telegram_main/.claude/garmin-tokens-{slug}/` | OAuth tokens per profile |
| `data/sessions/telegram_main/.claude/garmin-{slug}.db` | SQLite database per profile |
| `data/sessions/telegram_main/.claude/garmin.db` | Legacy single-profile DB (backward compat) |
