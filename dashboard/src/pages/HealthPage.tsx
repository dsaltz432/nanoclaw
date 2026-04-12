import { useEffect, useState, useRef, useCallback, Fragment } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GarminProfile { slug: string; display_name: string; full_name: string; connected: boolean; day_count: number; last_sync: string | null }
interface TrendPoint { date: string; value: number }
interface SleepPoint { date: string; total_hours: number; deep_hours: number; light_hours: number; rem_hours: number; awake_hours: number; sleep_score: number | null; average_heart_rate?: number | null; average_respiration_value?: number | null; average_spo2?: number | null }
interface SleepDetail { date: string; total_hours: number; deep_hours: number; light_hours: number; rem_hours: number; awake_hours: number; sleep_score: number | null; sleep_score_feedback: string | null; sleep_score_insight: string | null; average_heart_rate: number | null; lowest_heart_rate: number | null; average_respiration_value: number | null; lowest_respiration_value: number | null; highest_respiration_value: number | null; average_spo2: number | null; lowest_spo2: number | null; avg_sleep_stress: number | null }

// ── Config ────────────────────────────────────────────────────────────────────

const METRICS = [
  { key: "resting_hr",        label: "Resting HR",        unit: "bpm",  color: "#ef4444", invert: true,  desc: "Heart rate at complete rest. Lower is generally better for cardiovascular fitness." },
  { key: "steps",             label: "Steps",             unit: "steps",color: "#6366f1", invert: false, desc: "Total daily step count from your watch." },
  { key: "intensity_minutes", label: "Intensity Min",     unit: "min",  color: "#f59e0b", invert: false, desc: "Minutes of moderate + 2× vigorous activity. WHO recommends 150 min/week." },
  { key: "hrv",               label: "HRV",               unit: "ms",   color: "#10b981", invert: false, desc: "Heart rate variability measured overnight. Higher indicates better recovery and fitness." },
  { key: "endurance_score",   label: "Endurance",         unit: "",     color: "#3b82f6", invert: false, desc: "Garmin's cumulative endurance score. Trained: 5800+, Well-trained: 6600+, Expert: 7300+." },
  { key: "respiration",       label: "Respiration",       unit: "brpm", color: "#8b5cf6", invert: true,  desc: "Average waking breathing rate. Typical range is 12–20 breaths per minute." },
  { key: "vo2max",            label: "VO₂ Max",           unit: "ml/kg",color: "#06b6d4", invert: false, desc: "Max oxygen uptake estimated from activities. Higher is better. Superior: 50+ for most ages." },
  { key: "body_battery",      label: "Body Battery",      unit: "%",    color: "#f97316", invert: false, desc: "End-of-day energy level (0–100) based on HRV, stress, sleep, and activity." },
  { key: "sleep_duration",    label: "Sleep",             unit: "hrs",  color: "#a78bfa", invert: false, desc: "Total sleep duration. Most adults need 7–9 hours per night." },
] as const;

type MetricKey = typeof METRICS[number]["key"];

