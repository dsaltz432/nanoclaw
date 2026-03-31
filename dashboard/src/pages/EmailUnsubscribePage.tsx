import { useEffect, useState } from "react";

interface Stats {
  totalAttempts: number;
  successful: number;
  failed: number;
  successRate: number;
  uniqueSendersUnsubscribed: number;
}

interface TimelinePoint {
  date: string;
  success: number;
  failed: number;
}

interface HistoryEntry {
  date: string;
  senderName: string;
  senderEmail: string;
  result: string;
  url: string;
  method?: string;
}

interface DomainCount {
  domain: string;
  count: number;
}

interface LastScan {
  date: string;
  scannedAt: string;
  totalMessages: number;
  candidateCount: number;
}

interface PendingCandidate {
  senderName: string;
  senderEmail: string;
  subject: string;
  frequency: number;
  hasUnsubscribeHeader: boolean;
  hasOneClickUnsubscribe: boolean;
}

interface UnsubscribeData {
  stats: Stats;
  timeline: TimelinePoint[];
  history: HistoryEntry[];
  topDomains: DomainCount[];
  lastScan: LastScan;
  pendingCandidates: PendingCandidate[];
}

type Tab = "overview" | "candidates" | "history";

const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "candidates", label: "Latest Scan" },
  { key: "history", label: "History" },
];

