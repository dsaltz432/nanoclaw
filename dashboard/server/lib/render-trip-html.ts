// Server-side renderer for a public trip page.
// Takes a trip group + members + cached streams from strava.db and produces
// a self-contained HTML string suitable for upload to a public bucket.

interface TripMember {
  id: number;
  name: string;
  sport_type: string;
  start_date_local: string;
  distance: number | null;
  moving_time: number | null;
  elapsed_time: number | null;
  total_elevation_gain: number | null;
  average_heartrate: number | null;
  map_summary_polyline: string | null;
  leg_order: number;
}

interface TripData {
  id: number;
  name: string;
  description: string | null;
  photos_url: string | null;
  published_at: string | null;
  start_date: string | null;
  end_date: string | null;
  members: TripMember[];
  totals: {
    distance_m: number;
    moving_time_s: number;
    elapsed_time_s: number;
    elevation_m: number;
    avg_hr: number | null;
  };
  sport_breakdown: Record<string, number>;
  // Per-member streams; same shape returned by /groups/:id/streams
  legStreams: {
    activity_id: number;
    name: string;
    sport_type: string;
    start_date_local: string;
    distance: number[] | null;
    altitude: number[] | null;
    heartrate: number[] | null;
    velocity: number[] | null;
  }[];
  travelLegs?: TravelLeg[];
}

interface TravelLeg {
  id: number;
  mode: string;            // 'train' | 'ferry' | 'plane' | 'bus' | 'car'
  start_date: string;
  start_lat: number;
  start_lng: number;
  start_label: string | null;
  end_lat: number;
  end_lng: number;
  end_label: string | null;
  notes: string | null;
}

const TRAVEL_MODE_ICON: Record<string, string> = {
  train: "🚂",
  ferry: "⛴",
  plane: "✈️",
  bus: "🚌",
  car: "🚗",
};
const travelIcon = (mode: string) => TRAVEL_MODE_ICON[mode] ?? "→";

// ──────────────────────────────────────────────────────────────────────────────
// Constants kept in sync with the dashboard (StravaPage.tsx)

const SPORT_COLORS: Record<string, string> = {
  Run: "#f97316",
  TrailRun: "#ea580c",
  Ride: "#6366f1",
  VirtualRide: "#818cf8",
  Swim: "#3b82f6",
  Walk: "#22c55e",
  Hike: "#f59e0b",
  WeightTraining: "#a855f7",
  Yoga: "#ec4899",
  Workout: "#14b8a6",
  Soccer: "#10b981",
  Pickleball: "#06b6d4",
  NordicSki: "#64748b",
  Tennis: "#eab308",
  Snowshoe: "#94a3b8",
  Kayaking: "#0ea5e9",
};

const SPORT_ICONS: Record<string, string> = {
  Run: "🏃",
  TrailRun: "🏃",
  Ride: "🚴",
  VirtualRide: "🚴",
  Swim: "🏊",
  Walk: "🚶",
  Hike: "🥾",
  WeightTraining: "🏋️",
  Yoga: "🧘",
  Workout: "💪",
  Soccer: "⚽",
  Pickleball: "🏓",
  NordicSki: "⛷️",
  Tennis: "🎾",
  Snowshoe: "🥾",
  Kayaking: "🛶",
};

const LEG_PALETTE = [
  "#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4",
  "#a855f7", "#ec4899", "#14b8a6", "#f97316", "#3b82f6",
];

const sportColor = (s: string) => SPORT_COLORS[s] ?? "#6b7280";
const sportIcon = (s: string) => SPORT_ICONS[s] ?? "🏃";

// Per-trip sport-text overrides. Only changes the displayed string (the icon
// and color still come from the underlying Strava `sport_type`). Used when
// the activities are tagged as one sport on Strava but the trip should
// display as another — e.g. Kilimanjaro logged as Run but is conceptually a Hike.
const TRIP_SPORT_LABEL_OVERRIDES: Record<number, Record<string, string>> = {
  6: { Run: "Hike" }, // Climbing Kilimanjaro
};
function overrideSportLabel(tripId: number, sport: string): string {
  return TRIP_SPORT_LABEL_OVERRIDES[tripId]?.[sport] ?? sport;
}
const legColor = (i: number) => LEG_PALETTE[i % LEG_PALETTE.length] ?? "#6366f1";

// ──────────────────────────────────────────────────────────────────────────────
// Formatting helpers

