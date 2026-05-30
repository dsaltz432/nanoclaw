# Strava Trips (public trip pages)

The dashboard's Strava section can publish a "Trip" (a group of Strava activities) as a
self-contained public HTML page. Same pattern as [Sports Briefings](sports-briefing.md) — a
server-side renderer writes HTML to `data/trip-briefings/`, a launchd `WatchPaths` job uploads
to GCS, returns a public URL. Architecture detail in
[grouped-activities-plan.md](grouped-activities-plan.md); host launchd pattern in
[host-cronjobs.md](host-cronjobs.md).

| Component | Location |
|-----------|----------|
| HTML renderer | `dashboard/server/lib/render-trip-html.ts` |
| Build-trip-data helper | `dashboard/server/routes/strava.ts` (`buildTripDataForRender`, exported) |
| Upload script | `scripts/upload-trip-briefing.sh` |
| Upload watcher plist | `launchd/com.nanoclaw.trip-briefing-upload.plist` |
| GCS bucket (public) | `gs://strava-trips/` |
| Public index page | `https://storage.googleapis.com/strava-trips/index.html` |

**Publish flow:** edits in the dashboard's Edit Trip modal PATCH the row → if the trip is
already published, the server auto-renders + writes the new HTML + bumps `published_at` →
launchd uploads. No manual "Re-Publish" button.

**Republish after renderer changes:** code changes to `render-trip-html.ts` don't trigger the
auto-republish hook (no DB write). After such a change, run:

```bash
npx tsx scripts/republish-trips.ts
```

It iterates every currently-published trip (`WHERE published_slug IS NOT NULL`), renders the
HTML in memory, and **only writes when the SHA-256 differs** from the on-disk file. Unrelated
changes (Garmin sync, etc.) produce identical bytes and are no-ops. Footer renders from each
trip's stored `published_at` (not `new Date()`) so output is deterministic for the same input.

The script also regenerates `index.html` with the same hash check.
