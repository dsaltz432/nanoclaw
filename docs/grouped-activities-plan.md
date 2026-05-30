# Grouped Activities ("Trips") — Strava Dashboard

> **Status:** Shipped. This doc reflects the current architecture, not the original 2026-05 plan (which diverged on several points — see "Notes on evolution" at the bottom for the history).

A "Trip" is a logical group of Strava activities (a triathlon's 3 legs, a multi-day bike trip, etc.) that the dashboard treats as one unit: aggregate stats, a multi-leg map, and a stitched profile chart. Trips can be published to a public URL backed by GCS.

## Architecture overview

```
                       ┌─────────────────────────────────────────────┐
                       │           data/sessions/fitness/.claude/    │
                       │  ┌─ strava.db                               │
                       │  │   • activities                           │
                       │  │   • activity_groups   (trips)            │
                       │  │   • activity_group_members               │
                       │  │   • activity_streams  (per-activity cache)│
                       │  └────────────────────────────────────────  │
                       └─────────────────────────────────────────────┘
                                  ▲                       ▲
                                  │                       │
        ┌─────────────────────────┴──────────┐  ┌─────────┴──────────────┐
        │  dashboard/server  (Express)       │  │  groups/fitness/       │
        │  • REST API for trips              │  │  strava_sync.py        │
        │  • Server-renders trip HTML        │  │  (daily 1am UTC pull   │
        │  • Auto-republishes on edit        │  │   from Strava API)     │
        └────────┬──────────────────┬────────┘  └────────────────────────┘
                 │                  │
         iframe  │                  │ writes
                 ▼                  ▼
        ┌────────────────┐  data/trip-briefings/
        │  Dashboard     │       │.html
        │  React UI      │       ▼
        │  (edit modal,  │  launchd WatchPaths
        │   publish      │       │
        │   strip)       │       ▼   gcloud storage cp
        └────────────────┘  gs://strava-trips/
                                  │
                                  ▼
                         Public URL: https://storage.googleapis.com/strava-trips/<slug>.html
```

The **trip HTML is rendered once by the server** (`dashboard/server/lib/render-trip-html.ts`) and serves two consumers:
1. The dashboard's trip detail page embeds it via iframe (`/api/strava/groups/:id/preview`)
2. The published file in GCS at `<slug>.html` — what external viewers see

Same HTML in both places → no drift between preview and published.

## Schema

`strava.db` (host SQLite, written by both the sync container and the dashboard server in WAL mode):

```sql
-- The trip itself
CREATE TABLE activity_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  athlete_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  start_date TEXT,            -- derived from earliest member, cached
  end_date TEXT,              -- derived from latest member, cached
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_slug TEXT,        -- non-null = published; matches gs://strava-trips/<slug>.html
  published_at TEXT
);

-- Membership (which activities are in which trip)
CREATE TABLE activity_group_members (
  group_id INTEGER NOT NULL,
  activity_id INTEGER NOT NULL,
  leg_order INTEGER NOT NULL,
  PRIMARY KEY (group_id, activity_id),
  FOREIGN KEY (group_id) REFERENCES activity_groups(id) ON DELETE CASCADE
);

-- Cached Strava stream data for any activity that ever ended up in a trip.
-- Populated on-demand by the trip's first view (prefetchGroupStreams).
CREATE TABLE activity_streams (
  activity_id INTEGER PRIMARY KEY,
  time_json TEXT,
  distance_json TEXT,
  altitude_json TEXT,
  heartrate_json TEXT,
  velocity_json TEXT,
  latlng_json TEXT,
  fetched_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

All timestamps use ISO 8601 UTC for portability across JS `new Date(…)` implementations.

## API endpoints (`dashboard/server/routes/strava.ts`)

All behind the existing auth middleware. The trip-specific surface:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/strava/groups?athlete_id=` | List trips with aggregate stats + leg polylines for thumbnails |
| `GET` | `/api/strava/groups/:id` | Full trip detail (members, totals, sport breakdown) |
| `POST` | `/api/strava/groups` | Create trip from `{ athlete_id, name, description?, activity_ids[] }` |
| `PATCH` | `/api/strava/groups/:id` | Partial update (name/description/membership). **Auto-republishes** if `published_slug` is set. |
| `DELETE` | `/api/strava/groups/:id` | Delete trip (members cascade; underlying activities untouched) |
| `GET` | `/api/strava/groups/:id/preview` | Render trip HTML (no persist, no upload). Used by dashboard iframe + as the publish source. |
| `POST` | `/api/strava/groups/:id/publish` | First-time publish: generate slug, write file, set `published_slug` + `published_at`, regenerate `index.html` |
| `DELETE` | `/api/strava/groups/:id/publish` | Unpublish: delete local file, drop tombstone for the watcher, clear DB fields |

## Publish lifecycle

1. **User clicks "Publish public link"** on a trip → server renders HTML, writes to `data/trip-briefings/<slug>.html`, also regenerates `index.html`, stores slug + timestamp.
2. **launchd WatchPaths** detects the new file → runs `scripts/upload-trip-briefing.sh` → uploads to `gs://strava-trips/` via the `nanoclaw-backup` service account.
3. **Public URL is live**: `https://storage.googleapis.com/strava-trips/<slug>.html` (60s cache TTL).
4. **Any subsequent PATCH** to the trip (name, description, leg add/remove) → server auto-republishes (renders + writes), launchd uploads, public URL is in sync within ~5 seconds. No "Re-Publish" button needed.
5. **Unpublish** → server deletes local file + writes a tombstone marker in `data/trip-briefings/.tombstone/`. The watcher script does `gcloud storage rm` against the tombstone's slug name and clears the marker.

## Dashboard UI

`dashboard/src/pages/StravaPage.tsx` has a "Trips" tab inside each athlete's section.

**Trips list view** (`TripsTab` + `TripCard`):
- Grid of cards, newest trip first by start_date
- Each card: mini multi-leg map (Leaflet thumbnail), trip name, date range, sport chips, totals, leg count
- Hover reveals an `×` delete button per card (with confirmation)
- "+ New Trip" button → `CreateGroupModal` with activity picker (date-range pre-filter)

**Trip detail view** (`TripDetailView`):
- **Header**: back, name, date range, "✎ Edit" button
- **Publish strip**: either "🔗 Publish public link" (never published) or "Published ✓" + URL + Copy + Unpublish
- **Body**: single iframe pointing at `/api/strava/groups/:id/preview?v=<updated_at>` — the same HTML as the public page. Iframe self-sizes via `postMessage`.
- **Edit modal** (`EditTripModal`): single modal for name + description + member list (with × per row and + Add legs sub-modal). Save calls PATCH; iframe refreshes via the cache-bust query.

This is the single-source-of-truth pattern: only one renderer (`render-trip-html.ts`) decides what a trip looks like, and both internal preview and public URL serve identical bytes.

## Trip HTML (`render-trip-html.ts`)

Server-rendered, fully self-contained. Per trip, ~50-80 KB. Includes:

- Trip header + totals + sport breakdown
- **Multi-leg Leaflet map** — polylines as encoded strings in a `POLYLINES` JS array, decoded + drawn client-side. OSM tiles from CDN. Aspect-ratio adaptive (portrait routes get side-by-side layout with the legs table; wide routes stack).
- **Combined profile chart** — pre-rendered SVG with 3 metrics (Speed, Heart Rate, Elevation). Median-filtered velocity to kill GPS spikes. Per-leg color bar at the bottom of the chart.
- **Interactive**:
  - Click metric chips → toggle line + axis labels
  - Click leg chips → highlight on map (others dim)
  - Hover the chart → crosshair + dots at each visible metric + tooltip (leg name, distance, HR, elevation, speed)
- **Legs table** — sport icon, name, date, distance, moving time, elevation gain. Each row links to `strava.com/activities/<id>`.

Privacy: name-less by default. No athlete attribution. Random slug in URL.

## Index page

`gs://strava-trips/index.html` is regenerated on every publish/unpublish via `regenerateIndex()` in the server. Lists all currently-published trips as cards (no map thumbnails, just metadata). Newest first.

## Non-goals (deliberate omissions)

- No re-upload to Strava (`activity:write` scope unused; originals stay clean)
- No automatic publishing on trip create (privacy gate: you must explicitly click Publish once)
- No cross-athlete trips (each trip belongs to one athlete)
- No bulk stream backfill — streams cached only when a trip needs them
- No editing of underlying Strava activities

## Notes on evolution (since the original 2026-05 plan)

The original design had a few things that got removed or changed during build-out:

- **`kind` field** (`trip` / `multisport` / `custom`) — removed. The dashboard auto-detects multi-sport based on whether members share a date with different sports.
- **`color` field** — removed. Never had UI.
- **Inline editing of name + description on the detail page** — removed. Replaced by an explicit Edit modal so the detail page can be a faithful read-only iframe of the published HTML.
- **Separate "Delete Trip" button on the detail page** — moved to a hover-revealed `×` on each trip card in the list, so the detail page stays read-only.
- **Manual "Re-Publish" + "Changes pending" UI** — removed. Edits to already-published trips auto-republish.
- **`/api/strava/groups/:id/streams` endpoint** — removed. The streams cache is populated server-side at publish time and read by the renderer directly from the DB.
- **Lazy "Load profile chart" button** — removed. Background prefetch on create + auto-load on view means the chart is always ready.

Helpers + constants (`SPORT_COLORS`, `decodePolyline`, format helpers, etc.) are currently duplicated between the React dashboard (`StravaPage.tsx`) and the renderer (`render-trip-html.ts`). They're stable enough that the duplication has been judged not worth the cross-directory-import setup; a future refactor could extract them to `dashboard/shared/` if drift becomes a problem.
