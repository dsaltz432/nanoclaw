import { useEffect, useState, useCallback, useRef } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

// ── Types ────────────────────────────────────────────────────────────────────

interface Athlete {
  athlete_id: number;
  name: string;
  username: string | null;
  profile_pic: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  sex: string | null;
  last_sync: string | null;
  activities_synced: number;
  total_activities: number;
  total_distance_m: number;
  total_moving_time_s: number;
  total_elevation_m: number;
  show_streak: boolean;
}

interface Activity {
  id: number;
  athlete_id: number;
  name: string;
  sport_type: string;
  start_date_local: string;
  distance: number;
  moving_time: number;
  total_elevation_gain: number;
  average_speed: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  average_watts: number | null;
  kudos_count: number;
  suffer_score: number | null;
  trainer: number;
  commute: number;
}

interface TrendPoint {
  period: string;
  sport_type: string;
  total_km: number;
  total_seconds: number;
  count: number;
  total_elevation_m: number;
  avg_hr: number | null;
}

interface StatByType {
  sport_type: string;
  count: number;
  total_km: number;
  total_seconds: number;
  total_elevation_m: number;
  avg_hr: number | null;
  max_distance_m: number;
  last_activity: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function sportColor(type: string) {
  return SPORT_COLORS[type] ?? "#6b7280";
}

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

function sportIcon(type: string) {
  return SPORT_ICONS[type] ?? "🏃";
}

const LEG_COLORS = [
  "#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#06b6d4",
  "#a855f7", "#ec4899", "#14b8a6", "#f97316", "#3b82f6",
];

function legColor(i: number): string {
  return LEG_COLORS[i % LEG_COLORS.length] ?? "#6366f1";
}

// Per-trip sport-text overrides. Only changes the displayed label (icon and
// color still derive from the underlying Strava `sport_type`). Mirrors the
// same map in server/lib/render-trip-html.ts — keep in sync if you add trips.
const TRIP_SPORT_LABEL_OVERRIDES: Record<number, Record<string, string>> = {
  6: { Run: "Hike" }, // Climbing Kilimanjaro
};
function overrideSportLabel(tripId: number, sport: string): string {
  return TRIP_SPORT_LABEL_OVERRIDES[tripId]?.[sport] ?? sport;
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

// Day number of a leg within its trip (1-indexed, calendar-based — multiple
// legs on the same calendar date all return the same number).
function dayNumber(legDate: string, anchor: string | null | undefined): number {
  if (!anchor) return 1;
  const leg = new Date(legDate.substr(0, 10) + "T00:00:00").getTime();
  const start = new Date(anchor.substr(0, 10) + "T00:00:00").getTime();
  return Math.max(1, Math.round((leg - start) / 86400000) + 1);
}

function countDays(start: string | null, end: string | null): number {
  if (!start || !end) return 1;
  const s = new Date(start + "T00:00:00").getTime();
  const e = new Date(end + "T00:00:00").getTime();
  return Math.max(1, Math.round((e - s) / 86400000) + 1);
}

function fmtDistance(meters: number) {
  return (meters / 1000).toFixed(1) + " km";
}

function fmtTime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function fmtPace(meters: number, seconds: number) {
  if (!meters) return "—";
  const secPerKm = seconds / (meters / 1000);
  const mins = Math.floor(secPerKm / 60);
  const secs = Math.round(secPerKm % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}/km`;
}

function fmtSpeed(mps: number) {
  return (mps * 3.6).toFixed(1) + " km/h";
}

function fmtDate(iso: string) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function relativeSync(iso: string | null) {
  if (!iso) return "Never synced";
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 1) return "Synced just now";
  if (h < 24) return `Synced ${h}h ago`;
  return `Synced ${Math.floor(h / 24)}d ago`;
}

function isRun(type: string) {
  return type === "Run" || type === "TrailRun";
}

// ── Empty State ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center px-4">
      <div className="text-5xl mb-4">🚴</div>
      <h2 className="text-lg font-semibold text-gray-200 mb-2">No Strava accounts connected</h2>
      <p className="text-sm text-gray-500 max-w-md mb-6">
        To get started, create a Strava API application and run the OAuth setup script.
      </p>
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 text-left max-w-lg w-full">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Setup steps</p>
        <ol className="space-y-2 text-sm text-gray-400">
          <li>
            <span className="text-gray-200 font-medium">1.</span> Go to{" "}
            <span className="font-mono text-indigo-400">strava.com/settings/api</span>{" "}
            and create an app (set callback domain to <span className="font-mono text-indigo-400">localhost</span>)
          </li>
          <li>
            <span className="text-gray-200 font-medium">2.</span> Copy your{" "}
            <span className="font-mono text-indigo-400">Client ID</span> and{" "}
            <span className="font-mono text-indigo-400">Client Secret</span>
          </li>
          <li>
            <span className="text-gray-200 font-medium">3.</span> Run{" "}
            <span className="font-mono text-indigo-400 bg-gray-800 px-1.5 py-0.5 rounded text-xs">
              npx tsx scripts/strava-auth.ts
            </span>{" "}
            from the NanoClaw root
          </li>
          <li>
            <span className="text-gray-200 font-medium">4.</span> Repeat for each Strava account (yours + wife's)
          </li>
        </ol>
      </div>
    </div>
  );
}

// ── Polyline decoder ─────────────────────────────────────────────────────────

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

function PolylineMap({ encoded }: { encoded: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const points = decodePolyline(encoded);
    if (points.length < 2) return;

    const map = L.map(containerRef.current, {
      zoomControl: true,
      scrollWheelZoom: false,
      attributionControl: false,
    });
    mapRef.current = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
    }).addTo(map);

    const polyline = L.polyline(points, {
      color: "#6366f1",
      weight: 3.5,
      opacity: 0.9,
    }).addTo(map);

    // Start marker (green) and end marker (red)
    const startIcon = L.divIcon({
      html: `<div style="width:10px;height:10px;background:#22c55e;border-radius:50%;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.5)"></div>`,
      iconSize: [10, 10],
      iconAnchor: [5, 5],
      className: "",
    });
    const endIcon = L.divIcon({
      html: `<div style="width:10px;height:10px;background:#ef4444;border-radius:50%;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,.5)"></div>`,
      iconSize: [10, 10],
      iconAnchor: [5, 5],
      className: "",
    });
    L.marker(points[0], { icon: startIcon }).addTo(map);
    L.marker(points[points.length - 1], { icon: endIcon }).addTo(map);

    map.fitBounds(polyline.getBounds(), { padding: [20, 20] });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [encoded]);

  return (
    <div
      ref={containerRef}
      className="w-full rounded-lg overflow-hidden border border-gray-700"
      style={{ height: 220 }}
    />
  );
}

function MultiLegMap({
  polylines,
  height,
}: {
  polylines: { encoded: string; color: string; label?: string }[];
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    if (!polylines.length) return;

    const map = L.map(containerRef.current, {
      zoomControl: true,
      scrollWheelZoom: false,
      attributionControl: false,
      // Fractional zoom so fitBounds can land between integer levels and pack
      // the routes tighter against the visible area.
      zoomSnap: 0.1,
    });
    mapRef.current = map;

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
    }).addTo(map);

    let union: L.LatLngBounds | null = null;
    polylines.forEach(({ encoded, color }) => {
      const pts = decodePolyline(encoded);
      if (pts.length < 2) return;
      const line = L.polyline(pts, { color, weight: 3.5, opacity: 0.85 }).addTo(map);
      const b = line.getBounds();
      union = union ? union.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
    });
    if (union) {
      map.fitBounds(union, { padding: [4, 4] });
    }

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [polylines]);

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden"
      style={{ height: height ?? 220 }}
    />
  );
}

// ── Activity Streams Chart ────────────────────────────────────────────────────

interface Streams {
  time: number[] | null;
  distance: number[] | null;
  heartrate: number[] | null;
  altitude: number[] | null;
  velocity_smooth: number[] | null;
}

function StreamsChart({ activityId, sportType }: { activityId: number; sportType: string }) {
  const [streams, setStreams] = useState<Streams | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hovIdx, setHovIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    fetch(`/api/strava/activity/${activityId}/streams`)
      .then((r) => r.json())
      .then((d: Streams & { error?: string }) => {
        if (d.error) { setError(d.error); } else { setStreams(d); }
      })
      .catch(() => setError("Failed to load"))
      .finally(() => setLoading(false));
  }, [activityId]);

  if (loading || error || !streams) return null;

  const xArr = streams.distance ?? streams.time ?? [];
  if (xArr.length < 2) return null;

  const running = isRun(sportType);
  const W = 500, H = 120, padL = 36, padR = 36, padT = 8, padB = 20;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  function normalize(arr: number[]) {
    const mn = Math.min(...arr), mx = Math.max(...arr);
    const span = mx - mn || 1;
    return { arr, mn, mx, span, norm: arr.map(v => (v - mn) / span) };
  }

  const xMax = xArr[xArr.length - 1] || 1;
  const toX = (i: number) => padL + (xArr[i] / xMax) * chartW;
  const toY = (norm: number) => padT + chartH - norm * chartH;

  function makePath(normArr: number[]) {
    return normArr.map((n, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(1)},${toY(n).toFixed(1)}`).join(" ");
  }

  // Only show elevation if there's meaningful gain/loss (>5m range)
  // Floor altitude at 0 — GPS noise can produce negative values for sea-level activities
  const altRaw = streams.altitude ? streams.altitude.map((v) => Math.max(0, v)) : null;
  const altRange = altRaw ? Math.max(...altRaw) - Math.min(...altRaw) : 0;
  const alt = altRaw && altRange > 5 ? normalize(altRaw) : null;
  const hr  = streams.heartrate ? normalize(streams.heartrate) : null;
  // Convert velocity (m/s) to pace/speed — only if there's meaningful movement (max > 1 m/s)
  const velRaw = streams.velocity_smooth;
  const velMax = velRaw ? Math.max(...velRaw) : 0;
  const hasMeaningfulVelocity = velMax > 1;
  let pace: ReturnType<typeof normalize> | null = null;
  if (velRaw && running && hasMeaningfulVelocity) {
    const paceArr = velRaw.map(v => v > 0.5 ? 1000 / (v * 60) : 20);
    const p = normalize(paceArr);
    // Invert: lower pace (faster) should appear higher
    pace = { ...p, norm: p.norm.map(n => 1 - n) };
  }
  const speed = velRaw && !running && hasMeaningfulVelocity ? normalize(velRaw.map(v => v * 3.6)) : null;

  // Tooltip values at hover index
  const hov = hovIdx !== null ? hovIdx : null;
  const distKm = hov !== null && streams.distance ? (streams.distance[hov] / 1000).toFixed(2) : null;
  const hovHr  = hov !== null && streams.heartrate ? Math.round(streams.heartrate[hov]) : null;
  const hovAlt = hov !== null && altRaw ? Math.round(altRaw[hov] ?? 0) : null;
  const hovVel = hov !== null && velRaw            ? velRaw[hov]                         : null;
  const hovPaceStr = hovVel && hovVel > 0.5 && running
    ? `${Math.floor(1000/(hovVel*60))}:${String(Math.round((1000/(hovVel*60) % 1)*60)).padStart(2,"0")}/km`
    : null;
  const hovSpeedStr = hovVel && !running ? `${(hovVel*3.6).toFixed(1)} km/h` : null;