const RANGES: { label: string; days: number }[] = [
  { label: "1W",  days: 7   },
  { label: "1M",  days: 30  },
  { label: "3M",  days: 90  },
  { label: "6M",  days: 180 },
  { label: "1Y",  days: 365 },
  { label: "2Y",  days: 730 },
  { label: "5Y",  days: 1825},
  { label: "7Y",  days: 2555},
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getAgg(days: number): "day" | "week" | "month" {
  return days > 180 ? "month" : days > 30 ? "week" : "day";
}

function fmtAxis(d: string, agg: "day" | "week" | "month"): string {
  const date = new Date(d + "T12:00:00");
  if (agg === "month") return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtTooltip(d: string, agg: "day" | "week" | "month"): string {
  const date = new Date(d + "T12:00:00");
  if (agg === "month") return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  if (agg === "week") return "Week of " + date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function aggLabel(agg: "day" | "week" | "month"): string {
  if (agg === "month") return "Monthly avg";
  if (agg === "week")  return "Weekly avg";
  return "Daily";
}

function fmtVal(val: number, unit: string): string {
  if (unit === "steps") return Math.round(val).toLocaleString();
  if (unit === "hrs") return val.toFixed(1) + "h";
  // Metrics that benefit from decimals
  if (unit === "ml/kg" || unit === "ms") return val.toFixed(1) + " " + unit;
  // Integer metrics: bpm, min, %, brpm, no-unit scores
  if (unit === "bpm" || unit === "min" || unit === "%" || unit === "brpm" || unit === "")
    return Math.round(val).toString() + (unit ? " " + unit : "");
  return val.toFixed(1) + (unit ? " " + unit : "");
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3600000);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Large SVG trend chart ─────────────────────────────────────────────────────

function TrendChart({
  data, color, unit, days,
}: {
  data: TrendPoint[]; color: string; unit: string; days: number;
}) {
  const [hov, setHov] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (data.length < 2) return (
    <div className="flex h-48 items-center justify-center text-sm text-gray-600">
      Not enough data for this time range
    </div>
  );

  const agg = getAgg(days);
  const vals = data.map((d) => d.value);
  const rawMin = Math.min(...vals);
  const rawMax = Math.max(...vals);
  const rawRange = rawMax - rawMin;
  // When range is very small (flat data), pad by 0.5 above and below to center the line
  const padding = rawRange < 1 ? 0.5 : 0;
  const minV = rawMin - padding;
  const maxV = rawMax + padding;
  const range = maxV - minV;

  const W = 600, H = 260, padL = 34, padR = 8, padT = 10, padB = 30;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const toX = (i: number) => padL + (i / (data.length - 1)) * chartW;
  const toY = (v: number) => padT + chartH - ((v - minV) / range) * chartH;

  const pts = data.map((d, i) => `${toX(i)},${toY(d.value)}`).join(" ");

  // Show all labels when ≤10 points, otherwise ~6 evenly spaced
  const tickCount = data.length <= 10 ? data.length : Math.min(6, data.length);
  const tickIndices = tickCount === data.length
    ? data.map((_, i) => i)
    : Array.from({ length: tickCount }, (_, i) => Math.round((i / (tickCount - 1)) * (data.length - 1)));

  const yTicks = [0, 0.33, 0.67, 1].map((f) => minV + f * range);

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((x - padL) / chartW) * (data.length - 1));
    setHov(Math.max(0, Math.min(data.length - 1, idx)));
  }, [data.length]);

  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;

  return (
    <div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHov(null)}
      >
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={padL} y1={toY(v)} x2={W - padR} y2={toY(v)} stroke="#1f2937" strokeWidth={1} />
            <text x={padL - 4} y={toY(v) + 4} textAnchor="end" fontSize={11} fill="#4b5563">
              {unit === "steps" ? (v/1000).toFixed(0)+"k" : unit === "hrs" ? v.toFixed(1) : range < 4 ? v.toFixed(1) : Math.round(v)}
            </text>
          </g>
        ))}

        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.15" />
            <stop offset="100%" stopColor={color} stopOpacity="0.01" />
          </linearGradient>
        </defs>
        <polygon
          points={`${padL},${padT + chartH} ${pts} ${toX(data.length-1)},${padT + chartH}`}
          fill="url(#areaGrad)"
        />
        <polyline points={pts} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />

        {hov !== null && (() => {
          const cx = toX(hov);
          const cy = toY(data[hov].value);
          const label = fmtTooltip(data[hov].date, agg);
          const valStr = fmtVal(data[hov].value, unit);
          const TW = Math.max(120, label.length * 6.5), TH = 44, TPad = 6;
          const aboveY = cy - TH - 10;
          const ty = aboveY < padT ? cy + 12 : aboveY;
          const tx = Math.max(padL, Math.min(cx - TW / 2, W - padR - TW));
          return (
            <>
              <line x1={cx} y1={padT} x2={cx} y2={padT + chartH} stroke="#374151" strokeWidth={1} strokeDasharray="3,3" />
              <circle cx={cx} cy={cy} r={4} fill={color} stroke="#111827" strokeWidth={2} />
              <g transform={`translate(${tx},${ty})`}>
                <rect width={TW} height={TH} rx={6} fill="#111827" stroke="#374151" strokeWidth={1} />
                <text x={TW / 2} y={TPad + 10} textAnchor="middle" fontSize={9.5} fill="#6b7280">{label}</text>
                <text x={TW / 2} y={TPad + 28} textAnchor="middle" fontSize={13} fontWeight="700" fill="#f9fafb">{valStr}</text>
              </g>
            </>
          );
        })()}

        {tickIndices.map((i) => (
          <text key={i} x={toX(i)} y={H - 6} textAnchor="middle" fontSize={11} fill="#4b5563">
            {fmtAxis(data[i].date, agg)}
          </text>
        ))}

        <line x1={padL} y1={padT + chartH} x2={W - padR} y2={padT + chartH} stroke="#1f2937" strokeWidth={1} />
      </svg>
    </div>
  );
}

