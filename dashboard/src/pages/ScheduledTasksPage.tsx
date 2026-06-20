import { useEffect, useState, useRef } from "react";
import StatusBadge from "../components/StatusBadge";

interface ScheduledTask {
  key: string;
  label: string;
  launchdLabel: string;
  schedule: string;
  lastRun: string | null;
  exitCode: number | null;
  running: boolean;
  loaded: boolean;
  status: string;
  hasErrorLog: boolean;
  recentLines: string[];
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function ExitBadge({ task }: { task: ScheduledTask }) {
  if (!task.loaded) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-500/10 px-2 py-0.5 text-xs font-medium text-gray-400">
        not loaded
      </span>
    );
  }
  if (task.exitCode === null) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-500/10 px-2 py-0.5 text-xs font-medium text-gray-400">
        no exit yet
      </span>
    );
  }
  const ok = task.exitCode === 0;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
        ok ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-green-400" : "bg-red-400"}`}
      />
      exit {task.exitCode}
    </span>
  );
}

export default function ScheduledTasksPage({
  embedded,
}: {
  embedded?: boolean;
}) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [logs, setLogs] = useState<string>("");
  const [logsLoading, setLogsLoading] = useState(false);

  function toggleLogs(key: string) {
    if (expandedKey === key) {
      setExpandedKey(null);
      setLogs("");
      return;
    }
    setExpandedKey(key);
    setLogsLoading(true);
    fetch(`/api/scheduled-tasks/${key}/log?tail=200`)
      .then((r) => r.json())
      .then((data) => setLogs(data.logs || data.error || "No logs"))
      .catch(() => setLogs("Failed to fetch logs"))
      .finally(() => setLogsLoading(false));
  }

  function fetchTasks(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    fetch("/api/scheduled-tasks")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setTasks(data);
      })
      .catch(() => {})
      .finally(() => {
        setLoading(false);
        if (isRefresh) setTimeout(() => setRefreshing(false), 500);
      });
  }

  useEffect(() => {
    fetchTasks();
    intervalRef.current = setInterval(() => fetchTasks(true), 30000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-gray-500">Loading scheduled tasks...</p>
      </div>
    );
  }

  return (
    <div className={embedded ? "" : "p-4 sm:p-8"}>
      <div className="mb-6 flex items-center justify-between">
        {!embedded && (
          <h2 className="text-lg font-semibold text-gray-100">
            Native Host Scheduled Tasks
          </h2>
        )}
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span
            className={`inline-block h-2 w-2 rounded-full bg-green-500 transition-opacity ${refreshing ? "animate-pulse opacity-100" : "opacity-30"}`}
          />
          Auto-refresh 30s
        </div>
      </div>

      {tasks.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-gray-800 bg-gray-900 py-16">
          <p className="text-sm text-gray-500">No scheduled tasks</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((t) => (
            <div
              key={t.key}
              className="rounded-xl border border-gray-800 bg-gray-900"
            >
              <button
                onClick={() => toggleLogs(t.key)}
                className="flex w-full items-center gap-4 px-6 py-4 text-left transition-colors hover:bg-gray-800/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm font-medium text-gray-100">
                      {t.label}
                    </span>
                    <StatusBadge status={t.status} />
                    <ExitBadge task={t} />
                    {t.hasErrorLog && (
                      <span className="inline-flex items-center rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs font-medium text-yellow-400">
                        stderr
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-4 text-xs text-gray-500">
                    <span className="font-mono">{t.launchdLabel}</span>
                    <span>Schedule: {t.schedule}</span>
                    <span>
                      Last run:{" "}
                      {t.lastRun ? relativeTime(t.lastRun) : "never"}
                    </span>
                  </div>
                </div>
                <svg
                  className={`h-4 w-4 shrink-0 text-gray-500 transition-transform ${expandedKey === t.key ? "rotate-180" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M19.5 8.25l-7.5 7.5-7.5-7.5"
                  />
                </svg>
              </button>

              {t.recentLines.length > 0 && (
                <div className="border-t border-gray-800 px-6 py-3">
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5 text-gray-400">
                    {t.recentLines.join("\n")}
                  </pre>
                </div>
              )}

              {expandedKey === t.key && (
                <div className="border-t border-gray-800 px-6 py-4">
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-xs font-medium text-gray-400">
                      Recent log ({t.launchdLabel})
                    </h4>
                  </div>
                  {logsLoading ? (
                    <p className="text-xs text-gray-500">Loading logs...</p>
                  ) : (
                    <pre className="max-h-96 overflow-auto rounded-lg bg-gray-950 p-4 font-mono text-xs leading-5 text-gray-300">
                      {logs}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
