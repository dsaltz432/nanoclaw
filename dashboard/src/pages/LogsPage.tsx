import { useEffect, useState } from "react";

interface Group {
  jid: string;
  name: string;
  folder: string;
}

interface LogFile {
  filename: string;
  timestamp: string;
  size: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

export default function LogsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [logContent, setLogContent] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loadingGroups, setLoadingGroups] = useState(true);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [loadingContent, setLoadingContent] = useState(false);

  useEffect(() => {
    fetch("/api/groups")
      .then((r) => r.json())
      .then(setGroups)
      .catch(() => {})
      .finally(() => setLoadingGroups(false));
  }, []);

  function selectGroup(folder: string) {
    setSelectedFolder(folder);
    setSelectedFile(null);
    setLogContent(null);
    setLoadingFiles(true);
    fetch(`/api/logs/${encodeURIComponent(folder)}`)
      .then((r) => r.json())
      .then(setLogFiles)
      .catch(() => setLogFiles([]))
      .finally(() => setLoadingFiles(false));
  }

  function viewLogFile(folder: string, filename: string) {
    setSelectedFile(filename);
    setLoadingContent(true);
    fetch(`/api/logs/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`)
      .then((r) => r.text())
      .then(setLogContent)
      .catch(() => setLogContent("Failed to load log file"))
      .finally(() => setLoadingContent(false));
  }

  return (
    <div className="flex h-full">
      {/* Left panel: group list */}
      <div className="w-64 flex-shrink-0 overflow-auto border-r border-gray-800 bg-gray-900">
        <div className="px-4 py-3">
          <h3 className="text-xs font-medium text-gray-500 uppercase tracking-wider">Groups</h3>
        </div>
        {loadingGroups ? (
          <p className="px-4 text-xs text-gray-500">Loading...</p>
        ) : groups.length === 0 ? (
          <p className="px-4 text-xs text-gray-500">No groups</p>
        ) : (
          <div className="space-y-0.5 px-2">
            {groups.map((group) => (
              <button
                key={group.jid}
                onClick={() => selectGroup(group.folder)}
                className={`w-full rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                  selectedFolder === group.folder
                    ? "bg-indigo-500/10 text-indigo-400"
                    : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                }`}
              >
                <div className="font-medium">{group.name}</div>
                <div className="font-mono text-xs text-gray-600">{group.folder}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Right panel: log files and content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {!selectedFolder ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-sm text-gray-500">Select a group to view logs</p>
          </div>
        ) : (
          <>
            {/* Log file list */}
            <div className="border-b border-gray-800 bg-gray-900/50">
              <div className="px-6 py-3">
                <h3 className="text-sm font-medium text-gray-300">
                  Logs for <span className="font-mono text-indigo-400">{selectedFolder}</span>
                </h3>
              </div>
              {loadingFiles ? (
                <p className="px-6 pb-3 text-xs text-gray-500">Loading files...</p>
              ) : logFiles.length === 0 ? (
                <p className="px-6 pb-3 text-xs text-gray-500">No log files</p>
              ) : (
                <div className="max-h-48 overflow-auto px-4 pb-3">
                  <div className="space-y-1">
                    {logFiles.map((file) => (
                      <button
                        key={file.filename}
                        onClick={() => viewLogFile(selectedFolder, file.filename)}
                        className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                          selectedFile === file.filename
                            ? "bg-indigo-500/10 text-indigo-400"
                            : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
                        }`}
                      >
                        <span className="font-mono">{file.filename}</span>
                        <div className="flex items-center gap-3 text-gray-600">
                          <span>{formatBytes(file.size)}</span>
                          <span>{relativeTime(file.timestamp)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Log content */}
            <div className="flex-1 overflow-auto p-6">
              {!selectedFile ? (
                <p className="text-sm text-gray-500">Select a log file to view</p>
              ) : loadingContent ? (
                <p className="text-sm text-gray-500">Loading...</p>
              ) : (
                <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-gray-300">
                  {logContent}
                </pre>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
