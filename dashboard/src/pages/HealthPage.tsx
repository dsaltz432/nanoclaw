import { useEffect, useState } from "react";

// ── Types ────────────────────────────────────────────────────────────────────

interface GarminProfile {
  slug: string;
  display_name: string;
  full_name: string;
  connected: boolean;
  day_count: number;
  last_sync: string | null;
}

interface Overview {
  avg_resting_hr: number | null;
  avg_hrv: number | null;
  avg_sleep_hours: number | null;
  avg_steps: number | null;
  avg_stress: number | null;
  latest_weight_kg: number | null;
}

interface HRPoint { date: string; resting_heart_rate: number; max_heart_rate: number }
interface HRVPoint { date: string; last_night: number; weekly_avg: number; hrv_status: string }
interface SleepPoint {
  date: string; total_hours: number; deep_hours: number; light_hours: number;
  rem_hours: number; awake_hours: number; sleep_score: number | null;
}
interface StepsPoint { date: string; total_steps: number; active_calories: number }
interface StressPoint { date: string; overall_stress_level: number; avg_waking_stress: number }
interface RecoveryPoint { date: string; sport_type: string; max_hr: number; recovery_heart_rate: number; hrr_drop: number }
interface WeightPoint { date: string; weight_kg: number; body_fat_percent: number | null }

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function kgToLbs(kg: number) { return (kg * 2.20462).toFixed(1); }

// ── Mini SVG line chart ───────────────────────────────────────────────────────

function LineChart({
  data, color = "#6366f1", height = 80, label,
}: {
  data: number[];
  color?: string;
  height?: number;
  label?: string;
}) {
  if (data.length < 2) return <div className="text-xs text-gray-600 py-2">Not enough data</div>;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 300;
  const h = height;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 10) - 2;
    return `${x},${y}`;
  });
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none">
        <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      </svg>
      {label && <p className="text-xs text-gray-600 text-center mt-1">{label}</p>}
    </div>
  );
}

// Stack bar chart for sleep stages
function SleepBars({ data }: { data: SleepPoint[] }) {
  if (!data.length) return <div className="text-xs text-gray-600 py-2">No data</div>;
  const maxH = Math.max(...data.map((d) => d.total_hours), 1);
  const barW = Math.max(4, Math.floor(280 / data.length) - 1);
  const step = Math.floor(280 / data.length);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${Math.max(data.length * step, 280)} 80`} className="w-full">
        {data.map((d, i) => {
          const x = i * step;
          const totalH = (d.total_hours / maxH) * 65;
          const deepH = (d.deep_hours / maxH) * 65;
          const remH = (d.rem_hours / maxH) * 65;
          const lightH = (d.light_hours / maxH) * 65;
          let y = 67;
          return (
            <g key={d.date}>
              {deepH > 0 && (() => { y -= deepH; return <rect x={x} y={y} width={barW} height={deepH} fill="#6366f1" rx={1}><title>{`${d.date}: Deep ${d.deep_hours.toFixed(1)}h`}</title></rect>; })()}
              {remH > 0 && (() => { y -= remH; return <rect x={x} y={y} width={barW} height={remH} fill="#8b5cf6" rx={1}><title>{`REM ${d.rem_hours.toFixed(1)}h`}</title></rect>; })()}
              {lightH > 0 && (() => { y -= lightH; return <rect x={x} y={y} width={barW} height={lightH} fill="#a78bfa" opacity={0.7} rx={1}><title>{`Light ${d.light_hours.toFixed(1)}h`}</title></rect>; })()}
              {totalH > 14 && (
                <text x={x + barW / 2} y={67 - totalH - 2} textAnchor="middle" fontSize={6} fill="#9ca3af">
                  {d.total_hours.toFixed(1)}
                </text>
              )}
            </g>
          );
        })}
        <line x1={0} y1={68} x2={data.length * step} y2={68} stroke="#374151" strokeWidth={1} />
      </svg>
      <div className="flex gap-3 mt-1 justify-center">
        {[["#6366f1", "Deep"], ["#8b5cf6", "REM"], ["#a78bfa", "Light"]].map(([c, l]) => (
          <div key={l} className="flex items-center gap-1 text-xs text-gray-500">
            <span className="h-2 w-2 rounded-full inline-block" style={{ backgroundColor: c }} />{l}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Metric card ───────────────────────────────────────────────────────────────

function MetricCard({ icon, label, value, sub, color = "text-gray-100" }: {
  icon: string; label: string; value: string | null; sub?: string; color?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <p className="text-xs text-gray-500 mb-1">{icon} {label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value ?? "—"}</p>
      {sub && <p className="text-xs text-gray-600 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Chart section ─────────────────────────────────────────────────────────────

function ChartSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <p className="text-sm font-semibold text-gray-300 mb-3">{title}</p>
      {children}
    </div>
  );
}

// ── Range selector ────────────────────────────────────────────────────────────

function RangeSelector({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex gap-1 rounded-lg bg-gray-900 border border-gray-800 p-1">
      {[[30, "30d"], [90, "90d"], [180, "6m"], [365, "1y"]].map(([d, label]) => (
        <button key={d} onClick={() => onChange(Number(d))}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${value === d ? "bg-gray-800 text-gray-100" : "text-gray-400 hover:text-gray-300"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

// ── Profile selector ──────────────────────────────────────────────────────────

function ProfileSelector({ profiles, activeSlug, onChange }: {
  profiles: GarminProfile[];
  activeSlug: string;
  onChange: (slug: string) => void;
}) {
  if (profiles.length <= 1) return null;
  return (
    <div className="flex gap-1 rounded-lg bg-gray-900 border border-gray-800 p-1">
      {profiles.map((p) => (
        <button
          key={p.slug}
          onClick={() => onChange(p.slug)}
          className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
            activeSlug === p.slug
              ? "bg-gray-800 text-gray-100"
              : "text-gray-400 hover:text-gray-300"
          }`}
        >
          {(p.full_name || p.display_name || p.slug).split(" ")[0]}
        </button>
      ))}
    </div>
  );
}

