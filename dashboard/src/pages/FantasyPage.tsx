import { useEffect, useRef, useState } from "react";
import AdminTab from "./fantasy/AdminTab";
import ExpertsTab from "./fantasy/ExpertsTab";
import LineupTab from "./fantasy/LineupTab";
import MovesTab from "./fantasy/MovesTab";
import PlayerDossier from "./fantasy/PlayerDossier";
import ReadingTab from "./fantasy/ReadingTab";
import TodayTab from "./fantasy/TodayTab";
import TradesTab from "./fantasy/TradesTab";
import { Badge, ErrorBox, LeagueContext, MetaLine, NewsIndexProvider, type NewsIndex } from "./fantasy/viz";
import { ago, parseTime } from "./fantasy/labels";
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

// Tabs by decision, not by data source (CONTENT-PLAN.md): Today is the
// brief, Lineup the start/sit call, Moves adds, drops and FAAB, Trades sell
// and buy talk plus the builder, Rankings the consensus board, Reading the
// article and wire-note feed, and Admin ingest health. Admin is the only one
// that is league-independent.
const TABS: { key: Tab; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "lineup", label: "Lineup" },
  { key: "moves", label: "Moves" },
  { key: "trades", label: "Trades" },
  { key: "rankings", label: "Rankings" },
  { key: "reading", label: "Reading" },
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

/** `last_run` (content jobs only) is absolute, so its age is computed here, on the reader's clock. */
type Problem = { label: string; state: string; detail: string; last_run?: string | null };

type Overview = {
  state: { season?: string; season_type?: string; week?: number };
  season: string;
  target_week: number;
  leagues: League[];
  freshness: { failing: string[]; daily_last_run: string | null };
  audit: { failures: number; checks: { status: string; label: string; detail: string }[] };
  /** Content-layer jobs that are not ok (late counts), from the same states Admin shows. */
  content_health?: { problems: Problem[]; ok: number };
  error?: string;
};

