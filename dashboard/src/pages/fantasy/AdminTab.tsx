import { useCallback, useEffect, useState } from "react";
import { Badge, Card, FoldToggle, StatTile, Td, Th } from "./viz";
import { Select } from "./Select";
import { ago, srcShort } from "./labels";

/**
 * Admin — did the content layer actually run, and what did it write.
 *
 * Three questions, in the order you ask them when something looks stale:
 *   1. Is each site's job running on schedule, and did its last run succeed?
 *   2. What did it write — every article as it landed, with the flags that
 *      matter (paywalled, reads-as-instruction, player unresolved).
 *   3. The raw run log, for when the answer to 1 is "no".
 *
 * Nothing here is computed in the browser. `content-status` reads
 * ingest_runs and the two content tables in ff.db; this file only lays it
 * out. All strings from third parties arrive already defanged.
 */

type Run = {
  id?: number;
  source: string;
  detail: string | null;
  started_at: string;
  finished_at: string | null;
  ok: number | null;
  rows: number;
  error: string | null;
};

type Job = {
  label: string;
  every_min: number;
  via: string;
  last: Run | null;
  minutes_ago: number | null;
  state: "ok" | "late" | "failing" | "never" | "off";
  enabled?: boolean;
  window: { runs: number; fails: number };
};

type Source = {
  source: string;
  label: string;
  jobs: { articles: Job; rankings: Job };
  articles: {
    total: number;
    fetched_window: number;
    published_window: number;
    newest_published: string | null;
    newest_fetched: string | null;
    gated: number;
    suspicious: number;
    player_news: number;
    resolved: number;
  };
  rankings: { newest_snapshot: string | null; rows: number; resolved: number; lists: number };
};

type Extraction = {
  status: "done" | "failed" | "pending" | "skipped";
  claims_n: number;
  summary: string;
  attempts: number;
  error: string;
  elapsed_ms: number | null;
};

type Article = {
  extraction: Extraction;
  article_id: string;
  source: string;
  kind: "article" | "player_news";
  url: string;
  title: string;
  author: string;
  published_at: string | null;
  fetched_at: string;
  body_chars: number;
  category: string;
  player_id: string | null;
  player_name: string;
  player_team: string | null;
  player_position: string | null;
  flagged: boolean;
  gated: boolean;
};

type Core = {
  source: string;
  label: string;
  last: Run | null;
  minutes_ago: number | null;
  state: Job["state"];
  window: { runs: number; fails: number };
};

type Tally = { resolved: number; unresolved: number; ambiguous: number };
/** A name the resolver could not map to a Sleeper id (team/position appended), and how often it saw it. */
type TopName = [string, number];

type Resolver = {
  last_runs: Record<
    "articles" | "rankings",
    { at: string | null; totals: Tally | null; by_source: Record<string, Tally & { top: TopName[] }> }
  >;
  rankings: { source: string; snapshot: string; rows: number; unresolved: number; top: TopName[] }[];
  claims: {
    hours: number;
    n: number;
    unresolved: number;
    top: TopName[];
    by_source: { source: string; n: number; unresolved: number }[];
  };
};

type GatedSource = { source: string; gated: number; gated_window: number; total: number };

type Data = {
  hours: number;
  generated_at: string;
  totals: {
    articles: number;
    fetched_window: number;
    gated: number;
    flagged: number;
    rankings_rows: number;
    notes_window: number;
  };
  sources: Source[];
  core: Core[];
  claims: Core & {
    label: string;
    every_min: number;
    via: string;
    model: string;
    stats: {
      by_status: Record<string, { articles: number; claims: number; cost_usd: number; avg_ms: number | null }>;
      pending: number;
      claims: number;
      claims_resolved: number;
    };
  };
  articles: Article[];
  filters: { source: string | null; kind: string | null; limit: number };
  runs: Run[];
  last_run: {
    articles: { at?: string; resolver?: Record<string, number> } | null;
    rankings: { at?: string; season?: number; week?: number; resolver?: Record<string, number> } | null;
  };
  commands: { articles: string; rankings: string };
  /** Optional only so a cached payload from before these fields existed still renders. */
  resolver?: Resolver;
  gated_by_source?: GatedSource[];
  _stale?: boolean;
  _error?: string;
  error?: string;
};

const STATE_TONE: Record<Job["state"], "good" | "warning" | "critical" | "neutral"> = {
  ok: "good",
  late: "warning",
  failing: "critical",
  never: "neutral",
  off: "neutral",
};

