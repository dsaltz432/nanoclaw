import { useEffect, useState } from "react";
import AlertsTab from "./fantasy/AlertsTab";
import RightNow from "./fantasy/RightNow";
import NewsTab from "./fantasy/NewsTab";
import TradesTab from "./fantasy/TradesTab";
import WaiversTab from "./fantasy/WaiversTab";
import { Badge } from "./fantasy/viz";
import { MethodProvider, MethodologyPage } from "./fantasy/method";
import TrendsTab from "./fantasy/TrendsTab";

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

type Tab = "waivers" | "trades" | "trends" | "news" | "alerts";

const TABS: { key: Tab; label: string }[] = [
  { key: "waivers", label: "Waiver wire" },
  { key: "trades", label: "Trades" },
  { key: "trends", label: "Trends" },
  { key: "news", label: "News" },
  { key: "alerts", label: "Alerts" },
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
  const [tab, setTab] = useState<Tab>("waivers");
  const [league, setLeague] = useState<string>("redraft");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAudit, setShowAudit] = useState(false);
  const [showMethod, setShowMethod] = useState(false);
  // A summary should not tax every subsequent view. It opens expanded, and
  // folds to a one-line headline while you are still on the landing view.
  const [nowCollapsed, setNowCollapsed] = useState(false);
  // ...and once you pick a tab it goes away entirely. Its job is to spare you
  // cross-referencing three tabs to find the day's one important item; a tab
  // you have deliberately opened is not a view that needs saving from that,
  // and carrying the strip into all five made it read as chrome.
  const [tabChosen, setTabChosen] = useState(false);

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
          <label className="sr-only" htmlFor="ff-league">
            League
          </label>
          <select
            id="ff-league"
            value={league}
            onChange={(e) => setLeague(e.target.value)}
            className="w-full rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-3 py-2.5 text-sm font-medium text-indigo-200 sm:w-auto"
          >
            {overview.leagues.map((l) => (
              <option key={l.league_key} value={l.league_key} className="bg-gray-900 text-gray-100">
                {l.name}
              </option>
            ))}
          </select>
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

      {/* Above the subtabs on purpose — it draws from all of them, and the
          failure it fixes was that the day's most important item was only
          visible by cross-referencing three. */}
      {!tabChosen && (
        <RightNow
          league={league}
          collapsed={nowCollapsed}
          onToggle={() => setNowCollapsed((v) => !v)}
          key={`rn-${league}`}
        />
      )}

      {/* ── subtabs ─────────────────────────────────────────────────── */}
      <div className="mb-2 -mx-1 flex gap-1 overflow-x-auto rounded-lg bg-gray-900 p-1 px-1 sm:mx-0 sm:w-fit">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => {
              setTab(t.key);
              setTabChosen(true);
            }}
            className={`shrink-0 rounded-md px-2 py-2.5 text-sm font-medium transition-colors sm:px-4 ${
              tab === t.key ? "bg-gray-800 text-gray-100" : "text-gray-400 hover:text-gray-300"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "waivers" && (
        <WaiversTab league={league} key={`w-${league}`} />
      )}
      {tab === "trades" && <TradesTab league={league} key={`t-${league}`} />}
      {tab === "trends" && <TrendsTab league={league} key={`tr-${league}`} />}
      {tab === "news" && <NewsTab league={league} key={`n-${league}`} />}
      {tab === "alerts" && <AlertsTab league={league} key={`a-${league}`} />}

      {current?.status === "pre_draft" && tab !== "news" && (
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