  function onMouseMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    const chartX = svgX - padL;
    const frac = Math.max(0, Math.min(1, chartX / chartW));
    const targetX = frac * xMax;
    let closest = 0;
    let minDiff = Infinity;
    for (let i = 0; i < xArr.length; i++) {
      const diff = Math.abs(xArr[i] - targetX);
      if (diff < minDiff) { minDiff = diff; closest = i; }
    }
    setHovIdx(closest);
  }

  const metrics = [
    alt   && { label: "Elevation", color: "#6b7280", fill: true,  norm: alt.norm,  mn: alt.mn,  mx: alt.mx,  unit: "m" },
    hr    && { label: "Heart Rate", color: "#ef4444", fill: false, norm: hr.norm,   mn: hr.mn,   mx: hr.mx,   unit: "bpm" },
    pace  && { label: "Pace",       color: "#6366f1", fill: false, norm: pace.norm, mn: null,    mx: null,    unit: "" },
    speed && { label: "Speed",      color: "#6366f1", fill: false, norm: speed.norm,mn: speed.mn,mx: speed.mx,unit: "km/h" },
  ].filter(Boolean) as { label: string; color: string; fill: boolean; norm: number[]; mn: number|null; mx: number|null; unit: string }[];

  if (metrics.length === 0) return null;

  return (
    <div className="mb-4">
      {/* Legend + hover values */}
      <div className="flex flex-wrap gap-3 mb-1.5 text-xs">
        {metrics.map((m) => (
          <div key={m.label} className="flex items-center gap-1">
            <span className="inline-block h-2 w-4 rounded-sm" style={{ backgroundColor: m.color, opacity: m.fill ? 0.5 : 1 }} />
            <span className="text-gray-400">{m.label}</span>
          </div>
        ))}
        {hov !== null && (
          <span className="ml-auto text-gray-500">
            {distKm && `${distKm} km`}
            {hovHr && ` · ❤️ ${hovHr} bpm`}
            {hovAlt && ` · ⬆️ ${hovAlt}m`}
            {hovPaceStr && ` · 🏃 ${hovPaceStr}`}
            {hovSpeedStr && ` · 🚴 ${hovSpeedStr}`}
          </span>
        )}
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded-lg bg-gray-900/80 border border-gray-800 cursor-crosshair"
        style={{ height: 130 }}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHovIdx(null)}
      >
        {/* X axis */}
        <line x1={padL} y1={padT+chartH} x2={padL+chartW} y2={padT+chartH} stroke="#374151" strokeWidth={1} />

        {/* Metrics */}
        {metrics.map((m) => (
          <g key={m.label}>
            {m.fill && (
              <path
                d={`${makePath(m.norm)} L${toX(m.norm.length-1).toFixed(1)},${padT+chartH} L${padL},${padT+chartH} Z`}
                fill={m.color} opacity={0.2}
              />
            )}
            <path d={makePath(m.norm)} fill="none" stroke={m.color} strokeWidth={m.fill ? 1 : 1.75} opacity={m.fill ? 0.6 : 0.9} strokeLinejoin="round" />
          </g>
        ))}

        {/* Hover crosshair */}
        {hov !== null && (
          <>
            <line x1={toX(hov)} y1={padT} x2={toX(hov)} y2={padT+chartH} stroke="#6b7280" strokeWidth={1} strokeDasharray="3,3" />
            {metrics.map((m) => (
              <circle key={m.label} cx={toX(hov)} cy={toY(m.norm[hov])} r={3} fill={m.color} />
            ))}
          </>
        )}

        {/* Y-axis labels (elevation if present) */}
        {alt && (
          <>
            <text x={padL-4} y={padT+6} textAnchor="end" fontSize={7} fill="#6b7280">{Math.round(alt.mx)}m</text>
            <text x={padL-4} y={padT+chartH} textAnchor="end" fontSize={7} fill="#6b7280">{Math.round(alt.mn)}m</text>
          </>
        )}
        {hr && (
          <>
            <text x={W-padR+4} y={padT+6} textAnchor="start" fontSize={7} fill="#ef4444">{Math.round(hr.mx)}</text>
            <text x={W-padR+4} y={padT+chartH} textAnchor="start" fontSize={7} fill="#ef4444">{Math.round(hr.mn)}</text>
          </>
        )}

        {/* X axis distance labels */}
        {streams.distance && [0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const km = (frac * xMax / 1000).toFixed(1);
          const x = padL + frac * chartW;
          return <text key={frac} x={x} y={H-4} textAnchor="middle" fontSize={7} fill="#4b5563">{km}km</text>;
        })}
      </svg>
    </div>
  );
}

// ── Activity Detail Modal ─────────────────────────────────────────────────────

interface ActivityDetail {
  id: number;
  name: string;
  sport_type: string;
  start_date_local: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  average_speed: number;
  max_speed: number;
  average_heartrate: number | null;
  max_heartrate: number | null;
  average_watts: number | null;
  weighted_average_watts: number | null;
  kilojoules: number | null;
  suffer_score: number | null;
  kudos_count: number;
  comment_count: number;
  achievement_count: number;
  trainer: number;
  commute: number;
  description: string | null;
  map_summary_polyline: string | null;
}

