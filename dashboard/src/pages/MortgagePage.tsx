import { useEffect, useState } from "react";

interface RatePoint {
  date: string;
  rate: number;
}

interface MortgageData {
  rates: RatePoint[];
  current: number | null;
  previous: number | null;
  target: number;
  weekly_summary: string | null;
  weekly_run_at: string | null;
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function relativeTime(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

// ── SVG Line Chart ──────────────────────────────────────────────────────────

function RateChart({
  rates,
  target,
}: {
  rates: RatePoint[];
  target: number;
}) {
  if (rates.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-gray-500">
        No rate data yet
      </div>
    );
  }

  const W = 600;
  const H = 200;
  const PAD = { top: 20, right: 20, bottom: 32, left: 44 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const allRates = rates.map((r) => r.rate);
  const minR = Math.min(...allRates, target) - 0.3;
  const maxR = Math.max(...allRates, target) + 0.3;

  const xScale = (i: number) => (i / Math.max(rates.length - 1, 1)) * chartW;
  const yScale = (r: number) => chartH - ((r - minR) / (maxR - minR)) * chartH;

  // Build polyline points
  const points = rates
    .map((r, i) => `${xScale(i).toFixed(1)},${yScale(r.rate).toFixed(1)}`)
    .join(" ");

  // Target line y
  const targetY = yScale(target).toFixed(1);

  // Y axis ticks
  const yTicks: number[] = [];
  const step = (maxR - minR) / 4;
  for (let i = 0; i <= 4; i++) {
    yTicks.push(parseFloat((minR + i * step).toFixed(2)));
  }

  // X axis labels — show first, last, and a few in between
  const labelIndices = new Set<number>();
  labelIndices.add(0);
  labelIndices.add(rates.length - 1);
  if (rates.length > 4) {
    const mid = Math.floor(rates.length / 2);
    labelIndices.add(mid);
  }

  // Area fill path
  const areaPath = [
    `M ${xScale(0).toFixed(1)},${chartH}`,
    ...rates.map((r, i) => `L ${xScale(i).toFixed(1)},${yScale(r.rate).toFixed(1)}`),
    `L ${xScale(rates.length - 1).toFixed(1)},${chartH}`,
    "Z",
  ].join(" ");

  const belowTarget = rates[rates.length - 1]?.rate < target;

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        style={{ minWidth: "320px", maxWidth: "100%" }}
      >
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop
              offset="0%"
              stopColor={belowTarget ? "#10b981" : "#6366f1"}
              stopOpacity="0.25"
            />
            <stop
              offset="100%"
              stopColor={belowTarget ? "#10b981" : "#6366f1"}
              stopOpacity="0.02"
            />
          </linearGradient>
        </defs>

        <g transform={`translate(${PAD.left},${PAD.top})`}>
          {/* Grid lines */}
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={0}
                y1={yScale(tick).toFixed(1)}
                x2={chartW}
                y2={yScale(tick).toFixed(1)}
                stroke="#1f2937"
                strokeWidth={1}
              />
              <text
                x={-8}
                y={parseFloat(yScale(tick).toFixed(1)) + 4}
                textAnchor="end"
                fontSize={10}
                fill="#6b7280"
              >
                {tick.toFixed(2)}%
              </text>
            </g>
          ))}

          {/* Target rate line */}
          <line
            x1={0}
            y1={targetY}
            x2={chartW}
            y2={targetY}
            stroke="#10b981"
            strokeWidth={1.5}
            strokeDasharray="6,4"
          />
          <text
            x={chartW + 4}
            y={parseFloat(targetY) + 4}
            fontSize={9}
            fill="#10b981"
          >
            {target}%
          </text>

          {/* Area fill */}
          <path d={areaPath} fill="url(#areaGrad)" />

          {/* Rate line */}
          <polyline
            points={points}
            fill="none"
            stroke={belowTarget ? "#10b981" : "#6366f1"}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Data points */}
          {rates.map((r, i) => (
            <circle
              key={i}
              cx={xScale(i).toFixed(1)}
              cy={yScale(r.rate).toFixed(1)}
              r={rates.length > 14 ? 0 : 3}
              fill={belowTarget ? "#10b981" : "#6366f1"}
            />
          ))}

          {/* X axis labels */}
          {[...labelIndices].map((i) => (
            <text
              key={i}
              x={xScale(i).toFixed(1)}
              y={chartH + 20}
              textAnchor="middle"
              fontSize={10}
              fill="#6b7280"
            >
              {formatDate(rates[i].date)}
            </text>
          ))}
        </g>
      </svg>
    </div>
  );
}

// ── Weekly Summary ──────────────────────────────────────────────────────────