export default function EmailUnsubscribePage() {
  const [data, setData] = useState<UnsubscribeData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  useEffect(() => {
    fetch("/api/email-unsubscribe")
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-gray-500">Failed to load data</p>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8">
      <h2 className="mb-6 text-lg font-semibold text-gray-100">
        Email Unsubscribe
      </h2>

      <div className="mb-6 flex gap-1 rounded-lg bg-gray-900 p-1 w-full sm:w-fit">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? "bg-gray-800 text-gray-100"
                : "text-gray-400 hover:text-gray-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "overview" && <OverviewTab data={data} />}
      {activeTab === "candidates" && <CandidatesTab data={data} />}
      {activeTab === "history" && <HistoryTab data={data} />}
    </div>
  );
}

// ── Overview Tab ─────────────────────────────────────────────────────────────

function OverviewTab({ data }: { data: UnsubscribeData }) {
  const { stats, timeline, lastScan, topDomains } = data;

  return (
    <div className="space-y-6">
      {/* Stats cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total Attempts" value={stats.totalAttempts} />
        <StatCard
          label="Successful"
          value={stats.successful}
          color="green"
        />
        <StatCard label="Failed" value={stats.failed} color="red" />
        <StatCard
          label="Success Rate"
          value={`${stats.successRate}%`}
          color={stats.successRate >= 70 ? "green" : stats.successRate >= 40 ? "amber" : "red"}
        />
      </div>

      {/* Unique senders + last scan */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
          <p className="text-xs text-gray-500">Unique Senders Unsubscribed</p>
          <p className="mt-1 text-2xl font-semibold text-gray-100">
            {stats.uniqueSendersUnsubscribed}
          </p>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
          <p className="text-xs text-gray-500">Last Scan</p>
          <p className="mt-1 text-sm text-gray-300">
            {lastScan.scannedAt
              ? new Date(lastScan.scannedAt).toLocaleString()
              : "Never"}
          </p>
          {lastScan.candidateCount > 0 && (
            <p className="mt-0.5 text-xs text-gray-500">
              {lastScan.totalMessages} messages scanned,{" "}
              {lastScan.candidateCount} candidates found
            </p>
          )}
        </div>
      </div>

      {/* Timeline chart */}
      {timeline.length > 0 && (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
          <h3 className="mb-3 text-sm font-medium text-gray-300">
            Unsubscribe Activity
          </h3>
          <TimelineChart timeline={timeline} />
        </div>
      )}

      {/* Top domains */}
      {topDomains.length > 0 && (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
          <h3 className="mb-3 text-sm font-medium text-gray-300">
            Top Domains Unsubscribed
          </h3>
          <div className="space-y-2">
            {topDomains.map((d) => (
              <div key={d.domain} className="flex items-center justify-between">
                <span className="text-sm text-gray-400 font-mono">
                  {d.domain}
                </span>
                <span className="text-sm text-gray-300">{d.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Candidates Tab ───────────────────────────────────────────────────────────

function CandidatesTab({ data }: { data: UnsubscribeData }) {
  const { pendingCandidates, lastScan } = data;

  if (pendingCandidates.length === 0) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-8 text-center">
        <p className="text-gray-500">No candidates from the latest scan</p>
        {lastScan.scannedAt && (
          <p className="mt-1 text-xs text-gray-600">
            Last scan: {new Date(lastScan.scannedAt).toLocaleString()}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        {pendingCandidates.length} candidates from {lastScan.date} scan (
        {lastScan.totalMessages} messages scanned)
      </p>
      {pendingCandidates.map((c, i) => (
        <div
          key={i}
          className="rounded-xl border border-gray-800 bg-gray-900 p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-gray-100">
                  {c.senderName}
                </span>
                <FrequencyBadge count={c.frequency} />
              </div>
              <p className="mt-0.5 text-xs text-gray-500 truncate">
                {c.senderEmail}
              </p>
              <p className="mt-1 text-sm text-gray-400 truncate">
                {c.subject}
              </p>
            </div>
            <div className="flex shrink-0 gap-1.5">
              {c.hasUnsubscribeHeader && (
                <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-xs text-green-400">
                  unsub header
                </span>
              )}
              {c.hasOneClickUnsubscribe && (
                <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-xs text-blue-400">
                  one-click
                </span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── History Tab ──────────────────────────────────────────────────────────────

function HistoryTab({ data }: { data: UnsubscribeData }) {
  const { history } = data;

  if (history.length === 0) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-8 text-center">
        <p className="text-gray-500">No unsubscribe history yet</p>
        <p className="mt-1 text-xs text-gray-600">
          History will appear after you process your first batch
        </p>
      </div>
    );
  }

  // Group by date (already sorted newest first)
  const grouped = new Map<string, HistoryEntry[]>();
  for (const entry of history) {
    const list = grouped.get(entry.date) || [];
    list.push(entry);
    grouped.set(entry.date, list);
  }

  return (
    <div className="space-y-6">
      {[...grouped.entries()].map(([date, entries]) => (
        <div key={date}>
          <h3 className="mb-2 text-xs font-medium text-gray-500">
            {formatDateLabel(date)} — {entries.length} sender
            {entries.length !== 1 ? "s" : ""}
          </h3>
          <div className="space-y-2">
            {entries.map((entry, i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-900 px-4 py-3"
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    entry.result === "success" ? "bg-green-400" : "bg-red-400"
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-gray-200 truncate">
                    {entry.senderName}
                  </p>
                  <p className="text-xs text-gray-500 truncate">
                    {entry.senderEmail}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <span
                    className={`text-xs ${
                      entry.result === "success"
                        ? "text-green-400"
                        : "text-red-400"
                    }`}
                  >
                    {entry.result}
                  </span>
                  {entry.method && (
                    <p className="text-xs text-gray-600">{entry.method}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Components ───────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: "green" | "red" | "amber";
}) {
  const valueColor =
    color === "green"
      ? "text-green-400"
      : color === "red"
        ? "text-red-400"
        : color === "amber"
          ? "text-amber-400"
          : "text-gray-100";

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${valueColor}`}>{value}</p>
    </div>
  );
}

function FrequencyBadge({ count }: { count: number }) {
  const color =
    count >= 5
      ? "bg-red-500/10 text-red-400"
      : count >= 3
        ? "bg-amber-500/10 text-amber-400"
        : "bg-gray-800 text-gray-400";

  return (
    <span className={`rounded-full px-1.5 py-0.5 text-xs ${color}`}>
      {count}x
    </span>
  );
}

function TimelineChart({ timeline }: { timeline: TimelinePoint[] }) {
  if (timeline.length === 0) return null;

  const W = 600;
  const H = 160;
  const PAD = { top: 12, right: 12, bottom: 28, left: 32 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;

  const maxVal = Math.max(
    ...timeline.map((t) => t.success + t.failed),
    1,
  );

  const barWidth = Math.min(
    Math.max(chartW / timeline.length - 2, 4),
    24,
  );
  const gap = (chartW - barWidth * timeline.length) / Math.max(timeline.length - 1, 1);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full"
      preserveAspectRatio="xMidYMid meet"
    >
      <g transform={`translate(${PAD.left},${PAD.top})`}>
        {/* Y gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const y = chartH - frac * chartH;
          const val = Math.round(frac * maxVal);
          return (
            <g key={frac}>
              <line
                x1={0}
                y1={y}
                x2={chartW}
                y2={y}
                stroke="#374151"
                strokeWidth={0.5}
              />
              <text
                x={-6}
                y={y + 3}
                textAnchor="end"
                className="fill-gray-600"
                fontSize={9}
              >
                {val}
              </text>
            </g>
          );
        })}

        {/* Bars */}
        {timeline.map((t, i) => {
          const x = i * (barWidth + gap);
          const successH = (t.success / maxVal) * chartH;
          const failedH = (t.failed / maxVal) * chartH;

          return (
            <g key={t.date}>
              {/* Success (green) */}
              <rect
                x={x}
                y={chartH - successH - failedH}
                width={barWidth}
                height={successH}
                rx={2}
                className="fill-green-500/60"
              />
              {/* Failed (red) stacked on top */}
              {failedH > 0 && (
                <rect
                  x={x}
                  y={chartH - failedH}
                  width={barWidth}
                  height={failedH}
                  rx={2}
                  className="fill-red-500/60"
                />
              )}
              {/* X label */}
              {(i === 0 ||
                i === timeline.length - 1 ||
                i === Math.floor(timeline.length / 2)) && (
                <text
                  x={x + barWidth / 2}
                  y={chartH + 14}
                  textAnchor="middle"
                  className="fill-gray-600"
                  fontSize={9}
                >
                  {formatShortDate(t.date)}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatShortDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