function cadence(min: number): string {
  return min >= 1440 ? "daily" : min >= 60 ? `every ${Math.round(min / 60)}h` : `every ${min} min`;
}

export default function AdminTab() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [source, setSource] = useState<string>("");
  const [kind, setKind] = useState<string>("");
  const [showRuns, setShowRuns] = useState(false);
  const [busy, setBusy] = useState(false);
  const PAGE = 30;
  const [shown, setShown] = useState(PAGE);

  const load = useCallback(
    (refresh = false) => {
      setBusy(true);
      const q = new URLSearchParams({ limit: "120" });
      if (source) q.set("source", source);
      if (kind) q.set("kind", kind);
      if (refresh) q.set("refresh", "1");
      fetch(`/api/fantasy/content-status?${q.toString()}`)
        .then((r) => r.json())
        .then((d) => (d.error ? setErr(d.error) : (setErr(null), setData(d))))
        .catch((e) => setErr(String(e)))
        .finally(() => setBusy(false));
    },
    [source, kind]
  );

  useEffect(() => {
    setShown(PAGE);
    load();
  }, [load]);

  if (err) return <div className="p-6 text-sm text-red-400">{err}</div>;
  if (!data) return <div className="p-6 text-sm text-gray-500">Loading…</div>;

  const problems = data.sources.flatMap((s) =>
    (["articles", "rankings"] as const)
      .filter((j) => s.jobs[j].state === "failing" || s.jobs[j].state === "late")
      .map((j) => ({ label: s.label, job: s.jobs[j] }))
  );
  const coreProblems = [...data.core, data.claims].filter(
    (c) => c.state === "failing" || c.state === "late"
  );
  const resolver = data.resolver;
  // Worst offenders first: the one row you came to check should not hide
  // between five clean ones.
  const rankingTables = [...(resolver?.rankings ?? [])].sort(
    (a, b) => b.unresolved - a.unresolved || a.source.localeCompare(b.source)
  );
  const gated = [...(data.gated_by_source ?? [])].sort(
    (a, b) => b.gated_window - a.gated_window || b.gated - a.gated || a.source.localeCompare(b.source)
  );

  return (
    <div className="space-y-4">
      {/* ── headline: is anything wrong ─────────────────────────────── */}
      {problems.length + coreProblems.length > 0 ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
          <div className="mb-1 flex flex-wrap items-center gap-2">
            <Badge tone="warning">{problems.length + coreProblems.length} needing attention</Badge>
            {data._stale && <Badge tone="neutral">cached</Badge>}
          </div>
          <ul className="space-y-0.5 text-xs text-amber-100/90">
            {problems.map((p, i) => (
              <li key={i}>
                {p.label} — {p.job.label}: <span className="font-medium">{p.job.state}</span>
                {p.job.last?.error && <span className="text-amber-300/80"> · {p.job.last.error}</span>}
                {p.job.state === "late" && (
                  <span className="text-amber-300/80">
                    {" "}
                    · last ran {fmtAgo(p.job.minutes_ago)}, expected {cadence(p.job.every_min)} via{" "}
                    {p.job.via}
                  </span>
                )}
              </li>
            ))}
            {coreProblems.map((c) => (
              <li key={c.source}>
                {c.label}: <span className="font-medium">{c.state}</span>
                {c.last?.error && <span className="text-amber-300/80"> · {c.last.error}</span>}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
          <Badge tone="good">all jobs healthy</Badge>
          <span>as of {fmt(data.generated_at)}</span>
          {data._stale && <Badge tone="neutral">cached</Badge>}
          <button
            onClick={() => load(true)}
            disabled={busy}
            className="ml-auto rounded-md border border-gray-800 px-2 py-1 text-gray-400 hover:border-gray-700 hover:text-gray-200 disabled:opacity-50"
          >
            {busy ? "refreshing…" : "refresh"}
          </button>
        </div>
      )}

      {/* Seven tiles. The first six fill a 2/3 grid on phone and tablet; the
          seventh (unresolved names) spans the full row below them so it never
          sits as an orphan, and rejoins the grid at lg where four fit across.
          The "Content" tile moved here from Today — an ingest statistic, not a
          decision input — so "Claims extracted" now reports the backlog. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <StatTile
          label={`Articles fetched, ${data.hours}h`}
          value={data.totals.fetched_window}
          hint={`${data.totals.articles} stored in total`}
        />
        <StatTile
          label={`Wire notes, ${data.hours}h`}
          value={data.totals.notes_window}
          hint="Rotowire via ESPN, the existing feed"
        />
        <StatTile label="Rankings rows" value={data.totals.rankings_rows} hint="all snapshots" />
        <StatTile
          label="Content"
          value={data.claims.stats.claims}
          hint={`claims from ${data.claims.stats.by_status.done?.articles ?? 0} articles · ${data.sources.length} sites`}
        />
        <StatTile
          label="Extraction backlog"
          value={data.claims.stats.pending}
          hint={`articles waiting · ${data.claims.stats.claims_resolved} claims resolved`}
          tone={data.claims.stats.pending > 20 ? "warning" : "default"}
        />
        <StatTile
          label="Flagged"
          value={`${data.totals.flagged} / ${data.totals.gated}`}
          hint="reads as instruction / paywalled"
          tone={data.totals.flagged > 0 ? "warning" : "default"}
        />
        {resolver && (
          <div className="col-span-2 flex flex-col sm:col-span-3 lg:col-span-1 [&>div]:flex-1">
            <StatTile
              label={`Unresolved (claims, ${resolver.claims.hours}h)`}
              value={resolver.claims.unresolved}
              hint={`of ${resolver.claims.n} claims · names with no Sleeper id`}
              tone={resolver.claims.unresolved > 0 ? "warning" : "default"}
            />
          </div>
        )}
      </div>

      {/* ── per-source job health ───────────────────────────────────── */}
      <Card
        title="Sources"
        subtitle={
          <>
            One row per site and job. <span className="text-gray-400">Articles</span> run every 15
            min inside <code className="text-gray-400">ff-news.sh</code>;{" "}
            <span className="text-gray-400">rankings</span> every 2h or daily inside{" "}
            <code className="text-gray-400">ff-refresh.sh</code> depending on how fast the list moves.{" "}
            <span className="text-gray-500">off</span> means the adapter exists but is not in the default
            sources. A job is{" "}
            <span className="text-amber-300">late</span> when its last run is older than 2.5×
            its interval, and <span className="text-red-400">failing</span> when that run raised.
          </>
        }
      >
        <div className="ff-stack-wrap overflow-x-auto">
          <table className="ff-stack w-full">
            <thead>
              <tr>
                <Th>Site</Th>
                <Th>Job</Th>
                <Th>State</Th>
                <Th>Last run</Th>
                <Th className="text-right">Rows</Th>
                <Th className="text-right" title="runs / failures in the window">
                  {data.hours}h
                </Th>
                <Th>Stored</Th>
                <Th>Error</Th>
              </tr>
            </thead>
            <tbody>
              {data.sources.map((s) =>
                (["articles", "rankings"] as const).map((j, i) => {
                  const job = s.jobs[j];
                  return (
                    <tr key={`${s.source}-${j}`} className="border-t border-gray-800/60">
                      {/* Stacked, every card needs the site name; the ditto
                          mark only reads in a column. */}
                      <Td data-label="" className={`ff-row-head ${i === 0 ? "font-medium text-gray-200" : "text-gray-700"}`}>
                        <span className={i === 0 ? "" : "sm:hidden"}>{s.label}</span>
                        {i > 0 && <span className="hidden sm:inline">〃</span>}
                      </Td>
                      {/* One child per cell: stacked cells are flex rows and
                          loose children spread across them. */}
                      <Td data-label="Job" className="text-xs text-gray-400">
                        <span>
                          {job.label}
                          <span className="text-gray-600"> · {cadence(job.every_min)}</span>
                        </span>
                      </Td>
                      <Td data-label="State">
                        <Badge
                          tone={STATE_TONE[job.state]}
                          title={job.state === "off" ? "not in the default sources; see CONTENT-PLAN.md source review" : ""}
                        >
                          {job.state}
                        </Badge>
                      </Td>
                      <Td data-label="Last run" className="whitespace-nowrap text-xs text-gray-500" title={job.last?.started_at ?? ""}>
                        {job.last ? fmtAgo(job.minutes_ago) : "—"}
                      </Td>
                      <Td data-label="Rows" className="text-right tabular-nums">{job.last?.rows ?? "—"}</Td>
                      <Td data-label={`${data.hours}h`} className="text-right text-xs tabular-nums text-gray-500">
                        <span>
                          {job.window.runs}
                          {job.window.fails > 0 && (
                            <span className="text-red-400"> / {job.window.fails}</span>
                          )}
                        </span>
                      </Td>
                      <Td data-label="Stored" className="text-xs text-gray-500">
                        <span>
                        {j === "articles" ? (
                          <>
                            {s.articles.total} stored · {s.articles.fetched_window} new
                            {s.articles.player_news > 0 && (
                              <> · {s.articles.resolved}/{s.articles.player_news} players resolved</>
                            )}
                            {s.articles.gated > 0 && <> · {s.articles.gated} gated</>}
                            {s.articles.suspicious > 0 && (
                              <span className="text-amber-300"> · {s.articles.suspicious} flagged</span>
                            )}
                          </>
                        ) : s.rankings.newest_snapshot ? (
                          <>
                            {s.rankings.lists} lists · {s.rankings.rows} rows · {s.rankings.resolved} resolved ·
                            snapshot {s.rankings.newest_snapshot}
                          </>
                        ) : (
                          "—"
                        )}
                        </span>
                      </Td>
                      {/* An empty error cell is dropped on a phone so the
                          card does not end with "ERROR" and nothing. */}
                      {job.last?.error ? (
                        <Td data-label="Error" className="max-w-[18rem] truncate text-xs text-red-400/90" title={job.last.error}>
                          {job.last.error}
                        </Td>
                      ) : (
                        <Td data-label="Error" className="hidden sm:table-cell">{null}</Td>
                      )}
                    </tr>
                  );
                })
              )}
              {data.core.map((c) => (
                <tr key={c.source} className="border-t border-gray-800/60">
                  <Td data-label="" className="ff-row-head font-medium text-gray-400">{c.label}</Td>
                  <Td data-label="Job" className="text-xs text-gray-500">existing feed · every 15 min</Td>
                  <Td data-label="State">
                    <Badge tone={STATE_TONE[c.state]}>{c.state}</Badge>
                  </Td>
                  <Td data-label="Last run" className="whitespace-nowrap text-xs text-gray-500" title={c.last?.started_at ?? ""}>
                    {c.last ? fmtAgo(c.minutes_ago) : "—"}
                  </Td>
                  <Td data-label="Rows" className="text-right tabular-nums">{c.last?.rows ?? "—"}</Td>
                  <Td data-label={`${data.hours}h`} className="text-right text-xs tabular-nums text-gray-500">
                    <span>
                      {c.window.runs}
                      {c.window.fails > 0 && <span className="text-red-400"> / {c.window.fails}</span>}
                    </span>
                  </Td>
                  <Td data-label="Stored" className="text-xs text-gray-600">—</Td>
                  {c.last?.error ? (
                    <Td data-label="Error" className="max-w-[18rem] truncate text-xs text-red-400/90" title={c.last.error}>
                      {c.last.error}
                    </Td>
                  ) : (
                    <Td data-label="Error" className="hidden sm:table-cell">{null}</Td>
                  )}
                </tr>
              ))}
              <tr className="border-t border-gray-800/60">
                <Td data-label="" className="ff-row-head font-medium text-gray-200">Claims extraction</Td>
                <Td data-label="Job" className="text-xs text-gray-400">
                  <span>layer 2 · every {data.claims.every_min} min · {data.claims.model}</span>
                </Td>
                <Td data-label="State">
                  <Badge tone={STATE_TONE[data.claims.state]}>{data.claims.state}</Badge>
                </Td>
                <Td data-label="Last run" className="whitespace-nowrap text-xs text-gray-500" title={data.claims.last?.started_at ?? ""}>
                  {data.claims.last ? fmtAgo(data.claims.minutes_ago) : "—"}
                </Td>
                <Td data-label="Rows" className="text-right tabular-nums">{data.claims.last?.rows ?? "—"}</Td>
                <Td data-label={`${data.hours}h`} className="text-right text-xs tabular-nums text-gray-500">
                  <span>
                    {data.claims.window.runs}
                    {data.claims.window.fails > 0 && (
                      <span className="text-red-400"> / {data.claims.window.fails}</span>
                    )}
                  </span>
                </Td>
                <Td data-label="Stored" className="text-xs text-gray-500">
                  <span>
                  {data.claims.stats.claims} claims from {data.claims.stats.by_status.done?.articles ?? 0} articles
                  {" · "}
                  {data.claims.stats.pending} pending
                  {(data.claims.stats.by_status.failed?.articles ?? 0) > 0 && (
                    <span className="text-red-400"> · {data.claims.stats.by_status.failed?.articles} failed</span>
                  )}
                  {data.claims.stats.by_status.done?.avg_ms != null && (
                    <> · {(data.claims.stats.by_status.done.avg_ms / 1000).toFixed(0)}s avg</>
                  )}
                  </span>
                </Td>
                {data.claims.last?.error ? (
                  <Td data-label="Error" className="max-w-[18rem] truncate text-xs text-red-400/90" title={data.claims.last.error}>
                    {data.claims.last.error}
                  </Td>
                ) : (
                  <Td data-label="Error" className="hidden sm:table-cell">{null}</Td>
                )}
              </tr>
            </tbody>
          </table>
        </div>
        {!resolver && data.last_run.articles?.resolver && (
          <p className="mt-3 text-[11px] text-gray-600">
            Last article run resolved {data.last_run.articles.resolver.resolved} player names,{" "}
            {data.last_run.articles.resolver.unresolved} unknown, {data.last_run.articles.resolver.ambiguous}{" "}
            ambiguous. Unknown is expected for IDP players; ambiguous means two Sleeper players share the
            name and no team or position broke the tie.
          </p>
        )}
      </Card>

      {/* ── resolver: names that did not map to a Sleeper id ────────── */}
      {resolver && (
        <Card
          title="Resolver"
          subtitle={
            <>
              Player names the resolver could not map to a Sleeper id, per run and per table.{" "}
              <span className="text-gray-400">Unresolved</span> is expected for IDP and college players;{" "}
              <span className="text-gray-400">ambiguous</span> means two Sleeper players share the name and no
              team or position broke the tie. Names are shown exactly as the site printed them.
            </>
          }
        >
          {/* 1. the two most recent runs, side by side */}
          <div className="grid gap-3 sm:grid-cols-2">
            <LastRun label="Last article run" run={resolver.last_runs.articles} />
            <LastRun label="Last rankings run" run={resolver.last_runs.rankings} />
          </div>

          {/* 2. what is sitting unresolved in the stored tables right now */}
          <h4 className="mb-1.5 mt-4 text-xs font-medium text-gray-300">Unresolved in the tables</h4>
          <div className="ff-stack-wrap overflow-x-auto">
            <table className="ff-stack w-full">
              <thead>
                <tr>
                  <Th>Table</Th>
                  <Th>Snapshot</Th>
                  <Th className="text-right" title="unresolved / rows">
                    Unresolved
                  </Th>
                  <Th>Names</Th>
                </tr>
              </thead>
              <tbody>
                {rankingTables.map((r) => (
                  <tr key={`${r.source}-${r.snapshot}`} className="border-t border-gray-800/60 align-top">
                    <Td data-label="" className="ff-row-head whitespace-nowrap text-xs text-gray-300">
                      <span>
                        {srcShort(r.source)} <span className="text-gray-600">rankings</span>
                      </span>
                    </Td>
                    <Td data-label="Snapshot" className="whitespace-nowrap text-xs text-gray-500">
                      {r.snapshot}
                    </Td>
                    <Td data-label="Unresolved" className="whitespace-nowrap text-right text-xs tabular-nums">
                      <span>
                        <span className={r.unresolved > 0 ? "text-amber-300" : "text-gray-400"}>{r.unresolved}</span>
                        <span className="text-gray-600"> / {r.rows}</span>
                      </span>
                    </Td>
                    <Td data-label="Names">
                      <NamesCell unresolved={r.unresolved} top={r.top} />
                    </Td>
                  </tr>
                ))}
                <tr className="border-t border-gray-800/60 align-top">
                  <Td data-label="" className="ff-row-head text-xs text-gray-300">
                    <span className="block">
                      claims <span className="text-gray-600">(last {resolver.claims.hours}h)</span>
                      {resolver.claims.by_source.some((s) => s.unresolved > 0) && (
                        <span className="block text-[11px] font-normal tabular-nums text-gray-600">
                          {resolver.claims.by_source
                            .filter((s) => s.unresolved > 0)
                            .sort((a, b) => b.unresolved - a.unresolved)
                            .map((s) => `${srcShort(s.source)} ${s.unresolved}`)
                            .join(" · ")}
                        </span>
                      )}
                    </span>
                  </Td>
                  <Td data-label="Snapshot" className="whitespace-nowrap text-xs text-gray-600">
                    —
                  </Td>
                  <Td data-label="Unresolved" className="whitespace-nowrap text-right text-xs tabular-nums">
                    <span>
                      <span className={resolver.claims.unresolved > 0 ? "text-amber-300" : "text-gray-400"}>
                        {resolver.claims.unresolved}
                      </span>
                      <span className="text-gray-600"> / {resolver.claims.n}</span>
                    </span>
                  </Td>
                  <Td data-label="Names">
                    <NamesCell unresolved={resolver.claims.unresolved} top={resolver.claims.top} />
                  </Td>
                </tr>
                {rankingTables.length === 0 && (
                  <tr className="border-t border-gray-800/60">
                    <Td data-label="" className="text-xs text-gray-500" colSpan={4}>
                      No rankings snapshots stored yet.
                    </Td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* 3. paywall teasers, which the resolver never sees */}
          <h4 className="mt-4 text-xs font-medium text-gray-300">Paywalled teasers per source</h4>
          <p className="mb-1.5 text-[11px] text-gray-600">
            Stored with gated=1; never fetched harder and never extracted from.
          </p>
          <div className="ff-stack-wrap overflow-x-auto">
            <table className="ff-stack w-full">
              <thead>
                <tr>
                  <Th>Source</Th>
                  <Th className="text-right" title="gated / stored, all time">
                    Gated
                  </Th>
                  <Th className="text-right" title="gated articles fetched in the window">
                    {data.hours}h
                  </Th>
                  <Th>{null}</Th>
                </tr>
              </thead>
              <tbody>
                {gated.map((g) => (
                  <tr key={g.source} className="border-t border-gray-800/60">
                    <Td data-label="" className="ff-row-head whitespace-nowrap text-xs text-gray-300">
                      {srcShort(g.source)}
                    </Td>
                    <Td data-label="Gated" className="whitespace-nowrap text-right text-xs tabular-nums">
                      <span>
                        <span className={g.gated > 0 ? "text-gray-300" : "text-gray-400"}>{g.gated}</span>
                        <span className="text-gray-600"> / {g.total}</span>
                      </span>
                    </Td>
                    <Td
                      data-label={`${data.hours}h`}
                      className={`whitespace-nowrap text-right text-xs tabular-nums ${g.gated_window > 0 ? "text-amber-300" : "text-gray-500"}`}
                    >
                      {g.gated_window}
                    </Td>
                    {g.gated_window > 0 ? (
                      <Td data-label="">
                        <Badge tone="warning" title={`${g.gated_window} paywalled article${g.gated_window === 1 ? "" : "s"} landed in the last ${data.hours}h`}>
                          gated in window
                        </Badge>
                      </Td>
                    ) : (
                      <Td data-label="" className="hidden sm:table-cell">{null}</Td>
                    )}
                  </tr>
                ))}
                {gated.length === 0 && (
                  <tr className="border-t border-gray-800/60">
                    <Td data-label="" className="text-xs text-gray-500" colSpan={4}>
                      Nothing stored yet.
                    </Td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ── every article as it landed ──────────────────────────────── */}
      <Card
        title="Articles"
        subtitle="Newest fetched first. Titles open the source. Player news shows who it resolved to."
        right={
          <div className="flex items-center gap-2">
            <Select
              aria-label="Site"
              size="sm"
              value={source}
              onChange={setSource}
              options={[{ value: "", label: "all sites" }, ...data.sources.map((s) => ({ value: s.source, label: s.label }))]}
            />
            <Select
              aria-label="Kind"
              size="sm"
              value={kind}
              onChange={setKind}
              options={[
                { value: "", label: "articles + player news" },
                { value: "article", label: "articles only" },
                { value: "player_news", label: "player news only" },
              ]}
            />
          </div>
        }
      >
        <div className="ff-stack-wrap overflow-x-auto">
          <table className="ff-stack w-full">
            <thead>
              <tr>
                <Th>Fetched</Th>
                <Th>Published</Th>
                <Th>Site</Th>
                <Th>Title</Th>
                <Th>By</Th>
                <Th>Player</Th>
                <Th title="claims extracted by the model; hover for its one-line summary">Claims</Th>
                <Th className="text-right">Chars</Th>
              </tr>
            </thead>
            <tbody>
              {data.articles.slice(0, shown).map((a) => (
                <tr key={a.article_id} className="border-t border-gray-800/60 align-top">
                  <Td data-label="Fetched" className="whitespace-nowrap text-xs text-gray-500" title={a.fetched_at}>
                    {fmtShort(a.fetched_at)}
                  </Td>
                  <Td data-label="Published" className="whitespace-nowrap text-xs text-gray-500" title={a.published_at ?? ""}>
                    {a.published_at ? fmtShort(a.published_at) : "—"}
                  </Td>
                  <Td data-label="Site" className="whitespace-nowrap text-xs text-gray-400">
                    <span>
                      {labelFor(data, a.source)}
                      {a.kind === "player_news" && (
                        <span className="ml-1 text-[10px] uppercase tracking-wide text-gray-600">news</span>
                      )}
                    </span>
                  </Td>
                  <Td data-label="" className="ff-row-head max-w-[28rem]">
                    <a
                      href={a.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-gray-200 hover:text-indigo-300 hover:underline"
                    >
                      {a.title || a.url}
                    </a>
                    <span className="ml-1.5 inline-flex gap-1 align-middle">
                      {a.gated && <Badge tone="neutral" title="body looked paywalled or truncated">gated</Badge>}
                      {a.flagged && (
                        <Badge tone="warning" title="text reads as an instruction; stored, never obeyed">
                          flagged
                        </Badge>
                      )}
                    </span>
                    {a.category && <div className="text-[11px] font-normal text-gray-600">{a.category}</div>}
                  </Td>
                  <Td data-label="By" className="text-xs text-gray-500">{a.author || "—"}</Td>
                  <Td data-label="Player" className="whitespace-nowrap text-xs">
                    {a.kind === "player_news" && a.player_name ? (
                      a.player_id ? (
                        <span className="text-gray-300">
                          {a.player_name}
                          <span className="text-gray-600">
                            {" "}
                            {a.player_position}
                            {a.player_team ? ` · ${a.player_team}` : ""}
                          </span>
                        </span>
                      ) : (
                        <span className="text-gray-500" title="not a Sleeper fantasy-position player, or ambiguous">
                          {a.player_name}{" "}
                          <Badge tone="neutral">unresolved</Badge>
                        </span>
                      )
                    ) : (
                      <span
                        className="text-gray-700"
                        title={a.kind === "player_news" ? "this site's news items carry no player field" : ""}
                      >
                        —
                      </span>
                    )}
                  </Td>
                  <Td data-label="Claims" className="whitespace-nowrap text-xs" title={a.extraction.summary || a.extraction.error || ""}>
                    {a.extraction.status === "done" ? (
                      <span className={a.extraction.claims_n > 0 ? "text-gray-300" : "text-gray-600"}>
                        {a.extraction.claims_n}
                      </span>
                    ) : a.extraction.status === "failed" ? (
                      <Badge tone="critical" title={a.extraction.error}>
                        failed ×{a.extraction.attempts}
                      </Badge>
                    ) : a.extraction.status === "pending" ? (
                      <span className="text-gray-600">pending</span>
                    ) : (
                      <span className="text-gray-700" title="gated or too short to extract from">—</span>
                    )}
                  </Td>
                  <Td data-label="Chars" className="text-right text-xs tabular-nums text-gray-500">{a.body_chars}</Td>
                </tr>
              ))}
              {data.articles.length === 0 && (
                <tr>
                  <Td data-label="" className="text-gray-500" colSpan={8}>
                    Nothing stored yet for this filter.
                  </Td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <FoldToggle total={data.articles.length} shown={Math.min(shown, data.articles.length)} onToggle={() => setShown((n) => n + PAGE)} mode="more" />
        <p className="mt-2 text-[11px] text-gray-600">
          Showing {Math.min(shown, data.articles.length)} of the {data.articles.length} most recent. Run by hand with{" "}
          <code className="rounded bg-gray-900 px-1 py-0.5 text-gray-400">{data.commands.articles}</code>.
        </p>
      </Card>

      {/* ── raw run log ─────────────────────────────────────────────── */}
      <Card
        title="Run log"
        subtitle="Every content ingest_runs row, newest first, plus the wire-note feed it sits beside."
        right={
          <button
            onClick={() => setShowRuns((v) => !v)}
            className="rounded-md border border-gray-800 px-2 py-1 text-xs text-gray-400 hover:border-gray-700 hover:text-gray-200"
          >
            {showRuns ? "hide" : `show ${data.runs.length}`}
          </button>
        }
      >
        {showRuns ? (
          <div className="ff-stack-wrap overflow-x-auto">
            <table className="ff-stack w-full">
              <thead>
                <tr>
                  <Th>Started</Th>
                  <Th>Source</Th>
                  <Th>Detail</Th>
                  <Th>Result</Th>
                  <Th className="text-right">Rows</Th>
                  <Th className="text-right">Took</Th>
                  <Th>Error</Th>
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r, i) => (
                  <tr key={r.id ?? i} className="border-t border-gray-800/60">
                    <Td data-label="Started" className="whitespace-nowrap text-xs text-gray-500" title={r.started_at}>
                      {fmtShort(r.started_at)}
                    </Td>
                    <Td data-label="" className="ff-row-head whitespace-nowrap text-xs text-gray-300">{r.source}</Td>
                    {/* Content runs write "resolved 120 · unresolved 3 · ambiguous 1 · Name FA RB×1";
                        the names can run long, so clip and keep the full line on hover. */}
                    <Td data-label="Detail" className="max-w-[24rem] truncate text-xs text-gray-500" title={r.detail ?? ""}>
                      {r.detail || ""}
                    </Td>
                    <Td data-label="Result">
                      <Badge tone={r.ok === 1 ? "good" : r.ok === 0 ? "critical" : "neutral"}>
                        {r.ok === 1 ? "ok" : r.ok === 0 ? "fail" : "running"}
                      </Badge>
                    </Td>
                    <Td data-label="Rows" className="text-right text-xs tabular-nums">{r.rows}</Td>
                    <Td data-label="Took" className="text-right text-xs tabular-nums text-gray-500">
                      {took(r.started_at, r.finished_at)}
                    </Td>
                    {r.error ? (
                      <Td data-label="Error" className="max-w-[24rem] truncate text-xs text-red-400/90" title={r.error}>
                        {r.error}
                      </Td>
                    ) : (
                      <Td data-label="Error" className="hidden sm:table-cell">{null}</Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-gray-600">Collapsed. The sources table above already shows each job's last run.</p>
        )}
      </Card>
    </div>
  );
}

function labelFor(data: Data, source: string): string {
  return data.sources.find((s) => s.source === source)?.label ?? source;
}

/** One resolver run: when, the totals, and per site what it could not map. */
function LastRun({ label, run }: { label: string; run: Resolver["last_runs"]["articles"] }) {
  const sources = Object.entries(run.by_source).sort(
    (a, b) => b[1].unresolved - a[1].unresolved || a[0].localeCompare(b[0])
  );
  return (
    <div className="min-w-0 rounded-md border border-gray-800/60 px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-xs font-medium text-gray-300">{label}</span>
        <span className="text-xs text-gray-500" title={run.at ?? ""}>
          {run.at ? (ago(run.at) ?? run.at) : "never"}
        </span>
      </div>
      <div className="mt-1 text-xs tabular-nums text-gray-400">
        {run.totals ? (
          <>
            resolved {run.totals.resolved} · unresolved {run.totals.unresolved} · ambiguous {run.totals.ambiguous}
          </>
        ) : (
          <span className="text-gray-600">no totals recorded</span>
        )}
      </div>
      {sources.length === 0 ? (
        <p className="mt-1.5 text-[11px] text-gray-600">per-source breakdown appears after the next run</p>
      ) : (
        <ul className="mt-1.5 space-y-1 text-xs">
          {sources.map(([src, t]) =>
            t.unresolved === 0 && t.top.length === 0 ? (
              <li key={src} className="text-gray-600">
                {srcShort(src)} clean
              </li>
            ) : (
              <li key={src} className="flex flex-wrap items-center gap-1 text-gray-300">
                <span className="mr-1 tabular-nums">
                  {srcShort(src)} <span className="text-gray-500">unresolved</span> {t.unresolved}
                </span>
                <TopNames top={t.top} />
              </li>
            )
          )}
        </ul>
      )}
    </div>
  );
}

/** The names as neutral chips, "×n" only when a name was seen more than once. */
function TopNames({ top }: { top: TopName[] }) {
  return (
    <>
      {top.map(([name, n], i) => (
        <Badge key={`${name}-${i}`} tone="neutral" title={n > 1 ? `seen ${n} times` : ""}>
          {n > 1 ? `${name} ×${n}` : name}
        </Badge>
      ))}
    </>
  );
}

/** Table cell: green "clean" when nothing is unresolved, otherwise the chips. One wrapper, for the stacked layout. */
function NamesCell({ unresolved, top }: { unresolved: number; top: TopName[] }) {
  if (unresolved === 0) return <Badge tone="good">clean</Badge>;
  if (top.length === 0) return <span className="text-xs text-gray-600">names not recorded</span>;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      <TopNames top={top} />
    </span>
  );
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function fmtShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function fmtAgo(minutes: number | null | undefined): string {
  if (minutes == null) return "—";
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${Math.round(minutes)} min ago`;
  const h = minutes / 60;
  if (h < 36) return `${h.toFixed(h < 10 ? 1 : 0)}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function took(start: string, end: string | null): string {
  if (!end) return "…";
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return "—";
  const sec = (e - s) / 1000;
  return sec < 60 ? `${sec.toFixed(sec < 10 ? 1 : 0)}s` : `${(sec / 60).toFixed(1)}m`;
}