// ── HRV status color ──────────────────────────────────────────────────────────

function hrvStatusColor(status: string): string {
  const s = (status || "").toLowerCase();
  if (s.includes("balanced")) return "text-green-400";
  if (s.includes("low")) return "text-red-400";
  if (s.includes("unbalanced")) return "text-yellow-400";
  return "text-gray-400";
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function HealthPage() {
  const [profiles, setProfiles] = useState<GarminProfile[] | null>(null);
  const [activeSlug, setActiveSlug] = useState("");
  const [days, setDays] = useState(90);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [hrData, setHrData] = useState<HRPoint[]>([]);
  const [hrvData, setHrvData] = useState<HRVPoint[]>([]);
  const [sleepData, setSleepData] = useState<SleepPoint[]>([]);
  const [stepsData, setStepsData] = useState<StepsPoint[]>([]);
  const [stressData, setStressData] = useState<StressPoint[]>([]);
  const [recoveryData, setRecoveryData] = useState<RecoveryPoint[]>([]);
  const [weightData, setWeightData] = useState<WeightPoint[]>([]);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [notConnectedReason, setNotConnectedReason] = useState("");

  // Load profiles on mount
  useEffect(() => {
    fetch("/api/garmin/profiles")
      .then((r) => r.json())
      .then((data: GarminProfile[]) => {
        setProfiles(data);
        if (data.length > 0 && !activeSlug) {
          setActiveSlug(data[0].slug);
        }
      })
      .catch(() => setProfiles([]));
  }, []);

  // Check connection status for active profile
  useEffect(() => {
    if (!activeSlug) return;
    fetch(`/api/garmin/status?profile=${activeSlug}`)
      .then((r) => r.json())
      .then((d) => {
        setConnected(d.connected);
        if (!d.connected) setNotConnectedReason(d.reason ?? "");
      })
      .catch(() => setConnected(false));
  }, [activeSlug]);

  // Load data for active profile
  useEffect(() => {
    if (!connected || !activeSlug) return;
    const q = `profile=${activeSlug}`;
    fetch(`/api/garmin/overview?days=${days}&${q}`).then((r) => r.json()).then(setOverview).catch(() => {});
    fetch(`/api/garmin/heart-rate?days=${days}&${q}`).then((r) => r.json()).then(setHrData).catch(() => setHrData([]));
    fetch(`/api/garmin/hrv?days=${days}&${q}`).then((r) => r.json()).then(setHrvData).catch(() => setHrvData([]));
    fetch(`/api/garmin/sleep?days=${days}&${q}`).then((r) => r.json()).then(setSleepData).catch(() => setSleepData([]));
    fetch(`/api/garmin/steps?days=${days}&${q}`).then((r) => r.json()).then(setStepsData).catch(() => setStepsData([]));
    fetch(`/api/garmin/stress?days=${days}&${q}`).then((r) => r.json()).then(setStressData).catch(() => setStressData([]));
    fetch(`/api/garmin/recovery-trend?days=${days}&${q}`).then((r) => r.json()).then(setRecoveryData).catch(() => setRecoveryData([]));
    fetch(`/api/garmin/weight?days=365&${q}`).then((r) => r.json()).then(setWeightData).catch(() => setWeightData([]));
  }, [connected, days, activeSlug]);

  if (profiles === null) {
    return <div className="py-16 text-center text-sm text-gray-500">Loading...</div>;
  }

  if (profiles.length === 0) {
    return (
      <div className="max-w-lg mx-auto py-16 text-center">
        <p className="text-4xl mb-4">⌚</p>
        <p className="text-lg font-semibold text-gray-200 mb-2">Garmin not connected</p>
        <p className="text-sm text-gray-500 mb-6">No profiles found</p>
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 text-left text-sm text-gray-400 space-y-2">
          <p className="font-medium text-gray-300">Setup instructions:</p>
          <p>1. Run <code className="text-indigo-400">python3 scripts/garmin-auth.py</code></p>
          <p>2. Run <code className="text-indigo-400">python3 scripts/garmin-sync.py --full</code></p>
          <p>3. Refresh this page</p>
        </div>
      </div>
    );
  }

  if (connected === null) {
    return <div className="py-16 text-center text-sm text-gray-500">Loading...</div>;
  }

  if (!connected) {
    const activeProfile = profiles.find((p) => p.slug === activeSlug);
    return (
      <div className="space-y-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h1 className="text-xl font-bold text-gray-100">Health</h1>
          <ProfileSelector profiles={profiles} activeSlug={activeSlug} onChange={setActiveSlug} />
        </div>
        <div className="max-w-lg mx-auto py-8 text-center">
          <p className="text-4xl mb-4">⌚</p>
          <p className="text-lg font-semibold text-gray-200 mb-2">No data for {activeProfile?.full_name || activeSlug}</p>
          <p className="text-sm text-gray-500 mb-6">{notConnectedReason}</p>
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 text-left text-sm text-gray-400 space-y-2">
            <p className="font-medium text-gray-300">Sync this profile:</p>
            <p>Run <code className="text-indigo-400">python3 scripts/garmin-sync.py --profile {activeSlug} --full</code></p>
          </div>
        </div>
      </div>
    );
  }

  const latestHrv = hrvData[hrvData.length - 1];
  const latestSleep = sleepData[sleepData.length - 1];

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-bold text-gray-100">Health</h1>
        <div className="flex items-center gap-2 flex-wrap">
          <ProfileSelector profiles={profiles} activeSlug={activeSlug} onChange={setActiveSlug} />
          <RangeSelector value={days} onChange={setDays} />
        </div>
      </div>

      {/* Overview metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricCard icon="❤️" label="Resting HR" value={overview?.avg_resting_hr ? `${overview.avg_resting_hr} bpm` : null} sub={`${days}d avg`} color="text-red-400" />
        <MetricCard icon="📊" label="HRV" value={overview?.avg_hrv ? `${overview.avg_hrv} ms` : null}
          sub={latestHrv?.hrv_status ?? `${days}d avg`}
          color={latestHrv ? hrvStatusColor(latestHrv.hrv_status) : "text-gray-100"} />
        <MetricCard icon="😴" label="Sleep" value={overview?.avg_sleep_hours ? `${overview.avg_sleep_hours}h` : null} sub={`${days}d avg`} color="text-purple-400" />
        <MetricCard icon="👣" label="Steps" value={overview?.avg_steps ? Math.round(overview.avg_steps).toLocaleString() : null} sub={`${days}d avg`} color="text-green-400" />
        <MetricCard icon="🧘" label="Stress" value={overview?.avg_stress ? `${overview.avg_stress}` : null} sub={`${days}d avg · 0–100`} color={overview?.avg_stress && overview.avg_stress > 50 ? "text-orange-400" : "text-teal-400"} />
        <MetricCard icon="⚖️" label="Weight"
          value={overview?.latest_weight_kg ? `${kgToLbs(overview.latest_weight_kg)} lbs` : null}
          sub="latest" color="text-gray-100" />
      </div>

      {/* Charts row 1: HR + HRV */}
      <div className="grid sm:grid-cols-2 gap-4">
        <ChartSection title="❤️ Resting Heart Rate">
          {hrData.length > 0 ? (
            <>
              <LineChart data={hrData.map((d) => d.resting_heart_rate)} color="#f87171" label="bpm" />
              <div className="flex justify-between text-xs text-gray-600 mt-1 px-1">
                <span>{fmtDate(hrData[0].date)}</span>
                <span>{fmtDate(hrData[hrData.length - 1].date)}</span>
              </div>
            </>
          ) : <div className="py-8 text-center text-sm text-gray-500">No data yet</div>}
        </ChartSection>

        <ChartSection title="📊 HRV (Last Night)">
          {hrvData.length > 0 ? (
            <>
              <LineChart data={hrvData.map((d) => d.last_night)} color="#34d399" label="ms" />
              <div className="flex justify-between text-xs text-gray-600 mt-1 px-1">
                <span>{fmtDate(hrvData[0].date)}</span>
                <span>{fmtDate(hrvData[hrvData.length - 1].date)}</span>
              </div>
              {latestHrv && (
                <p className={`mt-2 text-xs font-medium ${hrvStatusColor(latestHrv.hrv_status)}`}>
                  Status: {latestHrv.hrv_status} · Last night: {latestHrv.last_night} ms · 7d avg: {latestHrv.weekly_avg} ms
                </p>
              )}
            </>
          ) : <div className="py-8 text-center text-sm text-gray-500">No data yet</div>}
        </ChartSection>
      </div>

      {/* Sleep */}
      <ChartSection title="😴 Sleep">
        {sleepData.length > 0 ? (
          <>
            <SleepBars data={sleepData.slice(-60)} />
            <div className="flex justify-between text-xs text-gray-600 mt-1 px-1">
              <span>{fmtDate(sleepData[Math.max(0, sleepData.length - 60)].date)}</span>
              <span>{fmtDate(sleepData[sleepData.length - 1].date)}</span>
            </div>
            {latestSleep && (
              <p className="mt-2 text-xs text-gray-500">
                Last night: {latestSleep.total_hours.toFixed(1)}h total · {latestSleep.deep_hours.toFixed(1)}h deep · {latestSleep.rem_hours.toFixed(1)}h REM
                {latestSleep.sleep_score ? ` · Score: ${latestSleep.sleep_score}` : ""}
              </p>
            )}
          </>
        ) : <div className="py-8 text-center text-sm text-gray-500">No sleep data yet</div>}
      </ChartSection>

      {/* Steps + Stress */}
      <div className="grid sm:grid-cols-2 gap-4">
        <ChartSection title="👣 Daily Steps">
          {stepsData.length > 0 ? (
            <>
              <LineChart data={stepsData.map((d) => d.total_steps)} color="#4ade80" label="steps" />
              <div className="flex justify-between text-xs text-gray-600 mt-1 px-1">
                <span>{fmtDate(stepsData[0].date)}</span>
                <span>{fmtDate(stepsData[stepsData.length - 1].date)}</span>
              </div>
            </>
          ) : <div className="py-8 text-center text-sm text-gray-500">No data yet</div>}
        </ChartSection>

        <ChartSection title="🧘 Stress Level">
          {stressData.length > 0 ? (
            <>
              <LineChart data={stressData.map((d) => d.overall_stress_level)} color="#fb923c" label="0–100 (lower = better)" />
              <div className="flex justify-between text-xs text-gray-600 mt-1 px-1">
                <span>{fmtDate(stressData[0].date)}</span>
                <span>{fmtDate(stressData[stressData.length - 1].date)}</span>
              </div>
            </>
          ) : <div className="py-8 text-center text-sm text-gray-500">No data yet</div>}
        </ChartSection>
      </div>

      {/* Heart Rate Recovery */}
      <ChartSection title="💪 Heart Rate Recovery (Garmin native · bpm drop after 2 min)">
        {recoveryData.length > 0 ? (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b border-gray-800">
                    <th className="text-left pb-2">Date</th>
                    <th className="text-left pb-2">Activity</th>
                    <th className="text-right pb-2">Max HR</th>
                    <th className="text-right pb-2">Recovery HR</th>
                    <th className="text-right pb-2">Drop</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-800/50">
                  {recoveryData.slice(-20).reverse().map((r, i) => (
                    <tr key={i} className="text-gray-300">
                      <td className="py-1.5">{fmtDate(r.date)}</td>
                      <td className="py-1.5">{r.sport_type}</td>
                      <td className="py-1.5 text-right">{r.max_hr}</td>
                      <td className="py-1.5 text-right">{r.recovery_heart_rate}</td>
                      <td className={`py-1.5 text-right font-semibold ${r.hrr_drop >= 30 ? "text-green-400" : r.hrr_drop >= 20 ? "text-yellow-400" : "text-red-400"}`}>
                        ↓{r.hrr_drop}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {recoveryData.length > 5 && (
              <div className="mt-3">
                <p className="text-xs text-gray-500 mb-1">Trend (bpm drop)</p>
                <LineChart data={recoveryData.map((d) => d.hrr_drop)} color="#34d399" height={60} />
              </div>
            )}
          </>
        ) : <div className="py-8 text-center text-sm text-gray-500">No recovery data yet — sync activities from Garmin</div>}
      </ChartSection>

      {/* Weight */}
      {weightData.length > 0 && (
        <ChartSection title="⚖️ Weight">
          <LineChart data={weightData.map((d) => parseFloat(kgToLbs(d.weight_kg)))} color="#94a3b8" label="lbs" />
          <div className="flex justify-between text-xs text-gray-600 mt-1 px-1">
            <span>{fmtDate(weightData[0].date)}</span>
            <span>{fmtDate(weightData[weightData.length - 1].date)}</span>
          </div>
        </ChartSection>
      )}
    </div>
  );
}
