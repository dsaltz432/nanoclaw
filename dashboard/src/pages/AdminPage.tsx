import { useState } from "react";
import TasksPage from "./TasksPage";
import GroupsPage from "./GroupsPage";
import ContainersPage from "./ContainersPage";
import ProjectsPage from "./ProjectsPage";

type Tab = "tasks" | "groups" | "containers" | "projects";

const tabs: { key: Tab; label: string }[] = [
  { key: "tasks", label: "Tasks" },
  { key: "groups", label: "Groups" },
  { key: "containers", label: "Containers" },
  { key: "projects", label: "Projects" },
];

export default function AdminPage() {
  const [active, setActive] = useState<Tab>("tasks");

  return (
    <div className="p-4 sm:p-8">
      <h2 className="mb-6 text-lg font-semibold text-gray-100">Admin</h2>

      <div className="mb-6 flex gap-1 rounded-lg bg-gray-900 p-1 w-fit">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActive(tab.key)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
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
    </div>
  );
}
