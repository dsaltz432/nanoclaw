import { lazy, useEffect, useState } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import Layout from "./components/Layout";
import LoginPage from "./pages/LoginPage";

// Each page is its own chunk, loaded when it is first opened: one bundle held
// every page (maps, charts, eleven sections) and the browser parsed all ~860KB
// before the page you opened could fetch anything. Layout wraps the outlet
// in Suspense, so the sidebar stays put while a page's chunk loads.
const DashboardPage = lazy(() => import("./pages/DashboardPage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const BeaconIntelPage = lazy(() => import("./pages/BeaconIntelPage"));
const MortgagePage = lazy(() => import("./pages/MortgagePage"));
const EmailUnsubscribePage = lazy(() => import("./pages/EmailUnsubscribePage"));
const StravaPage = lazy(() => import("./pages/StravaPage"));
const HealthPage = lazy(() => import("./pages/HealthPage"));
const TicketsPage = lazy(() => import("./pages/TicketsPage"));
const ShoppingPage = lazy(() => import("./pages/ShoppingPage"));
const FantasyPage = lazy(() => import("./pages/FantasyPage"));
const PeoplePage = lazy(() => import("./pages/PeoplePage"));

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
          <Route path="admin" element={<AdminPage />} />
          <Route path="beacon-intel" element={<BeaconIntelPage />} />
          <Route path="mortgage" element={<MortgagePage />} />
          <Route path="email-unsubscribe" element={<EmailUnsubscribePage />} />
          <Route path="strava" element={<StravaPage />} />
          <Route path="health" element={<HealthPage />} />
          <Route path="tickets" element={<TicketsPage />} />
          <Route path="shopping" element={<ShoppingPage />} />
          <Route path="fantasy" element={<FantasyPage />} />
          <Route path="people" element={<PeoplePage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
