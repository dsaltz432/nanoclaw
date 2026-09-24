import { useState } from "react";
import TasksPage from "./TasksPage";
import GroupsPage from "./GroupsPage";
import ContainersPage from "./ContainersPage";
import ProjectsPage from "./ProjectsPage";
import ScheduledTasksPage from "./ScheduledTasksPage";

type Tab = "tasks" | "groups" | "containers" | "projects" | "scheduled";

const tabs: { key: Tab; label: string }[] = [
  { key: "tasks", label: "NanoClaw Tasks" },
  { key: "scheduled", label: "Host Tasks" },
  { key: "groups", label: "Groups" },
  { key: "containers", label: "Containers" },
  { key: "projects", label: "Projects" },
];

export default function AdminPage() {
  const [active, setActive] = useState<Tab>("tasks");

  return (
    <div className="p-4 sm:p-8">
      <h2 className="mb-6 text-lg font-semibold text-gray-100">Admin</h2>

      {/* One scrollable row on phones rather than wrapping or clipping tabs. */}
      <div className="mb-6 flex w-fit max-w-full gap-1 overflow-x-auto rounded-lg bg-gray-900 p-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActive(tab.key)}
            className={`shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors sm:px-4 ${
              active === tab.key
                ? "bg-gray-800 text-gray-100"
                : "text-gray-400 hover:text-gray-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {active === "tasks" && <TasksPage embedded />}
      {active === "groups" && <GroupsPage embedded />}
      {active === "containers" && <ContainersPage embedded />}
      {active === "projects" && <ProjectsPage embedded />}
      {active === "scheduled" && <ScheduledTasksPage embedded />}
    </div>
  );
}