function ActivityDetailModal({ activityId, onClose }: { activityId: number; onClose: () => void }) {
  const [detail, setDetail] = useState<ActivityDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/strava/activity/${activityId}`)
      .then((r) => r.json())
      .then(setDetail)
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [activityId]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const running = detail ? isRun(detail.sport_type) : false;

  return (
    <div className="fixed inset-0 z-[2000] flex items-end sm:items-center justify-center p-0 sm:p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full sm:max-w-lg max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl">
        {/* Handle (mobile) */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <div className="h-1 w-10 rounded-full bg-gray-700" />
        </div>

        {loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading…</div>
        ) : !detail ? (
          <div className="p-8 text-center text-sm text-gray-500">Activity not found.</div>
        ) : (
          <div className="p-5">
            {/* Header */}
            <div className="flex items-start justify-between gap-3 mb-4">
              <div className="flex items-start gap-3">
                <span className="h-3 w-3 rounded-full mt-1.5 shrink-0" style={{ backgroundColor: sportColor(detail.sport_type) }} />
                <div>
                  <h2 className="text-base font-semibold text-gray-100 leading-snug">{detail.name}</h2>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {fmtDate(detail.start_date_local)}
                    {detail.trainer === 1 && " · Indoor"}
                    {detail.commute === 1 && " · Commute"}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={`https://www.strava.com/activities/${detail.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-orange-400 hover:text-orange-300 border border-orange-500/30 rounded-full px-2 py-0.5 transition-colors"
                >
                  Strava ↗
                </a>
                <button onClick={onClose} className="shrink-0 text-gray-500 hover:text-gray-300 text-lg leading-none">✕</button>
              </div>
            </div>

            {/* Map */}
            {detail.map_summary_polyline && (
              <div className="mb-4">
                <PolylineMap encoded={detail.map_summary_polyline} />
              </div>
            )}

            {/* Streams chart */}
            <StreamsChart activityId={detail.id} sportType={detail.sport_type} />

            {/* Primary stats */}
            <div className="grid grid-cols-3 gap-3 mb-4">
              {detail.distance > 0 && (
                <div className="rounded-xl bg-gray-800 p-3 text-center">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wide">Distance</p>
                  <p className="text-base font-bold text-gray-100 mt-0.5">{fmtDistance(detail.distance)}</p>
                </div>
              )}
              <div className="rounded-xl bg-gray-800 p-3 text-center">
                <p className="text-[10px] text-gray-500 uppercase tracking-wide">Time</p>
                <p className="text-base font-bold text-gray-100 mt-0.5">{fmtTime(detail.moving_time)}</p>
              </div>
              {detail.distance > 0 && (
                <div className="rounded-xl bg-gray-800 p-3 text-center">
                  <p className="text-[10px] text-gray-500 uppercase tracking-wide">{running ? "Pace" : "Speed"}</p>
                  <p className="text-base font-bold text-gray-100 mt-0.5">
                    {running ? fmtPace(detail.distance, detail.moving_time) : fmtSpeed(detail.average_speed)}
                  </p>
                </div>
              )}
            </div>

            {/* Secondary stats */}
            <div className="grid grid-cols-2 gap-2 mb-4">
              {detail.total_elevation_gain > 0 && (
                <Stat icon="⬆️" label="Elevation" value={`${Math.round(detail.total_elevation_gain).toLocaleString()} m`} />
              )}
              {detail.average_heartrate != null && (
                <Stat icon="❤️" label="Avg HR" value={`${Math.round(detail.average_heartrate)} bpm`} />
              )}
              {detail.max_heartrate != null && (
                <Stat icon="💓" label="Max HR" value={`${Math.round(detail.max_heartrate)} bpm`} />
              )}
              {detail.average_watts != null && detail.average_watts > 0 && (
                <Stat icon="⚡" label="Avg Power" value={`${Math.round(detail.average_watts)} W`} />
              )}
              {detail.kilojoules != null && detail.kilojoules > 0 && (
                <Stat icon="🔥" label="Calories" value={`${Math.round(detail.kilojoules * 0.239)} kcal`} />
              )}
              {detail.suffer_score != null && detail.suffer_score > 0 && (
                <Stat icon="😤" label="Suffer Score" value={String(Math.round(detail.suffer_score))} />
              )}
              {detail.elapsed_time > detail.moving_time + 60 && (
                <Stat icon="⏱️" label="Elapsed" value={fmtTime(detail.elapsed_time)} />
              )}
            </div>

            {/* Achievements / kudos */}
            {(detail.achievement_count > 0 || detail.kudos_count > 0) && (
              <div className="flex gap-3 mb-4">
                {detail.achievement_count > 0 && (
                  <span className="rounded-full bg-yellow-500/10 border border-yellow-500/20 px-3 py-1 text-xs text-yellow-400">
                    🏆 {detail.achievement_count} achievement{detail.achievement_count !== 1 ? "s" : ""}
                  </span>
                )}
                {detail.kudos_count > 0 && (
                  <span className="rounded-full bg-indigo-500/10 border border-indigo-500/20 px-3 py-1 text-xs text-indigo-400">
                    👍 {detail.kudos_count} kudo{detail.kudos_count !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            )}

            {/* Description */}
            {detail.description && (
              <p className="text-sm text-gray-400 leading-relaxed border-t border-gray-800 pt-3">
                {detail.description}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-gray-800/60 px-3 py-2">
      <span className="text-sm">{icon}</span>
      <div>
        <p className="text-[10px] text-gray-500">{label}</p>
        <p className="text-xs font-semibold text-gray-200">{value}</p>
      </div>
    </div>
  );
}

// ── Activity Card ─────────────────────────────────────────────────────────────

function ActivityCard({ activity, onOpen }: { activity: Activity; onOpen: (id: number) => void }) {
  const color = sportColor(activity.sport_type);
  const running = isRun(activity.sport_type);
  const hasDist = activity.distance > 0;

  return (
    <div
      className="rounded-xl border border-gray-800 bg-gray-900 p-4 cursor-pointer hover:border-gray-600 transition-colors"
      onClick={() => onOpen(activity.id)}
    >
      <div className="flex items-start gap-3">
        <span className="h-2.5 w-2.5 rounded-full mt-1.5 shrink-0" style={{ backgroundColor: color }} />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-gray-100 text-sm leading-snug truncate">{activity.name}</p>
          <p className="text-xs text-gray-500 mt-0.5">{fmtDate(activity.start_date_local)}</p>
        </div>
        {(activity.trainer === 1) && (
          <span className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-500">Indoor</span>
        )}
        {(activity.commute === 1) && (
          <span className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-500">Commute</span>
        )}
      </div>
      <div className={`mt-3 grid gap-2 text-center ${hasDist ? "grid-cols-3" : "grid-cols-1"}`}>
        {hasDist && (
          <div>
            <p className="text-xs text-gray-500">Distance</p>
            <p className="text-sm font-semibold text-gray-200">{fmtDistance(activity.distance)}</p>
          </div>
        )}
        <div>
          <p className="text-xs text-gray-500">Time</p>
          <p className="text-sm font-semibold text-gray-200">{fmtTime(activity.moving_time)}</p>
        </div>
        {hasDist && (
          <div>
            <p className="text-xs text-gray-500">{running ? "Pace" : "Speed"}</p>
            <p className="text-sm font-semibold text-gray-200">
              {running
                ? fmtPace(activity.distance, activity.moving_time)
                : fmtSpeed(activity.average_speed)}
            </p>
          </div>
        )}
      </div>
      {(activity.average_heartrate || activity.total_elevation_gain > 0) && (
        <div className="mt-2 flex flex-wrap gap-2">
          {activity.average_heartrate && (
            <span className="text-xs text-gray-500">
              ❤️ {Math.round(activity.average_heartrate)} bpm
            </span>
          )}
          {activity.total_elevation_gain > 0 && (
            <span className="text-xs text-gray-500">
              ⬆️ {Math.round(activity.total_elevation_gain).toLocaleString()}m
            </span>
          )}
          {activity.suffer_score != null && activity.suffer_score > 0 && (
            <span className="text-xs text-gray-500">
              🔥 {Math.round(activity.suffer_score)} suffer
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Trends Chart ─────────────────────────────────────────────────────────────

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function formatPeriodLabel(p: string, period: string, i: number, periods: [string, unknown][]): string {
  if (period === "month") {
    // p = "2025-08" → "Aug" or "Jan '26" on year change
    const [yr, mo] = p.split("-");
    const mon = MONTHS[parseInt(mo) - 1];
    const prevYear = i > 0 ? periods[i-1][0].split("-")[0] : null;
    return (parseInt(mo) === 1 && prevYear && prevYear !== yr) ? `${mon} '${yr.slice(2)}` : mon;
  }
  if (period === "week") {
    // p = "2026-13" (year-week number) → show label only for first week of each month
    const [yr, wk] = p.split("-");
    const jan1 = new Date(parseInt(yr), 0, 1);
    const d = new Date(jan1.getTime() + (parseInt(wk) - 1) * 7 * 86400000);
    const mon = d.getMonth();
    // Show label when month changes (first week of a new month)
    const prevMon = i > 0 ? (() => {
      const [pyr, pwk] = periods[i-1][0].split("-");
      const pjan1 = new Date(parseInt(pyr), 0, 1);
      return new Date(pjan1.getTime() + (parseInt(pwk) - 1) * 7 * 86400000).getMonth();
    })() : -1;
    return mon !== prevMon ? MONTHS[mon] : "";
  }
  if (period === "day") {
    // p = "2025-08-15" → show every 7th only to avoid crowding
    if (i % 7 !== 0) return "";
    const [, mo, day] = p.split("-");
    return `${MONTHS[parseInt(mo)-1]} ${parseInt(day)}`;
  }
  return p.slice(5);
}

function TrendsChart({
  trends,
  period,
  onPeriodChange,
}: {
  trends: TrendPoint[];
  period: string;
  onPeriodChange: (p: string) => void;
}) {
  const [metric, setMetric] = useState<"km" | "hours">("hours");
  const [filterType, setFilterType] = useState<string | null>(null);
  const pageSize = 8;
  const [pageOffset, setPageOffset] = useState(0);
  useEffect(() => { setPageOffset(0); }, [period]);

  const allSportTypes = [...new Set(trends.map((t) => t.sport_type))];

  // Build full period list from ALL trends (so filtered view keeps bar positions)
  const allPeriods = [...new Set(trends.map((t) => t.period))].sort();
  const periodMap = new Map<string, { total_km: number; total_hours: number; types: Record<string, { km: number; hours: number }> }>();
  for (const p of allPeriods) periodMap.set(p, { total_km: 0, total_hours: 0, types: {} });
  for (const t of trends) {
    if (filterType && t.sport_type !== filterType) continue;
    const entry = periodMap.get(t.period)!;
    const hours = t.total_seconds / 3600;
    entry.total_km += t.total_km;
    entry.total_hours += hours;
    if (!entry.types[t.sport_type]) entry.types[t.sport_type] = { km: 0, hours: 0 };
    entry.types[t.sport_type].km += t.total_km;
    entry.types[t.sport_type].hours += hours;
  }

  const periods = Array.from(periodMap.entries()).sort(([a], [b]) => a.localeCompare(b));
  const totalPages = Math.ceil(periods.length / pageSize);
  // pageOffset counts from the end: 0 = most recent page
  const pageStart = Math.max(0, periods.length - pageSize * (pageOffset + 1));
  const pageEnd = periods.length - pageSize * pageOffset;
  const visiblePeriods = periods.slice(pageStart, pageEnd);

  const getValue = (v: { total_km: number; total_hours: number }) => metric === "km" ? v.total_km : v.total_hours;
  const getTypeValue = (v: { km: number; hours: number }) => metric === "km" ? v.km : v.hours;
  const visibleTypes = filterType ? [filterType] : allSportTypes;
  const maxVal = Math.max(...periods.map(([, v]) => getValue(v)), 1);

  if (allSportTypes.length === 0) {
    return <div className="py-12 text-center text-sm text-gray-500">No activity data yet.</div>;
  }

  const barW = period === "day" ? 16 : 32;
  const barStep = period === "day" ? 22 : 40;

  return (
    <div>
      <div className="mb-3 flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1 rounded-lg bg-gray-900 p-1">
          {(["hours", "km"] as const).map((m) => (
            <button key={m} onClick={() => setMetric(m)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${metric === m ? "bg-gray-800 text-gray-100" : "text-gray-400 hover:text-gray-300"}`}>
              {m === "km" ? "Distance" : "Hours"}
            </button>
          ))}
        </div>
        <div className="flex gap-1 rounded-lg bg-gray-900 p-1">
          {[["day","Daily"],["week","Weekly"],["month","Monthly"]].map(([p, label]) => (
            <button key={p} onClick={() => onPeriodChange(p)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${period === p ? "bg-gray-800 text-gray-100" : "text-gray-400 hover:text-gray-300"}`}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Sport type legend — tap to filter */}
      <div className="mb-3 flex gap-2 flex-wrap">
        {allSportTypes.map((st) => {
          const active = filterType === null || filterType === st;
          return (
            <button key={st}
              onClick={() => setFilterType(filterType === st ? null : st)}
              className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs transition-all border ${
                active
                  ? "border-transparent text-gray-300 bg-gray-800"
                  : "border-gray-700 text-gray-600 bg-transparent"
              }`}
              style={active ? { borderColor: sportColor(st) } : {}}
            >
              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: active ? sportColor(st) : "#4b5563" }} />
              {st}
            </button>
          );
        })}
      </div>

      {/* Bar chart — always fixed width, bars right-aligned */}
      <svg
        viewBox={`0 0 ${pageSize * barStep} 160`}
        className="w-full"
        preserveAspectRatio="none"
      >
        {visiblePeriods.map(([p, val], i) => {
          const padLeft = pageSize - visiblePeriods.length;
          const x = (padLeft + i) * barStep + (barStep - barW) / 2;
          const totalVal = getValue(val);
          const totalH = (totalVal / maxVal) * 120;
          let yOffset = 130;

          return (
            <g key={p}>
              {visibleTypes.map((st) => {
                const tv = val.types[st];
                if (!tv) return null;
                const v = getTypeValue(tv);
                if (!v) return null;
                const h = (v / maxVal) * 120;
                yOffset -= h;
                return (
                  <rect key={st} x={x} y={yOffset} width={barW} height={h}
                    fill={sportColor(st)} opacity={0.85} rx={2}>
                    <title>{`${st}: ${metric === "km" ? v.toFixed(1) + " km" : v.toFixed(1) + "h"}`}</title>
                  </rect>
                );
              })}
              {totalH > 10 && (
                <text x={x + barW / 2} y={130 - totalH - 3} textAnchor="middle" fontSize={7} fill="#9ca3af">
                  {metric === "km" ? totalVal.toFixed(0) : totalVal.toFixed(1)}
                </text>
              )}
              <text x={x + barW / 2} y={148} textAnchor="middle" fontSize={7} fill="#6b7280">
                {formatPeriodLabel(p, period, i, visiblePeriods)}
              </text>
            </g>
          );
        })}
        {/* Baseline */}
        <line x1={0} y1={131} x2={pageSize * barStep} y2={131} stroke="#374151" strokeWidth={1} />
      </svg>

      {/* Pagination */}
      <div className="mt-2 flex items-center justify-between">
        <button
          onClick={() => setPageOffset((o) => Math.min(o + 1, totalPages - 1))}
          disabled={pageOffset >= totalPages - 1}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5"/></svg>
          Older
        </button>
        <p className="text-xs text-gray-600">{metric === "km" ? "Distance (km)" : "Time (hours)"}{filterType ? ` · ${filterType}` : ""}</p>
        <button
          onClick={() => setPageOffset((o) => Math.max(o - 1, 0))}
          disabled={pageOffset === 0}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Newer
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5"/></svg>
        </button>
      </div>
    </div>
  );
}

// ── Stats Tab ─────────────────────────────────────────────────────────────────

function StatsTab({ athleteId }: { athleteId: number }) {
  const [stats, setStats] = useState<{ by_type: StatByType[] } | null>(null);

  useEffect(() => {
    fetch(`/api/strava/stats?athlete_id=${athleteId}`)
      .then((r) => r.json())
      .then(setStats)
      .catch(() => setStats({ by_type: [] }));
  }, [athleteId]);

  if (!stats) return <div className="py-8 text-sm text-gray-500">Loading...</div>;
  if (stats.by_type.length === 0)
    return <div className="py-8 text-sm text-gray-500">No activities yet.</div>;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {stats.by_type.map((s) => (
        <div
          key={s.sport_type}
          className="rounded-xl border border-gray-800 bg-gray-900 p-4"
          style={{ borderLeftColor: sportColor(s.sport_type), borderLeftWidth: 3 }}
        >
          <div className="flex items-center gap-2 mb-3">
            <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: sportColor(s.sport_type) }} />
            <span className="font-medium text-gray-200">{s.sport_type}</span>
            <span className="ml-auto text-xs text-gray-500">{s.count} activities</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {s.total_km > 1 && (
              <div>
                <p className="text-xs text-gray-500">Total Distance</p>
                <p className="font-semibold text-gray-200">{s.total_km.toFixed(1)} km</p>
              </div>
            )}
            <div>
              <p className="text-xs text-gray-500">Total Time</p>
              <p className="font-semibold text-gray-200">{fmtTime(s.total_seconds)}</p>
            </div>
            {s.total_elevation_m > 0 && (
              <div>
                <p className="text-xs text-gray-500">Elevation</p>
                <p className="font-semibold text-gray-200">{s.total_elevation_m.toLocaleString()}m</p>
              </div>
            )}
            {s.avg_hr && (
              <div>
                <p className="text-xs text-gray-500">Avg HR</p>
                <p className="font-semibold text-gray-200">{s.avg_hr} bpm</p>
              </div>
            )}
          </div>
          <p className="mt-2 text-xs text-gray-600">Last: {fmtDate(s.last_activity)}</p>
        </div>
      ))}
    </div>
  );
}

// ── Activities Tab ────────────────────────────────────────────────────────────

function ActivitiesTab({ athleteId }: { athleteId: number }) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [type, setType] = useState("all");
  const [sportTypes, setSportTypes] = useState<string[]>([]);
  const [openActivityId, setOpenActivityId] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const LIMIT = 20;

  useEffect(() => {
    fetch(`/api/strava/sport-types?athlete_id=${athleteId}`)
      .then((r) => r.json())
      .then(setSportTypes)
      .catch(() => setSportTypes([]));
  }, [athleteId]);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({
      athlete_id: String(athleteId),
      limit: String(LIMIT),
      offset: String(offset),
    });
    if (type !== "all") params.set("type", type);
    if (search) params.set("search", search);

    fetch(`/api/strava/activities?${params}`)
      .then((r) => r.json())
      .then(setActivities)
      .catch(() => setActivities([]))
      .finally(() => setLoading(false));
  }, [athleteId, type, search, offset]);

  useEffect(() => {
    setOffset(0);
  }, [type, search]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      {/* Filters */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <input
          type="text"
          placeholder="Search activities..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none w-full sm:w-64"
        />
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => setType("all")}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              type === "all"
                ? "border-indigo-500 bg-indigo-500/15 text-indigo-300"
                : "border-gray-700 text-gray-400 hover:border-gray-600"
            }`}
          >
            All
          </button>
          {sportTypes.map((st) => (
            <button
              key={st}
              onClick={() => setType(st)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                type === st
                  ? "border-indigo-500 bg-indigo-500/15 text-indigo-300"
                  : "border-gray-700 text-gray-400 hover:border-gray-600"
              }`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-gray-500 py-4">Loading...</div>
      ) : activities.length === 0 ? (
        <div className="py-12 text-center text-sm text-gray-500">No activities found.</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {activities.map((a) => (
            <ActivityCard key={a.id} activity={a} onOpen={setOpenActivityId} />
          ))}
        </div>
      )}

      {/* Pagination */}
      {activities.length > 0 && (
        <div className="mt-4 flex items-center gap-3 justify-center">
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-30"
          >
            ← Prev
          </button>
          <span className="text-xs text-gray-500">{offset + 1}–{offset + activities.length}</span>
          <button
            disabled={activities.length < LIMIT}
            onClick={() => setOffset(offset + LIMIT)}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-30"
          >
            Next →
          </button>
        </div>
      )}

      {openActivityId != null && (
        <ActivityDetailModal activityId={openActivityId} onClose={() => setOpenActivityId(null)} />
      )}
    </div>
  );
}

// ── Calendar Tab ─────────────────────────────────────────────────────────────

interface CalendarActivity {
  id: number;
  name: string;
  sport_type: string;
  moving_time: number;
  distance: number;
}

interface CalendarDay {
  date: string;
  total_seconds: number;
  active: boolean;
  sport_types: string[];
  activities: CalendarActivity[];
}

const DAYS_OF_WEEK = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function CalendarTab({ athleteId }: { athleteId: number }) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [days, setDays] = useState<CalendarDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDay, setSelectedDay] = useState<{ day: number; info: CalendarDay } | null>(null);
  const [openActivityId, setOpenActivityId] = useState<number | null>(null);

  useEffect(() => {
    setLoading(true);
    // Compute full grid range including overflow days from adjacent months
    const daysInMonthVal = new Date(year, month, 0).getDate();
    const firstDowVal = new Date(year, month - 1, 1).getDay();
    const prevMonthDaysVal = new Date(year, month - 1, 0).getDate();
    const gridStart = firstDowVal === 0
      ? `${year}-${String(month).padStart(2, "0")}-01`
      : (() => {
          const d = prevMonthDaysVal - firstDowVal + 1;
          const pm = month === 1 ? 12 : month - 1;
          const py = month === 1 ? year - 1 : year;
          return `${py}-${String(pm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        })();
    const lastDay = daysInMonthVal;
    const lastDow = new Date(year, month - 1, lastDay).getDay();
    const nextDays = lastDow === 6 ? 0 : 6 - lastDow;
    const gridEnd = nextDays === 0
      ? `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`
      : (() => {
          const nm = month === 12 ? 1 : month + 1;
          const ny = month === 12 ? year + 1 : year;
          return `${ny}-${String(nm).padStart(2, "0")}-${String(nextDays).padStart(2, "0")}`;
        })();
    fetch(`/api/strava/calendar?athlete_id=${athleteId}&start_date=${gridStart}&end_date=${gridEnd}`)
      .then((r) => r.json())
      .then(setDays)
      .catch(() => setDays([]))
      .finally(() => setLoading(false));
  }, [athleteId, year, month]);

  function prevMonth() {
    if (month === 1) { setMonth(12); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  }
  function nextMonth() {
    if (month === 12) { setMonth(1); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  }

  const dayMap = new Map(days.map((d) => [d.date, d]));
  const daysInMonth = new Date(year, month, 0).getDate();
  const firstDow = new Date(year, month - 1, 1).getDay();
  const activeDays = days.filter((d) => d.active && d.date.startsWith(`${year}-${String(month).padStart(2, "0")}`)).length;

  // Days from previous month to fill the first row
  const prevMonthDays = new Date(year, month - 1, 0).getDate(); // days in prev month
  const prevMonthCells: { day: number; overflow: "prev" }[] = Array.from(
    { length: firstDow },
    (_, i) => ({ day: prevMonthDays - firstDow + 1 + i, overflow: "prev" as const })
  );

  // Days from next month to fill the last row
  const currentCells = Array.from({ length: daysInMonth }, (_, i) => ({
    day: i + 1,
    overflow: null as null,
  }));

  const allCells = [...prevMonthCells, ...currentCells];
  const remainder = allCells.length % 7;
  const nextMonthCells = remainder === 0 ? [] : Array.from(
    { length: 7 - remainder },
    (_, i) => ({ day: i + 1, overflow: "next" as const })
  );
  const cells = [...allCells, ...nextMonthCells];

  // For streak calc, only current-month cells matter


  // Split into weeks and compute streak (using current-month-only cells)
  const weeks: { day: number; overflow: "prev" | "next" | null }[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  const weekActive = weeks.map((week) => {
    const activeDaysInWeek = week.filter((c) => {
      const cm = c.overflow === "prev" ? (month === 1 ? 12 : month - 1) : c.overflow === "next" ? (month === 12 ? 1 : month + 1) : month;
      const cy = c.overflow === "prev" ? (month === 1 ? year - 1 : year) : c.overflow === "next" ? (month === 12 ? year + 1 : year) : year;
      const dateStr = `${cy}-${String(cm).padStart(2, "0")}-${String(c.day).padStart(2, "0")}`;
      return dayMap.get(dateStr)?.active ?? false;
    }).length;
    return activeDaysInWeek >= 3;
  });

  // Current streak: count consecutive active weeks from the end
  let currentStreak = 0;
  for (let i = weekActive.length - 1; i >= 0; i--) {
    if (weekActive[i]) currentStreak++;
    else break;
  }

  return (
    <div>
      {/* Header: nav + streak */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <button
          onClick={prevMonth}
          className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
        >
          ←
        </button>
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-gray-200">
            {MONTH_NAMES[month - 1]} {year}
          </span>
          {!loading && (() => {
            const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;
            const elapsedDays = isCurrentMonth ? now.getDate() - 1 : daysInMonth;
            const pct = elapsedDays > 0 ? Math.round((activeDays / elapsedDays) * 100) : 0;
            return (
              <span className="text-xs text-gray-500">
                {activeDays}/{elapsedDays} days ({pct}%)
              </span>
            );
          })()}
        </div>
        <button
          onClick={nextMonth}
          className="rounded-md border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:text-gray-200 transition-colors"
          disabled={year === now.getFullYear() && month === now.getMonth() + 1}
        >
          →
        </button>
      </div>

      {/* Day-of-week headers */}
      <div className="grid grid-cols-8 mb-0.5">
        <div />
        {DAYS_OF_WEEK.map((d) => (
          <div key={d} className="text-center text-[10px] font-medium text-gray-600">{d}</div>
        ))}
      </div>

      {loading ? (
        <div className="py-6 text-center text-sm text-gray-500">Loading...</div>
      ) : (
        <div className="space-y-0.5">
          {weeks.map((week, wi) => (
            <div key={wi} className="grid grid-cols-8 gap-0.5">
              {/* Week streak indicator */}
              <div className="flex items-center justify-center">
                {weekActive[wi] ? (
                  <span className="text-green-400 text-xs">✓</span>
                ) : (
                  <span className="text-gray-700 text-xs">·</span>
                )}
              </div>
              {week.map((cell, di) => {
                const { day, overflow } = cell;
                // Compute correct year/month for overflow days
                const cellMonth = overflow === "prev"
                  ? (month === 1 ? 12 : month - 1)
                  : overflow === "next"
                  ? (month === 12 ? 1 : month + 1)
                  : month;
                const cellYear = overflow === "prev"
                  ? (month === 1 ? year - 1 : year)
                  : overflow === "next"
                  ? (month === 12 ? year + 1 : year)
                  : year;
                const dateStr = `${cellYear}-${String(cellMonth).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                const info = dayMap.get(dateStr);
                const active = info?.active ?? false;
                const isToday = day === now.getDate() && cellMonth === now.getMonth() + 1 && cellYear === now.getFullYear();
                const sportDots = (info?.sport_types ?? []).slice(0, 3);

                return (
                  <div
                    key={dateStr}
                    className={`relative h-9 flex flex-col items-center justify-center rounded transition-colors ${
                      selectedDay?.day === day && selectedDay?.info?.date === dateStr
                        ? "bg-indigo-500/20 border border-indigo-500/50"
                        : active
                        ? "bg-green-500/20 border border-green-500/40 cursor-pointer hover:border-green-400"
                        : isToday
                        ? "border border-gray-600"
                        : "border border-transparent"
                    } ${active ? "cursor-pointer" : ""}`}
                    onClick={() => {
                      if (!info) return;
                      setSelectedDay(selectedDay?.info?.date === dateStr ? null : { day, info });
                    }}
                  >
                    <span className={`text-[10px] font-medium leading-none ${active ? "text-green-400" : isToday ? "text-gray-300" : "text-gray-600"}`}>
                      {day}
                    </span>
                    {sportDots.length > 0 && (
                      <span className="flex gap-0.5 mt-0.5">
                        {sportDots.map((st, i) => <span key={i} className="h-1 w-1 rounded-full" style={{ backgroundColor: sportColor(st) }} />)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Tooltip */}
      {selectedDay && (
        <div className="mt-3 rounded-lg border border-indigo-500/30 bg-gray-800 p-3 text-xs">
          <div className="flex items-center justify-between mb-2">
            <p className="font-medium text-gray-200">
              {MONTH_NAMES[month - 1]} {selectedDay.day} — {fmtTime(selectedDay.info.total_seconds)}
            </p>
            <button onClick={() => setSelectedDay(null)} className="text-gray-500 hover:text-gray-300 text-sm leading-none">✕</button>
          </div>
          <div className="space-y-1">
            {selectedDay.info.activities.map((a) => (
              <button
                key={a.id}
                onClick={() => setOpenActivityId(a.id)}
                className="w-full flex items-center justify-between gap-2 text-gray-400 hover:text-gray-200 hover:bg-gray-700/50 rounded px-2 py-1.5 transition-colors text-left"
              >
                <span className="flex items-center gap-2"><span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ backgroundColor: sportColor(a.sport_type) }} />{a.name}</span>
                <span className="text-gray-500 shrink-0">{fmtTime(a.moving_time)}{a.distance > 0 ? ` · ${(a.distance/1000).toFixed(1)}km` : ""}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {openActivityId != null && (
        <ActivityDetailModal activityId={openActivityId} onClose={() => setOpenActivityId(null)} />
      )}

      {/* Legend */}
      <div className="mt-3 flex items-center gap-4 text-[10px] text-gray-600">
        <div className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded bg-green-500/30 border border-green-500/50" /> ≥30 min</div>
        <div className="flex items-center gap-1"><span className="text-green-400 text-xs">✓</span> week (3+ days)</div>
      </div>
    </div>
  );
}

// ── Trends Tab ────────────────────────────────────────────────────────────────

function TrendsTab({ athleteId }: { athleteId: number }) {
  const [trends, setTrends] = useState<TrendPoint[]>([]);
  const [period, setPeriod] = useState("week");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/strava/trends?athlete_id=${athleteId}&period=${period}`)
      .then((r) => r.json())
      .then(setTrends)
      .catch(() => setTrends([]))
      .finally(() => setLoading(false));
  }, [athleteId, period]);

  if (loading) return <div className="py-8 text-center text-sm text-gray-500">Loading...</div>;

  return (
    <TrendsChart trends={trends} period={period} onPeriodChange={setPeriod} />
  );
}

// ── Athlete Section ───────────────────────────────────────────────────────────

type AthleteTab = "calendar" | "stats" | "activities" | "trips" | "trends" | "ask";
const ATHLETE_TABS: { key: AthleteTab; label: string; icon: string }[] = [
  { key: "calendar", label: "Calendar", icon: "📅" },
  { key: "stats", label: "Breakdown", icon: "📊" },
  { key: "activities", label: "Activities", icon: "🏃" },
  { key: "trips", label: "Trips", icon: "🗺️" },
  { key: "trends", label: "Trends", icon: "📈" },
  { key: "ask", label: "Ask", icon: "🤖" },
];

// ── Trips Tab ─────────────────────────────────────────────────────────────────

interface TripGroupSummary {
  id: number;
  athlete_id: number;
  name: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  leg_count: number;
  total_distance_m: number;
  total_moving_time_s: number;
  total_elapsed_time_s: number;
  total_elevation_m: number;
  sport_types: string[];
  polylines: string[];
}

interface TripGroupMember {
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

interface TripTravelLeg {
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

const TRAVEL_MODES = ["train", "ferry", "plane", "bus", "car"] as const;
const TRAVEL_MODE_ICON: Record<string, string> = {
  train: "🚂", ferry: "⛴", plane: "✈️", bus: "🚌", car: "🚗",
};
const travelIcon = (mode: string) => TRAVEL_MODE_ICON[mode] ?? "→";

interface TripGroupDetail {
  id: number;
  athlete_id: number;
  name: string;
  description: string | null;
  photos_url: string | null;
  start_date: string | null;
  end_date: string | null;
  updated_at: string;
  published_slug: string | null;
  published_at: string | null;
  members: TripGroupMember[];
  travel_legs?: TripTravelLeg[];
  totals: {
    distance_m: number;
    moving_time_s: number;
    elapsed_time_s: number;
    elevation_m: number;
    kilojoules: number;
    avg_hr: number | null;
    calories: number;
  };
  sport_breakdown: Record<string, number>;
}

function isMultiSportSummary(g: TripGroupSummary): boolean {
  return g.sport_types.length > 1 && g.start_date === g.end_date;
}

function isMultiSportDetail(members: TripGroupMember[]): boolean {
  if (members.length < 2) return false;
  const dates = new Set(members.map((m) => m.start_date_local.substr(0, 10)));
  const sports = new Set(members.map((m) => m.sport_type));
  return dates.size === 1 && sports.size > 1;
}

function TripsTab({ athleteId }: { athleteId: number }) {
  const [groups, setGroups] = useState<TripGroupSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/strava/groups?athlete_id=${athleteId}`)
      .then((r) => r.json())
      .then(setGroups)
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, [athleteId]);

  useEffect(() => {
    load();
  }, [load]);

  if (selectedId != null) {
    return (
      <TripDetailView
        groupId={selectedId}
        athleteId={athleteId}
        onBack={() => {
          setSelectedId(null);
          load();
        }}
      />
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-400">
          {groups.length} {groups.length === 1 ? "trip" : "trips"}
        </h3>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-indigo-500/20 border border-indigo-500/40 px-3 py-1.5 text-xs font-medium text-indigo-300 hover:bg-indigo-500/30 transition-colors"
        >
          + New Trip
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-gray-500 py-4">Loading...</div>
      ) : groups.length === 0 ? (
        <div className="py-12 text-center text-sm text-gray-500">
          No trips yet.<br />
          Click <span className="text-indigo-400">+ New Trip</span> to combine activities into a multi-day adventure or multi-sport event.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {groups.map((g) => (
            <TripCard
              key={g.id}
              group={g}
              onOpen={() => setSelectedId(g.id)}
              onDeleted={() => load()}
            />
          ))}
        </div>
      )}

      {showCreate && (
        <CreateGroupModal
          athleteId={athleteId}
          onClose={() => setShowCreate(false)}
          onCreated={(newId) => {
            setShowCreate(false);
            load();
            setSelectedId(newId);
          }}
        />
      )}
    </div>
  );
}

function TripCard({
  group,
  onOpen,
  onDeleted,
}: {
  group: TripGroupSummary;
  onOpen: () => void;
  onDeleted: () => void;
}) {
  const multisport = isMultiSportSummary(group);
  const polylines = group.polylines.map((encoded, i) => ({
    encoded,
    color: multisport ? sportColor(group.sport_types[i] ?? "") : legColor(i),
  }));
  const dateRange = formatDateRange(group.start_date, group.end_date);
  const days = countDays(group.start_date, group.end_date);

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Delete "${group.name}"? Underlying activities are not affected.`)) return;
    const r = await fetch(`/api/strava/groups/${group.id}`, { method: "DELETE" });
    if (r.ok) onDeleted();
  }

  return (
    <div
      onClick={onOpen}
      className="group relative text-left rounded-xl border border-gray-800 bg-gray-900 overflow-hidden hover:border-indigo-500/50 transition-colors cursor-pointer"
    >
      {/* Delete button — appears on hover, top-right corner */}
      <button
        type="button"
        onClick={handleDelete}
        title="Delete trip"
        aria-label="Delete trip"
        className="absolute top-2 right-2 z-10 w-6 h-6 rounded-full bg-gray-900/80 border border-gray-700 text-gray-400 hover:bg-red-500/20 hover:border-red-500/40 hover:text-red-300 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center justify-center text-xs"
      >
        ✕
      </button>
      {polylines.length ? (
        <div className="border-b border-gray-800">
          <MultiLegMap polylines={polylines} height={128} />
        </div>
      ) : (
        <div className="h-32 bg-gray-800/40 flex items-center justify-center text-xs text-gray-500 border-b border-gray-800">
          No map data
        </div>
      )}
      <div className="p-3">
        <h4 className="text-sm font-semibold text-gray-100 truncate">
          {group.name}
        </h4>
        <p className="text-xs text-gray-500 mt-0.5">
          {dateRange}
          {days > 1 ? ` · ${days} days` : ""}
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {group.sport_types.map((st) => (
            <span
              key={st}
              className="text-[10px] rounded-full px-1.5 py-0.5 border"
              style={{ color: sportColor(st), borderColor: sportColor(st) + "55" }}
            >
              {sportIcon(st)} {overrideSportLabel(group.id, st)}
            </span>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
          <div>
            <p className="text-gray-500 text-[10px]">Distance</p>
            <p className="font-semibold text-gray-200">
              {fmtDistance(group.total_distance_m)}
            </p>
          </div>
          <div>
            <p className="text-gray-500 text-[10px]">Moving Time</p>
            <p className="font-semibold text-gray-200">
              {fmtTime(group.total_moving_time_s)}
            </p>
          </div>
          <div>
            <p className="text-gray-500 text-[10px]">Elevation Gain</p>
            <p className="font-semibold text-gray-200">
              {Math.round(group.total_elevation_m).toLocaleString()} m
            </p>
          </div>
        </div>
        <p className="text-[10px] text-gray-600 mt-2">
          {group.leg_count} {group.leg_count === 1 ? "leg" : "legs"}
        </p>
      </div>
    </div>
  );
}

function TripDetailView({
  groupId,
  athleteId,
  onBack,
}: {
  groupId: number;
  athleteId: number;
  onBack: () => void;
}) {
  const [group, setGroup] = useState<TripGroupDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showEdit, setShowEdit] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(900);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/strava/groups/${groupId}`)
      .then((r) => r.json())
      .then((d) => setGroup(d.error ? null : d))
      .catch(() => setGroup(null))
      .finally(() => setLoading(false));
  }, [groupId]);

  useEffect(() => {
    load();
  }, [load]);

  // Listen for iframe self-reported height so we can size it to its content
  // and avoid an inner scrollbar.
  useEffect(() => {
    function handler(e: MessageEvent) {
      const d = e.data;
      if (d && d.type === "trip-page-height" && typeof d.height === "number") {
        setIframeHeight(Math.max(600, Math.ceil(d.height)));
      }
    }
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  async function handlePublish() {
    setPublishing(true);
    try {
      const r = await fetch(`/api/strava/groups/${groupId}/publish`, { method: "POST" });
      if (r.ok) load();
    } finally {
      setPublishing(false);
    }
  }

  async function handleUnpublish() {
    if (!confirm("Unpublish this trip? The public URL will stop working.")) return;
    setPublishing(true);
    try {
      const r = await fetch(`/api/strava/groups/${groupId}/publish`, { method: "DELETE" });
      if (r.ok) load();
    } finally {
      setPublishing(false);
    }
  }

  function copyPublicUrl(url: string) {
    const flash = () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(flash).catch(() => fallback(url, flash));
    } else {
      fallback(url, flash);
    }
  }

  function fallback(url: string, onSuccess: () => void) {
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try {
      const ok = document.execCommand("copy");
      if (ok) onSuccess();
      else alert("Copy unsupported — select the URL manually.");
    } catch {
      alert("Copy unsupported — select the URL manually.");
    } finally {
      document.body.removeChild(ta);
    }
  }

  if (loading)
    return <div className="text-sm text-gray-500 py-4">Loading...</div>;
  if (!group)
    return (
      <div className="text-sm text-gray-500 py-4">
        Trip not found.{" "}
        <button onClick={onBack} className="text-indigo-400 hover:underline">
          ← Back
        </button>
      </div>
    );

  const dateRange = formatDateRange(group.start_date, group.end_date);
  const days = countDays(group.start_date, group.end_date);
  // Cache-bust the iframe whenever the trip is edited so the preview reflects latest data
  const previewSrc = `/api/strava/groups/${groupId}/preview?v=${encodeURIComponent(group.updated_at)}`;

  return (
    <div>
      {/* Header */}
      <div className="mb-4 flex items-start gap-3">
        <button
          onClick={onBack}
          className="text-gray-400 hover:text-gray-200 text-sm pt-1"
        >
          ←
        </button>
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-semibold text-gray-100">{group.name}</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {dateRange}
            {days > 1 ? ` · ${days} days` : ""} · {group.members.length} legs
          </p>
        </div>
        <button
          onClick={() => setShowEdit(true)}
          className="text-xs text-indigo-400 hover:text-indigo-300 pt-1 px-2 py-1 rounded hover:bg-gray-800"
        >
          ✎ Edit
        </button>
      </div>

      {/* Publish status strip — simplified: once published, edits auto-sync */}
      {(() => {
        const slug = group.published_slug;
        const publicUrl = slug
          ? `https://storage.googleapis.com/strava-trips/${slug}.html`
          : null;

        if (!slug) {
          return (
            <div className="mb-4 flex items-center gap-2">
              <button
                onClick={handlePublish}
                disabled={publishing}
                className="rounded-lg bg-indigo-500/20 border border-indigo-500/40 px-3 py-1.5 text-xs font-medium text-indigo-300 hover:bg-indigo-500/30 disabled:opacity-50 transition-colors"
              >
                {publishing ? "Publishing…" : "🔗 Publish public link"}
              </button>
              <span className="text-[11px] text-gray-500">
                Generates a shareable read-only page; future edits auto-sync
              </span>
            </div>
          );
        }

        return (
          <div className="mb-4 rounded-lg border border-gray-800 bg-gray-900/40 p-2.5 flex flex-wrap items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 font-medium bg-emerald-500/15 text-emerald-400">
              Published ✓
            </span>
            <a
              href={publicUrl!}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-1 min-w-0 text-xs text-gray-300 hover:text-indigo-300 truncate"
            >
              {publicUrl}
            </a>
            <button
              onClick={() => copyPublicUrl(publicUrl!)}
              className="text-[11px] text-gray-400 hover:text-gray-200 px-2 py-1 rounded hover:bg-gray-800"
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button
              onClick={handleUnpublish}
              disabled={publishing}
              className="text-[11px] text-red-400 hover:text-red-300 px-2 py-1 rounded hover:bg-gray-800 disabled:opacity-50"
            >
              Unpublish
            </button>
          </div>
        );
      })()}

      {/* The trip view itself — same HTML that the public bucket serves. */}
      <iframe
        title={group.name}
        src={previewSrc}
        style={{ width: "100%", height: iframeHeight, border: "none", display: "block" }}
        className="rounded-lg"
      />

      {showEdit && (
        <EditTripModal
          group={group}
          athleteId={athleteId}
          onClose={() => setShowEdit(false)}
          onChanged={() => {
            load();
            setShowEdit(false);
          }}
        />
      )}
    </div>
  );
}

function EditTripModal({
  group,
  athleteId,
  onClose,
  onChanged,
}: {
  group: TripGroupDetail;
  athleteId: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description ?? "");
  const [photosUrl, setPhotosUrl] = useState(group.photos_url ?? "");
  // Local working copy of members so the user can stage removes/adds before saving
  const [members, setMembers] = useState(group.members);
  // Local working copy of travel legs (mutations write to server immediately,
  // then we reflect the change here so the UI stays in sync without re-fetching).
  const [travelLegs, setTravelLegs] = useState<TripTravelLeg[]>(group.travel_legs ?? []);
  const [editingTravelLeg, setEditingTravelLeg] = useState<TripTravelLeg | "new" | null>(null);
  const [showAddMembers, setShowAddMembers] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    name.trim() !== group.name ||
    (description || "").trim() !== (group.description ?? "").trim() ||
    (photosUrl || "").trim() !== (group.photos_url ?? "").trim() ||
    JSON.stringify(members.map((m) => m.id)) !==
      JSON.stringify(group.members.map((m) => m.id));

  function removeMember(id: number) {
    if (members.length <= 1) {
      alert("A trip must have at least one leg.");
      return;
    }
    setMembers(members.filter((m) => m.id !== id));
  }

  async function save() {
    setError(null);
    if (!name.trim()) {
      setError("Name cannot be empty");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (name.trim() !== group.name) body.name = name.trim();
      if ((description || "").trim() !== (group.description ?? "").trim())
        body.description = description.trim() || null;
      if ((photosUrl || "").trim() !== (group.photos_url ?? "").trim())
        body.photos_url = photosUrl.trim() || null;
      const oldIds = group.members.map((m) => m.id);
      const newIds = members.map((m) => m.id);
      if (JSON.stringify(oldIds) !== JSON.stringify(newIds))
        body.activity_ids = newIds;
      if (Object.keys(body).length === 0) {
        onChanged();
        return;
      }
      const r = await fetch(`/api/strava/groups/${group.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        onChanged();
      } else {
        const data = await r.json().catch(() => ({}));
        setError(data.error ?? "Save failed");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[2000] bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="w-full sm:max-w-2xl bg-gray-900 sm:rounded-xl border border-gray-700 flex flex-col"
        style={{ maxHeight: "90vh" }}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <h3 className="text-base font-semibold text-gray-100">Edit Trip</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200">✕</button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-gray-400">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-400">Description (optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-400">Photo album URL</label>
            <input
              type="url"
              value={photosUrl}
              onChange={(e) => setPhotosUrl(e.target.value)}
              placeholder="https://photos.app.goo.gl/..."
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-400">
                Legs ({members.length})
              </label>
              <button
                type="button"
                onClick={() => setShowAddMembers(true)}
                className="text-[11px] text-indigo-400 hover:text-indigo-300"
              >
                + Add legs
              </button>
            </div>
            <div className="rounded-lg border border-gray-800 divide-y divide-gray-800 max-h-72 overflow-auto">
              {members.map((m, i) => (
                <div
                  key={m.id}
                  className="px-3 py-2 hover:bg-gray-800/40 flex items-center gap-2 text-xs"
                >
                  <span className="w-6 text-gray-500">#{i + 1}</span>
                  <span className="w-6">{sportIcon(m.sport_type)}</span>
                  <span className="flex-1 min-w-0">
                    <span className="text-gray-200 truncate block">{m.name}</span>
                    <span className="text-gray-500">{fmtDate(m.start_date_local)}</span>
                  </span>
                  <button
                    onClick={() => removeMember(m.id)}
                    title="Remove from trip"
                    className="text-gray-500 hover:text-red-400 px-1"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-400">
                Travel Legs ({travelLegs.length})
              </label>
              <button
                type="button"
                onClick={() => setEditingTravelLeg("new")}
                className="text-[11px] text-indigo-400 hover:text-indigo-300"
              >
                + Add travel leg
              </button>
            </div>
            <p className="text-[11px] text-gray-500 mb-2">
              Trains, ferries, etc. — drawn as dashed lines on the map. Don't count toward trip totals.
            </p>
            {travelLegs.length === 0 ? (
              <div className="rounded-lg border border-dashed border-gray-800 px-3 py-4 text-center text-xs text-gray-500">
                No travel legs yet.
              </div>
            ) : (
              <div className="rounded-lg border border-gray-800 divide-y divide-gray-800 max-h-48 overflow-auto">
                {[...travelLegs].sort((a, b) => a.start_date.localeCompare(b.start_date)).map((tl) => (
                  <div
                    key={tl.id}
                    className="px-3 py-2 hover:bg-gray-800/40 flex items-center gap-2 text-xs"
                  >
                    <span className="w-6">{travelIcon(tl.mode)}</span>
                    <span className="flex-1 min-w-0">
                      <span className="text-gray-200 truncate block">
                        {(tl.start_label || `${tl.start_lat.toFixed(2)},${tl.start_lng.toFixed(2)}`) +
                          " → " +
                          (tl.end_label || `${tl.end_lat.toFixed(2)},${tl.end_lng.toFixed(2)}`)}
                      </span>
                      <span className="text-gray-500">{fmtDate(tl.start_date)} · {tl.mode}</span>
                    </span>
                    <button
                      onClick={() => setEditingTravelLeg(tl)}
                      title="Edit"
                      className="text-gray-500 hover:text-indigo-400 px-1"
                    >
                      ✎
                    </button>
                    <button
                      onClick={async () => {
                        if (!confirm("Delete this travel leg?")) return;
                        const r = await fetch(
                          `/api/strava/groups/${group.id}/travel-legs/${tl.id}`,
                          { method: "DELETE" }
                        );
                        if (r.ok) {
                          setTravelLegs(travelLegs.filter((x) => x.id !== tl.id));
                          onChanged();
                        }
                      }}
                      title="Delete"
                      className="text-gray-500 hover:text-red-400 px-1"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {error && <div className="text-xs text-red-400">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-800">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800/40"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !dirty || !name.trim()}
            className="rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      {editingTravelLeg && (
        <TravelLegModal
          groupId={group.id}
          members={members}
          existing={editingTravelLeg === "new" ? null : editingTravelLeg}
          onClose={() => setEditingTravelLeg(null)}
          onSaved={(saved) => {
            setTravelLegs((prev) => {
              const without = prev.filter((x) => x.id !== saved.id);
              return [...without, saved];
            });
            setEditingTravelLeg(null);
            onChanged();
          }}
        />
      )}

      {showAddMembers && (
        <AddMembersModal
          athleteId={athleteId}
          existingMemberIds={members.map((m) => m.id)}
          initialDateFrom={group.start_date}
          initialDateTo={group.end_date}
          onClose={() => setShowAddMembers(false)}
          onSubmit={(newActivities) => {
            const additions: TripGroupMember[] = newActivities.map((a) => ({
              id: a.id,
              name: a.name,
              sport_type: a.sport_type,
              start_date_local: a.start_date_local,
              distance: a.distance,
              moving_time: a.moving_time,
              elapsed_time: null,
              total_elevation_gain: a.total_elevation_gain,
              average_heartrate: a.average_heartrate,
              map_summary_polyline: null,
              leg_order: 0, // server resequences on save
            }));
            const merged = [...members, ...additions].sort((a, b) =>
              a.start_date_local.localeCompare(b.start_date_local)
            );
            setMembers(merged);
            setShowAddMembers(false);
          }}
        />
      )}
    </div>
  );
}

function TravelLegModal({
  groupId,
  members,
  existing,
  onClose,
  onSaved,
}: {
  groupId: number;
  members: TripGroupMember[];
  existing: TripTravelLeg | null;
  onClose: () => void;
  onSaved: (saved: TripTravelLeg) => void;
}) {
  const [mode, setMode] = useState<string>(existing?.mode ?? "train");
  const [startDate, setStartDate] = useState(existing?.start_date.slice(0, 10) ?? "");
  const [startLabel, setStartLabel] = useState(existing?.start_label ?? "");
  const [startLat, setStartLat] = useState<string>(existing ? String(existing.start_lat) : "");
  const [startLng, setStartLng] = useState<string>(existing ? String(existing.start_lng) : "");
  const [endLabel, setEndLabel] = useState(existing?.end_label ?? "");
  const [endLat, setEndLat] = useState<string>(existing ? String(existing.end_lat) : "");
  const [endLng, setEndLng] = useState<string>(existing ? String(existing.end_lng) : "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Endpoint-from-activity picker: derive start/end coords from a member's polyline.
  type EndpointOption = { key: string; label: string; lat: number; lng: number };
  const endpointOptions: EndpointOption[] = members.flatMap((m) => {
    if (!m.map_summary_polyline) return [];
    const pts = decodePolyline(m.map_summary_polyline);
    if (pts.length < 2) return [];
    const start = pts[0]!;
    const end = pts[pts.length - 1]!;
    return [
      {
        key: `${m.id}-start`,
        label: `Start of "${m.name}" (${fmtDate(m.start_date_local)})`,
        lat: start[0],
        lng: start[1],
      },
      {
        key: `${m.id}-end`,
        label: `End of "${m.name}" (${fmtDate(m.start_date_local)})`,
        lat: end[0],
        lng: end[1],
      },
    ];
  });

  function applyEndpoint(which: "start" | "end", key: string) {
    if (!key) return;
    const opt = endpointOptions.find((o) => o.key === key);
    if (!opt) return;
    if (which === "start") {
      setStartLat(opt.lat.toFixed(5));
      setStartLng(opt.lng.toFixed(5));
    } else {
      setEndLat(opt.lat.toFixed(5));
      setEndLng(opt.lng.toFixed(5));
    }
  }

  async function save() {
    setError(null);
    const sLat = Number(startLat), sLng = Number(startLng);
    const eLat = Number(endLat), eLng = Number(endLng);
    if (!startDate) return setError("Date is required");
    if (Number.isNaN(sLat) || Number.isNaN(sLng) || Number.isNaN(eLat) || Number.isNaN(eLng))
      return setError("All four coordinates are required");
    const body = {
      mode,
      start_date: startDate,
      start_lat: sLat,
      start_lng: sLng,
      start_label: startLabel.trim() || null,
      end_lat: eLat,
      end_lng: eLng,
      end_label: endLabel.trim() || null,
      notes: notes.trim() || null,
    };
    setSaving(true);
    try {
      const url = existing
        ? `/api/strava/groups/${groupId}/travel-legs/${existing.id}`
        : `/api/strava/groups/${groupId}/travel-legs`;
      const r = await fetch(url, {
        method: existing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        setError(data.error ?? "Save failed");
        return;
      }
      const saved = await r.json();
      onSaved({
        id: existing?.id ?? saved.id,
        mode: saved.mode,
        start_date: saved.start_date,
        start_lat: saved.start_lat,
        start_lng: saved.start_lng,
        start_label: saved.start_label,
        end_lat: saved.end_lat,
        end_lng: saved.end_lng,
        end_label: saved.end_label,
        notes: saved.notes,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[2100] bg-black/70 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-gray-900 rounded-xl border border-gray-700 flex flex-col" style={{ maxHeight: "90vh" }}>
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <h3 className="text-base font-semibold text-gray-100">
            {existing ? "Edit travel leg" : "Add travel leg"}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200">✕</button>
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-gray-400">Mode</label>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-gray-200"
              >
                {TRAVEL_MODES.map((m) => (
                  <option key={m} value={m}>{travelIcon(m)} {m}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-gray-400">Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-gray-200"
              />
            </div>
          </div>

          <div className="rounded-lg border border-gray-800 p-3 space-y-2">
            <div className="text-gray-400 font-medium">From</div>
            {endpointOptions.length > 0 && (
              <select
                onChange={(e) => { applyEndpoint("start", e.target.value); e.target.value = ""; }}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-gray-300"
                defaultValue=""
              >
                <option value="">Pre-fill from activity endpoint…</option>
                {endpointOptions.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
            )}
            <input
              placeholder="Label (e.g. Perpignan)"
              value={startLabel}
              onChange={(e) => setStartLabel(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-gray-200"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                placeholder="Latitude"
                value={startLat}
                onChange={(e) => setStartLat(e.target.value)}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-gray-200"
              />
              <input
                placeholder="Longitude"
                value={startLng}
                onChange={(e) => setStartLng(e.target.value)}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-gray-200"
              />
            </div>
          </div>

          <div className="rounded-lg border border-gray-800 p-3 space-y-2">
            <div className="text-gray-400 font-medium">To</div>
            {endpointOptions.length > 0 && (
              <select
                onChange={(e) => { applyEndpoint("end", e.target.value); e.target.value = ""; }}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-gray-300"
                defaultValue=""
              >
                <option value="">Pre-fill from activity endpoint…</option>
                {endpointOptions.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </select>
            )}
            <input
              placeholder="Label (e.g. Lunel)"
              value={endLabel}
              onChange={(e) => setEndLabel(e.target.value)}
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-gray-200"
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                placeholder="Latitude"
                value={endLat}
                onChange={(e) => setEndLat(e.target.value)}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-gray-200"
              />
              <input
                placeholder="Longitude"
                value={endLng}
                onChange={(e) => setEndLng(e.target.value)}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-gray-200"
              />
            </div>
          </div>

          <div>
            <label className="text-gray-400">Notes (optional)</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Bike malfunction forced this train"
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-800 px-2 py-1.5 text-gray-200"
            />
          </div>

          {error && <div className="text-red-400">{error}</div>}
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-800">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800/40"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-40"
          >
            {saving ? "Saving…" : existing ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateGroupModal({
  athleteId,
  onClose,
  onCreated,
}: {
  athleteId: number;
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({
      athlete_id: String(athleteId),
      limit: "100",
    });
    if (search) params.set("search", search);
    if (dateFrom) params.set("date_from", dateFrom);
    if (dateTo) params.set("date_to", `${dateTo}T23:59:59`);
    fetch(`/api/strava/activities?${params}`)
      .then((r) => r.json())
      .then((acts: Activity[]) => setActivities(acts))
      .catch(() => setActivities([]));
  }, [athleteId, search, dateFrom, dateTo]);

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function submit() {
    setError(null);
    if (!name.trim()) {
      setError("Name required");
      return;
    }
    if (selected.size < 1) {
      setError("Select at least one activity");
      return;
    }
    setSubmitting(true);
    try {
      const r = await fetch("/api/strava/groups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          athlete_id: athleteId,
          name: name.trim(),
          description: description.trim() || null,
          activity_ids: Array.from(selected),
        }),
      });
      const data = await r.json();
      if (r.ok && data.id) {
        onCreated(data.id);
      } else {
        setError(data.error ?? "Failed to create trip");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[2000] bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="w-full sm:max-w-2xl bg-gray-900 sm:rounded-xl border border-gray-700 flex flex-col"
        style={{ maxHeight: "90vh" }}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <h3 className="text-base font-semibold text-gray-100">New Trip</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4 space-y-4">
          <div>
            <label className="text-xs font-medium text-gray-400">Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Vermont Bike Trip"
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-400">
              Description (optional)
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-400">
                Activities ({selected.size} selected · {activities.length} matching)
              </label>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="text-xs rounded border border-gray-700 bg-gray-800 px-2 py-1 text-gray-200 focus:border-indigo-500 focus:outline-none w-32"
              />
            </div>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <label className="text-xs text-gray-400">
                From
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 focus:border-indigo-500 focus:outline-none"
                />
              </label>
              <label className="text-xs text-gray-400">
                To
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 focus:border-indigo-500 focus:outline-none"
                />
              </label>
            </div>
            {(dateFrom || dateTo) && (
              <button
                type="button"
                onClick={() => {
                  setDateFrom("");
                  setDateTo("");
                }}
                className="mb-2 text-[10px] text-indigo-400 hover:text-indigo-300"
              >
                Clear dates
              </button>
            )}
            <div className="max-h-72 overflow-auto rounded-lg border border-gray-800 divide-y divide-gray-800">
              {activities.length === 0 ? (
                <div className="p-3 text-xs text-gray-500">
                  No activities found.
                </div>
              ) : (
                activities.map((a) => (
                  <label
                    key={a.id}
                    className="flex items-center gap-2 p-2 hover:bg-gray-800/40 cursor-pointer text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(a.id)}
                      onChange={() => toggle(a.id)}
                      className="rounded border-gray-700"
                    />
                    <span className="w-6">{sportIcon(a.sport_type)}</span>
                    <span className="flex-1 min-w-0">
                      <span className="text-gray-200 truncate block">
                        {a.name}
                      </span>
                      <span className="text-gray-500">
                        {fmtDate(a.start_date_local)} ·{" "}
                        {fmtDistance(a.distance)}
                      </span>
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>

          {error && <div className="text-xs text-red-400">{error}</div>}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-800">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800/40"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || selected.size < 1 || !name.trim()}
            className="rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-40"
          >
            {submitting ? "Creating..." : "Create Trip"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddMembersModal({
  athleteId,
  existingMemberIds,
  initialDateFrom,
  initialDateTo,
  onClose,
  onSubmit,
}: {
  athleteId: number;
  existingMemberIds: number[];
  initialDateFrom?: string | null;
  initialDateTo?: string | null;
  onClose: () => void;
  // Returns the FULL Activity objects (not just IDs) so the caller doesn't
  // need to re-fetch — picking an activity from outside the recent window
  // (e.g. an old trip from a prior year) still includes its data.
  onSubmit: (activities: Activity[]) => void;
}) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState(initialDateFrom ?? "");
  const [dateTo, setDateTo] = useState(initialDateTo ?? "");
  const existingSet = new Set(existingMemberIds);

  useEffect(() => {
    const params = new URLSearchParams({
      athlete_id: String(athleteId),
      limit: "100",
    });
    if (search) params.set("search", search);
    if (dateFrom) params.set("date_from", dateFrom);
    // Make the to-date inclusive of the whole day (start_date_local is full ISO)
    if (dateTo) params.set("date_to", `${dateTo}T23:59:59`);
    fetch(`/api/strava/activities?${params}`)
      .then((r) => r.json())
      .then((acts: Activity[]) =>
        setActivities(acts.filter((a) => !existingSet.has(a.id)))
      )
      .catch(() => setActivities([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athleteId, search, dateFrom, dateTo]);

  function toggle(id: number) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  return (
    <div className="fixed inset-0 z-[2000] bg-black/70 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div
        className="w-full sm:max-w-2xl bg-gray-900 sm:rounded-xl border border-gray-700 flex flex-col"
        style={{ maxHeight: "90vh" }}
      >
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <h3 className="text-base font-semibold text-gray-100">Add Legs</h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-200"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-auto p-4 space-y-3">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search activities..."
            className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
          />
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-gray-400">
              From
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 focus:border-indigo-500 focus:outline-none"
              />
            </label>
            <label className="text-xs text-gray-400">
              To
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="mt-1 w-full rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-xs text-gray-200 focus:border-indigo-500 focus:outline-none"
              />
            </label>
          </div>
          {(dateFrom || dateTo) && (
            <button
              type="button"
              onClick={() => {
                setDateFrom("");
                setDateTo("");
              }}
              className="text-[10px] text-indigo-400 hover:text-indigo-300"
            >
              Clear dates
            </button>
          )}
          <div className="text-xs text-gray-500">
            {selected.size} selected · {activities.length} matching
          </div>
          <div className="max-h-96 overflow-auto rounded-lg border border-gray-800 divide-y divide-gray-800">
            {activities.length === 0 ? (
              <div className="p-3 text-xs text-gray-500">
                No additional activities.
              </div>
            ) : (
              activities.map((a) => (
                <label
                  key={a.id}
                  className="flex items-center gap-2 p-2 hover:bg-gray-800/40 cursor-pointer text-xs"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(a.id)}
                    onChange={() => toggle(a.id)}
                    className="rounded border-gray-700"
                  />
                  <span className="w-6">{sportIcon(a.sport_type)}</span>
                  <span className="flex-1 min-w-0">
                    <span className="text-gray-200 truncate block">
                      {a.name}
                    </span>
                    <span className="text-gray-500">
                      {fmtDate(a.start_date_local)} · {fmtDistance(a.distance)}
                    </span>
                  </span>
                </label>
              ))
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 p-4 border-t border-gray-800">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-800/40"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(activities.filter((a) => selected.has(a.id)))}
            disabled={selected.size < 1}
            className="rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-600 disabled:opacity-40"
          >
            Add {selected.size > 0 ? `(${selected.size})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}

function AthleteSection({ athlete }: { athlete: Athlete }) {
  const [tab, setTab] = useState<AthleteTab>("calendar");
  const [streak, setStreak] = useState<number>(0);

  useEffect(() => {
    fetch(`/api/strava/streak?athlete_id=${athlete.athlete_id}`)
      .then((r) => r.json())
      .then((d) => setStreak(d.streak ?? 0))
      .catch(() => {});
  }, [athlete.athlete_id]);

  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900/60 overflow-hidden">
      {/* Athlete header */}
      <div className="flex items-start gap-4 p-5 border-b border-gray-800">
        {athlete.profile_pic ? (
          <img
            src={athlete.profile_pic}
            alt={athlete.name}
            className="h-12 w-12 rounded-full object-cover shrink-0"
          />
        ) : (
          <div className="h-12 w-12 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-400 text-lg font-bold shrink-0">
            {athlete.name.charAt(0)}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-gray-100">{athlete.name.split(" ")[0]}</h2>
            {athlete.show_streak && streak > 0 && (
              <span className="rounded-full bg-orange-500/15 border border-orange-500/30 px-2 py-0.5 text-xs font-medium text-orange-400">
                🔥 {streak}w
              </span>
            )}
          </div>
          {athlete.city && (
            <p className="text-xs text-gray-500 mt-0.5">
              {[athlete.city, athlete.state, athlete.country].filter(Boolean).join(", ")}
            </p>
          )}
          <p className="text-xs text-gray-600 mt-1">{relativeSync(athlete.last_sync)}</p>
        </div>
        {/* Totals chips */}
        <div className="hidden sm:flex flex-wrap gap-3 shrink-0">
          <div className="text-right">
            <p className="text-xs text-gray-500">Activities</p>
            <p className="text-sm font-semibold text-gray-200">{athlete.total_activities.toLocaleString()}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-500">Distance</p>
            <p className="text-sm font-semibold text-gray-200">{Math.round(athlete.total_distance_m / 1000).toLocaleString()} km</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-500">Time</p>
            <p className="text-sm font-semibold text-gray-200">{Math.round(athlete.total_moving_time_s / 3600).toLocaleString()}h</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-500">Elevation</p>
            <p className="text-sm font-semibold text-gray-200">{Math.round(athlete.total_elevation_m).toLocaleString()} m</p>
          </div>
        </div>
      </div>

      {/* Mobile totals */}
      <div className="grid grid-cols-4 gap-0 border-b border-gray-800 sm:hidden">
        {[
          { label: "Activities", value: athlete.total_activities.toLocaleString() },
          { label: "Distance", value: Math.round(athlete.total_distance_m / 1000).toLocaleString() + " km" },
          { label: "Time", value: Math.round(athlete.total_moving_time_s / 3600).toLocaleString() + "h" },
          { label: "Elevation", value: Math.round(athlete.total_elevation_m).toLocaleString() + " m" },
        ].map(({ label, value }) => (
          <div key={label} className="py-3 text-center border-r border-gray-800 last:border-0">
            <p className="text-xs text-gray-500">{label}</p>
            <p className="text-xs font-semibold text-gray-200 mt-0.5">{value}</p>
          </div>
        ))}
      </div>

      {/* Sub-tabs */}
      <div className="flex border-b border-gray-800 px-2 sm:px-4 pt-2 sm:pt-3 gap-0 sm:gap-1">
        {ATHLETE_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex flex-col sm:flex-row items-center gap-0.5 sm:gap-1.5 px-1.5 sm:px-3 py-1.5 sm:py-2 text-[10px] sm:text-sm font-medium transition-colors border-b-2 -mb-px min-w-0 flex-1 sm:flex-none ${
              tab === t.key
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-gray-400 hover:text-gray-300"
            }`}
          >
            <span className="text-sm sm:text-sm leading-none">{t.icon}</span>
            <span className="truncate">{t.label}</span>
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="p-4 sm:p-5">
        {tab === "calendar" && <CalendarTab athleteId={athlete.athlete_id} />}
        {tab === "stats" && <StatsTab athleteId={athlete.athlete_id} />}
        {tab === "activities" && <ActivitiesTab athleteId={athlete.athlete_id} />}
        {tab === "trips" && (
          <TripsTab key={athlete.athlete_id} athleteId={athlete.athlete_id} />
        )}
        {tab === "trends" && <TrendsTab athleteId={athlete.athlete_id} />}
        {tab === "ask" && <AiSearch athleteId={athlete.athlete_id} />}
      </div>
    </div>
  );
}

// ── AI Search ─────────────────────────────────────────────────────────────────

function AiSearch({ athleteId }: { athleteId: number }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "pending" | "done" | "error">("idle");

  async function ask() {
    if (!question.trim()) return;
    setStatus("pending");
    setAnswer(null);
    try {
      const res = await fetch("/api/strava/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question, athlete_id: athleteId }),
      });
      const { task_id, error } = await res.json() as { task_id?: string; error?: string };
      if (!task_id) { setAnswer(error ?? "Failed to submit."); setStatus("error"); return; }

      // Poll for the answer
      const start = Date.now();
      while (Date.now() - start < 90_000) {
        await new Promise((r) => setTimeout(r, 2500));
        const poll = await fetch(`/api/strava/ask/${task_id}`).then((r) => r.json()) as { status: string; answer?: string };
        if (poll.status === "done") {
          setAnswer(poll.answer ?? "No answer.");
          setStatus("done");
          return;
        }
      }
      setAnswer("Timed out waiting for answer.");
      setStatus("error");
    } catch {
      setAnswer("Failed to get an answer.");
      setStatus("error");
    }
  }

  return (
    <div className="rounded-2xl border border-gray-800 bg-gray-900/60 p-5">
      <h3 className="text-sm font-semibold text-gray-200 mb-3">Ask about your activities</h3>
      <div className="flex flex-col gap-3 sm:flex-row">
        <input
          type="text"
          placeholder='e.g. "When did I last swim?"'
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
        />
        <button
          onClick={ask}
          disabled={status === "pending" || !question.trim()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 transition-colors"
        >
          {status === "pending" ? "Thinking..." : "Ask"}
        </button>
      </div>
      {status === "pending" && (
        <p className="mt-3 text-xs text-gray-500 animate-pulse">Running query in background (~20–30s)…</p>
      )}
      {answer && (
        <div className="mt-4 rounded-xl border border-gray-700 bg-gray-800 p-4 text-sm text-gray-200 whitespace-pre-wrap leading-relaxed">
          {answer}
        </div>
      )}
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function StravaPage() {
  const [athletes, setAthletes] = useState<Athlete[] | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);

  useEffect(() => {
    fetch("/api/strava/athletes")
      .then((r) => r.json())
      .then(setAthletes)
      .catch(() => setAthletes([]));
  }, []);

  if (athletes === null) {
    return <div className="p-6 text-sm text-gray-500">Loading...</div>;
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold text-gray-100">Strava</h1>
        {athletes.length > 0 && (
          <a
            href={`/api/strava/export.csv?athlete_id=${athletes[activeIdx].athlete_id}`}
            download
            className="rounded-md px-3 py-1.5 text-xs font-medium bg-gray-800 text-gray-300 hover:text-gray-100 transition-colors"
          >
            ↓ Export CSV
          </a>
        )}
      </div>

      {athletes.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {/* Account tabs */}
          {athletes.length > 1 && (
            <div className="flex gap-1 rounded-lg bg-gray-900 p-1 w-full sm:w-fit">
              {athletes.map((a, i) => (
                <button
                  key={a.athlete_id}
                  onClick={() => setActiveIdx(i)}
                  className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                    activeIdx === i
                      ? "bg-gray-800 text-gray-100"
                      : "text-gray-400 hover:text-gray-300"
                  }`}
                >
                  {a.profile_pic && (
                    <img
                      src={a.profile_pic}
                      alt={a.name}
                      className="h-5 w-5 rounded-full object-cover"
                    />
                  )}
                  {a.name.split(" ")[0]}
                </button>
              ))}
            </div>
          )}

          {/* Active athlete section */}
          <AthleteSection athlete={athletes[activeIdx]} />
        </>
      )}
    </div>
  );
}
