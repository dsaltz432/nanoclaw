import { useEffect, useState } from "react";
import StatusBadge from "../components/StatusBadge";

interface Group {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  is_main: boolean;
  container_config: { additionalMounts?: Array<{ hostPath: string; readonly: boolean }> } | null;
  session_id: string | null;
}

interface LogFile {
  filename: string;
  timestamp: string;
  size: number;
}

function channelType(jid: string): string {
  if (jid.startsWith("tg:")) return "Telegram";
  if (jid.startsWith("slack:")) return "Slack";
  if (jid.startsWith("discord:")) return "Discord";
  if (jid.startsWith("gmail:")) return "Gmail";
  if (jid.includes("@g.us") || jid.includes("@s.whatsapp")) return "WhatsApp";
  return "Unknown";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  // Log viewer state
  const [logGroup, setLogGroup] = useState<Group | null>(null);
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [logContent, setLogContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);

  useEffect(() => {
    fetch("/api/groups")
      .then((r) => r.json())
      .then(setGroups)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function openLogs(group: Group) {
    if (logGroup?.folder === group.folder) {
      setLogGroup(null);
      return;
    }
    setLogGroup(group);
    setSelectedFile(null);
    setLogContent(null);
    setLoadingFiles(true);
    fetch(`/api/logs/${encodeURIComponent(group.folder)}`)
      .then((r) => r.json())
      .then(setLogFiles)
      .catch(() => setLogFiles([]))
      .finally(() => setLoadingFiles(false));
  }

  function viewLogFile(filename: string) {
    if (!logGroup) return;
    setSelectedFile(filename);
    setLoadingContent(true);
    fetch(`/api/logs/${encodeURIComponent(logGroup.folder)}/${encodeURIComponent(filename)}`)
      .then((r) => r.text())
      .then(setLogContent)
      .catch(() => setLogContent("Failed to load log file"))
      .finally(() => setLoadingContent(false));
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-gray-500">Loading groups...</p>
      </div>
    );
  }

  return (
    <div className="p-8">
      <h2 className="mb-6 text-lg font-semibold text-gray-100">Groups</h2>

      {groups.length === 0 ? (
        <p className="text-gray-500">No groups registered</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {groups.map((group) => (
            <div
              key={group.jid}
              className={`rounded-xl border bg-gray-900 p-6 transition-colors ${
                logGroup?.folder === group.folder
                  ? "border-indigo-500/40"
                  : "border-gray-800"
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-sm font-medium text-gray-100">{group.name}</h3>
                  <p className="mt-1 font-mono text-xs text-gray-500">{group.folder}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
                    {channelType(group.jid)}
                  </span>
                  {group.is_main && <StatusBadge status="main" />}
                </div>
              </div>

              <div className="mt-4 space-y-2 text-xs">
                <div className="flex justify-between">
                  <span className="text-gray-500">Trigger</span>
                  <code className="rounded bg-gray-800 px-1.5 py-0.5 font-mono text-gray-400">
                    {group.trigger_pattern}
                  </code>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Session</span>
                  <span className="font-mono text-gray-400">
                    {group.session_id ? group.session_id.slice(0, 12) + "..." : "none"}
                  </span>
                </div>
              </div>

              {group.container_config?.additionalMounts &&
                group.container_config.additionalMounts.length > 0 && (
                  <div className="mt-4 border-t border-gray-800 pt-3">
                    <p className="mb-2 text-xs font-medium text-gray-500">Additional Mounts</p>
                    <div className="space-y-1">
                      {group.container_config.additionalMounts.map((mount, i) => (
                        <div key={i} className="flex items-center gap-2 text-xs">
                          <span className="font-mono text-gray-400">{mount.hostPath}</span>
                          {mount.readonly && (
                            <span className="rounded bg-gray-800 px-1 text-gray-500">ro</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              <div className="mt-4 border-t border-gray-800 pt-3">
                <button
                  onClick={() => openLogs(group)}
                  className={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
                    logGroup?.folder === group.folder
                      ? "text-indigo-400"
                      : "text-gray-500 hover:text-gray-300"
                  }`}
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  {logGroup?.folder === group.folder ? "Hide Logs" : "View Logs"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Log viewer panel */}
      {logGroup && (
        <div className="mt-6 rounded-xl border border-gray-800 bg-gray-900 overflow-hidden">
          <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
            <h3 className="text-sm font-medium text-gray-300">
              Logs —{" "}
              <span className="font-mono text-indigo-400">{logGroup.name}</span>
            </h3>
            <button
              onClick={() => setLogGroup(null)}
              className="text-gray-600 hover:text-gray-400 transition-colors"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="flex" style={{ minHeight: "320px", maxHeight: "60vh" }}>
            {/* File list */}
            <div className="w-56 shrink-0 border-r border-gray-800 overflow-auto">
              {loadingFiles ? (
                <p className="p-4 text-xs text-gray-500">Loading...</p>
              ) : logFiles.length === 0 ? (
                <p className="p-4 text-xs text-gray-500">No log files</p>
              ) : (
                <div className="space-y-0.5 p-2">
                  {logFiles.map((file) => (
                    <button
                      key={file.filename}
                      onClick={() => viewLogFile(file.filename)}
                      className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${
                        selectedFile === file.filename
                          ? "bg-indigo-500/10 text-indigo-400"
                          : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                      }`}
                    >
                      <div className="font-mono text-xs truncate">{file.filename}</div>
                      <div className="mt-0.5 flex gap-2 text-xs text-gray-600">
                        <span>{formatBytes(file.size)}</span>
                        <span>{relativeTime(file.timestamp)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Log content */}
            <div className="flex-1 overflow-auto p-5">
              {!selectedFile ? (
                <p className="text-xs text-gray-500">Select a log file to view</p>
              ) : loadingContent ? (
                <p className="text-xs text-gray-500">Loading...</p>
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-gray-300">
                  {logContent}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
