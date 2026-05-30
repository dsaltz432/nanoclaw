# Trips — Pending Follow-ups

Open work items related to the Strava Trips feature ([grouped-activities-plan.md](grouped-activities-plan.md)). Originated from investigating the **Biking Across Europe 2017** trip (group id 8). The renderer feature work (§2) is done; only data cleanup (§1) is in progress.

## Progress checklist

### Trip 8 — Biking Across Europe 2017

**Done**
- [x] Deleted corrupted activity `1044734504` ("Back to figuers") on Strava + locally
- [x] Renamed `1052244492` to "Hyeres to Antibes" (Jun 24)
- [x] Renamed `1054043893` to "Antibes to Eze, Monaco, Menton" (Jun 25)
- [x] Renamed `1066184095` to "Teglio Veneto to Trieste" (Jul 3)
- [x] Uploaded Jun 19 Besalú→Perpignan GPX (activity `18655354684`) + added to trip
- [x] Travel leg: Jun 20 train Perpignan → Lunel
- [x] Travel leg: Jul 1 train Milan → Venice

**Pending — GPX uploads to Strava**
- [ ] Jun 17 — Empordà wine-tour outbound (~32 km). Pair with existing `1041130525` (10.3 km return).
- [ ] Jun 29 — Vercelli → Pezzana (~13 km). Comes after the morning Panice Sottana→Cuneo ride and the Cuneo→Vercelli train.

**Pending — travel legs to add**
- [ ] Jun 23 — train Aix-en-Provence → Hyères (off day on Porquerolles)
- [ ] Jun 26 — train Menton → Nice (Sarah flying home; Adam pickup)
- [ ] Jun 29 — train Cuneo → Vercelli (mid-day, between two recorded rides)
- [ ] Jul 7 — ferry Mali Lošinj → Zadar
- [ ] *(optional)* Jul 10 — ferry Split → Dubrovnik (only if Dubrovnik is added to the trip)

**Pending — once all of the above are done**
- [ ] Update trip description if travel-leg map markers don't fully convey the transit story
- [ ] Publish the trip if not already (auto-republish handles updates)

### Feature work
- [x] §2 — `activity_group_travel_legs` schema + API + renderer + dashboard UI shipped

---

## 1. Data cleanup: Biking Across Europe 2017 (group id 8)

The 2017 trip has missing/mis-recorded ride days plus several genuine transit days that the renderer can't currently express. None of this is a bug in the dashboard — it's incomplete source data. The plan here is to fix it on Strava, let it sync, and then re-wire the trip in the dashboard.

### Investigation summary

Cross-referenced three sources: original Google Sheets route plan, Strava activity GPS endpoints (decoded polylines), and the author's day-by-day trip journal. The journal was decisive on several days where the Strava data alone was ambiguous.

**True transit days (no riding — candidates for `activity_group_travel_legs` once that feature lands):**
- **Jun 20** — train Perpignan → Lunel, after a bike malfunction in Perpignan forced cancellation of the planned Perpignan→Béziers ride
- **Jun 23** — train Aix-en-Provence → Hyères (off day spent on Porquerolles Island). *Journal-confirmed; earlier analysis based on GPS alone had this wrong as a "missed ride."*
- **Jun 26** — train Menton → Nice (Sarah flying home, Adam being picked up at Nice). *Journal-confirmed; earlier analysis had this wrong as a "missed ride."*
- **Jun 29** *(mid-day)* — train Cuneo → Vercelli (between two recorded rides on the same day)
- **Jul 1** — train Milan → Venice (Frecciarossa)
- **Jul 7** — ferry Mali Lošinj → Zadar
- **Jul 10** *(post-bike)* — ferry Split → Dubrovnik. Only relevant if Dubrovnik is treated as part of the trip; bike-trip activities end Jul 9.

**Ride days with broken or missing recordings:**
- **Jun 17** — Empordà wine tour (~32 km of the 43 km loop unrecorded). Strava activity `1041130525` ("Ride back from the wineries", 10.3 km) only captured the return leg; the outbound + winery-to-winery portion was lost.
- **Jun 19** — Besalú → Perpignan (~85 km). Recorded as activity `1044734504` ("Back to figuers") but corrupted: `elapsed_time=0`, `moving_time=85s` for 25 km of distance → `avg_speed=294 m/s = 1062 km/h`. Only fragments of start/end points were saved. Journal confirms a full 85 km ride.
- **Jun 24** — Hyères → Antibes. *Was* recorded (`1052244492`, 138 km, 8.4 hr moving) but **mis-named** "Aix-en Provence to Antibes". The planned "day off + evening train" was scrapped — actually rode the full distance.
- **Jun 29** *(afternoon)* — Vercelli → Pezzana (~13 km). Not recorded. Journal: "bike 67km downhill to Cuneo, take a train to Vercelli, and then bike the 13km south to Pezzana." Comes after the morning's Panice Sottana → Cuneo ride and the Cuneo → Vercelli train.

