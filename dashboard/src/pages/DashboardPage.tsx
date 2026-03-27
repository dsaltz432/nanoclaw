import { useEffect, useState } from "react";
import StatusBadge from "../components/StatusBadge";

interface Task {
  id: string;
  group_folder: string;
  status: string;
  last_run: string | null;
  last_result: string | null;
  schedule_type: string;
  schedule_value: string;
  prompt: string;
}

interface Container {
  id: string;
  name: string;
  status: string;
}

interface Group {
  jid: string;
  name: string;
  folder: string;
}

function taskLabel(task: Task): string {
  const firstLine = task.prompt.split("\n").find((l) => l.trim().length > 0) || "";
  const clean = firstLine.replace(/^#+\s*/, "").replace(/\*\*/g, "").replace(/^You are /, "").trim();
  if (clean.length > 50) return clean.slice(0, 47) + "...";
  return clean || task.group_folder;
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

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch("/api/tasks").then((r) => r.json()),
      fetch("/api/containers").then((r) => r.json()),
      fetch("/api/groups").then((r) => r.json()),
    ])
      .then(([t, c, g]) => {
        setTasks(t);
        setContainers(c);
        setGroups(g);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const recurringTasks = tasks.filter((t) => t.schedule_type === "cron" || t.schedule_type === "interval");

  const recentRuns = tasks
    .filter((t) => t.last_run)
    .sort((a, b) => new Date(b.last_run!).getTime() - new Date(a.last_run!).getTime())
    .slice(0, 5);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-gray-500">Loading dashboard...</p>
      </div>
    );
  }

  return (
    <div className="p-8">
      <h2 className="mb-6 text-lg font-semibold text-gray-100">Dashboard</h2>

      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SummaryCard title="Recurring Tasks" value={recurringTasks.length}>
          <p className="mt-2 text-xs text-gray-500">Active scheduled jobs</p>
        </SummaryCard>

        <SummaryCard title="Containers" value={containers.length}>
          <p className="mt-2 text-xs text-gray-500">
            {containers.filter((c) => c.status === "running").length} running
          </p>
        </SummaryCard>

        <SummaryCard title="Groups" value={groups.length}>
          <p className="mt-2 text-xs text-gray-500">Registered groups</p>
        </SummaryCard>
      </div>

      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
        <h3 className="mb-4 text-sm font-medium text-gray-300">Recent Task Runs</h3>
        {recentRuns.length === 0 ? (
          <p className="text-sm text-gray-500">No recent runs</p>
        ) : (
          <div className="space-y-3">
            {recentRuns.map((task) => (
              <div
                key={task.id}
                className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-950 px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-gray-300">{taskLabel(task)}</span>
                    <span className="rounded bg-gray-800 px-1.5 py-0.5 text-xs text-gray-400">{task.group_folder}</span>
                  </div>
                  {task.last_result && (
                    <p className="mt-1 truncate text-xs text-gray-500">{task.last_result}</p>
                  )}
                </div>
                <div className="ml-4 flex items-center gap-3">
                  <StatusBadge status={task.status} />
                  <span className="text-xs text-gray-500">
                    {task.last_run ? relativeTime(task.last_run) : "never"}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  title,
  value,
  children,
}: {
  title: string;
  value: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
      <p className="text-sm text-gray-400">{title}</p>
      <p className="mt-1 text-3xl font-semibold text-gray-100">{value}</p>
      {children}
    </div>
  );
}