function fmtDistance(m: number): string {
  const km = m / 1000;
  return km < 1
    ? `${Math.round(m)} m`
    : `${km.toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;
}

function fmtTime(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso.length > 10 ? iso : iso + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start) return "";
  const s = new Date(start + "T00:00:00");
  if (!end || start === end) {
    return s.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  const e = new Date(end + "T00:00:00");
  const sameYear = s.getFullYear() === e.getFullYear();
  const sameMonth = sameYear && s.getMonth() === e.getMonth();
  if (sameMonth) {
    return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })}–${e.getDate()}, ${e.getFullYear()}`;
  }
  if (sameYear) {
    return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${e.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${e.getFullYear()}`;
  }
  return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} – ${e.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
}

function countDays(start: string | null, end: string | null): number {
  if (!start || !end) return 1;
  const s = new Date(start + "T00:00:00").getTime();
  const e = new Date(end + "T00:00:00").getTime();
  return Math.max(1, Math.round((e - s) / 86400000) + 1);
}

function dayNumber(legDate: string, anchor: string | null): number {
  if (!anchor) return 1;
  const leg = new Date(legDate.substr(0, 10) + "T00:00:00").getTime();
  const start = new Date(anchor.substr(0, 10) + "T00:00:00").getTime();
  return Math.max(1, Math.round((leg - start) / 86400000) + 1);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Mercator-correct aspect ratio for the map container
function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let idx = 0, lat = 0, lng = 0;
  while (idx < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}

function computeRoutesAspectRatio(encoded: string[]): number | null {
  let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180, any = false;
  for (const enc of encoded) {
    for (const [lat, lng] of decodePolyline(enc)) {
      any = true;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  }
  if (!any) return null;
  const meanLat = (minLat + maxLat) / 2;
  const latM = (maxLat - minLat) * 111000;
  const lngM = (maxLng - minLng) * 111000 * Math.cos((meanLat * Math.PI) / 180);
  if (latM < 1 || lngM < 1) return null;
  return lngM / latM;
}

// 7-sample median filter (matches the dashboard's chart filter)
function medianFilter(arr: (number | null)[], window = 7): (number | null)[] {
  const half = Math.floor(window / 2);
  const out: (number | null)[] = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] == null) { out[i] = null; continue; }
    const slice: number[] = [];
    for (let j = Math.max(0, i - half); j < Math.min(arr.length, i + half + 1); j++) {
      const v = arr[j];
      if (v != null) slice.push(v);
    }
    slice.sort((a, b) => a - b);
    out[i] = slice[Math.floor(slice.length / 2)] ?? null;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────
// SVG profile chart renderer (server-side, no client JS needed)

interface ProfileResult {
  svg: string;
  present: { alt: boolean; hr: boolean; speed: boolean };
  hoverData: {
    // Each sample: [legIdx, cumDistance, alt|null, hr|null, speed|null]
    samples: (number | null)[][];
    // Per-leg metadata for the tooltip
    legs: { name: string; sportType: string; dayNumber: number }[];
    // Chart geometry so JS can map values → Y pixels (matches SVG renderer)
    geom: {
      W: number; H: number; padL: number; padR: number;
      padT: number; chartH: number; xMax: number;
      altMin: number; altRange: number; altMeaningful: boolean;
      hrMin: number; hrRange: number; hasHr: boolean;
      speedMin: number; speedRange: number; hasSpeed: boolean;
    };
    multisport: boolean;
  };
}

function renderProfileSvg(trip: TripData, multisport: boolean): ProfileResult {
  const legs = trip.legStreams;
  const empty: ProfileResult = {
    svg: "",
    present: { alt: false, hr: false, speed: false },
    hoverData: {
      samples: [], legs: [],
      geom: { W: 0, H: 0, padL: 0, padR: 0, padT: 0, chartH: 0, xMax: 0,
        altMin: 0, altRange: 1, altMeaningful: false,
        hrMin: 0, hrRange: 1, hasHr: false,
        speedMin: 0, speedRange: 1, hasSpeed: false },
      multisport: false,
    },
  };
  if (!legs.length) return empty;

  interface P { legIdx: number; cum: number; alt: number | null; hr: number | null; speed: number | null; }
  const points: P[] = [];
  const legBoundaries: number[] = [];
  const legSegments: { idx: number; xStart: number; xEnd: number; color: string; sportType: string }[] = [];
  let cumOffset = 0;
  for (let li = 0; li < legs.length; li++) {
    const leg = legs[li]!;
    const xArr = leg.distance;
    if (!xArr || xArr.length < 2) continue;
    if (li > 0) legBoundaries.push(cumOffset);
    const segStart = cumOffset;
    const alt = leg.altitude;
    const hr = leg.heartrate;
    const velRaw = leg.velocity;
    const vel = velRaw ? medianFilter(velRaw as (number | null)[]) : null;
    for (let i = 0; i < xArr.length; i++) {
      const v = vel ? vel[i] ?? null : null;
      const rawAlt = alt ? alt[i] ?? null : null;
      points.push({
        legIdx: li,
        cum: cumOffset + (xArr[i] ?? 0),
        alt: rawAlt != null ? Math.max(0, rawAlt) : null,
        hr: hr ? hr[i] ?? null : null,
        speed: v != null ? v * 3.6 : null,
      });
    }
    const last = xArr[xArr.length - 1];
    cumOffset += last ?? 0;
    legSegments.push({
      idx: li,
      xStart: segStart,
      xEnd: cumOffset,
      color: multisport ? sportColor(leg.sport_type) : legColor(li),
      sportType: leg.sport_type,
    });
  }
  if (points.length < 2) return empty;

  const MAX = 800;
  const stride = Math.max(1, Math.ceil(points.length / MAX));
  const sampled = points.filter((_, i) => i % stride === 0);

  // viewBox dimensions. The chart renders at container_width × (H/W). Width
  // is fixed at 900 as a reference; H drives the vertical aspect. 4:1 was
  // cramped for elevation/HR profiles; 2.8:1 gives lines room to breathe.
  const W = 900, H = 320, padL = 50, padR = 50, padT = 12, padB = 56;
  const plotW = W - padL - padR;
  const chartH = H - padT - padB;

  const xMax = sampled[sampled.length - 1]?.cum ?? 1;
  const toX = (cum: number) => padL + (cum / xMax) * plotW;

  const altVals = sampled.map((p) => p.alt).filter((v): v is number => v != null);
  const hrVals = sampled.map((p) => p.hr).filter((v): v is number => v != null);
  const speedVals = sampled.map((p) => p.speed).filter((v): v is number => v != null);
  const altMin = altVals.length ? Math.min(...altVals) : 0;
  const altMax = altVals.length ? Math.max(...altVals) : 1;
  const altRange = altMax - altMin || 1;
  const altMeaningful = altVals.length > 0 && altRange > 5;
  const hrMin = hrVals.length ? Math.min(...hrVals) : 0;
  const hrMax = hrVals.length ? Math.max(...hrVals) : 1;
  const hrRange = hrMax - hrMin || 1;
  // Auto-hide HR when fewer than half the legs recorded it. A trip with HR on
  // only 1 of 4 days produces a single short segment in an otherwise HR-less
  // chart, which is more confusing than useful (and the trip-level avg HR
  // would be unrepresentative).
  const legsWithHr = legs.filter(
    (l) => l.heartrate && l.heartrate.some((v) => v != null)
  ).length;
  const hasHr =
    hrVals.length > 0 && legs.length > 0 && legsWithHr / legs.length >= 0.5;
  const speedMin = 0;
  const sortedSpeed = [...speedVals].sort((a, b) => a - b);
  const speedMax = sortedSpeed.length
    ? sortedSpeed[Math.min(sortedSpeed.length - 1, Math.floor(sortedSpeed.length * 0.99))] ?? 1
    : 1;
  const speedRange = speedMax - speedMin || 1;
  const hasSpeed = speedVals.length > 0 && speedMax > 1;

  const toAltY = (v: number) => padT + chartH - ((v - altMin) / altRange) * chartH;
  const toHrY = (v: number) => padT + chartH - ((v - hrMin) / hrRange) * chartH;
  const toSpeedY = (v: number) => {
    const y = padT + chartH - ((v - speedMin) / speedRange) * chartH;
    return Math.max(padT, Math.min(padT + chartH, y));
  };

  // Emit a path that starts each contiguous run of non-null values with M
  // (MoveTo). Without this, a metric like HR that's null at the start of the
  // trip (e.g. Day 1 had no HR sensor) would produce an invalid path starting
  // with L. Bonus: gaps in the middle become two separate sub-paths rather
  // than a straight line bridging the gap.
  const buildPath = (key: keyof Pick<P, "alt" | "hr" | "speed">, toY: (v: number) => number): string => {
    const parts: string[] = [];
    let started = false;
    for (const p of sampled) {
      const v = p[key];
      if (v == null) { started = false; continue; }
      parts.push(`${started ? "L" : "M"}${toX(p.cum).toFixed(1)},${toY(v).toFixed(1)}`);
      started = true;
    }
    return parts.join(" ");
  };

  const altPath = altMeaningful ? buildPath("alt", toAltY) : "";
  const hrPath = hasHr ? buildPath("hr", toHrY) : "";
  const speedPath = hasSpeed ? buildPath("speed", toSpeedY) : "";

  // Axis assignment (Speed > HR > Elevation, max 2 axes)
  type Axis = { key: "speed" | "hr" | "alt"; name: string; max: number; min: number; unit: string; color: string; fmt: (v: number) => string };
  const candidates: Axis[] = [];
  if (hasSpeed) candidates.push({ key: "speed", name: "Speed", max: speedMax, min: 0, unit: "km/h", color: "#06b6d4", fmt: (v) => v < 10 ? v.toFixed(1) : v.toFixed(0) });
  if (hasHr) candidates.push({ key: "hr", name: "Heart Rate", max: hrMax, min: hrMin, unit: "bpm", color: "#ef4444", fmt: (v) => Math.round(v).toString() });
  if (altMeaningful) candidates.push({ key: "alt", name: "Elevation", max: altMax, min: altMin, unit: "m", color: "#fbbf24", fmt: (v) => Math.round(v).toLocaleString() });
  const leftAxis = candidates[0];
  const rightAxis = candidates[1];
  const inlineMetrics = candidates.slice(2);

  const legBarY = padT + chartH + 4;
  const legBarH = 4;
  const legNumberY = padT + chartH + 18;

  const tripStart = legs[0]?.start_date_local ?? null;

  let svg = `<svg viewBox="0 0 ${W} ${H}" class="profile-svg" preserveAspectRatio="xMidYMid meet">`;

  // x-axis line
  svg += `<line x1="${padL}" y1="${padT + chartH}" x2="${padL + plotW}" y2="${padT + chartH}" stroke="#374151" stroke-width="1"/>`;

  // leg boundaries
  for (const cum of legBoundaries) {
    svg += `<line x1="${toX(cum)}" y1="${padT}" x2="${toX(cum)}" y2="${padT + chartH}" stroke="#4b5563" stroke-width="1" stroke-dasharray="3,3"/>`;
  }

  // elevation area + line
  if (altMeaningful) {
    const lastX = toX(sampled[sampled.length - 1]?.cum ?? 0).toFixed(1);
    svg += `<path class="metric metric-alt" d="${altPath} L${lastX},${padT + chartH} L${padL},${padT + chartH} Z" fill="#fbbf24" opacity="0.18"/>`;
    svg += `<path class="metric metric-alt" d="${altPath}" fill="none" stroke="#fbbf24" stroke-width="1.5" opacity="0.85" stroke-linejoin="round"/>`;
  }
  // speed
  if (hasSpeed) {
    svg += `<path class="metric metric-speed" d="${speedPath}" fill="none" stroke="#06b6d4" stroke-width="1.5" opacity="0.85" stroke-linejoin="round"/>`;
  }
  // Metrics that start hidden — user clicks the legend chip to toggle on.
  // HR is busy by default; viewers can opt in if they care about heart-rate.
  const DEFAULT_HIDDEN_METRICS = new Set<"alt" | "hr" | "speed">(["hr"]);
  const mc = (key: "alt" | "hr" | "speed") =>
    `metric metric-${key}${DEFAULT_HIDDEN_METRICS.has(key) ? " metric-hidden" : ""}`;

  // HR
  if (hasHr) {
    svg += `<path class="${mc("hr")}" d="${hrPath}" fill="none" stroke="#ef4444" stroke-width="1.75" opacity="0.9" stroke-linejoin="round"/>`;
  }

  // Y-axis labels (data-metric matches the path's class so toggling hides them together)
  if (leftAxis) {
    const k = leftAxis.key;
    svg += `<text class="${mc(k)}" x="${padL - 4}" y="${padT + 6}" text-anchor="end" font-size="9" fill="${leftAxis.color}">${leftAxis.fmt(leftAxis.max)}</text>`;
    svg += `<text class="${mc(k)}" x="${padL - 4}" y="${padT + chartH}" text-anchor="end" font-size="9" fill="${leftAxis.color}">${leftAxis.fmt(leftAxis.min)}</text>`;
    svg += `<text class="${mc(k)}" x="10" y="${padT + chartH / 2}" text-anchor="middle" font-size="9" fill="${leftAxis.color}" opacity="0.9" transform="rotate(-90 10 ${padT + chartH / 2})" style="letter-spacing:0.5px">${leftAxis.name} (${leftAxis.unit})</text>`;
  }
  if (rightAxis) {
    const k = rightAxis.key;
    svg += `<text class="${mc(k)}" x="${W - padR + 4}" y="${padT + 6}" text-anchor="start" font-size="9" fill="${rightAxis.color}">${rightAxis.fmt(rightAxis.max)}</text>`;
    svg += `<text class="${mc(k)}" x="${W - padR + 4}" y="${padT + chartH}" text-anchor="start" font-size="9" fill="${rightAxis.color}">${rightAxis.fmt(rightAxis.min)}</text>`;
    svg += `<text class="${mc(k)}" x="${W - 10}" y="${padT + chartH / 2}" text-anchor="middle" font-size="9" fill="${rightAxis.color}" opacity="0.9" transform="rotate(-90 ${W - 10} ${padT + chartH / 2})" style="letter-spacing:0.5px">${rightAxis.name} (${rightAxis.unit})</text>`;
  }
  for (let i = 0; i < inlineMetrics.length; i++) {
    const m = inlineMetrics[i]!;
    const txt = m.name === "Elevation"
      ? `⛰ ${m.fmt(m.min)}–${m.fmt(m.max)}m`
      : `${m.fmt(m.min)}–${m.fmt(m.max)} ${m.unit}`;
    svg += `<text class="${mc(m.key)}" x="${padL + 4}" y="${padT + 9 + i * 10}" text-anchor="start" font-size="8" fill="${m.color}" opacity="0.75">${escapeHtml(txt)}</text>`;
  }

  // Per-leg color bar
  for (let i = 0; i < legSegments.length; i++) {
    const s = legSegments[i]!;
    const x0 = toX(s.xStart);
    const x1 = toX(s.xEnd);
    const w = Math.max(0, x1 - x0);
    svg += `<rect x="${x0}" y="${legBarY}" width="${w}" height="${legBarH}" fill="${s.color}" opacity="0.9"/>`;
    if (w > 22) {
      const label = multisport ? sportIcon(s.sportType) : `${i + 1}`;
      svg += `<text x="${x0 + w / 2}" y="${legNumberY}" text-anchor="middle" font-size="9" fill="${s.color}" font-weight="600">${escapeHtml(label)}</text>`;
    }
  }

  // X-axis ticks
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const km = ((frac * xMax) / 1000).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const x = padL + frac * plotW;
    svg += `<text x="${x}" y="${H - 4}" text-anchor="middle" font-size="8" fill="#4b5563">${km} km</text>`;
  }

  // Placeholder hover overlay — updated by client JS on mousemove
  svg += `<g id="hover" style="display:none">`;
  svg += `<line id="hov-cross" y1="${padT}" y2="${padT + chartH}" stroke="#9ca3af" stroke-width="1" stroke-dasharray="3,3"/>`;
  svg += `<circle id="hov-alt" r="3" fill="#fbbf24" style="display:none"/>`;
  svg += `<circle id="hov-hr" r="3" fill="#ef4444" style="display:none"/>`;
  svg += `<circle id="hov-speed" r="3" fill="#06b6d4" style="display:none"/>`;
  svg += `<rect id="hov-label-bg" rx="3" fill="#0a0a0a" opacity="0.85" style="display:none"/>`;
  svg += `<text id="hov-label" text-anchor="end" font-size="9" fill="#e5e7eb" style="display:none"></text>`;
  svg += `</g>`;
  svg += `</svg>`;
  void tripStart;

  // Compact sampled data for JS hover lookup. Numbers rounded for size.
  const samples = sampled.map((p) => [
    p.legIdx,
    Math.round(p.cum),
    p.alt != null ? Math.round(p.alt) : null,
    p.hr != null ? Math.round(p.hr) : null,
    p.speed != null ? Math.round(p.speed * 10) / 10 : null,
  ]);
  const legMeta = legs.map((l) => ({
    name: l.name,
    sportType: l.sport_type,
    dayNumber: dayNumber(l.start_date_local, legs[0]?.start_date_local ?? null),
  }));

  return {
    svg,
    present: { alt: altMeaningful, hr: hasHr, speed: hasSpeed },
    hoverData: {
      samples,
      legs: legMeta,
      geom: {
        W, H, padL, padR, padT, chartH, xMax,
        altMin, altRange, altMeaningful,
        hrMin, hrRange, hasHr,
        speedMin, speedRange, hasSpeed,
      },
      multisport,
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Index page: list of all currently-published trips

export interface IndexTrip {
  id: number;
  slug: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  leg_count: number;
  total_distance_m: number;
  total_moving_time_s: number;
  total_elevation_m: number;
  sport_types: string[];
  published_at: string;
}

export function renderIndexHtml(trips: IndexTrip[]): string {
  // Sort newest first by start_date (falling back to published_at)
  const sorted = [...trips].sort((a, b) => {
    const aKey = a.start_date || a.published_at;
    const bKey = b.start_date || b.published_at;
    return bKey.localeCompare(aKey);
  });

  const cards = sorted
    .map((t) => {
      const dateRange = formatDateRange(t.start_date, t.end_date);
      const days = countDays(t.start_date, t.end_date);
      const sportsHtml = t.sport_types
        .map(
          (s) =>
            `<span class="sport-chip" style="color:${sportColor(s)};border-color:${sportColor(s)}55">${sportIcon(s)} ${escapeHtml(overrideSportLabel(t.id, s))}</span>`
        )
        .join("");
      return `
        <a class="trip-card" href="./${escapeHtml(t.slug)}.html">
          <div class="trip-top">
            <h3 class="trip-name">${escapeHtml(t.name)}</h3>
            <div class="trip-meta">${escapeHtml(dateRange)}${days > 1 ? ` · ${days} days` : ""}</div>
          </div>
          <div class="trip-sports">${sportsHtml}</div>
          <div class="trip-stats">
            <span><span class="stat-icon">📏</span>${fmtDistance(t.total_distance_m)}</span>
            <span><span class="stat-icon">⏱️</span>${fmtTime(t.total_moving_time_s)}</span>
            <span><span class="stat-icon">⛰️</span>${Math.round(t.total_elevation_m).toLocaleString()} m</span>
            <span><span class="stat-icon">📍</span>${t.leg_count} ${t.leg_count === 1 ? "leg" : "legs"}</span>
          </div>
        </a>
      `;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Trips</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e0e0e0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
    }
    .accent-bar {
      height: 4px;
      background: linear-gradient(90deg, #6366f1, #22c55e, #f59e0b, #ef4444, #06b6d4);
    }
    .container {
      max-width: 880px;
      margin: 0 auto;
      padding: 48px 24px 80px;
    }
    h1 { font-size: 2rem; font-weight: 700; margin-bottom: 8px; color: #fff; }
    .subtitle { color: #888; font-size: 0.95rem; margin-bottom: 32px; }
    .empty { color: #666; font-size: 0.95rem; padding: 40px 0; text-align: center; }

    .trip-list { display: flex; flex-direction: column; gap: 14px; }
    .trip-card {
      background: #161616;
      border: 1px solid #2a2a2a;
      border-radius: 12px;
      padding: 18px 22px;
      text-decoration: none;
      color: inherit;
      transition: border-color .15s ease, background .15s ease, transform .15s ease;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .trip-card:hover {
      border-color: #6366f1;
      background: #1a1a1a;
      transform: translateY(-1px);
    }
    .trip-top { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; flex-wrap: wrap; }
    .trip-name { font-size: 1.15rem; font-weight: 600; color: #fff; }
    .trip-meta { font-size: 0.85rem; color: #888; white-space: nowrap; }

    .trip-sports { display: flex; flex-wrap: wrap; gap: 6px; }
    .sport-chip {
      font-size: 0.7rem;
      padding: 2px 8px;
      border: 1px solid;
      border-radius: 9999px;
      letter-spacing: 0.2px;
    }

    .trip-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 14px;
      color: #c5c5c5;
      font-size: 0.85rem;
    }
    .trip-stats span { display: inline-flex; align-items: center; gap: 5px; }
    .stat-icon { font-size: 0.95rem; }

    footer {
      margin-top: 40px;
      text-align: center;
      color: #4b5563;
      font-size: 0.7rem;
    }
  </style>
</head>
<body>
  <div class="accent-bar"></div>
  <div class="container">
    <h1>Trips</h1>
    <p class="subtitle">Adventures by GPS — multi-day rides, hikes, multi-sport days.</p>
    ${sorted.length === 0
      ? `<div class="empty">No trips published yet.</div>`
      : `<div class="trip-list">${cards}</div>`}
    <footer>Updated ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</footer>
  </div>
</body>
</html>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Main render

export function renderTripHtml(trip: TripData): string {
  const multisport = (() => {
    if (trip.members.length < 2) return false;
    const dates = new Set(trip.members.map((m) => m.start_date_local.substr(0, 10)));
    const sports = new Set(trip.members.map((m) => m.sport_type));
    return dates.size === 1 && sports.size > 1;
  })();

  const polylines = trip.members
    .filter((m) => m.map_summary_polyline)
    .map((m, i) => ({
      encoded: m.map_summary_polyline as string,
      color: multisport ? sportColor(m.sport_type) : legColor(i),
      name: m.name,
      idx: i,
    }));

  const travelLegs = trip.travelLegs ?? [];

  const routeAspect = computeRoutesAspectRatio(polylines.map((p) => p.encoded));
  const clampedAR = routeAspect ? Math.max(0.5, Math.min(3, routeAspect)) : 1.5;
  const useSideBySide = clampedAR < 1.5;

  const dateRange = formatDateRange(trip.start_date, trip.end_date);
  const days = countDays(trip.start_date, trip.end_date);

  // Average speed = total distance / total moving time. Only meaningful when
  // there's actual movement (otherwise division by zero or nonsense values).
  const avgSpeedKmh = trip.totals.moving_time_s > 0
    ? (trip.totals.distance_m / trip.totals.moving_time_s) * 3.6
    : null;
  const avgSpeedDisplay = avgSpeedKmh != null
    ? (avgSpeedKmh < 10 ? avgSpeedKmh.toFixed(1) : avgSpeedKmh.toFixed(0))
    : null;

  // Auto-hide HR when fewer than half the legs recorded it. Matches the same
  // check inside renderProfileSvg so the totals stat, chart line, axis, and
  // legend chip all disappear together — no "1 leg out of 4" HR confusion.
  const totalLegs = trip.legStreams.length;
  const legsWithHr = trip.legStreams.filter(
    (l) => l.heartrate && l.heartrate.some((v) => v != null)
  ).length;
  const sparseHr = totalLegs > 0 && legsWithHr / totalLegs < 0.5;
  const showAvgHr = !sparseHr && trip.totals.avg_hr != null;

  const totalsHtml = `
    <div class="totals${showAvgHr ? "" : " no-hr"}">
      <div class="stat"><span class="stat-icon">📏</span><div><div class="stat-label">Distance</div><div class="stat-value">${fmtDistance(trip.totals.distance_m)}</div></div></div>
      <div class="stat"><span class="stat-icon">⏱️</span><div><div class="stat-label">Moving Time</div><div class="stat-value">${fmtTime(trip.totals.moving_time_s)}</div></div></div>
      ${avgSpeedDisplay != null ? `<div class="stat"><span class="stat-icon">🚴</span><div><div class="stat-label">Avg Speed</div><div class="stat-value">${avgSpeedDisplay} km/h</div></div></div>` : ""}
      <div class="stat"><span class="stat-icon">⛰️</span><div><div class="stat-label">Elevation Gain</div><div class="stat-value">${Math.round(trip.totals.elevation_m).toLocaleString()} m</div></div></div>
      ${showAvgHr ? `<div class="stat"><span class="stat-icon">❤️</span><div><div class="stat-label">Avg HR</div><div class="stat-value">${trip.totals.avg_hr} bpm</div></div></div>` : ""}
    </div>
  `;

  const sportBreakdownHtml = Object.keys(trip.sport_breakdown).length > 1
    ? `<div class="sport-breakdown">${Object.entries(trip.sport_breakdown).map(([sport, count]) => `
        <span class="sport-chip" style="color:${sportColor(sport)};border-color:${sportColor(sport)}55">${sportIcon(sport)} ${escapeHtml(overrideSportLabel(trip.id, sport))} × ${count}</span>
      `).join("")}</div>`
    : "";

  const showMap = polylines.length > 0 || travelLegs.length > 0;

  const mapHtml = showMap
    ? `<div class="map-wrap${useSideBySide ? " portrait" : ""}" style="${useSideBySide ? `--ar:${clampedAR};` : `aspect-ratio:${clampedAR};max-height:500px`}"><div id="map"></div></div>`
    : "";

  // Build a combined list of legs (rides + travel) sorted into chronological
  // order. Rides sort by their actual start time; travel legs have only a
  // date, so we *infer* a time-of-day for each by checking which ride on the
  // same date it spatially follows. A travel leg whose start coords match a
  // ride's end coords gets inserted right after that ride.
  //
  // This handles the common case of "morning ride → train → afternoon ride"
  // (e.g. Jun 29 2017: Panice Sottana→Cuneo, train Cuneo→Vercelli,
  // Vercelli→Pezzana) — without it, both rides bunch at the front and the
  // train falls to the end.
  type CombinedLeg =
    | { kind: "ride"; date: string; member: TripMember; sortKey: string }
    | { kind: "travel"; date: string; leg: TravelLeg; sortKey: string };

  function approxDistKm(a: [number, number], b: [number, number]): number {
    const dLat = (b[0] - a[0]) * 111;
    const dLon = (b[1] - a[1]) * 111 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }
  const SPATIAL_MATCH_KM = 20;

  // Pre-decode polylines once so the travel-leg insertion search is cheap.
  const rideEndpoints = new Map<number, { start: [number, number] | null; end: [number, number] | null }>();
  for (const m of trip.members) {
    if (!m.map_summary_polyline) {
      rideEndpoints.set(m.id, { start: null, end: null });
      continue;
    }
    const pts = decodePolyline(m.map_summary_polyline);
    rideEndpoints.set(m.id, {
      start: pts.length > 0 ? (pts[0] ?? null) : null,
      end: pts.length > 0 ? (pts[pts.length - 1] ?? null) : null,
    });
  }

  function travelLegSortKey(tl: TravelLeg): string {
    const date = tl.start_date.substr(0, 10);
    const sameDayRides = trip.members.filter((m) => m.start_date_local.substr(0, 10) === date);
    let bestAfter: { ride: TripMember; dist: number } | null = null;
    for (const m of sameDayRides) {
      const end = rideEndpoints.get(m.id)?.end;
      if (!end) continue;
      const d = approxDistKm(end, [tl.start_lat, tl.start_lng]);
      if (!bestAfter || d < bestAfter.dist) bestAfter = { ride: m, dist: d };
    }
    if (bestAfter && bestAfter.dist < SPATIAL_MATCH_KM) {
      const startMs = new Date(bestAfter.ride.start_date_local).getTime();
      const movingS = bestAfter.ride.moving_time || 0;
      return new Date(startMs + movingS * 1000 + 1000).toISOString();
    }
    let bestBefore: { ride: TripMember; dist: number } | null = null;
    for (const m of sameDayRides) {
      const start = rideEndpoints.get(m.id)?.start;
      if (!start) continue;
      const d = approxDistKm(start, [tl.end_lat, tl.end_lng]);
      if (!bestBefore || d < bestBefore.dist) bestBefore = { ride: m, dist: d };
    }
    if (bestBefore && bestBefore.dist < SPATIAL_MATCH_KM) {
      const startMs = new Date(bestBefore.ride.start_date_local).getTime();
      return new Date(startMs - 1000).toISOString();
    }
    return `${date}T12:00:00.000Z`;
  }

  const combinedLegs: CombinedLeg[] = [
    ...trip.members.map<CombinedLeg>((m) => ({
      kind: "ride",
      date: m.start_date_local.substr(0, 10),
      member: m,
      sortKey: m.start_date_local,
    })),
    ...travelLegs.map<CombinedLeg>((tl) => ({
      kind: "travel",
      date: tl.start_date.substr(0, 10),
      leg: tl,
      sortKey: travelLegSortKey(tl),
    })),
  ].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  // member.id → its index in `polylines` (which is the same as its data-leg
  // index for the click-highlight machinery). Rides without polylines get no
  // chip.
  const memberIdToPolyIdx = new Map<number, number>();
  {
    let _i = 0;
    for (const m of trip.members) {
      if (m.map_summary_polyline) memberIdToPolyIdx.set(m.id, _i++);
    }
  }

  // Walk combinedLegs to build chips in chronological order. data-leg still
  // points into polylineLayers (rides 0..R-1, travel legs R..R+T-1) so the
  // click handlers don't need to change — only the DOM order does.
  const legendChipsHtml = combinedLegs.map((row) => {
    if (row.kind === "ride") {
      const m = row.member;
      const polyIdx = memberIdToPolyIdx.get(m.id);
      if (polyIdx === undefined) return "";
      const p = polylines[polyIdx]!;
      const label = multisport
        ? `${sportIcon(m.sport_type)} ${escapeHtml(p.name)}`
        : `Day ${dayNumber(m.start_date_local, trip.start_date)}: ${escapeHtml(p.name)}`;
      return `<button type="button" class="leg-chip" data-leg="${polyIdx}" title="${escapeHtml(p.name)}"><span class="leg-swatch" style="background:${p.color}"></span>${label}</button>`;
    }
    const tl = row.leg;
    const travelPos = travelLegs.findIndex((x) => x.id === tl.id);
    const i = polylines.length + travelPos;
    const from = tl.start_label?.trim() || `${tl.start_lat.toFixed(2)},${tl.start_lng.toFixed(2)}`;
    const to = tl.end_label?.trim() || `${tl.end_lat.toFixed(2)},${tl.end_lng.toFixed(2)}`;
    const title = `${travelIcon(tl.mode)} ${from} → ${to} (${tl.mode})`;
    return `<button type="button" class="leg-chip leg-chip-travel" data-leg="${i}" title="${escapeHtml(title)}"><span class="leg-swatch leg-swatch-travel"></span>${travelIcon(tl.mode)} ${escapeHtml(from)} → ${escapeHtml(to)}</button>`;
  }).join("");
  const legendHtml = legendChipsHtml ? `<div class="legend">${legendChipsHtml}</div>` : "";

  const legsTableHtml = `
    <div class="legs">
      <div class="legs-header">Legs</div>
      <!-- Click any sortable column header to sort. data-sort-key controls the sort, default 'order' is chronological by date. -->
      <div class="legs-cols">
        <button type="button" class="col-day sortable" data-sort-key="order" data-sort-default="asc">Day</button>
        <button type="button" class="col-name sortable" data-sort-key="name" data-sort-default="asc">Activity</button>
        <button type="button" class="col-num-right sortable" data-sort-key="distance" data-sort-default="desc">Distance</button>
        <button type="button" class="col-num-right sortable" data-sort-key="time" data-sort-default="desc">Moving Time</button>
        <button type="button" class="col-num-right sortable" data-sort-key="elev" data-sort-default="desc">Elev Gain</button>
      </div>
      ${combinedLegs.map((row, i) => {
        if (row.kind === "ride") {
          const m = row.member;
          const day = dayNumber(m.start_date_local, trip.start_date);
          const distVal = m.distance ?? 0;
          const timeVal = m.moving_time ?? 0;
          const elevVal = m.total_elevation_gain ?? 0;
          return `
        <a class="leg-row" href="https://www.strava.com/activities/${m.id}" target="_blank" rel="noopener noreferrer"
           data-order="${i}" data-name="${escapeHtml(m.name.toLowerCase())}" data-distance="${distVal}" data-time="${timeVal}" data-elev="${elevVal}">
          <span class="col-day">Day ${day}</span>
          <span class="col-name">
            <span class="leg-name">${escapeHtml(m.name)}</span>
            <span class="leg-date">${escapeHtml(fmtDate(m.start_date_local))}</span>
          </span>
          <span class="col-num-right">${m.distance ? fmtDistance(m.distance) : "—"}</span>
          <span class="col-num-right">${m.moving_time ? fmtTime(m.moving_time) : "—"}</span>
          <span class="col-num-right">${m.total_elevation_gain ? `${Math.round(m.total_elevation_gain).toLocaleString()} m` : "—"}</span>
        </a>`;
        }
        const tl = row.leg;
        const day = dayNumber(tl.start_date, trip.start_date);
        const from = tl.start_label?.trim() || `${tl.start_lat.toFixed(2)},${tl.start_lng.toFixed(2)}`;
        const to = tl.end_label?.trim() || `${tl.end_lat.toFixed(2)},${tl.end_lng.toFixed(2)}`;
        const nameStr = `${tl.mode} ${from} to ${to}`.toLowerCase();
        return `
        <div class="leg-row leg-row-travel"
             data-order="${i}" data-name="${escapeHtml(nameStr)}" data-distance="0" data-time="0" data-elev="0">
          <span class="col-day">Day ${day}</span>
          <span class="col-name">
            <span class="leg-name">${travelIcon(tl.mode)} ${escapeHtml(from)} → ${escapeHtml(to)}</span>
            <span class="leg-date">${escapeHtml(fmtDate(tl.start_date))} · ${escapeHtml(tl.mode)}</span>
          </span>
          <span class="col-num-right">—</span>
          <span class="col-num-right">—</span>
          <span class="col-num-right">—</span>
        </div>`;
      }).join("")}
    </div>
  `;

  const profile = trip.legStreams.length > 0 ? renderProfileSvg(trip, multisport) : null;
  // Metrics that start hidden (matches DEFAULT_HIDDEN_METRICS inside renderProfileSvg).
  // The chip starts in the dimmed state with chart-key-hidden so its visual matches the hidden line.
  const DEFAULT_HIDDEN_CHIPS = new Set(["hr"]);
  const chartHtml = profile
    ? `<div class="profile">${profile.svg}<div class="profile-legend">${(
        [
          ["speed", "#06b6d4", "Speed", profile.present.speed],
          ["hr", "#ef4444", "Heart Rate", profile.present.hr],
          ["alt", "#fbbf24", "Elevation", profile.present.alt],
        ] as [string, string, string, boolean][]
      )
        .filter(([, , , present]) => present)
        .map(([key, color, name]) => `<button type="button" class="chart-key${DEFAULT_HIDDEN_CHIPS.has(key) ? " chart-key-hidden" : ""}" data-toggle-metric="${key}"><span class="chart-swatch" style="background:${color}"></span>${name}</button>`)
        .join("")}</div></div>`
    : "";

  const descriptionHtml = trip.description?.trim()
    ? `<div class="description"><div class="description-label">Description</div><div class="description-body">${escapeHtml(trip.description)}</div></div>`
    : "";

  // Page composition: map+legs side-by-side or stacked based on route shape
  const mapAndLegsHtml = useSideBySide
    ? `<div class="layout-grid"><div class="layout-left">${mapHtml}${legendHtml}</div><div class="layout-right">${legsTableHtml}</div></div>`
    : `${mapHtml}${legendHtml}${legsTableHtml}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(trip.name)}</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif;
      background: #0a0a0a;
      color: #e5e7eb;
      line-height: 1.45;
    }
    .container { max-width: 1100px; margin: 0 auto; padding: 24px 16px 80px; }
    .trip-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
    .trip-header h1 { margin: 0 0 4px; font-size: 22px; color: #f3f4f6; font-weight: 600; }
    .trip-header .meta { color: #9ca3af; font-size: 13px; }

    .photos-link {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 6px 12px;
      background: rgba(31,41,55,.6); border: 1px solid #374151;
      border-radius: 8px;
      color: #d1d5db; text-decoration: none;
      font-size: 13px;
      flex-shrink: 0;
      transition: border-color .15s ease, background .15s ease;
    }
    .photos-link:hover { background: rgba(31,41,55,.9); border-color: #6366f1; }

    .totals { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; margin: 16px 0 12px; }
    /* Avg HR present → 5 cells. Avg HR missing → 4 cells. */
    @media (min-width: 640px) { .totals { grid-template-columns: repeat(5, 1fr); } .totals.no-hr { grid-template-columns: repeat(4, 1fr); } }
    .stat { display: flex; align-items: center; gap: 8px; background: rgba(31,41,55,.6); border-radius: 8px; padding: 10px 12px; }
    .stat-icon { font-size: 14px; }
    .stat-label { font-size: 10px; color: #6b7280; }
    .stat-value { font-size: 13px; font-weight: 600; color: #e5e7eb; }

    .sport-breakdown { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
    .sport-chip { font-size: 12px; padding: 2px 10px; border: 1px solid; border-radius: 9999px; }

    .layout-grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
    @media (min-width: 768px) { .layout-grid { grid-template-columns: 1fr 1fr; } }
    .layout-left, .layout-right { min-width: 0; }

    .map-wrap { border-radius: 8px; border: 1px solid #374151; overflow: hidden; margin-bottom: 12px; width: 100%; min-height: 200px; max-height: 500px; }
    .map-wrap.portrait { aspect-ratio: var(--ar); max-width: calc(500px * var(--ar)); margin-left: auto; margin-right: auto; }
    .layout-left .map-wrap.portrait { max-width: 100%; margin: 0; }
    #map { width: 100%; height: 100%; }

    .legend { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 12px; font-size: 11px; color: #d1d5db; }
    .leg-chip {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 6px; border-radius: 4px;
      background: transparent; border: 1px solid transparent;
      color: inherit; font: inherit; cursor: pointer;
      transition: background .15s ease, border-color .15s ease, opacity .15s ease;
    }
    .leg-chip:hover { background: rgba(31,41,55,.4); }
    .leg-chip.leg-active { background: rgba(31,41,55,.7); border-color: #9ca3af; }
    .legend.has-active .leg-chip:not(.leg-active) { opacity: 0.4; }
    .leg-swatch { display: inline-block; width: 12px; height: 8px; border-radius: 2px; }
    /* Travel-leg swatch: dashed-line look to match the dashed polyline on the map. */
    .leg-swatch-travel {
      background: repeating-linear-gradient(90deg, #9ca3af 0 3px, transparent 3px 6px) !important;
      background-color: transparent;
      border-radius: 0;
    }
    .leg-chip-travel { color: #cbd5e1; }
    /* Leaflet tooltip styling tweak so it matches the dark map theme. */
    .leaflet-tooltip {
      background: rgba(17, 24, 39, 0.92);
      color: #e5e7eb;
      border: 1px solid #374151;
      font-size: 12px;
      padding: 4px 8px;
      box-shadow: 0 2px 6px rgba(0,0,0,.4);
    }
    .leaflet-tooltip-top:before { border-top-color: rgba(17,24,39,.92); }
    .leaflet-tooltip-bottom:before { border-bottom-color: rgba(17,24,39,.92); }
    .leaflet-tooltip-left:before { border-left-color: rgba(17,24,39,.92); }
    .leaflet-tooltip-right:before { border-right-color: rgba(17,24,39,.92); }

    .legs { border: 1px solid #374151; border-radius: 8px; overflow: hidden; margin-bottom: 16px; }
    .legs-header { padding: 8px 12px; background: rgba(31,41,55,.4); border-bottom: 1px solid #374151; font-size: 12px; color: #9ca3af; font-weight: 600; }
    .legs-cols { display: flex; gap: 8px; padding: 6px 12px; background: rgba(31,41,55,.2); border-bottom: 1px solid #374151; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; color: #6b7280; }
    .legs-cols .sortable {
      background: transparent; border: none; color: inherit; font: inherit;
      cursor: pointer; padding: 0; text-transform: inherit; letter-spacing: inherit;
      transition: color .15s ease;
    }
    .legs-cols .sortable:hover { color: #d1d5db; }
    .legs-cols .sortable.sort-active { color: #e5e7eb; }
    .legs-cols .sortable.sort-active::after { content: " ↓"; }
    .legs-cols .sortable.sort-active.sort-asc::after { content: " ↑"; }
    .leg-row { display: flex; gap: 8px; padding: 8px 12px; align-items: center; font-size: 12px; color: inherit; text-decoration: none; border-bottom: 1px solid #1f2937; transition: background .15s ease; }
    .leg-row:last-child { border-bottom: none; }
    .leg-row:hover { background: rgba(31,41,55,.4); }
    .leg-row-travel { color: #9ca3af; background: rgba(31,41,55,.15); cursor: default; }
    .leg-row-travel:hover { background: rgba(31,41,55,.25); }
    .leg-row-travel .leg-name { color: #d1d5db; }
    .travel-marker {
      display: flex; align-items: center; justify-content: center;
      width: 24px; height: 24px;
      background: rgba(17,24,39,.92); border: 1px solid #9ca3af; border-radius: 50%;
      font-size: 13px; line-height: 1;
      box-shadow: 0 2px 4px rgba(0,0,0,.4);
    }
    .col-day { width: 48px; color: #9ca3af; flex-shrink: 0; text-align: left; }
    .col-name { flex: 1; min-width: 0; text-align: left; }
    .leg-name { display: block; color: #e5e7eb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .leg-date { color: #6b7280; font-size: 11px; }
    .col-num-right { width: 80px; text-align: right; color: #d1d5db; flex-shrink: 0; }
    /* On phones, tighten the right-aligned columns + day column so all 6
       columns fit. Activity name will truncate cleanly. */
    @media (max-width: 639px) {
      .legs-cols, .leg-row { gap: 4px; padding-left: 8px; padding-right: 8px; font-size: 11px; }
      .col-day { width: 36px; }
      .col-num-right { width: 56px; }
    }

    .profile { background: rgba(17,24,39,.6); border: 1px solid #374151; border-radius: 8px; padding: 12px; margin-bottom: 16px; }
    .profile-svg { width: 100%; height: auto; display: block; cursor: crosshair; }
    .profile-legend { display: flex; gap: 12px; margin-top: 6px; font-size: 11px; color: #9ca3af; flex-wrap: wrap; }
    .chart-key {
      display: inline-flex; align-items: center; gap: 4px;
      background: transparent; border: none; color: inherit; font: inherit;
      cursor: pointer; padding: 0; transition: opacity .15s ease;
    }
    .chart-key.chart-key-hidden { opacity: 0.35; }
    .chart-swatch { display: inline-block; width: 14px; height: 8px; border-radius: 2px; }
    .metric.metric-hidden { display: none; }

    .description { background: rgba(17,24,39,.4); border: 1px solid #374151; border-radius: 8px; padding: 12px; }
    .description-label { font-size: 10px; text-transform: uppercase; color: #6b7280; margin-bottom: 4px; }
    .description-body { font-size: 13px; color: #d1d5db; white-space: pre-wrap; }

    footer { margin-top: 32px; text-align: center; color: #4b5563; font-size: 10px; }
    footer a { color: #6b7280; text-decoration: none; }
    footer a:hover { color: #9ca3af; }
  </style>
</head>
<body>
  <div class="container">
    <header class="trip-header">
      <div class="trip-header-text">
        <h1>${escapeHtml(trip.name)}</h1>
        <div class="meta">${escapeHtml(dateRange)}${days > 1 ? ` · ${days} days` : ""}</div>
      </div>
      ${trip.photos_url
        ? `<a class="photos-link" href="${escapeHtml(trip.photos_url)}" target="_blank" rel="noreferrer">📷 Photo album</a>`
        : ""}
    </header>
    ${totalsHtml}
    ${sportBreakdownHtml}
    ${mapAndLegsHtml}
    ${chartHtml}
    ${descriptionHtml}
    <footer>Powered by Strava · Published ${(trip.published_at ? new Date(trip.published_at) : new Date()).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</footer>
  </div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    const POLYLINES = ${JSON.stringify(polylines)};
    const TRAVEL_LEGS = ${JSON.stringify(travelLegs.map((t) => ({
      mode: t.mode,
      start: [t.start_lat, t.start_lng],
      end: [t.end_lat, t.end_lng],
      icon: travelIcon(t.mode),
      label: `${t.start_label || ""} → ${t.end_label || ""}`.trim(),
    })))};
    const HOVER = ${profile ? JSON.stringify(profile.hoverData) : "null"};
    function decodePolyline(encoded) {
      const points = []; let idx = 0, lat = 0, lng = 0;
      while (idx < encoded.length) {
        let b, shift = 0, result = 0;
        do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lat += result & 1 ? ~(result >> 1) : result >> 1;
        shift = 0; result = 0;
        do { b = encoded.charCodeAt(idx++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        lng += result & 1 ? ~(result >> 1) : result >> 1;
        points.push([lat / 1e5, lng / 1e5]);
      }
      return points;
    }
    // Each entry: { line, baseStyle, activeStyle, dimStyle }. A flat array so
    // legend chips (rides + travel legs) share a single data-leg index space.
    const polylineLayers = [];
    if ((POLYLINES.length > 0 || TRAVEL_LEGS.length > 0) && document.getElementById('map')) {
      const map = L.map('map', { zoomControl: true, scrollWheelZoom: false, attributionControl: false, zoomSnap: 0.1 });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
      let union = null;
      for (const p of POLYLINES) {
        const pts = decodePolyline(p.encoded);
        if (pts.length < 2) { polylineLayers.push(null); continue; }
        const baseStyle = { weight: 3.5, opacity: 0.85, color: p.color };
        const line = L.polyline(pts, baseStyle).addTo(map);
        line.bindTooltip(p.name, { sticky: true, direction: 'top', opacity: 0.95 });
        polylineLayers.push({
          line,
          baseStyle:   { weight: 3.5, opacity: 0.85 },
          activeStyle: { weight: 5.5, opacity: 1 },
          dimStyle:    { weight: 2,   opacity: 0.25 },
        });
        const b = line.getBounds();
        union = union ? union.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
      }
      // Travel legs: dashed grey line between endpoints + emoji marker at midpoint.
      for (const t of TRAVEL_LEGS) {
        const baseStyle = { color: '#9ca3af', weight: 2.5, opacity: 0.75, dashArray: '6,6' };
        const line = L.polyline([t.start, t.end], baseStyle).addTo(map);
        const tooltipText = (t.icon + ' ' + t.label).trim() || (t.icon + ' transit');
        line.bindTooltip(tooltipText, { sticky: true, direction: 'top', opacity: 0.95 });
        polylineLayers.push({
          line,
          baseStyle:   { weight: 2.5, opacity: 0.75, dashArray: '6,6' },
          activeStyle: { weight: 4,   opacity: 1,    dashArray: '8,6' },
          dimStyle:    { weight: 1.5, opacity: 0.2,  dashArray: '6,6' },
        });
        const mid = [(t.start[0] + t.end[0]) / 2, (t.start[1] + t.end[1]) / 2];
        L.marker(mid, {
          icon: L.divIcon({
            html: '<div class="travel-marker">' + t.icon + '</div>',
            className: '',
            iconSize: [24, 24],
            iconAnchor: [12, 12],
          }),
          interactive: false,
        }).addTo(map);
        const b = line.getBounds();
        union = union ? union.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
      }
      if (union) map.fitBounds(union, { padding: [4, 4] });
    }

    // ── Map leg highlight ──
    // Click a leg chip in the legend to highlight that polyline; click again
    // (or any other chip) to switch. Click the active one to clear.
    // Travel legs share this machinery — their entries carry their own dashed
    // style so highlight/dim preserves the dash pattern.
    let activeLeg = null;
    function applyHighlight() {
      polylineLayers.forEach(function (entry, i) {
        if (!entry) return;
        if (activeLeg === null) {
          entry.line.setStyle(entry.baseStyle);
        } else if (i === activeLeg) {
          entry.line.setStyle(entry.activeStyle);
          entry.line.bringToFront();
        } else {
          entry.line.setStyle(entry.dimStyle);
        }
      });
      var chips = document.querySelectorAll('.leg-chip');
      var legend = document.querySelector('.legend');
      chips.forEach(function (chip) {
        var idx = parseInt(chip.getAttribute('data-leg'), 10);
        chip.classList.toggle('leg-active', activeLeg === idx);
      });
      if (legend) legend.classList.toggle('has-active', activeLeg !== null);
    }
    document.querySelectorAll('.leg-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var idx = parseInt(chip.getAttribute('data-leg'), 10);
        activeLeg = (activeLeg === idx) ? null : idx;
        applyHighlight();
      });
    });

    // ── Chart metric toggle ──
    // Click a metric chip below the chart to hide/show that metric's line + axis.
    document.querySelectorAll('.chart-key').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var metric = btn.getAttribute('data-toggle-metric');
        var hidden = btn.classList.toggle('chart-key-hidden');
        document.querySelectorAll('.metric.metric-' + metric).forEach(function (el) {
          el.classList.toggle('metric-hidden', hidden);
        });
      });
    });

    // ── Sortable legs table ──
    // Click a header to sort by that column. Click again to flip direction.
    // 'order' is the original chronological leg order; other keys are numeric
    // (distance, time, elev) or string (name).
    (function setupSort() {
      var legsContainer = document.querySelector('.legs');
      if (!legsContainer) return;
      var headers = legsContainer.querySelectorAll('.sortable');
      var state = { key: 'order', asc: true };
      function applySort() {
        var rows = Array.from(legsContainer.querySelectorAll('.leg-row'));
        rows.sort(function (a, b) {
          var av = a.getAttribute('data-' + state.key);
          var bv = b.getAttribute('data-' + state.key);
          var an = parseFloat(av), bn = parseFloat(bv);
          var cmp;
          if (!isNaN(an) && !isNaN(bn)) cmp = an - bn;
          else cmp = String(av).localeCompare(String(bv));
          return state.asc ? cmp : -cmp;
        });
        rows.forEach(function (r) { legsContainer.appendChild(r); });
        headers.forEach(function (h) {
          var isActive = h.getAttribute('data-sort-key') === state.key;
          h.classList.toggle('sort-active', isActive);
          h.classList.toggle('sort-asc', isActive && state.asc);
        });
      }
      headers.forEach(function (h) {
        h.addEventListener('click', function () {
          var key = h.getAttribute('data-sort-key');
          if (state.key === key) {
            state.asc = !state.asc;
          } else {
            state.key = key;
            state.asc = h.getAttribute('data-sort-default') === 'asc';
          }
          applySort();
        });
      });
    })();

    // ── Dashboard iframe self-sizing ──
    // When this page is embedded as an iframe (by the NanoClaw dashboard's
    // trip detail view), post our scrollHeight to the parent so the iframe
    // can resize to fit the content — no internal scrollbar. Harmless no-op
    // when viewed directly (no parent listener).
    if (window.parent !== window) {
      function reportHeight() {
        try {
          window.parent.postMessage(
            { type: 'trip-page-height', height: document.body.scrollHeight },
            '*'
          );
        } catch (e) { /* cross-origin: ignore */ }
      }
      window.addEventListener('load', reportHeight);
      window.addEventListener('resize', reportHeight);
      // Also fire after content shifts (e.g. metric toggle changes axes)
      new ResizeObserver(reportHeight).observe(document.body);
    }

    // ── Chart hover crosshair + tooltip ──
    // Mouse moves over the profile SVG → vertical line + colored dot at each
    // visible metric's value + tooltip showing leg name and exact readings.
    (function setupHover() {
      if (!HOVER || HOVER.samples.length < 2) return;
      var svg = document.querySelector('.profile-svg');
      if (!svg) return;
      var G = HOVER.geom;
      var SAMPLES = HOVER.samples;
      var LEGS = HOVER.legs;
      var MULTISPORT = HOVER.multisport;
      var SPORT_ICONS = ${JSON.stringify(SPORT_ICONS)};

      var hoverGroup = document.getElementById('hover');
      var cross = document.getElementById('hov-cross');
      var dotAlt = document.getElementById('hov-alt');
      var dotHr = document.getElementById('hov-hr');
      var dotSpeed = document.getElementById('hov-speed');
      var label = document.getElementById('hov-label');
      var labelBg = document.getElementById('hov-label-bg');

      var plotW = G.W - G.padL - G.padR;
      function toX(cum) { return G.padL + (cum / G.xMax) * plotW; }
      function toAltY(v) { return G.padT + G.chartH - ((v - G.altMin) / G.altRange) * G.chartH; }
      function toHrY(v) { return G.padT + G.chartH - ((v - G.hrMin) / G.hrRange) * G.chartH; }
      function toSpeedY(v) {
        var y = G.padT + G.chartH - ((v - G.speedMin) / G.speedRange) * G.chartH;
        return Math.max(G.padT, Math.min(G.padT + G.chartH, y));
      }

      function isHidden(key) {
        var btn = document.querySelector('.chart-key[data-toggle-metric="' + key + '"]');
        return btn && btn.classList.contains('chart-key-hidden');
      }

      function onMove(e) {
        var rect = svg.getBoundingClientRect();
        var svgX = (e.clientX - rect.left) / rect.width * G.W;
        var chartX = svgX - G.padL;
        var frac = Math.max(0, Math.min(1, chartX / plotW));
        var targetCum = frac * G.xMax;

        // Closest sample (linear scan — fast enough for ~800 samples)
        var closest = 0;
        var minDiff = Infinity;
        for (var i = 0; i < SAMPLES.length; i++) {
          var diff = Math.abs(SAMPLES[i][1] - targetCum);
          if (diff < minDiff) { minDiff = diff; closest = i; }
        }
        var s = SAMPLES[closest];
        var legIdx = s[0], cum = s[1], alt = s[2], hr = s[3], speed = s[4];
        var x = toX(cum);

        hoverGroup.style.display = '';
        cross.setAttribute('x1', x);
        cross.setAttribute('x2', x);

        var showAlt = alt != null && G.altMeaningful && !isHidden('alt');
        var showHr = hr != null && G.hasHr && !isHidden('hr');
        var showSpeed = speed != null && G.hasSpeed && !isHidden('speed');

        if (showAlt) {
          dotAlt.setAttribute('cx', x);
          dotAlt.setAttribute('cy', toAltY(alt));
          dotAlt.style.display = '';
        } else dotAlt.style.display = 'none';
        if (showHr) {
          dotHr.setAttribute('cx', x);
          dotHr.setAttribute('cy', toHrY(hr));
          dotHr.style.display = '';
        } else dotHr.style.display = 'none';
        if (showSpeed) {
          dotSpeed.setAttribute('cx', x);
          dotSpeed.setAttribute('cy', toSpeedY(speed));
          dotSpeed.style.display = '';
        } else dotSpeed.style.display = 'none';

        // Tooltip text
        var leg = LEGS[legIdx] || { name: '?', sportType: '', dayNumber: 1 };
        var parts = [];
        parts.push(MULTISPORT
          ? (SPORT_ICONS[leg.sportType] || '🏃') + ' ' + leg.name
          : 'Day ' + leg.dayNumber + ': ' + leg.name);
        parts.push((cum / 1000).toFixed(2) + ' km');
        if (showHr) parts.push('❤️ ' + Math.round(hr) + ' bpm');
        if (showAlt) parts.push('⬆️ ' + Math.round(alt).toLocaleString() + 'm');
        if (showSpeed) parts.push('🚴 ' + speed.toFixed(1) + ' km/h');
        label.textContent = parts.join(' · ');
        label.setAttribute('x', G.W - G.padR - 4);
        label.setAttribute('y', G.padT + 9);
        label.style.display = '';

        // Background box behind the text for legibility
        var bbox = label.getBBox();
        labelBg.setAttribute('x', bbox.x - 4);
        labelBg.setAttribute('y', bbox.y - 2);
        labelBg.setAttribute('width', bbox.width + 8);
        labelBg.setAttribute('height', bbox.height + 4);
        labelBg.style.display = '';
        // Make sure label paints over the bg
        label.parentNode.appendChild(label);
      }

      function onLeave() { hoverGroup.style.display = 'none'; }

      svg.addEventListener('mousemove', onMove);
      svg.addEventListener('mouseleave', onLeave);
    })();
  </script>
</body>
</html>`;
}
