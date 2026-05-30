#!/usr/bin/env node
/**
 * Cut a round-trip GPX at the turnaround point. Useful when the only GPX
 * available for a route is "A → B → A" but you only rode A → B (or B → A).
 *
 * Strategy: find the trackpoint farthest (great-circle distance) from the
 * file's first trackpoint. That's the turnaround. Slice the trackpoint list
 * up to and including that point.
 *
 * Usage:
 *   npx tsx scripts/cut-gpx-at-turnaround.ts <input.gpx> [output.gpx] \
 *     [--start YYYY-MM-DDTHH:MM:SSZ] [--duration <hours>]
 *
 * --start    Rebase the first trackpoint's time. Subsequent points keep their
 *            original relative offsets (after time-scaling, if --duration set).
 * --duration Scale all intervals proportionally to hit a target elapsed time
 *            for the cut segment. Same semantics as in reverse-gpx.ts.
 */
import fs from "fs";

const argv = process.argv.slice(2);
if (argv.length < 1) {
  console.error(
    "Usage: npx tsx scripts/cut-gpx-at-turnaround.ts <input.gpx> [output.gpx] [--start ISO] [--duration <hours>]"
  );
  process.exit(1);
}

const inputPath = argv[0]!;
let outputPath: string | undefined;
let startOverride: string | undefined;
let targetDurationHours: number | undefined;
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--start") startOverride = argv[++i];
  else if (argv[i] === "--duration") targetDurationHours = Number(argv[++i]);
  else outputPath = argv[i];
}
if (!outputPath) {
  outputPath = inputPath.replace(/\.gpx$/i, "-cut.gpx");
}

const xml = fs.readFileSync(inputPath, "utf8");

// Find all trkpts and their lat/lon.
const trkptRe = /<trkpt\b[^>]*\/>|<trkpt\b[^>]*>[\s\S]*?<\/trkpt>/g;
type Pt = { raw: string; lat: number; lon: number; time?: Date };
const pts: Pt[] = [];
let m: RegExpExecArray | null;
while ((m = trkptRe.exec(xml)) !== null) {
  const raw = m[0];
  const lat = Number(/lat="([^"]+)"/.exec(raw)?.[1]);
  const lon = Number(/lon="([^"]+)"/.exec(raw)?.[1]);
  const tMatch = /<time>([^<]+)<\/time>/.exec(raw);
  const time = tMatch ? new Date(tMatch[1]!) : undefined;
  pts.push({ raw, lat, lon, time });
}
if (pts.length < 3) {
  console.error("Not enough trackpoints to detect a turnaround.");
  process.exit(1);
}

// Great-circle distance (haversine, km) — accurate enough for "which point is farthest"
function distKm(a: Pt, b: Pt): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const start = pts[0]!;
let maxIdx = 0;
let maxDist = 0;
for (let i = 1; i < pts.length; i++) {
  const d = distKm(start, pts[i]!);
  if (d > maxDist) {
    maxDist = d;
    maxIdx = i;
  }
}

const kept = pts.slice(0, maxIdx + 1);
const turnaround = pts[maxIdx]!;
console.log(`Start:        ${start.lat.toFixed(4)}, ${start.lon.toFixed(4)}`);
console.log(`Turnaround:   ${turnaround.lat.toFixed(4)}, ${turnaround.lon.toFixed(4)} (index ${maxIdx}/${pts.length - 1}, ${maxDist.toFixed(2)} km from start)`);
console.log(`Keeping ${kept.length} of ${pts.length} trackpoints.`);

// Re-time the kept segment if requested.
let timeMap: Map<string, string> | null = null;
if (kept.every((p) => p.time && !isNaN(p.time.getTime()))) {
  const intervalsMs: number[] = [];
  for (let i = 1; i < kept.length; i++) {
    intervalsMs.push(kept[i]!.time!.getTime() - kept[i - 1]!.time!.getTime());
  }
  if (targetDurationHours) {
    const orig = intervalsMs.reduce((a, b) => a + b, 0);
    const target = targetDurationHours * 3600 * 1000;
    if (orig > 0) {
      const scale = target / orig;
      for (let i = 0; i < intervalsMs.length; i++) intervalsMs[i] = Math.round(intervalsMs[i]! * scale);
    }
  }
  const startMs = startOverride ? new Date(startOverride).getTime() : kept[0]!.time!.getTime();
  if (isNaN(startMs)) throw new Error(`Invalid --start: ${startOverride}`);
  const newTimes = [new Date(startMs)];
  for (const dt of intervalsMs) newTimes.push(new Date(newTimes[newTimes.length - 1]!.getTime() + dt));
  timeMap = new Map();
  kept.forEach((p, i) => timeMap!.set(p.raw, newTimes[i]!.toISOString()));
}

// Splice the new trackpoints back into the original document, replacing the
// whole trkpt block in each trkseg with the kept (and possibly re-timed) ones.
let outBody = xml;
outBody = outBody.replace(/<trkseg>[\s\S]*?<\/trkseg>/g, (seg) => {
  const inner = seg.slice("<trkseg>".length, -"</trkseg>".length);
  const firstStart = inner.search(/<trkpt\b/);
  const lastEnd = inner.lastIndexOf("</trkpt>") + "</trkpt>".length;
  if (firstStart < 0) return seg;
  const newPts = kept.map((p) => {
    if (!timeMap) return p.raw;
    const iso = timeMap.get(p.raw)!;
    if (/<time>/.test(p.raw)) return p.raw.replace(/<time>[^<]+<\/time>/, `<time>${iso}</time>`);
    return p.raw.replace(/(<trkpt\b[^>]*>)/, `$1<time>${iso}</time>`);
  });
  return `<trkseg>${inner.slice(0, firstStart)}${newPts.join("\n")}${inner.slice(lastEnd)}</trkseg>`;
});

fs.writeFileSync(outputPath, outBody);
const finalFirstTime = /<trkpt[\s\S]*?<time>([^<]+)<\/time>/.exec(outBody)?.[1];
const allTimes = [...outBody.matchAll(/<time>([^<]+)<\/time>/g)];
console.log(`\nWrote ${outputPath}`);
if (finalFirstTime && allTimes.length > 0) {
  console.log(`  first time: ${finalFirstTime}`);
  console.log(`  last time:  ${allTimes[allTimes.length - 1]![1]}`);
}
