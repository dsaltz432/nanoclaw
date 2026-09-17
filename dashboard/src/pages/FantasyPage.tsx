import { useEffect, useState } from "react";
import AdminTab from "./fantasy/AdminTab";
import ExpertsTab from "./fantasy/ExpertsTab";
import LineupTab from "./fantasy/LineupTab";
import MovesTab from "./fantasy/MovesTab";
import PlayerDossier from "./fantasy/PlayerDossier";
import ReadingTab from "./fantasy/ReadingTab";
import TodayTab from "./fantasy/TodayTab";
import TradesTab from "./fantasy/TradesTab";
import { Badge } from "./fantasy/viz";
import { Select } from "./fantasy/Select";
import { MethodProvider, MethodologyPage } from "./fantasy/method";

/**
 * Fantasy Football.
 *
 * Sleeper's API is read-only, so nothing here is an action — it is a place to
 * see the analysis and decide. The claim still gets entered by hand in the app.
 *
 * League selection is global to the tab and deliberately explicit. QB is worth
 * 0.44x RB in the redraft league and 1.31x RB in the superflex guillotine
 * league, so a number without a league attached is not just imprecise, it is
 * wrong somewhere. Every panel re-fetches when the league changes.
 */

type Tab = "today" | "lineup" | "moves" | "trades" | "rankings" | "reading" | "admin";

// Phase 5 (CONTENT-PLAN.md): tabs by decision, not by data source.
//   Today     the brief
//   Lineup    start / sit this week
//   Moves     add / drop / claim / stash (the waiver engine is a fold inside)
//   Trades    sell candidates, buy targets, then the builder
//   Rankings  the consensus board
//   Reading   articles and wire notes, one feed
// Waiver wire, Trends, News and Experts are absorbed; Alerts is hidden until
// an implementation earns its place. Dynasty is league behaviour, not a tab.
const TABS: { key: Tab; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "lineup", label: "Lineup" },
  { key: "moves", label: "Moves" },
  { key: "trades", label: "Trades" },
  { key: "rankings", label: "Rankings" },
  { key: "reading", label: "Reading" },
  // Ingest health for the content layer: which sites ran, what they wrote,
  // and every article as it landed. League-independent.
  { key: "admin", label: "Admin" },
];

type League = {
  league_id: string;
  league_key: string;
  season: string;
  name: string;
  total_rosters: number;
  faab_budget: number;
  status: string;
};

type Overview = {
  state: { season?: string; season_type?: string; week?: number };
  season: string;
  target_week: number;
  leagues: League[];
  freshness: {
    sources: { source: string; last_run: string; ok: boolean }[];
    failing: string[];
    daily_last_run: string | null;
    live_last_run: string | null;
  };
  audit: { failures: number; checks: { status: string; label: string; detail: string }[] };
  counts: Record<string, number>;
  error?: string;
};