**Lower-confidence flags (worth a second look but not in the upload list yet):**
- **Jul 4** — journal says Trieste → Kraljevica was 120 km; Strava recorded 68 km. Could be ~50 km of missing data, or journal exaggeration. Endpoints check out (Trieste → Kraljevica via the coast is ~78 km direct), so leaning toward journal exaggeration.

**Journal corrections to the Strava narrative (not the analysis):**
- **Jul 9 "To Split"** — earlier flagged as a likely train (40.3 km/h avg). Journal confirms it was a real ride with a "big climb over the mountain ridge and down into Split." The high avg speed is an auto-pause artifact: slow climbing was excluded from `moving_time`, leaving only the fast descent. Keep as-is.

### Cleanup plan

#### A) Upload new private rides to Strava (GPX from external source)

| Date | Route | Approx distance | Purpose |
|---|---|---|---|
| 2017-06-17 | Empordà wine-tour outbound loop | ~32 km | Fills the wine-tour day; pair with existing `1041130525` (10.3 km return) |
| 2017-06-19 | Besalú → Perpignan | ~85 km | Replaces corrupted activity `1044734504` |
| 2017-06-29 | Vercelli → Pezzana | ~13 km | Fills the afternoon ride after the Cuneo→Vercelli train |

*(Removed from previous plan: Jun 23 Aix→Hyères and Jun 26 Menton→Nice — both were trains per journal, not missed rides.)*

Set:
- Activity date to the correct day (Strava uses GPX timestamp; override manually if absent). Order in the trip is driven by `start_date_local`.
- Sport: Bike (`sport_type = Ride`)
- Privacy: private/hidden. The trip page renders from the local DB cache, so private activities still appear correctly on the public trip HTML. Only direct clicks to `strava.com/activities/<id>` would be blocked.

#### B) Edit existing activities on Strava

| Activity ID | Current name | Action |
|---|---|---|
| `1044734504` | "Back to figuers" (Jun 19, 1062 km/h glitch) | **Delete on Strava.** Garbage data skews totals. Replaced by the new Jun 19 GPX upload. |
| `1052244492` | "Aix-en Provence to Antibes" (Jun 24, actually starts in Hyères) | **Rename** to "Hyères to Antibes" |
| `1054043893` | "Nice, Eze, Monaco, Menton" (Jun 25, actually starts in Antibes) | **Rename** to "Antibes to Eze, Monaco, Menton" |
| `1066184095` | "To The Dalmatian coast" (Jul 3, Teglio Veneto → Trieste — Trieste is still Italy, not Dalmatia) | **Rename** to "Teglio Veneto to Trieste" |
| `1075042830` | "To Split" (Jul 9, 40 km/h avg) | **Keep as-is.** Journal confirms real ride; high avg is auto-pause artifact. |

#### C) Sync + trip wiring

After Strava edits:

```bash
# Manual sync (otherwise wait for nightly 1am UTC)
cd /Users/danielsaltz/Documents/repositories/nanoclaw
docker exec -i $(docker ps --filter "name=fitness" -q) python /workspace/strava_sync.py
```

Then in the dashboard:
1. Open **Biking Across Europe 2017** → **Edit**
2. **Remove** deleted Jun 19 activity from legs (if not auto-dropped)
3. **+ Add legs** → pick the three new uploaded rides (Jun 17, Jun 19, Jun 29)
4. Save → PATCH auto-republish triggers within ~5s

#### D) Optional: trip description annotation

Once travel legs (see §2 below) land, the transit story should live on the map. Until then, surface it in the trip description field:

> Several transit segments not shown on the map: Jun 20 train Perpignan→Lunel (after bike malfunction); Jun 23 train Aix→Hyères (off day on Porquerolles Island); Jun 26 train Menton→Nice (pickup logistics); Jun 29 short train Cuneo→Vercelli mid-day; Jul 1 train Milan→Venice; Jul 7 ferry Mali Lošinj→Zadar.

### Helper script created during investigation

`scripts/decode-trip-endpoints.ts <group_id>` — decodes the `map_summary_polyline` of every activity in a trip and prints start/end GPS coordinates plus avg-speed sanity check. Useful for spotting train-speed glitches and mis-named activities in other trips.

---

## 2. Feature: `activity_group_travel_legs` (transit legs on trip map)

The 2017 cleanup above will give us the *rides* back, but the trip will still have visual gaps where trains and ferries went. Solving this generically means letting a trip have non-ride "travel legs" that render on the map but don't pollute totals or contribute to the profile chart.

### Why not just fake Strava activities

Tempting to upload "train" activities to Strava. Rejected because:
- Pollutes Strava with fake rides
- No real `sport_type` for trains; mapping to Workout/etc. is awkward
- Inflates trip totals (a 4-hour train would add to "moving_time")
- Skews the profile chart and sport breakdown

### Schema