function WeeklySummary({ text, runAt }: { text: string; runAt: string }) {
  // Render markdown-ish bold and bullets
  const lines = text.split("\n");
  return (
    <div className="space-y-1.5">
      {runAt && (
        <p className="text-xs text-gray-500 mb-3">
          Last weekly report · {relativeTime(runAt)}
        </p>
      )}
      {lines.map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return null;
        // Bold markers
        const formatted = trimmed.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        const isBullet = trimmed.startsWith("-") || trimmed.startsWith("•");
        const content = isBullet ? formatted.replace(/^[-•]\s*/, "") : formatted;
        return (
          <div key={i} className={`text-sm ${isBullet ? "flex gap-2 text-gray-300" : "text-gray-400"}`}>
            {isBullet && <span className="mt-0.5 shrink-0 text-gray-600">•</span>}
            <span dangerouslySetInnerHTML={{ __html: content }} />
          </div>
        );
      })}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function MortgagePage() {
  const [data, setData] = useState<MortgageData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/mortgage")
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-sm text-gray-500">Loading...</p>
      </div>
    );
  }

  const { rates = [], current, previous, target = 5.8, weekly_summary, weekly_run_at } = data ?? {};
  const change = current != null && previous != null ? current - previous : null;
  const belowTarget = current != null && current < target;
  const bpsToTarget = current != null ? Math.round((current - target) * 100) : null;

  return (
    <div className="p-4 sm:p-8 max-w-4xl">
      {/* Header */}
      <div className="mb-6 sm:mb-8">
        <h2 className="text-lg font-semibold text-gray-100">Mortgage Rate Tracker</h2>
        <p className="mt-0.5 text-sm text-gray-500">30-year fixed · updated daily</p>
      </div>

      {/* Stat cards */}
      <div className="mb-6 sm:mb-8 grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
        {/* Current rate */}
        <div className={`rounded-xl border p-4 sm:p-5 ${belowTarget ? "border-green-700/50 bg-green-900/10" : "border-gray-800 bg-gray-900"}`}>
          <p className="text-xs text-gray-500 mb-1">Current Rate</p>
          <p className={`text-2xl sm:text-3xl font-bold ${belowTarget ? "text-green-400" : "text-gray-100"}`}>
            {current != null ? `${current.toFixed(2)}%` : "—"}
          </p>
          {change != null && (
            <p className={`mt-1 text-xs ${change > 0 ? "text-red-400" : "text-green-400"}`}>
              {change > 0 ? "▲" : "▼"} {Math.abs(change).toFixed(2)}% from yesterday
            </p>
          )}
        </div>

        {/* Target */}
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 sm:p-5">
          <p className="text-xs text-gray-500 mb-1">Refinance Target</p>
          <p className="text-2xl sm:text-3xl font-bold text-blue-400">{target.toFixed(1)}%</p>
          {bpsToTarget != null && (
            <p className="mt-1 text-xs text-gray-500">
              {bpsToTarget > 0 ? `${bpsToTarget} bps above target` : `${Math.abs(bpsToTarget)} bps below — alert!`}
            </p>
          )}
        </div>

        {/* Trend */}
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 sm:p-5">
          <p className="text-xs text-gray-500 mb-1">7-day Trend</p>
          {rates.length >= 2 ? (() => {
            const last7 = rates.slice(-7);
            const first = last7[0].rate;
            const last = last7[last7.length - 1].rate;
            const diff = last - first;
            const rising = diff > 0.02;
            const falling = diff < -0.02;
            return (
              <>
                <p className={`text-2xl sm:text-3xl font-bold ${rising ? "text-red-400" : falling ? "text-green-400" : "text-gray-300"}`}>
                  {rising ? "📈 Rising" : falling ? "📉 Falling" : "➡️ Stable"}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  {diff > 0 ? "+" : ""}{diff.toFixed(2)}% over last {last7.length} days
                </p>
              </>
            );
          })() : (
            <p className="text-3xl font-bold text-gray-600">—</p>
          )}
        </div>
      </div>

      {/* Alert banner */}
      {belowTarget && (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-green-700/50 bg-green-900/15 px-4 py-3">
          <span className="text-xl">⚠️</span>
          <div>
            <p className="text-sm font-medium text-green-300">Refinancing opportunity!</p>
            <p className="text-xs text-green-400/70">
              Rate has dropped below the {target}% threshold. Consider refinancing your mortgage.
            </p>
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="mb-6 sm:mb-8 rounded-xl border border-gray-800 bg-gray-900 p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-gray-200">Rate History</h3>
          <div className="flex items-center gap-4 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-px w-5 bg-indigo-500" />
              30yr Fixed
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-px w-5 border-t border-dashed border-green-500" />
              {target}% target
            </span>
          </div>
        </div>
        <RateChart rates={rates} target={target} />
      </div>

      {/* Rate history table + weekly report side by side */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* History table */}
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h3 className="mb-4 text-sm font-semibold text-gray-200">Daily Log</h3>
          {rates.length === 0 ? (
            <p className="text-sm text-gray-500">No data yet.</p>
          ) : (
            <div className="space-y-1">
              {[...rates].reverse().map((r, i) => {
                const prev = rates[rates.length - 2 - i];
                const chg = prev ? r.rate - prev.rate : null;
                return (
                  <div key={r.date} className="flex items-center justify-between py-1.5 border-b border-gray-800/60 last:border-0">
                    <span className="text-xs text-gray-400">{formatDate(r.date)}</span>
                    <div className="flex items-center gap-3">
                      {chg != null && Math.abs(chg) >= 0.01 && (
                        <span className={`text-xs ${chg > 0 ? "text-red-400" : "text-green-400"}`}>
                          {chg > 0 ? "▲" : "▼"} {Math.abs(chg).toFixed(2)}%
                        </span>
                      )}
                      <span className={`text-sm font-medium ${r.rate < target ? "text-green-400" : "text-gray-100"}`}>
                        {r.rate.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Weekly report */}
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h3 className="mb-4 text-sm font-semibold text-gray-200">Weekly Report</h3>
          {weekly_summary ? (
            <WeeklySummary text={weekly_summary} runAt={weekly_run_at ?? ""} />
          ) : (
            <p className="text-sm text-gray-500">No weekly report yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