/** A league status worth a word in the meta line; "in season" is the default and says nothing. */
const STATUS_TEXT: Record<string, string> = { pre_draft: "pre draft", complete: "season over" };
/** "12 teams · $100 FAAB": the hint under each league in the picker's list. */
const leagueFacts = (l: { total_rosters: number; faab_budget: number; status: string }) =>
  [`${l.total_rosters} teams`, `$${l.faab_budget} FAAB`, STATUS_TEXT[l.status]].filter(Boolean).join(" · ");

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

  // The health panel floats over the page, so it closes like a popover: on a
  // click anywhere outside it, or Escape.
  const healthRef = useRef<HTMLDivElement>(null);

  // A link from inside a tab (Today's "Elsewhere" line, "Open Admin") is
  // clicked far down the page; the page scroller keeps its offset across a
  // tab switch, so without this the new tab opens at its bottom.
  const tabBarRef = useRef<HTMLDivElement>(null);
  const jumpTo = (t: Tab) => {
    setTab(t);
    const bar = tabBarRef.current;
    if (bar && bar.getBoundingClientRect().top < 0) bar.scrollIntoView({ block: "start" });
  };
  useEffect(() => {
    if (!showAudit) return;
    const onDown = (e: MouseEvent) => {
      if (healthRef.current && !healthRef.current.contains(e.target as Node)) setShowAudit(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setShowAudit(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [showAudit]);

  // The news badge beside every player name reads one page-wide index: a
  // count and a shade per player, and the headlines, so a hover needs no
  // request (~43KB gzipped, pre-warmed and cached on the server).
  const [newsIndex, setNewsIndex] = useState<NewsIndex | null>(null);
  useEffect(() => {
    fetch("/api/fantasy/news-index")
      .then((r) => r.json())
      .then((d: Partial<NewsIndex>) => d.players && d.notes && setNewsIndex({ players: d.players, notes: d.notes }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/fantasy/overview")
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error || d.detail) : setOverview(d)))
      .catch((e) => setErr(String(e)));
  }, []);

  const current = overview?.leagues.find((l) => l.league_key === league);
  const staleHours = hoursSince(overview?.freshness.daily_last_run);
  // The league picker means nothing on Admin (league-independent) or on the
  // Methodology page, so neither shows it.
  const showLeague = tab !== "admin" && !showMethod;

  // Health, summarised from three sources: the data-quality audit, the
  // ingest sources, and the content-layer jobs. Only what is NOT ok is listed;
  // the full picture is Admin's job. Admin computes the content jobs live, so
  // it is handed only the first two.
  const feedProblems: Problem[] = overview
    ? [
        ...overview.audit.checks
          .filter((c) => c.status !== "ok")
          .map((c) => ({ label: c.label, state: c.status, detail: c.detail })),
        ...overview.freshness.failing.map((src) => ({ label: src, state: "failing", detail: "" })),
      ]
    : [];
  const problems: Problem[] = [...feedProblems, ...(overview?.content_health?.problems ?? [])];
  const okCount = overview
    ? overview.audit.checks.filter((c) => c.status === "ok").length + (overview.content_health?.ok ?? 0)
    : 0;

  const buttons = (
    <div className="flex shrink-0 items-center gap-2">
      <button
        type="button"
        onClick={() => setShowMethod((v) => !v)}
        className={`rounded-md border px-2 py-1 text-[11px] sm:px-2.5 sm:text-xs ${
          showMethod
            ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-300"
            : "border-gray-800 text-gray-400 hover:border-gray-700 hover:text-gray-200"
        }`}
        title="Every data source, and what each is used for"
      >
        Methodology
      </button>
      {overview && (
        // Relative wrapper so the panel drops over the page rather than
        // pushing the picker and the tabs down.
        <div className="relative" ref={healthRef}>
          <button
            type="button"
            onClick={() => setShowAudit((v) => !v)}
            aria-expanded={showAudit}
            className={`rounded-md border px-2 py-1 text-[11px] sm:px-2.5 sm:text-xs ${
              problems.length > 0
                ? "border-amber-500/40 text-amber-300 hover:border-amber-400"
                : "border-gray-800 text-gray-500 hover:border-gray-700 hover:text-gray-300"
            }`}
            title={staleHours == null ? "never refreshed" : `data refreshed ${staleHours.toFixed(0)}h ago`}
          >
            {problems.length > 0 ? `${problems.length} ${problems.length === 1 ? "issue" : "issues"}` : "Healthy"}
            {staleHours != null && staleHours > 36 && " · stale"}
          </button>
          {showAudit && (
            <div className="absolute right-0 top-full z-20 mt-1 w-[min(28rem,calc(100vw-2rem))] rounded-lg border border-gray-800 bg-gray-900 p-3 shadow-xl">
              <p className="mb-2 text-[11px] text-gray-500">
                Data refreshed {staleHours == null ? "never" : `${staleHours.toFixed(0)}h ago`}
              </p>
              {problems.length > 0 && (
                <ul className="mb-2 space-y-1.5">
                  {problems.map((p, i) => {
                    const ran = ago(p.last_run);
                    const detail = [ran ? `last ran ${ran}` : "", p.detail].filter(Boolean).join(" · ");
                    return (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        <Badge tone={p.state === "warn" || p.state === "late" ? "warning" : "critical"}>{p.state}</Badge>
                        <div className="min-w-0">
                          <div className="text-gray-300">{p.label}</div>
                          {detail && (
                            <div className="truncate text-gray-600" title={detail}>
                              {detail}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="flex items-baseline justify-between gap-3 border-t border-gray-800 pt-2 text-xs">
                <span className="text-gray-500">
                  {okCount} {okCount === 1 ? "check" : "checks"} ok
                </span>
                {tab !== "admin" && (
                  <button
                    type="button"
                    onClick={() => {
                      jumpTo("admin");
                      setShowMethod(false);
                      setShowAudit(false);
                    }}
                    className="ff-inline ff-hit text-indigo-400 hover:text-indigo-300"
                  >
                    Open Admin →
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <NewsIndexProvider value={newsIndex}>
      <LeagueContext.Provider value={league}>
        <div className="ff-scope px-4 pb-4 pt-3 sm:px-8 sm:pb-8 sm:pt-5">
          {/* ── header: one row on every tab ────────────────────────────────
              Title, league picker and its facts, then Methodology and health,
              on one line from sm up, so the tab bar sits at the same height on
              every tab (Admin, which hides the picker, used to jump ~80px) and
              the page starts ~100px sooner. On a phone the app bar already
              names the page: the picker takes the row, the buttons ride beside
              it, and the league's facts are in the picker's own list. */}
          <div className="mb-2 flex min-h-[2.25rem] flex-wrap items-center gap-x-3 gap-y-1 sm:mb-3">
            <h2 className="hidden text-lg font-semibold text-gray-100 sm:block">Fantasy Football</h2>
            {overview && showLeague && (
              <>
                <Select
                  aria-label="League"
                  tone="accent"
                  value={league}
                  onChange={setLeague}
                  options={overview.leagues.map((l) => ({ value: l.league_key, label: l.name, hint: leagueFacts(l) }))}
                  className="min-w-0 flex-1 sm:w-auto sm:min-w-[14rem] sm:flex-none"
                />
                {/* "22 teams · $1000 FAAB" is what stops you reading a guillotine
                    number as a redraft one, so it stays in view on desktop. */}
                {current && (
                  <MetaLine className="hidden sm:flex">
                    <span>week {overview.target_week}</span>
                    <span>{current.total_rosters} teams</span>
                    <span>${current.faab_budget} FAAB</span>
                    {STATUS_TEXT[current.status] && <span>{STATUS_TEXT[current.status]}</span>}
                  </MetaLine>
                )}
              </>
            )}
            <div className="ml-auto">{buttons}</div>
          </div>

          {err && <ErrorBox className="mb-4">{err}</ErrorBox>}

          {/* ── subtabs ─────────────────────────────────────────────────── */}
          {/* Four equal columns on a phone (4 + 3, no orphan row, nothing off
              screen); a single row from sm up. It used to scroll sideways with
              nothing signalling it, so Reading and Admin were invisible at 390px. */}
          {!showMethod && (
            <div
              ref={tabBarRef}
              className="mb-2 grid grid-cols-4 gap-0.5 rounded-lg bg-gray-900 p-0.5 sm:flex sm:w-fit sm:flex-nowrap sm:gap-1 sm:p-1"
            >
              {TABS.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`min-w-0 rounded-md px-1 py-1.5 text-sm font-medium transition-colors sm:shrink-0 sm:px-4 sm:py-2 ${
                    tab === t.key ? "bg-gray-800 text-gray-100" : "text-gray-400 hover:text-gray-300"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {/* Keyed on the league, so the Methodology page holds only this
              league's notes: they interpolate league facts (rival counts, tie
              rates, the FLEX list), and one registered while another league was
              open would sit beside this one's, contradicting it. The picker, the
              tab bar and this component's own state live outside it, so only the
              notes reset. The tabs are keyed on the league too, so they remount
              (with their loading skeletons) exactly as before. */}
          <MethodProvider key={league}>
            {showMethod ? (
              <MethodologyPage onBack={() => setShowMethod(false)} />
            ) : (
              <>
                {tab === "today" && <TodayTab league={league} onPlayer={setDossier} onTab={jumpTo} key={`td-${league}`} />}
                {tab === "lineup" && <LineupTab league={league} onPlayer={setDossier} key={`l-${league}`} />}
                {tab === "moves" && <MovesTab league={league} onPlayer={setDossier} key={`m-${league}`} />}
                {tab === "trades" && <TradesTab league={league} status={current?.status} onPlayer={setDossier} key={`t-${league}`} />}
                {tab === "rankings" && <ExpertsTab league={league} onPlayer={setDossier} key={`e-${league}`} />}
                {tab === "reading" && <ReadingTab league={league} onPlayer={setDossier} key={`r-${league}`} />}
                {tab === "admin" && <AdminTab onPlayer={setDossier} feedProblems={feedProblems} />}

                {current?.status === "pre_draft" && showLeague && tab !== "reading" && (
                  <p className="mt-4 text-xs text-gray-600">
                    {current.name} has not drafted yet, so roster-dependent panels will be empty until it does.
                  </p>
                )}
              </>
            )}
            {dossier && <PlayerDossier playerId={dossier} league={league} onClose={() => setDossier(null)} />}
          </MethodProvider>
        </div>
      </LeagueContext.Provider>
    </NewsIndexProvider>
  );
}

function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = parseTime(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}