// ── Sleep detail modal ────────────────────────────────────────────────────────

function SleepDetailModal({ date, profile, onClose }: { date: string; profile: string; onClose: () => void }) {
  const [detail, setDetail] = useState<SleepDetail | null | "loading">("loading");

  useEffect(() => {
    fetch(`/api/garmin/sleep/${date}?profile=${profile}`)
      .then((r) => r.json())
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [date, profile]);

  const d = typeof detail === "object" ? detail : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-sm rounded-xl border border-gray-700 bg-gray-900 p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button onClick={onClose} className="absolute right-3 top-3 text-gray-500 hover:text-gray-300 text-lg leading-none">×</button>
        <h3 className="mb-4 text-sm font-semibold text-gray-200">
          Sleep · {date ? new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }) : date}
        </h3>
        {detail === "loading" ? (
          <div className="text-sm text-gray-600 py-6 text-center">Loading…</div>
        ) : !d ? (
          <div className="text-sm text-gray-600 py-6 text-center">No detail available</div>
        ) : (
          <div className="space-y-3">
            {/* Score */}
            {d.sleep_score != null && (
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-a78bfa text-lg font-bold text-purple-400" style={{ borderColor: "#a78bfa" }}>
                  {d.sleep_score}
                </div>
                <div className="text-xs text-gray-400">
                  {d.sleep_score_feedback && <div className="font-medium text-gray-300">{d.sleep_score_feedback}</div>}
                  {d.sleep_score_insight && <div className="mt-0.5">{d.sleep_score_insight}</div>}
                </div>
              </div>
            )}

            {/* Sleep stages */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              {[
                { label: "Total", val: d.total_hours, color: "#a78bfa" },
                { label: "Deep",  val: d.deep_hours,  color: "#3b82f6" },
                { label: "REM",   val: d.rem_hours,   color: "#8b5cf6" },
                { label: "Light", val: d.light_hours, color: "#6b7280" },
                { label: "Awake", val: d.awake_hours, color: "#374151" },
              ].map(({ label, val, color }) => (
                <div key={label} className="flex items-center gap-2 rounded-lg bg-gray-800 px-3 py-2">
                  <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
                  <span className="text-gray-400">{label}</span>
                  <span className="ml-auto font-semibold text-gray-200">{(val || 0).toFixed(1)}h</span>
                </div>
              ))}
            </div>

            {/* Vitals */}
            <div className="grid grid-cols-3 gap-2 text-xs">
              {d.average_heart_rate != null && (
                <div className="rounded-lg bg-gray-800 px-2 py-2 text-center">
                  <div className="text-gray-500">HR avg</div>
                  <div className="font-semibold text-gray-200">{d.average_heart_rate} bpm</div>
                </div>
              )}
              {d.lowest_heart_rate != null && (
                <div className="rounded-lg bg-gray-800 px-2 py-2 text-center">
                  <div className="text-gray-500">HR low</div>
                  <div className="font-semibold text-gray-200">{d.lowest_heart_rate} bpm</div>
                </div>
              )}
              {d.average_respiration_value != null && (
                <div className="rounded-lg bg-gray-800 px-2 py-2 text-center">
                  <div className="text-gray-500">Resp</div>
                  <div className="font-semibold text-gray-200">{d.average_respiration_value} brpm</div>
                </div>
              )}
              {d.average_spo2 != null && (
                <div className="rounded-lg bg-gray-800 px-2 py-2 text-center">
                  <div className="text-gray-500">SpO₂</div>
                  <div className="font-semibold text-gray-200">{d.average_spo2}%</div>
                </div>
              )}
              {d.avg_sleep_stress != null && (
                <div className="rounded-lg bg-gray-800 px-2 py-2 text-center">
                  <div className="text-gray-500">Stress</div>
                  <div className="font-semibold text-gray-200">{d.avg_sleep_stress}</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Body Battery band chart ────────────────────────────────────────────────────

interface BatteryPoint { date: string; peak: number; end_of_day: number }

function BodyBatteryChart({ data, days }: { data: BatteryPoint[]; days: number }) {
  const [hov, setHov] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (data.length < 2) return (
    <div className="flex h-48 items-center justify-center text-sm text-gray-600">Not enough data</div>
  );

  const agg = getAgg(days);
  const W = 600, H = 260, padL = 34, padR = 8, padT = 10, padB = 30;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const maxV = Math.max(...data.map((d) => d.peak), 100);
  const minV = 0;
  const toX = (i: number) => padL + (i / (data.length - 1)) * chartW;
  const toY = (v: number) => padT + chartH - ((v - minV) / (maxV - minV)) * chartH;

  const peakPts   = data.map((d, i) => `${toX(i)},${toY(d.peak)}`).join(" ");
  const eodPts    = data.map((d, i) => `${toX(i)},${toY(d.end_of_day)}`).join(" ");
  const bandPts   = [
    ...data.map((d, i) => `${toX(i)},${toY(d.peak)}`),
    ...[...data].reverse().map((d, i) => `${toX(data.length - 1 - i)},${toY(d.end_of_day)}`),
  ].join(" ");

  const tickCount = data.length <= 10 ? data.length : Math.min(6, data.length);
  const tickIndices = tickCount === data.length
    ? data.map((_, i) => i)
    : Array.from({ length: tickCount }, (_, i) => Math.round((i / (tickCount - 1)) * (data.length - 1)));

  const yTicks = [0, 25, 50, 75, 100];

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((x - padL) / chartW) * (data.length - 1));
    setHov(Math.max(0, Math.min(data.length - 1, idx)));
  }, [data.length]);

  const avgPeak = Math.round(data.reduce((a, b) => a + b.peak, 0) / data.length);
  const avgEod  = Math.round(data.reduce((a, b) => a + b.end_of_day, 0) / data.length);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-sm inline-block" style={{ background: "#f59e0b" }} />
          Morning peak <span className="text-gray-300 font-medium">avg {avgPeak}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-sm inline-block" style={{ background: "#6b7280" }} />
          End of day <span className="text-gray-300 font-medium">avg {avgEod}</span>
        </span>
        {agg !== "day" && (
          <span className="ml-auto rounded-full bg-gray-800 px-2 py-0.5 text-xs text-gray-500">{aggLabel(agg)}</span>
        )}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHov(null)}
      >
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={padL} y1={toY(v)} x2={W - padR} y2={toY(v)} stroke="#1f2937" strokeWidth={1} />
            <text x={padL - 4} y={toY(v) + 4} textAnchor="end" fontSize={11} fill="#4b5563">{v}</text>
          </g>
        ))}

        {/* Band fill */}
        <polygon points={bandPts} fill="#f59e0b" fillOpacity={0.12} />

        {/* End-of-day line */}
        <polyline points={eodPts} fill="none" stroke="#6b7280" strokeWidth={1.5} strokeLinejoin="round" strokeDasharray="4,2" />

        {/* Peak line */}
        <polyline points={peakPts} fill="none" stroke="#f59e0b" strokeWidth={2} strokeLinejoin="round" />

        {/* Hover */}
        {hov !== null && (() => {
          const cx = toX(hov);
          const label = fmtTooltip(data[hov].date, agg);
          const TW = Math.max(130, label.length * 6.5), TH = 54, TPad = 6;
          const cy = toY(data[hov].peak);
          const aboveY = cy - TH - 10;
          const ty = aboveY < padT ? cy + 12 : aboveY;
          const tx = Math.max(padL, Math.min(cx - TW / 2, W - padR - TW));
          return (
            <>
              <line x1={cx} y1={padT} x2={cx} y2={padT + chartH} stroke="#374151" strokeWidth={1} strokeDasharray="3,3" />
              <circle cx={cx} cy={toY(data[hov].peak)} r={4} fill="#f59e0b" stroke="#111827" strokeWidth={2} />
              <circle cx={cx} cy={toY(data[hov].end_of_day)} r={3} fill="#6b7280" stroke="#111827" strokeWidth={2} />
              <g transform={`translate(${tx},${ty})`}>
                <rect width={TW} height={TH} rx={6} fill="#111827" stroke="#374151" strokeWidth={1} />
                <text x={TW / 2} y={TPad + 10} textAnchor="middle" fontSize={9.5} fill="#6b7280">{label}</text>
                <text x={TW / 2} y={TPad + 26} textAnchor="middle" fontSize={12} fontWeight="700" fill="#f59e0b">Peak {data[hov].peak}</text>
                <text x={TW / 2} y={TPad + 42} textAnchor="middle" fontSize={12} fontWeight="700" fill="#9ca3af">End {data[hov].end_of_day}</text>
              </g>
            </>
          );
        })()}

        {tickIndices.map((i) => (
          <text key={i} x={toX(i)} y={H - 6} textAnchor="middle" fontSize={11} fill="#4b5563">
            {fmtAxis(data[i].date, agg)}
          </text>
        ))}
        <line x1={padL} y1={padT + chartH} x2={W - padR} y2={padT + chartH} stroke="#1f2937" strokeWidth={1} />
      </svg>
    </div>
  );
}

