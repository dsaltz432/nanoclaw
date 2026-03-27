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

function channelType(jid: string): string {
  if (jid.startsWith("tg:")) return "Telegram";
  if (jid.startsWith("slack:")) return "Slack";
  if (jid.startsWith("discord:")) return "Discord";
  if (jid.startsWith("gmail:")) return "Gmail";
  if (jid.includes("@g.us") || jid.includes("@s.whatsapp")) return "WhatsApp";
  return "Unknown";
}

export default function GroupsPage() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/groups")
      .then((r) => r.json())
      .then(setGroups)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

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
            <div key={group.jid} className="rounded-xl border border-gray-800 bg-gray-900 p-6">
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
