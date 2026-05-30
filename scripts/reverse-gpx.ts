#!/usr/bin/env node
/**
 * Reverse a GPX track. Useful when you find someone's route in the opposite
 * direction (e.g. Wikiloc has Perpignan→Besalú but you rode Besalú→Perpignan).
 *
 * Behavior:
 *   - Reverses every <trkpt> within each <trkseg>.
 *   - Re-times the points so the timeline still moves forward. Original
 *     intervals between trackpoints are preserved (just reversed), so a long
 *     climb at the *end* of the original route becomes a long climb at the
 *     *start* of the reversed route — the durations stay realistic.
 *   - Optionally rebases the start time to a date you specify.
 *
 * Usage:
 *   npx tsx scripts/reverse-gpx.ts <input.gpx> [output.gpx] \
 *     [--start YYYY-MM-DDTHH:MM] [--duration <hours>]
 *
 * Options:
 *   --start <iso>      Anchor the first trackpoint at this local time.
 *                      Default: preserved from the input's first trkpt.
 *   --duration <hours> Scale all trackpoint intervals so the total elapsed
 *                      time matches the target. Useful when the source GPX
 *                      is a car/drone recording but the activity is a bike
 *                      ride. Pacing variation (climbs vs descents) is
 *                      preserved proportionally.
 *
 * Defaults:
 *   - output: <input>-reversed.gpx next to the input
 */
import fs from "fs";
import path from "path";

const argv = process.argv.slice(2);
if (argv.length < 1 || argv[0] === "-h" || argv[0] === "--help") {
  console.error(
    "Usage: npx tsx scripts/reverse-gpx.ts <input.gpx> [output.gpx] [--start YYYY-MM-DDTHH:MM] [--duration <hours>]"
  );
  process.exit(1);
}

const inputPath = argv[0]!;
let outputPath: string | undefined;
let startOverride: string | undefined;
let targetDurationHours: number | undefined;
for (let i = 1; i < argv.length; i++) {
  if (argv[i] === "--start") {
    startOverride = argv[++i];
  } else if (argv[i] === "--duration") {
    targetDurationHours = Number(argv[++i]);
    if (!Number.isFinite(targetDurationHours) || targetDurationHours <= 0) {
      throw new Error("--duration must be a positive number of hours");
    }
  } else {
    outputPath = argv[i];
  }
}
if (!outputPath) {
  const ext = path.extname(inputPath);
  outputPath = inputPath.replace(new RegExp(`${ext}$`), `-reversed${ext}`);
}

const xml = fs.readFileSync(inputPath, "utf8");

// Regex-based parse: GPX is verbose XML and we only need to walk trkseg blocks
// and rearrange trkpt order. A real XML parser would be cleaner but adds a
// dependency for what is fundamentally a string-shuffle.
function reverseTrkseg(seg: string): string {
  const trkpts: string[] = [];
  const re = /<trkpt\b[^>]*\/>|<trkpt\b[^>]*>[\s\S]*?<\/trkpt>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg)) !== null) trkpts.push(m[0]);
  if (trkpts.length === 0) return seg;

  // Extract original timestamps so we can preserve forward-moving time but
  // reverse the *intervals* (so the new last point ends with the longest gap,
  // and the new first point starts immediately).
  const timestamps: Date[] = trkpts.map((p) => {
    const t = /<time>([^<]+)<\/time>/.exec(p);
    return t ? new Date(t[1]!) : new Date(NaN);
  });
  const haveTimes = timestamps.every((d) => !isNaN(d.getTime()));
  const reversed = [...trkpts].reverse();

  let newTimes: Date[] | null = null;
  if (haveTimes) {
    const intervalsMs: number[] = [];
    for (let i = 1; i < timestamps.length; i++) {
      intervalsMs.push(timestamps[i]!.getTime() - timestamps[i - 1]!.getTime());
    }
    // Reverse the intervals so the *spatial* sequence keeps its pacing.
    intervalsMs.reverse();
    // Optional duration stretch: scale every interval by a constant factor to
    // hit a target total elapsed time. Preserves relative pacing (climbs are
    // still proportionally slower than descents).
    if (targetDurationHours) {
      const origTotalMs = intervalsMs.reduce((a, b) => a + b, 0);
      const targetMs = targetDurationHours * 3600 * 1000;
      if (origTotalMs > 0) {
        const scale = targetMs / origTotalMs;
        for (let i = 0; i < intervalsMs.length; i++) {
          intervalsMs[i] = Math.round(intervalsMs[i]! * scale);
        }
      }
    }
    const startMs = startOverride
      ? new Date(startOverride).getTime()
      : timestamps[0]!.getTime();
    if (isNaN(startMs)) {
      throw new Error(`Invalid --start date: ${startOverride}`);
    }
    newTimes = [new Date(startMs)];
    for (const delta of intervalsMs) {
      newTimes.push(new Date(newTimes[newTimes.length - 1]!.getTime() + delta));
    }
  }

  const rewritten = reversed.map((p, i) => {
    if (!newTimes) return p;
    const iso = newTimes[i]!.toISOString();
    if (/<time>/.test(p)) {
      return p.replace(/<time>[^<]+<\/time>/, `<time>${iso}</time>`);
    }
    // Inject <time> right after the opening trkpt tag if missing
    return p.replace(/(<trkpt\b[^>]*>)/, `$1<time>${iso}</time>`);
  });

  // Replace just the trkpt block while preserving any wrapping text (name,
  // extensions) inside the trkseg.
  const firstStart = seg.search(/<trkpt\b/);
  const lastEnd = seg.lastIndexOf("</trkpt>") + "</trkpt>".length;
  const selfClosingEnd = seg.search(/<trkpt\b[^>]*\/>\s*<\/trkseg>/);
  const end = lastEnd > 0 ? lastEnd : selfClosingEnd > 0 ? selfClosingEnd : seg.length;
  if (firstStart < 0) return seg;
  return seg.slice(0, firstStart) + rewritten.join("\n") + seg.slice(end);
}

const reversedXml = xml.replace(
  /<trkseg>[\s\S]*?<\/trkseg>/g,
  (m) => `<trkseg>${reverseTrkseg(m.slice("<trkseg>".length, -"</trkseg>".length))}</trkseg>`
);

fs.writeFileSync(outputPath, reversedXml);

// Quick summary
const ptCount = (reversedXml.match(/<trkpt\b/g) ?? []).length;
const firstTime = /<trkpt\b[^>]*>[\s\S]*?<time>([^<]+)<\/time>/.exec(reversedXml);
const lastTimeAll = [...reversedXml.matchAll(/<time>([^<]+)<\/time>/g)];
console.log(`Wrote ${outputPath}`);
console.log(`  trackpoints: ${ptCount}`);
if (firstTime && lastTimeAll.length > 0) {
  console.log(`  first time:  ${firstTime[1]}`);
  console.log(`  last  time:  ${lastTimeAll[lastTimeAll.length - 1]![1]}`);
}