// ── Sleep chart (bar for ≤1M, line for >1M) ───────────────────────────────────

function SleepChart({ data, days, profile }: { data: SleepPoint[]; days: number; profile: string }) {
  const [hov, setHov] = useState<number | null>(null);
  const [detailDate, setDetailDate] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  if (!data.length) return <div className="text-sm text-gray-600 py-4">No sleep data</div>;

  const LEGEND = [
    { label: "Total",  color: "#a78bfa", key: "total_hours"  as const },
    { label: "Deep",   color: "#3b82f6", key: "deep_hours"   as const },
    { label: "REM",    color: "#8b5cf6", key: "rem_hours"    as const },
    { label: "Light",  color: "#6b7280", key: "light_hours"  as const },
  ];

  const W = 600, H = 260, padL = 28, padR = 8, padT = 10, padB = 30;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;
  const tickCount = data.length <= 10 ? data.length : Math.min(6, data.length);
  const tickIndices = tickCount === data.length
    ? data.map((_, i) => i)
    : Array.from({ length: tickCount }, (_, i) =>
        data.length === 1 ? 0 : Math.round((i / (tickCount - 1)) * (data.length - 1))
      );

  // ── Bar chart (≤30 days) ──────────────────────────────────────────────────

  if (days <= 30) {
    const maxH = Math.max(...data.map((d) => d.total_hours), 1);
    const step = chartW / data.length;
    const barW = Math.max(2, step - 2);
    function bh(hrs: number) { return (hrs / maxH) * chartH; }

    return (
      <div>
        <div className="mb-3 flex flex-wrap gap-4 text-xs text-gray-400">
          {LEGEND.slice(1).map(({ label, color }) => (
            <span key={label} className="flex items-center gap-1">
              <span className="h-2 w-3 rounded-sm inline-block" style={{ background: color }} />
              {label}
            </span>
          ))}
          {hov !== null && (
            <span className="ml-2 text-gray-300">
              {fmtTooltip(data[hov].date, "day")} · {data[hov].total_hours.toFixed(1)}h
              {data[hov].sleep_score != null ? ` · score ${data[hov].sleep_score}` : ""}
            </span>
          )}
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full cursor-pointer" ref={svgRef}>
          {Array.from({ length: Math.floor(maxH) + 1 }, (_, i) => i).map((v) => {
            const y = padT + chartH - bh(v);
            const is7 = v === 7;
            return (
              <g key={v}>
                <line x1={padL} y1={y} x2={W - padR} y2={y}
                  stroke={is7 ? "#4b5563" : "#1f2937"} strokeWidth={1}
                  strokeDasharray={is7 ? "4,4" : undefined} />
                <text x={padL - 4} y={y + 4} textAnchor="end" fontSize={11} fill={is7 ? "#9ca3af" : "#4b5563"}>{v}h</text>
              </g>
            );
          })}
          {data.map((d, i) => {
            const x = padL + i * step + (step - barW) / 2;
            const bottom = padT + chartH;
            const deep  = bh(d.deep_hours  || 0);
            const rem   = bh(d.rem_hours   || 0);
            const light = bh(d.light_hours || 0);
            const hasStages = (d.deep_hours || 0) + (d.rem_hours || 0) + (d.light_hours || 0) > 0;
            return (
              <g key={d.date}
                onMouseEnter={() => setHov(i)}
                onMouseLeave={() => setHov(null)}
                onClick={() => setDetailDate(d.date)}
                style={{ cursor: "pointer" }}
              >
                {hasStages ? (
                  <>
                    <rect x={x} y={bottom - deep}                         width={barW} height={deep}  fill="#3b82f6" />
                    <rect x={x} y={bottom - deep - rem}                   width={barW} height={rem}   fill="#8b5cf6" />
                    <rect x={x} y={bottom - deep - rem - light}           width={barW} height={light} fill="#6b7280" />
                  </>
                ) : (
                  <rect x={x} y={bottom - bh(d.total_hours)} width={barW} height={bh(d.total_hours)} fill="#a78bfa" opacity={0.5} />
                )}
                <rect x={x} y={padT} width={barW} height={chartH} fill="transparent" />
              </g>
            );
          })}
          {tickIndices.map((i) => (
            <text key={i} x={padL + i * step + step / 2} y={H - 6} textAnchor="middle" fontSize={11} fill="#4b5563">
              {fmtAxis(data[i].date, "day")}
            </text>
          ))}
          <line x1={padL} y1={padT + chartH} x2={W - padR} y2={padT + chartH} stroke="#1f2937" strokeWidth={1} />
        </svg>
        {detailDate && <SleepDetailModal date={detailDate} profile={profile} onClose={() => setDetailDate(null)} />}
      </div>
    );
  }

  // ── Line chart (>30 days) ─────────────────────────────────────────────────

  const allVals = data.flatMap((d) => [d.total_hours, d.deep_hours || 0, d.rem_hours || 0, d.light_hours || 0, d.awake_hours || 0]);
  const minV = 0;
  const maxV = Math.max(...data.map((d) => d.total_hours), 1);

  const toX = (i: number) => padL + (i / Math.max(data.length - 1, 1)) * chartW;
  const toY = (v: number) => padT + chartH - ((v - minV) / (maxV - minV || 1)) * chartH;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((x - padL) / chartW) * (data.length - 1));
    setHov(Math.max(0, Math.min(data.length - 1, idx)));
  };

  const yTicks = Array.from({ length: Math.floor(maxV) + 1 }, (_, i) => i);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-4 text-xs text-gray-400">
        {LEGEND.map(({ label, color }) => (
          <span key={label} className="flex items-center gap-1">
            <span className="h-2 w-3 rounded-sm inline-block" style={{ background: color }} />
            {label}
          </span>
        ))}
        {hov !== null && (
          <span className="ml-2 text-gray-300">
            {fmtTooltip(data[hov].date, getAgg(days))} · {data[hov].total_hours.toFixed(1)}h
          </span>
        )}
        {getAgg(days) !== "day" && (
          <span className="ml-auto rounded-full bg-gray-800 px-2 py-0.5 text-xs text-gray-500">
            {aggLabel(getAgg(days))}
          </span>
        )}
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHov(null)}
      >
        {yTicks.map((v) => {
          const is7 = v === 7;
          return (
            <g key={v}>
              <line x1={padL} y1={toY(v)} x2={W - padR} y2={toY(v)}
                stroke={is7 ? "#4b5563" : "#1f2937"} strokeWidth={1}
                strokeDasharray={is7 ? "4,4" : undefined} />
              <text x={padL - 4} y={toY(v) + 4} textAnchor="end" fontSize={11} fill={is7 ? "#9ca3af" : "#6b7280"}>{v}h</text>
            </g>
          );
        })}

        {/* Lines for each stage */}
        {LEGEND.map(({ color, key }) => {
          const pts = data.map((d, i) => `${toX(i)},${toY(d[key] || 0)}`).join(" ");
          return (
            <polyline key={key} points={pts} fill="none" stroke={color}
              strokeWidth={key === "total_hours" ? 2.5 : 1.5}
              strokeOpacity={key === "total_hours" ? 1 : 0.75}
              strokeLinejoin="round" />
          );
        })}

        {/* Hover crosshair + tooltip */}
        {hov !== null && (() => {
          const cx = toX(hov);
          const cy = toY(data[hov].total_hours);
          const TW = 130, TH = 42, TPad = 6;
          const aboveY = cy - TH - 8;
          const ty = aboveY < padT ? cy + 12 : aboveY;
          const tx = Math.max(padL, Math.min(cx - TW / 2, W - padR - TW));
          return (
            <Fragment>
              <line x1={cx} y1={padT} x2={cx} y2={padT + chartH} stroke="#374151" strokeWidth={1} strokeDasharray="3,3" />
              <circle cx={cx} cy={cy} r={4} fill="#a78bfa" stroke="#111827" strokeWidth={2} />
              <g transform={`translate(${tx},${ty})`}>
                <rect width={TW} height={TH} rx={6} fill="#111827" stroke="#374151" strokeWidth={1} />
                <text x={TW / 2} y={TPad + 10} textAnchor="middle" fontSize={11} fill="#6b7280">
                  {fmtTooltip(data[hov].date, getAgg(days))}
                </text>
                <text x={TW / 2} y={TPad + 28} textAnchor="middle" fontSize={13} fontWeight="700" fill="#f9fafb">
                  {data[hov].total_hours.toFixed(1)}h total
                </text>
              </g>
            </Fragment>
          );
        })()}

        {tickIndices.map((i) => (
          <text key={i} x={toX(i)} y={H - 6} textAnchor="middle" fontSize={11} fill="#4b5563">
            {fmtAxis(data[i].date, getAgg(days))}
          </text>
        ))}
        <line x1={padL} y1={padT + chartH} x2={W - padR} y2={padT + chartH} stroke="#1f2937" strokeWidth={1} />
      </svg>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function HealthPage() {
  const [profiles, setProfiles] = useState<GarminProfile[]>([]);
  const [profile, setProfile] = useState<string>("");
  const [metric, setMetric] = useState<MetricKey>("resting_hr");
  const [days, setDays] = useState(30);
  const [sleepDays, setSleepDays] = useState(30);
  const [trendData, setTrendData] = useState<TrendPoint[]>([]);
  const [batteryData, setBatteryData] = useState<BatteryPoint[]>([]);
  const [sleepData, setSleepData] = useState<SleepPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [sleepLoading, setSleepLoading] = useState(false);
  const [metricRanges, setMetricRanges] = useState<Record<string, string | null>>({});

  const metricCfg = METRICS.find((m) => m.key === metric)!;

  useEffect(() => {
    fetch("/api/garmin/profiles")
      .then((r) => r.json())
      .then((p: GarminProfile[]) => {
        setProfiles(p);
        if (p.length > 0) setProfile(p[0].slug);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!profile) return;
    fetch(`/api/garmin/metric-ranges?profile=${profile}`)
      .then((r) => r.json())
      .then(setMetricRanges)
      .catch(() => {});
  }, [profile]);

  useEffect(() => {
    if (!profile) return;
    setLoading(true);
    if (metric === "body_battery") {
      fetch(`/api/garmin/body-battery?days=${days}&profile=${profile}`)
        .then((r) => r.json())
        .then(setBatteryData)
        .catch(() => {})
        .finally(() => setLoading(false));
    } else {
      fetch(`/api/garmin/trend?metric=${metric}&days=${days}&profile=${profile}`)
        .then((r) => r.json())
        .then(setTrendData)
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [profile, metric, days]);

  useEffect(() => {
    if (!profile) return;
    setSleepLoading(true);
    fetch(`/api/garmin/sleep?days=${sleepDays}&profile=${profile}`)
      .then((r) => r.json())
      .then(setSleepData)
      .catch(() => {})
      .finally(() => setSleepLoading(false));
  }, [profile, sleepDays]);

  const activeProfile = profiles.find((p) => p.slug === profile);

  return (
    <div className="p-4 sm:p-8 max-w-4xl">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Health</h2>
          {activeProfile && (
            <p className="text-sm text-gray-500">
              {activeProfile.full_name || activeProfile.slug}
              {activeProfile.last_sync && <span className="ml-2">· synced {relTime(activeProfile.last_sync)}</span>}
            </p>
          )}
        </div>
        {profiles.length > 1 && (
          <div className="flex gap-1 rounded-lg bg-gray-900 p-1">
            {profiles.map((p) => (
              <button
                key={p.slug}
                onClick={() => setProfile(p.slug)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${profile === p.slug ? "bg-gray-800 text-gray-100" : "text-gray-400 hover:text-gray-300"}`}
              >
                {p.full_name.split(" ")[0] || p.display_name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Metric selector */}
      <div className="mb-4 flex flex-wrap gap-2">
        {METRICS.map((m) => (
          <button
            key={m.key}
            onClick={() => setMetric(m.key as MetricKey)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition-colors border ${
              metric === m.key
                ? "border-transparent text-white"
                : "border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-300"
            }`}
            style={metric === m.key ? { background: m.color } : {}}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* Time range selector */}
      {(() => {
        const earliest = metricRanges[metric];
        const maxDays = earliest
          ? Math.floor((Date.now() - new Date(earliest).getTime()) / 86400000)
          : Infinity;
        const dataFrom = earliest
          ? new Date(earliest).toLocaleDateString("en-US", { month: "short", year: "numeric" })
          : null;
        return (
          <div className="mb-6">
            <div className="flex gap-1 rounded-lg bg-gray-900 p-1 w-fit">
              {RANGES.map((r) => {
                const unavailable = r.days > maxDays * 1.08; // 8% buffer so e.g. 6.9Y of data enables 7Y button
                return (
                  <button
                    key={r.label}
                    onClick={() => !unavailable && setDays(r.days)}
                    title={unavailable ? `No data before ${dataFrom}` : undefined}
                    className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                      unavailable
                        ? "text-gray-700 cursor-not-allowed"
                        : days === r.days
                        ? "bg-gray-800 text-gray-100"
                        : "text-gray-400 hover:text-gray-300"
                    }`}
                  >
                    {r.label}
                  </button>
                );
              })}
            </div>
            {dataFrom && maxDays < 3650 && (
              <p className="mt-1.5 text-xs text-gray-600">
                Data available from {dataFrom}
              </p>
            )}
          </div>
        );
      })()}

      {/* Trend chart */}
      <div className="mb-8 rounded-xl border border-gray-800 bg-gray-900 p-3 sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2">
            {metricCfg.label}
            <span className="group relative">
              <svg className="h-3.5 w-3.5 text-gray-600 hover:text-gray-400 transition-colors cursor-help" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="12" cy="12" r="10" />
                <path d="M12 16v-4m0-4h.01" strokeLinecap="round" />
              </svg>
              <span className="pointer-events-none absolute top-full left-0 mt-2 w-64 rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 text-xs font-normal leading-relaxed text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity z-50 shadow-lg">
                {metricCfg.desc}
              </span>
            </span>
            {metric !== "body_battery" && trendData.length > 0 && (
              <span className="ml-1 font-normal text-gray-400">
                avg {fmtVal(trendData.reduce((a, b) => a + b.value, 0) / trendData.length, metricCfg.unit)}
              </span>
            )}
          </h3>
          {getAgg(days) !== "day" && metric !== "body_battery" && (
            <span className="rounded-full bg-gray-800 px-2 py-0.5 text-xs text-gray-500">
              {aggLabel(getAgg(days))}
            </span>
          )}
        </div>
        {loading ? (
          <div className="flex h-48 items-center justify-center text-sm text-gray-600">Loading…</div>
        ) : metric === "body_battery" ? (
          <BodyBatteryChart data={batteryData} days={days} />
        ) : (
          <TrendChart data={trendData} color={metricCfg.color} unit={metricCfg.unit} days={days} />
        )}
      </div>

      {/* Sleep breakdown */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-3 sm:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-gray-300">Sleep</h3>
          {/* Sleep-specific range selector */}
          {(() => {
            const earliest = metricRanges["sleep_duration"];
            const maxDays = earliest
              ? Math.floor((Date.now() - new Date(earliest).getTime()) / 86400000)
              : Infinity;
            return (
              <div className="flex gap-1 rounded-lg bg-gray-800 p-1">
                {RANGES.map((r) => {
                  const unavailable = r.days > maxDays * 1.08;
                  return (
                    <button
                      key={r.label}
                      onClick={() => !unavailable && setSleepDays(r.days)}
                      title={unavailable ? "No data for this range" : undefined}
                      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                        unavailable
                          ? "text-gray-700 cursor-not-allowed"
                          : sleepDays === r.days
                          ? "bg-gray-700 text-gray-100"
                          : "text-gray-400 hover:text-gray-300"
                      }`}
                    >
                      {r.label}
                    </button>
                  );
                })}
              </div>
            );
          })()}
        </div>
        {sleepLoading ? (
          <div className="flex h-40 items-center justify-center text-sm text-gray-600">Loading…</div>
        ) : (
          <SleepChart data={sleepData} days={sleepDays} profile={profile} />
        )}
      </div>
    </div>
  );
}
