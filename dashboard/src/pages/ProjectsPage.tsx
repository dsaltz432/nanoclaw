import { useEffect, useState } from "react";
import StatusBadge from "../components/StatusBadge";

interface Project {
  name: string;
  path: string;
  branch: string;
  lastCommits: string[];
  status: string[];
  ahead: number;
  behind: number;
  mainBranch: string | null;
  openPRs: Array<{
    number: number;
    title: string;
    url: string;
    createdAt: string;
    headRefName: string;
  }>;
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

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then(setProjects)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-gray-500">Loading projects...</p>
      </div>
    );
  }

  return (
    <div className="p-8">
      <h2 className="mb-6 text-lg font-semibold text-gray-100">Projects</h2>

      {projects.length === 0 ? (
        <p className="text-gray-500">No projects configured</p>
      ) : (
        <div className="space-y-4">
          {projects.map((project) => (
            <div key={project.path} className="rounded-xl border border-gray-800 bg-gray-900 p-6">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-sm font-medium text-gray-100">{project.name}</h3>
                  <p className="mt-1 font-mono text-xs text-gray-500">{project.path}</p>
                </div>
                <div className="flex items-center gap-2">
                  <code className="rounded bg-indigo-500/10 px-2 py-0.5 font-mono text-xs text-indigo-400">
                    {project.branch}
                  </code>
                  {project.mainBranch && (project.ahead > 0 || project.behind > 0) ? (
                    <span className="font-mono text-xs text-gray-400">
                      {project.ahead > 0 && <span className="text-green-400">+{project.ahead} ahead</span>}
                      {project.ahead > 0 && project.behind > 0 && <span> · </span>}
                      {project.behind > 0 && <span className="text-yellow-400">-{project.behind} behind</span>}
                      <span className="text-gray-600"> {project.mainBranch}</span>
                    </span>
                  ) : project.mainBranch ? (
                    <span className="font-mono text-xs text-gray-500">up to date with {project.mainBranch}</span>
                  ) : null}
                  {project.status.length === 0 ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-xs text-green-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-400" />
                      clean
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-400">
                      <span className="h-1.5 w-1.5 rounded-full bg-yellow-400" />
                      {project.status.length} modified
                    </span>
                  )}
                </div>
              </div>

              {project.lastCommits.length > 0 && (
                <div className="mt-4">
                  <h4 className="mb-2 text-xs font-medium text-gray-500">Recent Commits</h4>
                  <div className="space-y-1">
                    {project.lastCommits.map((commit, i) => (
                      <p key={i} className="truncate font-mono text-xs text-gray-400">
                        {commit}
                      </p>
                    ))}
                  </div>
                </div>
              )}

              {project.openPRs.length > 0 && (
                <div className="mt-4 border-t border-gray-800 pt-4">
                  <h4 className="mb-2 text-xs font-medium text-gray-500">
                    Open PRs ({project.openPRs.length})
                  </h4>
                  <div className="space-y-2">
                    {project.openPRs.map((pr) => (
                      <div
                        key={pr.number}
                        className="flex items-center justify-between rounded-lg border border-gray-800 bg-gray-950 px-4 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <a
                            href={pr.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-sm text-indigo-400 transition-colors hover:text-indigo-300"
                          >
                            #{pr.number} {pr.title}
                          </a>
                          <p className="mt-0.5 font-mono text-xs text-gray-600">{pr.headRefName}</p>
                        </div>
                        <span className="ml-4 text-xs text-gray-500">
                          {relativeTime(pr.createdAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
