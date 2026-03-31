import { useEffect, useState } from "react";
import StatusBadge from "../components/StatusBadge";

interface Task {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: string;
  created_at: string;
  context_mode: string;
  name?: string | null;
}

interface TaskRun {
  id: number;
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
  log_file: string | null;
  log_content: string | null;
}

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const absDiff = Math.abs(diff);
  const isFuture = diff < 0;

  const seconds = Math.floor(absDiff / 1000);
  if (seconds < 60) return isFuture ? `in ${seconds}s` : `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return isFuture ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return isFuture ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return isFuture ? `in ${days}d` : `${days}d ago`;
}

function taskLabel(task: Task): string {
  if (task.name) return task.name;
  // Extract a short description from the first line of the prompt
  const firstLine = task.prompt.split("\n").find((l) => l.trim().length > 0) || "";
  // Strip markdown and take first ~60 chars
  const clean = firstLine.replace(/^#+\s*/, "").replace(/\*\*/g, "").replace(/^You are /, "").trim();
  if (clean.length > 60) return clean.slice(0, 57) + "...";
  return clean || task.id;
}

function formatSchedule(task: Task): string {
  if (task.schedule_type === "once") return "once";
  if (task.schedule_type === "interval") {
    const ms = parseInt(task.schedule_value);
    if (ms >= 86400000) return `every ${Math.floor(ms / 86400000)}d`;
    if (ms >= 3600000) return `every ${Math.floor(ms / 3600000)}h`;
    if (ms >= 60000) return `every ${Math.floor(ms / 60000)}m`;
    return `every ${Math.floor(ms / 1000)}s`;
  }
  return task.schedule_value; // cron expression
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSec}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  return `${hours}h ${remainingMin}m`;
}

type TabFilter = "daily" | "weekly" | "ad_hoc";

function classifyTask(task: Task): TabFilter {
  if (task.schedule_type === "cron") {
    // Cron: min hour dom month dow
    // If day-of-week is * and day-of-month is *, it's daily
    const parts = task.schedule_value.trim().split(/\s+/);
    const dow = parts[4]; // day of week
    if (dow === "*") return "daily";
    return "weekly";
  }
  if (task.schedule_type === "interval") {
    const ms = parseInt(task.schedule_value);
    // Intervals >= 1 day are weekly-ish, shorter are daily
    if (ms >= 86400000) return "weekly";
    return "daily";
  }
  return "ad_hoc";
}

/** Extract sort key from cron/interval: hour * 60 + minute for time-of-day ordering */
function taskTimeSort(task: Task): number {
  if (task.schedule_type === "cron") {
    const parts = task.schedule_value.trim().split(/\s+/);
    const minute = parseInt(parts[0]) || 0;
    const hour = parseInt(parts[1]) || 0;
    return hour * 60 + minute;
  }
  // For interval/once, sort by next_run time-of-day
  if (task.next_run) {
    const d = new Date(task.next_run);
    return d.getHours() * 60 + d.getMinutes();
  }
  return 9999;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<number | null>(null);
  const [showPromptFor, setShowPromptFor] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabFilter>("daily");

  useEffect(() => {
    fetch("/api/tasks")
      .then((r) => r.json())
      .then(setTasks)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function toggleExpand(taskId: string) {
    if (expandedId === taskId) {
      setExpandedId(null);
      setRuns([]);
      return;
    }
    setExpandedId(taskId);
    setRunsLoading(true);
    fetch(`/api/tasks/${taskId}/runs`)
      .then((r) => r.json())
      .then(setRuns)
      .catch(() => setRuns([]))
      .finally(() => setRunsLoading(false));
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-gray-500">Loading tasks...</p>
      </div>
    );
  }

  const tabs: { key: TabFilter; label: string }[] = [
    { key: "daily", label: "Daily" },
    { key: "weekly", label: "Weekly" },
    { key: "ad_hoc", label: "Ad-Hoc" },
  ];

  const filteredTasks = tasks
    .filter((t) => classifyTask(t) === activeTab)
    .sort((a, b) => taskTimeSort(a) - taskTimeSort(b));
  const counts = {
    daily: tasks.filter((t) => classifyTask(t) === "daily").length,
    weekly: tasks.filter((t) => classifyTask(t) === "weekly").length,
    ad_hoc: tasks.filter((t) => classifyTask(t) === "ad_hoc").length,
  };

  return (
    <div className="p-4 sm:p-8">
      <h2 className="mb-6 text-lg font-semibold text-gray-100">Scheduled Tasks</h2>

      <div className="mb-6 flex gap-1 rounded-lg bg-gray-900 p-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => { setActiveTab(tab.key); setExpandedId(null); setRuns([]); }}
            className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? "bg-gray-800 text-gray-100"
                : "text-gray-400 hover:text-gray-300"
            }`}
          >
            {tab.label}
            <span className={`rounded-full px-1.5 py-0.5 text-xs ${
              activeTab === tab.key
                ? "bg-gray-700 text-gray-300"
                : "bg-gray-800 text-gray-500"
            }`}>
              {counts[tab.key]}
            </span>
          </button>
        ))}
      </div>

      {filteredTasks.length === 0 ? (
        <p className="text-gray-500">No {activeTab.replace("_", " ")} tasks</p>
      ) : (
        <div className="space-y-3">
          {filteredTasks.map((task) => (
            <div key={task.id} className="rounded-xl border border-gray-800 bg-gray-900">
              <button
                onClick={() => toggleExpand(task.id)}
                className="flex w-full items-center gap-4 px-6 py-4 text-left transition-colors hover:bg-gray-800/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-gray-200">{taskLabel(task)}</span>
                      <StatusBadge status={task.status} />
                      {task.last_result?.startsWith("Error:") && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs text-red-400">
                          <span className="h-1.5 w-1.5 rounded-full bg-red-400" />
                          last run failed
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-400">{task.group_folder}</span>
                      <code className="rounded bg-gray-800 px-1.5 py-0.5 font-mono text-xs text-gray-400">
                        {formatSchedule(task)}
                      </code>
                    </div>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
                    <span>Next: {task.next_run ? `${new Date(task.next_run).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })} ET (${relativeTime(task.next_run)})` : "N/A"}</span>
                    <span>Last: {task.last_run ? relativeTime(task.last_run) : "never"}</span>
                    {task.last_result && (
                      <span className="max-w-xs truncate">Result: {task.last_result}</span>
                    )}
                  </div>
                </div>
                <svg
                  className={`h-4 w-4 text-gray-500 transition-transform ${expandedId === task.id ? "rotate-180" : ""}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
              </button>

              {expandedId === task.id && (
                <div className="border-t border-gray-800 px-6 py-4">
                  <div className="mb-4">
                    <button
                      onClick={() => setShowPromptFor(showPromptFor === task.id ? null : task.id)}
                      className="text-xs font-medium text-indigo-400 transition-colors hover:text-indigo-300"
                    >
                      {showPromptFor === task.id ? "Hide Prompt" : "Show Prompt"}
                    </button>
                    {showPromptFor === task.id && (
                      <pre className="mt-2 max-h-48 overflow-auto rounded-lg bg-gray-950 p-4 font-mono text-xs text-gray-300">
                        {task.prompt}
                      </pre>
                    )}
                  </div>

                  <h4 className="mb-3 text-xs font-medium text-gray-400">Run History</h4>
                  {runsLoading ? (
                    <p className="text-xs text-gray-500">Loading runs...</p>
                  ) : runs.length === 0 ? (
                    <p className="text-xs text-gray-500">No runs yet</p>
                  ) : (
                    <div className="space-y-2">
                      {runs.map((run) => (
                        <div key={run.id} className="rounded-lg border border-gray-800 bg-gray-950">
                          <button
                            onClick={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
                            className="flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-gray-900/50"
                          >
                            <div className="flex items-center gap-3">
                              <span className="text-xs text-gray-500">
                                {new Date(run.run_at).toLocaleString()}
                              </span>
                              <span className="font-mono text-xs text-gray-400">
                                {formatDuration(run.duration_ms)}
                              </span>
                              <StatusBadge status={run.status} />
                            </div>
                            <svg
                              className={`h-3 w-3 text-gray-600 transition-transform ${expandedRunId === run.id ? "rotate-180" : ""}`}
                              fill="none"
                              viewBox="0 0 24 24"
                              stroke="currentColor"
                              strokeWidth={2}
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                            </svg>
                          </button>
                          {expandedRunId === run.id && (
                            <div className="border-t border-gray-800 px-4 py-3 space-y-3">
                              <div>
                                <h5 className="mb-1 text-xs font-medium text-gray-500">Result</h5>
                                <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-900 p-3 font-mono text-xs text-gray-300">
                                  {run.error ?? run.result ?? "No output"}
                                </pre>
                              </div>
                              {run.log_content && (
                                <div>
                                  <h5 className="mb-1 text-xs font-medium text-gray-500">
                                    Container Log
                                    {run.log_file && <span className="ml-2 font-mono text-gray-600">{run.log_file}</span>}
                                  </h5>
                                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-900 p-3 font-mono text-xs leading-5 text-gray-400">
                                    {run.log_content}
                                  </pre>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
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