export default function FantasyPage() {
  const [tab, setTab] = useState<Tab>("today");
  // Any player name on any tab opens the dossier: rankings across
  // sites, claims with rationale, notes, and status in all three leagues.
  const [dossier, setDossier] = useState<string | null>(null);
  const [league, setLeague] = useState<string>("redraft");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const [showMethod, setShowMethod] = useState(false);

  useEffect(() => {
    fetch("/api/fantasy/overview")
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error || d.detail) : setOverview(d)))
      .catch((e) => setErr(String(e)));
  }, []);

  const current = overview?.leagues.find((l) => l.league_key === league);
  const staleHours = hoursSince(overview?.freshness.daily_last_run);

  return (
    <MethodProvider>
    <div className="ff-scope p-4 sm:p-8">

      {/* Health and explanation are both top-right and both out of the way:
          neither is what you came for, and both were previously a band across
          the page that every panel had to start below. */}
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 sm:mb-5 sm:gap-y-2">
        <h2 className="text-base font-semibold text-gray-100 sm:text-lg">Fantasy Football</h2>
        {overview && (
          <span className="text-xs text-gray-500">
            {overview.state.season} {overview.state.season_type}, projecting week {overview.target_week}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowMethod((v) => !v)}
            className={`rounded-md border px-2.5 py-1 text-xs ${
              showMethod
                ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-300"
                : "border-gray-800 text-gray-400 hover:border-gray-700 hover:text-gray-200"
            }`}
            title="Every data source, and what each is used for"
          >
            Methodology
          </button>
          {overview && (
            <button
              onClick={() => setShowAudit((v) => !v)}
              className={`rounded-md border px-2.5 py-1 text-xs ${
                overview.audit.failures > 0 || overview.freshness.failing.length > 0
                  ? "border-amber-500/40 text-amber-300 hover:border-amber-400"
                  : "border-gray-800 text-gray-500 hover:border-gray-700 hover:text-gray-300"
              }`}
              title={
                staleHours == null
                  ? "never refreshed"
                  : `data refreshed ${staleHours.toFixed(0)}h ago`
              }
            >
              {overview.audit.failures > 0
                ? `${overview.audit.failures} checks failing`
                : overview.freshness.failing.length > 0
                ? `${overview.freshness.failing.length} sources failing`
                : "healthy"}
              {staleHours != null && staleHours > 36 && " · stale"}
            </button>
          )}
        </div>
      </div>

      {err && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-300">
          {err}
        </div>
      )}

      {showMethod ? (
        <MethodologyPage onBack={() => setShowMethod(false)} />
      ) : (
      <>
      {/* ── league selector ───────────────────────────────────────────
          A native select rather than three cards. The cards cost ~360px of a
          844px phone screen, so you scrolled a full viewport of chrome before
          reaching the thing you opened the tab for. A select is also the one
          control every phone already knows how to render as a full-screen
          picker.

          The meta line survives underneath, because "22 teams · $1000 FAAB"
          is what stops you reading a guillotine number as a redraft one. */}
      {overview && (
        <div className="mb-4">
          <Select
            aria-label="League"
            tone="accent"
            value={league}
            onChange={setLeague}
            options={overview.leagues.map((l) => ({ value: l.league_key, label: l.name }))}
            className="w-full sm:w-auto sm:min-w-[16rem]"
          />
          {current && (
            <p className="mt-1 text-[11px] text-gray-500">
              {current.total_rosters} teams · ${current.faab_budget} FAAB ·{" "}
              {current.status.replace("_", " ")}
            </p>
          )}
        </div>
      )}

      {showAudit && overview && (
        <div className="mb-5 rounded-lg border border-gray-800 bg-gray-900 p-4">
          <p className="mb-2 text-xs text-gray-500">
            Data refreshed {staleHours == null ? "never" : `${staleHours.toFixed(0)}h ago`}
            {overview.freshness.failing.length > 0 &&
              ` · failing sources: ${overview.freshness.failing.join(", ")}`}
          </p>
          <ul className="space-y-1.5">
            {overview.audit.checks.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-xs">
                <Badge
                  tone={c.status === "ok" ? "good" : c.status === "warn" ? "warning" : "critical"}
                >
                  {c.status}
                </Badge>
                <div className="min-w-0">
                  <div className="text-gray-300">{c.label}</div>
                  {c.detail && <div className="text-gray-600">{c.detail}</div>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* ── subtabs ─────────────────────────────────────────────────── */}
      {/* Wraps to a second row on a phone. It used to scroll sideways with
          nothing signalling it, so Reading and Admin were off-screen and
          effectively invisible at 390px. */}
      <div className="mb-2 flex flex-wrap gap-1 rounded-lg bg-gray-900 p-1 sm:w-fit sm:flex-nowrap">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`shrink-0 rounded-md px-2 py-2.5 text-sm font-medium transition-colors sm:px-4 ${
              tab === t.key ? "bg-gray-800 text-gray-100" : "text-gray-400 hover:text-gray-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "today" && <TodayTab league={league} onPlayer={setDossier} onTab={setTab} key={`td-${league}`} />}
      {tab === "lineup" && <LineupTab league={league} onPlayer={setDossier} key={`l-${league}`} />}
      {tab === "moves" && <MovesTab league={league} onPlayer={setDossier} key={`m-${league}`} />}
      {tab === "trades" && <TradesTab league={league} onPlayer={setDossier} key={`t-${league}`} />}
      {tab === "rankings" && <ExpertsTab league={league} onPlayer={setDossier} key={`e-${league}`} />}
      {tab === "reading" && <ReadingTab league={league} onPlayer={setDossier} key={`r-${league}`} />}
      {tab === "admin" && <AdminTab />}
      {dossier && <PlayerDossier playerId={dossier} onClose={() => setDossier(null)} />}

      {current?.status === "pre_draft" && tab !== "reading" && tab !== "admin" && (
        <p className="mt-4 text-xs text-gray-600">
          {current.name} has not drafted yet, so roster-dependent panels will be empty until it does.
        </p>
      )}
      </>
      )}
    </div>
    </MethodProvider>
  );
}

function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}