```sql
CREATE TABLE activity_group_travel_legs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES activity_groups(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,            -- 'train' | 'ferry' | 'plane' | 'bus' | 'car'
  start_date TEXT NOT NULL,      -- ISO local date — drives ordering
  start_lat REAL NOT NULL,
  start_lng REAL NOT NULL,
  start_label TEXT,              -- e.g. "Perpignan"
  end_lat REAL NOT NULL,
  end_lng REAL NOT NULL,
  end_label TEXT,                -- e.g. "Lunel"
  notes TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

No `leg_order` field — interleave with rides by `start_date_local` (rides already sort this way too; travel legs always happen on distinct days, so date alone is enough).

### Renderer changes (`dashboard/server/lib/render-trip-html.ts`)

Trip data passed to `renderTripHtml()` gains a `travelLegs[]` array. Then:

1. **Map** — dashed polyline between `(start_lat, start_lng)` and `(end_lat, end_lng)`. Single neutral grey color (no per-mode color). Mode emoji marker at the midpoint (🚂 ⛴ ✈ 🚌 🚗). Endpoints feed into the existing bounds calculation.
2. **Legs table** — interleaved with ride rows, sorted by `start_date`. Row shows mode icon + "Perpignan → Lunel" in place of distance/time/elevation columns.
3. **Profile chart** — skip travel legs (no streams to draw).
4. **Totals + sport breakdown** — don't count travel legs.

### API endpoints (`dashboard/server/routes/strava.ts`)

```
POST   /api/strava/groups/:id/travel-legs
PATCH  /api/strava/groups/:id/travel-legs/:tlid
DELETE /api/strava/groups/:id/travel-legs/:tlid
```

Each mutation triggers `republishGroup(id, { mustExist: true })` if the trip is currently published — same auto-republish hook as activity PATCH.

`GET /api/strava/groups/:id` returns `travel_legs[]` alongside `members[]`.

### Dashboard UI (`dashboard/src/pages/StravaPage.tsx`)

In `EditTripModal`, add a "Travel Legs" section below the activity legs list. Each row: mode icon, date, "from → to" labels, edit/delete buttons.

`+ Add travel leg` button → small modal with:
- Mode dropdown (train / ferry / plane / bus / car)
- Date picker
- **From**: label text field + lat/lng (with "use endpoint of activity..." dropdown that pre-fills coords from the end of an existing ride)
- **To**: label text field + lat/lng (with "use start of activity..." dropdown)
- Notes (optional)

The endpoint-from-activity picker is the key UX move — 90% of travel legs connect two existing rides, so you should never have to type coords by hand.

### Scope for first cut

- Schema migration
- API CRUD
- Renderer: dashed line + mode marker on map; legs-table row
- Dashboard: add/edit/delete via Edit modal, with endpoint-from-activity picker

### Deferred (later, only if needed)

- Drag-to-reorder (date-based sort is sufficient for now)
- Great-circle curves for long flights (straight line is fine at trip-map zoom)
- Per-mode polyline colors (one neutral grey keeps the map clean)
- Aggregate "X km transit" stat alongside the trip totals
- Auto-detection of probable transit gaps from existing activity GPS endpoints

### Mode list

`train | ferry | plane | bus | car` — covers the realistic transit modes for multi-day bike/multisport trips. Add more later if a real use case emerges.

### Why this design weaves cleanly

- **Renderer is still single-source-of-truth.** Iframe preview and public HTML share the same bytes; travel legs render identically in both.
- **Auto-republish covers it.** Any travel-leg mutation goes through `republishGroup()`, so the bucket stays in sync without manual steps.
- **No impact on existing trips.** Trips without travel legs render exactly as before. The `travelLegs[]` array is just empty.
- **`scripts/republish-trips.ts` keeps working.** The republish helper reads from the DB, so once it pulls `travelLegs` for each group it'll diff the HTML the same way (hash-compare, write only if changed).

### Worked example: 2017 European bike trip travel legs

Once the feature lands, these are the rows to add for group id 8:

| Date | Mode | From | To | Notes |
|---|---|---|---|---|
| 2017-06-20 | train | Perpignan | Lunel | Bike malfunction in Perpignan forced cancellation of planned Perpignan→Béziers ride |
| 2017-06-23 | train | Aix-en-Provence | Hyères | Off day on Porquerolles Island |
| 2017-06-26 | train | Menton | Nice | Sarah flying home; picking up Adam at Nice airport |
| 2017-06-29 | train | Cuneo | Vercelli | Mid-day train between two recorded rides (Panice Sottana→Cuneo and Vercelli→Pezzana) |
| 2017-07-01 | train | Milan | Venice | Frecciarossa |
| 2017-07-07 | ferry | Mali Lošinj | Zadar | 5-hour ferry; early ferry didn't accept bikes |
| 2017-07-10 | ferry | Split | Dubrovnik | *Only if Dubrovnik is added to the trip — bike-trip activities currently end Jul 9* |
