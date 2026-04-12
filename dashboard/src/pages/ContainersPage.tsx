import { useEffect, useState, useRef } from "react";
import StatusBadge from "../components/StatusBadge";

interface Container {
  id: string;
  name: string;
  image: string;
  status: string;
  created: string;
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

export default function ContainersPage({ embedded }: { embedded?: boolean }) {
  const [containers, setContainers] = useState<Container[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [expandedName, setExpandedName] = useState<string | null>(null);
  const [logs, setLogs] = useState<string>("");
  const [logsLoading, setLogsLoading] = useState(false);
  const logsIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function fetchLogs(name: string) {
    fetch(`/api/containers/${name}/logs?tail=200`)
      .then((r) => r.json())
      .then((data) => setLogs(data.logs || data.error || "No logs"))
      .catch(() => setLogs("Failed to fetch logs"));
  }

  function toggleLogs(name: string) {
    if (expandedName === name) {
      setExpandedName(null);
      setLogs("");
      if (logsIntervalRef.current) clearInterval(logsIntervalRef.current);
      return;
    }
    setExpandedName(name);
    setLogsLoading(true);
    fetch(`/api/containers/${name}/logs?tail=200`)
      .then((r) => r.json())
      .then((data) => setLogs(data.logs || data.error || "No logs"))
      .catch(() => setLogs("Failed to fetch logs"))
      .finally(() => setLogsLoading(false));
    // Auto-refresh logs every 5s
    if (logsIntervalRef.current) clearInterval(logsIntervalRef.current);
    logsIntervalRef.current = setInterval(() => fetchLogs(name), 5000);
  }

  function fetchContainers(isRefresh = false) {
    if (isRefresh) setRefreshing(true);
    fetch("/api/containers")
      .then((r) => r.json())
      .then(setContainers)
      .catch(() => {})
      .finally(() => {
        setLoading(false);
        if (isRefresh) setTimeout(() => setRefreshing(false), 500);
      });
  }

  useEffect(() => {
    fetchContainers();
    intervalRef.current = setInterval(() => fetchContainers(true), 10000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (logsIntervalRef.current) clearInterval(logsIntervalRef.current);
    };
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-gray-500">Loading containers...</p>
      </div>
    );
  }

  return (
    <div className={embedded ? "" : "p-4 sm:p-8"}>
      <div className="mb-6 flex items-center justify-between">
        {!embedded && <h2 className="text-lg font-semibold text-gray-100">Containers</h2>}
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span
            className={`inline-block h-2 w-2 rounded-full bg-green-500 transition-opacity ${refreshing ? "animate-pulse opacity-100" : "opacity-30"}`}
          />
          Auto-refresh 10s
        </div>
      </div>

      {containers.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-gray-800 bg-gray-900 py-16">
          <svg className="mb-3 h-8 w-8 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25m9-5.25v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
          </svg>
          <p className="text-sm text-gray-500">No containers running</p>
        </div>
      ) : (
        <div className="space-y-3">
          {containers.map((c) => (
            <div key={c.id} className="rounded-xl border border-gray-800 bg-gray-900">
              <button
                onClick={() => toggleLogs(c.name)}
                className="flex w-full items-center gap-4 px-6 py-4 text-left transition-colors hover:bg-gray-800/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm text-gray-200">{c.name}</span>
                    <StatusBadge status={c.status} />
                  </div>
                  <div className="mt-1 flex gap-4 text-xs text-gray-500">
                    <span>Image: <span className="font-mono">{c.image}</span></span>
                    <span>Created: {relativeTime(c.created)}</span>
                  </div>
                </div>
                <svg
                  className={`h-4 w-4 text-gray-500 transition-transform ${expandedName === c.name ? "rotate-180" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>

              {expandedName === c.name && (
                <div className="border-t border-gray-800 px-6 py-4">
                  <div className="mb-2 flex items-center justify-between">
                    <h4 className="text-xs font-medium text-gray-400">Container Logs</h4>
                    <span className="text-xs text-gray-600">auto-refresh 5s</span>
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
