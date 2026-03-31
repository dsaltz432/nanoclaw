import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import TasksPage from "./pages/TasksPage";
import GroupsPage from "./pages/GroupsPage";
import ContainersPage from "./pages/ContainersPage";
import ProjectsPage from "./pages/ProjectsPage";
import BeaconIntelPage from "./pages/BeaconIntelPage";
import MortgagePage from "./pages/MortgagePage";
import EmailUnsubscribePage from "./pages/EmailUnsubscribePage";

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((res) => res.json())
      .then((data) => setAuthenticated(data.authenticated))
      .catch(() => setAuthenticated(false));
  }, []);

  if (authenticated === null) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-950">
        <div className="text-gray-400">Loading...</div>
      </div>
    );
  }

  if (!authenticated) {
    return <LoginPage onLogin={() => setAuthenticated(true)} />;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<DashboardPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="groups" element={<GroupsPage />} />
          <Route path="containers" element={<ContainersPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="beacon-intel" element={<BeaconIntelPage />} />
          <Route path="mortgage" element={<MortgagePage />} />
          <Route path="email-unsubscribe" element={<EmailUnsubscribePage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
