import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Badge, Card, ErrorBox, FoldToggle, HoverInfo, Loading, MetaLine, Note, SubHead, Td, Th } from "./viz";
import { Select } from "./Select";
import { PlayerName } from "./NoteLine";
import { ago, fmtDate, fmtDateTime, parseTime, srcShort } from "./labels";

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

type State = "ok" | "late" | "failing" | "never" | "off";

type Job = {
  label: string;
  every_min: number;
  via: string;
  last: Run | null;
  state: State;
  window: { runs: number; fails: number };
};

type Source = {
  source: string;
  label: string;
  jobs: { articles: Job; rankings: Job };
  articles: {
    total: number;
    fetched_window: number;
    gated: number;
    suspicious: number;
    player_news: number;
    resolved: number;
  };
  rankings: { newest_snapshot: string | null; rows: number; resolved: number; lists: number };
};

type Article = {
  extraction: {
    status: "done" | "failed" | "pending" | "skipped";
    claims_n: number;
    summary: string;
    attempts: number;
    error: string;
  };
  article_id: string;
  source: string;
  kind: "article" | "player_news";
  url: string;
  title: string;
  author: string;
  published_at: string | null;
  fetched_at: string;
  body_chars: number;
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
  state: State;
  window: { runs: number; fails: number };
  /** Not sent yet; the core feeds run inside ff-news.sh, every 15 min. */
  every_min?: number;
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

type Data = {
  hours: number;
  generated_at: string;
  totals: { articles: number; fetched_window: number; notes_window: number };
  sources: Source[];
  core: Core[];
  claims: Core & {
    every_min: number;
    via: string;
    stats: {
      by_status: Record<string, { articles: number; claims: number; avg_ms: number | null }>;
      pending: number;
      claims: number;
    };
  };
  articles: Article[];
  runs: Run[];
  commands: { articles: string };
  resolver: Resolver;
  _stale?: boolean;
  error?: string;
};

/** One line of the Sources table: a site's job, a core feed, or claims extraction. */
type JobRow = {
  key: string;
  /** Who, for the problem list ("FantasyPros — rankings"). */
  name: string;
  site: string;
  siteClass: string;
  /** A site's second job: a ditto in the desktop column, a dimmed name on a phone. */
  repeat: boolean;
  /** The job on a phone's line 1 ("rankings"); the Job column carries it on a desktop. */
  jobName: string | null;
  job: string;
  state: State;
  every_min: number;
  via?: string;
  last: Run | null;
  window: { runs: number; fails: number };
  stored: ReactNode | null;
};

const STATE_TONE: Record<State, "good" | "warning" | "critical" | "neutral"> = {
  ok: "good",
  late: "warning",
  failing: "critical",
  never: "neutral",
  off: "neutral",
};

const CORE_EVERY_MIN = 15;
const PAGE = 15;
const RUN_PAGE = 20;
/** Above this many articles waiting, the extraction backlog reads amber. */
const BACKLOG_WARN = 20;

function cadence(min: number): string {
  return min >= 1440 ? "daily" : min >= 60 ? `every ${Math.round(min / 60)}h` : `every ${min} min`;
}

/** A health problem the page shell knows about and Admin cannot compute: a data-audit check or a failing feed. */
export type FeedProblem = { label: string; state: string; detail: string };

export default function AdminTab({ onPlayer, feedProblems }: { onPlayer?: (id: string) => void; feedProblems: FeedProblem[] }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [source, setSource] = useState<string>("");
  const [kind, setKind] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [allArticles, setAllArticles] = useState(false);
  const [allRuns, setAllRuns] = useState(false);

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
    setAllArticles(false);
    load();
  }, [load]);

  if (!data) return err ? <ErrorBox>{err}</ErrorBox> : <Loading rows={6} />;

  const claimsStats = data.claims.stats;
  const failedArticles = claimsStats.by_status.failed?.articles ?? 0;
  const avgMs = claimsStats.by_status.done?.avg_ms;
  const rows: JobRow[] = [
    ...data.sources.flatMap((s) =>
      (["articles", "rankings"] as const).map((j, i): JobRow => {
        const job = s.jobs[j];
        return {
          key: `${s.source}-${j}`,
          name: `${s.label} — ${job.label}`,
          site: s.label,
          siteClass: "font-medium text-gray-200",
          repeat: i > 0,
          jobName: job.label,
          job: `${job.label} · ${cadence(job.every_min)}`,
          state: job.state,
          every_min: job.every_min,
          via: job.via,
          last: job.last,
          window: job.window,
          stored:
            j === "articles" ? (
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
                {s.rankings.lists} lists · {s.rankings.rows} rows · {s.rankings.resolved} resolved · snapshot{" "}
                {fmtDate(s.rankings.newest_snapshot) || s.rankings.newest_snapshot}
              </>
            ) : null,
        };
      })
    ),
    ...data.core.map(
      (c): JobRow => ({
        key: c.source,
        name: c.label,
        site: c.label,
        siteClass: "font-medium text-gray-400",
        repeat: false,
        jobName: null,
        job: cadence(c.every_min ?? CORE_EVERY_MIN),
        state: c.state,
        every_min: c.every_min ?? CORE_EVERY_MIN,
        last: c.last,
        window: c.window,
        stored: null,
      })
    ),
    {
      key: "claims",
      name: "Claims extraction",
      site: "Claims extraction",
      siteClass: "font-medium text-gray-200",
      repeat: false,
      jobName: null,
      job: cadence(data.claims.every_min),
      state: data.claims.state,
      every_min: data.claims.every_min,
      via: data.claims.via,
      last: data.claims.last,
      window: data.claims.window,
      stored: (
        <>
          {claimsStats.claims} claims from {claimsStats.by_status.done?.articles ?? 0} articles ·{" "}
          <span className={claimsStats.pending > BACKLOG_WARN ? "text-amber-300" : ""}>
            {claimsStats.pending} pending
          </span>
          {failedArticles > 0 && <span className="text-red-400"> · {failedArticles} failed</span>}
          {avgMs != null && <> · {(avgMs / 1000).toFixed(0)}s avg</>}
        </>
      ),
    },
  ];
  // "never" counts, as it does in the shell's content_health, so this count
  // and the header badge's agree; "off" is a choice, not a problem.
  const problems = rows.filter((r) => r.state === "failing" || r.state === "late" || r.state === "never");
  const nProblems = feedProblems.length + problems.length;
  const jobErrors = rows.some((r) => r.last?.error);
  const runErrors = data.runs.some((r) => r.error);

  const resolver = data.resolver;
  // Worst offenders first: the one row you came to check should not hide
  // between five clean ones.
  const rankingTables = [...resolver.rankings].sort(
    (a, b) => b.unresolved - a.unresolved || a.source.localeCompare(b.source)
  );
  const articles = allArticles ? data.articles : data.articles.slice(0, PAGE);
  const runs = allRuns ? data.runs : data.runs.slice(0, RUN_PAGE);

  return (
    <div className="space-y-4">
      {/* ── headline: is anything wrong ─────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
          {nProblems > 0 ? (
            <Badge tone="warning">{nProblems} needing attention</Badge>
          ) : (
            <Badge tone="good">all healthy</Badge>
          )}
          <span title={data.generated_at}>as of {fmtDateTime(data.generated_at) || data.generated_at}</span>
          {data._stale && <Badge tone="neutral">cached</Badge>}
          {/* The volume in the window and the names the resolver gave up on:
              all the Sources table does not already say. Three tiles for three
              numbers were ~100px; this is part of a line. */}
          <MetaLine className="text-xs">
            <HoverInfo info={`${data.totals.articles} stored`}>
              <span className="tabular-nums text-gray-300">{data.totals.fetched_window}</span> articles
            </HoverInfo>
            <HoverInfo info="Rotowire via ESPN">
              <span className="tabular-nums text-gray-300">{data.totals.notes_window}</span> wire notes
            </HoverInfo>
            <HoverInfo info={`of ${resolver.claims.n} claims in the last ${resolver.claims.hours}h`}>
              <span className={`tabular-nums ${resolver.claims.unresolved > 0 ? "text-amber-300" : "text-gray-300"}`}>
                {resolver.claims.unresolved}
              </span>{" "}
              unresolved names
            </HoverInfo>
            <span>last {data.hours}h</span>
          </MetaLine>
          <button
            type="button"
            onClick={() => load(true)}
            disabled={busy}
            className="ff-inline ff-hit ml-auto text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
          >
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        {nProblems > 0 && (
          <ul className="space-y-0.5 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-100/90">
            {/* The shell's audit checks and core-feed failures first: Admin
                cannot compute those, and they are what the header badge led with. */}
            {feedProblems.map((p, i) => (
              <li key={`feed-${p.label}-${i}`}>
                {p.label}: <span className="font-medium">{p.state}</span>
                {p.detail && <span className="text-amber-300/80"> · {p.detail}</span>}
              </li>
            ))}
            {problems.map((p) => (
              <li key={p.key}>
                {p.name}: <span className="font-medium">{p.state}</span>
                {p.last?.error && <span className="text-amber-300/80"> · {p.last.error}</span>}
                {p.state === "never" && (
                  <span className="text-amber-300/80">
                    {" "}
                    · has never run, expected {cadence(p.every_min)}
                    {p.via && <> via {p.via}</>}
                  </span>
                )}
                {p.state === "late" && (
                  <span className="text-amber-300/80">
                    {" "}
                    · last ran {p.last ? (ago(p.last.started_at) ?? p.last.started_at) : "never"}, expected{" "}
                    {cadence(p.every_min)}
                    {p.via && <> via {p.via}</>}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {err && <ErrorBox>{err}</ErrorBox>}
      </div>

      <div aria-busy={busy} className={`space-y-4 transition-opacity ${busy ? "opacity-60" : ""}`}>

        {/* ── per-source job health ───────────────────────────────────── */}
        <Card title="Sources" info="Each site's jobs, the core feeds and claims extraction: state, last run, what is stored.">
          <Note>
            {`One row per site and job. Articles run every 15 min inside ff-news.sh; rankings every 2h or daily inside ff-refresh.sh, depending on how fast the list moves. "off" means the adapter exists but is not in the default sources. A job is late when its last run is older than 2.5x its interval, and failing when that run raised. The ${data.hours}h column is runs / failures in the window. Run the article job by hand with ${data.commands.articles}.`}
          </Note>
          <div className="ff-stack-wrap overflow-x-auto">
            <table className="ff-stack w-full">
              <thead>
                <tr>
                  <Th>Site</Th>
                  <Th className="hidden sm:table-cell">Job</Th>
                  <Th className="hidden sm:table-cell">State</Th>
                  <Th className="hidden sm:table-cell">Last run</Th>
                  <Th className="hidden text-right sm:table-cell">Rows</Th>
                  <Th className="hidden text-right sm:table-cell" title="runs / failures in the window">
                    {data.hours}h
                  </Th>
                  <Th className="hidden sm:table-cell">Stored</Th>
                  {jobErrors && <Th className="hidden sm:table-cell">Error</Th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key} className="border-t border-gray-800/60">
                    {/* The row head. On a phone it is the whole card: site and job
                        with the state on the right, then last run · rows · runs,
                        then what is stored and any error, each clamped. */}
                    <Td data-label="" className="ff-row-head">
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1">
                          <span className={`hidden sm:inline ${r.repeat ? "text-gray-700" : r.siteClass}`}>
                            {r.repeat ? "〃" : r.site}
                          </span>
                          <span className={`sm:hidden ${r.repeat ? "font-normal text-gray-500" : r.siteClass}`}>
                            {r.site}
                          </span>
                          {r.jobName && <span className="text-xs font-normal text-gray-400 sm:hidden"> {r.jobName}</span>}
                        </span>
                        <span className="shrink-0 sm:hidden">
                          <StateBadge state={r.state} />
                        </span>
                      </div>
                      <div className="sm:hidden">
                        <MetaLine className="mt-0.5">
                          <span title={r.last ? fmtDateTime(r.last.started_at) : ""}>
                            {r.last ? `ran ${ago(r.last.started_at) ?? fmtDateTime(r.last.started_at)}` : "never ran"}
                          </span>
                          {/* Left out at 0, as in the run log: "0 rows" says nothing "ran 6 min ago" does not. */}
                          {!!r.last?.rows && (
                            <span className="tabular-nums">
                              {r.last.rows} {r.last.rows === 1 ? "row" : "rows"}
                            </span>
                          )}
                          <span className="tabular-nums">
                            {r.window.runs} runs/{data.hours}h
                            {r.window.fails > 0 && <span className="text-red-400">, {r.window.fails} failed</span>}
                          </span>
                        </MetaLine>
                        {r.stored && (
                          <div className="mt-0.5 line-clamp-2 text-[11px] font-normal text-gray-500">{r.stored}</div>
                        )}
                        {r.last?.error && (
                          <div className="mt-0.5 line-clamp-2 text-[11px] font-normal text-red-400/90" title={r.last.error}>
                            {r.last.error}
                          </div>
                        )}
                      </div>
                    </Td>
                    <Td data-label="Job" className="hidden text-xs text-gray-400 sm:table-cell">
                      {r.job}
                    </Td>
                    <Td data-label="State" className="hidden sm:table-cell">
                      <StateBadge state={r.state} />
                    </Td>
                    <Td
                      data-label="Last run"
                      className="hidden whitespace-nowrap text-xs text-gray-500 sm:table-cell"
                      title={r.last ? fmtDateTime(r.last.started_at) : ""}
                    >
                      {r.last ? (ago(r.last.started_at) ?? fmtDateTime(r.last.started_at)) : "—"}
                    </Td>
                    <Td data-label="Rows" className="hidden text-right tabular-nums sm:table-cell">
                      {r.last?.rows ?? "—"}
                    </Td>
                    <Td
                      data-label={`${data.hours}h`}
                      className="hidden text-right text-xs tabular-nums text-gray-500 sm:table-cell"
                    >
                      <span>
                        {r.window.runs}
                        {r.window.fails > 0 && <span className="text-red-400"> / {r.window.fails}</span>}
                      </span>
                    </Td>
                    <Td data-label="Stored" className="hidden text-xs text-gray-500 sm:table-cell">
                      {r.stored ? <span>{r.stored}</span> : "—"}
                    </Td>
                    {jobErrors && (
                      <Td
                        data-label="Error"
                        className="hidden text-xs text-red-400/90 sm:table-cell"
                        title={r.last?.error ?? ""}
                      >
                        <span className="block max-w-[14rem] truncate">{r.last?.error}</span>
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* ── resolver: names that did not map to a Sleeper id ────────── */}
        <Card
          title="Resolver"
          secondary
          info="Player names the resolver could not map to a Sleeper id, per run and per table."
        >
          <Note>
            Unresolved is expected for IDP and college players; ambiguous means two Sleeper players share the name and
            no team or position broke the tie. Names are shown exactly as the site printed them.
          </Note>
          {/* 1. the two most recent runs, side by side */}
          <div className="grid gap-3 sm:grid-cols-2">
            <LastRun label="Last article run" run={resolver.last_runs.articles} />
            <LastRun label="Last rankings run" run={resolver.last_runs.rankings} />
          </div>

          {/* 2. what is sitting unresolved in the stored tables right now */}
          <SubHead className="mb-1.5 mt-4">Unresolved in the tables</SubHead>
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
                      {srcShort(r.source)} <span className="text-gray-600">rankings</span>
                    </Td>
                    <Td data-label="Snapshot" className="whitespace-nowrap text-xs text-gray-500" title={r.snapshot}>
                      {fmtDate(r.snapshot) || r.snapshot}
                    </Td>
                    <Td data-label="Unresolved" className="text-right text-xs tabular-nums">
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
                {rankingTables.length === 0 && (
                  <tr className="border-t border-gray-800/60">
                    <Td data-label="" className="text-xs text-gray-500" colSpan={4}>
                      No rankings snapshots stored yet.
                    </Td>
                  </tr>
                )}
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
                  <Td data-label="Snapshot" empty className="text-xs text-gray-600">
                    —
                  </Td>
                  <Td data-label="Unresolved" className="text-right text-xs tabular-nums">
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
              </tbody>
            </table>
          </div>
        </Card>

        {/* ── every article as it landed ──────────────────────────────── */}
        <Card
          title="Articles"
          secondary
          info="Newest fetched first; titles open the source."
          rightStacks
          right={
            <div className="flex flex-wrap items-center gap-2">
              <Select
                aria-label="Site"
                size="sm"
                value={source}
                onChange={setSource}
                options={[{ value: "", label: "All sites" }, ...data.sources.map((s) => ({ value: s.source, label: s.label }))]}
              />
              <Select
                aria-label="Kind"
                size="sm"
                value={kind}
                onChange={setKind}
                options={[
                  { value: "", label: "Articles + player news" },
                  { value: "article", label: "Articles only" },
                  { value: "player_news", label: "Player news only" },
                ]}
              />
            </div>
          }
        >
          {data.articles.length === 0 ? (
            <p className="text-xs text-gray-500">Nothing stored yet for this filter.</p>
          ) : (
            <>
              <div className="ff-stack-wrap overflow-x-auto">
                <table className="ff-stack w-full">
                  <thead>
                    <tr>
                      <Th>When</Th>
                      <Th>Site</Th>
                      <Th>Title</Th>
                      <Th title="claims extracted by the model; hover for its one-line summary">Claims</Th>
                      <Th className="text-right">Chars</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {articles.map((a) => {
                      const when = a.published_at ?? a.fetched_at;
                      const whenTitle = [
                        a.published_at && `published ${fmtDateTime(a.published_at)} (${ago(a.published_at) ?? ""})`,
                        `fetched ${fmtDateTime(a.fetched_at)}`,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      const site = (
                        <>
                          {labelFor(data, a.source)}
                          {a.kind === "player_news" && (
                            <span className="ml-1 text-[10px] uppercase tracking-wide text-gray-600">news</span>
                          )}
                        </>
                      );
                      // Shown at every width; a phone's line also leads with
                      // site · when · claims, whose own columns it drops.
                      const player = playerMeta(a, onPlayer);
                      const meta = [
                        a.author && <span key="by">{a.author}</span>,
                        player && <span key="player">{player}</span>,
                        (a.gated || a.flagged) && (
                          <span key="flags" className="inline-flex gap-1 self-center">
                            {a.gated && <Badge tone="neutral" title="body looked paywalled or truncated">gated</Badge>}
                            {a.flagged && (
                              <Badge tone="warning" title="text reads as an instruction; stored, never obeyed">
                                flagged
                              </Badge>
                            )}
                          </span>
                        ),
                      ];
                      return (
                        <tr key={a.article_id} className="border-t border-gray-800/60 align-top">
                          <Td
                            data-label="When"
                            className="hidden whitespace-nowrap text-xs text-gray-500 sm:table-cell"
                            title={whenTitle}
                          >
                            {fmtDateTime(when)}
                          </Td>
                          <Td data-label="Site" className="hidden whitespace-nowrap text-xs text-gray-400 sm:table-cell">
                            <span>{site}</span>
                          </Td>
                          {/* The row head: title, then one meta line. On a phone the
                              meta line also carries site · when · claims, whose own
                              columns are dropped there. */}
                          <Td data-label="" className="ff-row-head">
                            <div className="sm:max-w-[28rem]">
                              <a
                                href={a.url}
                                target="_blank"
                                rel="noreferrer"
                                className="line-clamp-2 text-gray-200 hover:text-indigo-300 hover:underline"
                                title={a.title || a.url}
                              >
                                {a.title || a.url}
                              </a>
                              <MetaLine className="mt-0.5 sm:hidden">
                                <span>{site}</span>
                                <span title={whenTitle}>{fmtDateTime(when)}</span>
                                {claimsText(a) && <span>{claimsText(a)}</span>}
                                {meta}
                              </MetaLine>
                              <MetaLine className="mt-0.5 max-sm:hidden">{meta}</MetaLine>
                            </div>
                          </Td>
                          <Td
                            data-label="Claims"
                            className="hidden whitespace-nowrap text-xs sm:table-cell"
                            title={a.extraction.summary || a.extraction.error || ""}
                          >
                            <ClaimsCell a={a} />
                          </Td>
                          <Td data-label="Chars" className="hidden text-right text-xs tabular-nums text-gray-500 sm:table-cell">
                            {a.body_chars}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <FoldToggle
                total={data.articles.length}
                shown={articles.length}
                expanded={allArticles}
                onToggle={() => setAllArticles((v) => !v)}
                mode="all"
              />
            </>
          )}
        </Card>

        {/* ── raw run log ─────────────────────────────────────────────── */}
        <Card
          title="Run log"
          collapsible
          info={`The last ${data.runs.length} content and wire-feed runs, newest first.`}
        >
          <div className="ff-stack-wrap overflow-x-auto">
            <table className="ff-stack w-full">
              <thead>
                <tr>
                  <Th className="hidden sm:table-cell">Started</Th>
                  <Th>Source</Th>
                  <Th className="hidden sm:table-cell">Detail</Th>
                  <Th className="hidden sm:table-cell">Result</Th>
                  <Th className="hidden text-right sm:table-cell">Rows</Th>
                  <Th className="hidden text-right sm:table-cell">Took</Th>
                  {runErrors && <Th className="hidden sm:table-cell">Error</Th>}
                </tr>
              </thead>
              <tbody>
                {runs.map((r, i) => (
                  <tr key={r.id ?? i} className="border-t border-gray-800/60">
                    <Td
                      data-label="Started"
                      className="hidden whitespace-nowrap text-xs text-gray-500 sm:table-cell"
                      title={r.started_at}
                    >
                      {fmtDateTime(r.started_at)}
                    </Td>
                    {/* The row head. On a phone: source with the result on the right,
                        then started · rows · took, then the detail and error, clamped. */}
                    <Td data-label="" className="ff-row-head text-xs text-gray-300">
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 break-words sm:whitespace-nowrap">{r.source}</span>
                        <span className="shrink-0 sm:hidden">
                          <RunBadge ok={r.ok} />
                        </span>
                      </div>
                      <div className="sm:hidden">
                        <MetaLine className="mt-0.5">
                          <span>{fmtDateTime(r.started_at)}</span>
                          {r.rows ? <span className="tabular-nums">{r.rows} {r.rows === 1 ? "row" : "rows"}</span> : null}
                          {r.finished_at && <span className="tabular-nums">took {took(r.started_at, r.finished_at)}</span>}
                        </MetaLine>
                        {r.detail && (
                          <div className="mt-0.5 line-clamp-2 break-words text-[11px] font-normal text-gray-500" title={r.detail}>
                            {r.detail}
                          </div>
                        )}
                        {r.error && (
                          <div className="mt-0.5 line-clamp-2 break-words text-[11px] font-normal text-red-400/90" title={r.error}>
                            {r.error}
                          </div>
                        )}
                      </div>
                    </Td>
                    {/* Content runs write "resolved 120 · unresolved 3 · ambiguous 1 · Name FA RB×1";
                        the names can run long, so clip and keep the full line on hover. */}
                    <Td data-label="Detail" className="hidden text-xs text-gray-500 sm:table-cell" title={r.detail ?? ""}>
                      <span className={`block ${runErrors ? "max-w-[12rem]" : "max-w-[16rem]"} truncate`}>
                        {r.detail || "—"}
                      </span>
                    </Td>
                    <Td data-label="Result" className="hidden sm:table-cell">
                      <RunBadge ok={r.ok} />
                    </Td>
                    <Td
                      data-label="Rows"
                      empty={!r.rows}
                      className={`hidden text-right text-xs tabular-nums sm:table-cell ${r.rows ? "" : "text-gray-600"}`}
                    >
                      {r.rows ?? "—"}
                    </Td>
                    <Td data-label="Took" className="hidden text-right text-xs tabular-nums text-gray-500 sm:table-cell">
                      {took(r.started_at, r.finished_at)}
                    </Td>
                    {runErrors && (
                      <Td data-label="Error" className="hidden text-xs text-red-400/90 sm:table-cell" title={r.error ?? ""}>
                        <span className="block max-w-[12rem] truncate">{r.error}</span>
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <FoldToggle
            total={data.runs.length}
            shown={runs.length}
            expanded={allRuns}
            onToggle={() => setAllRuns((v) => !v)}
            mode="all"
          />
        </Card>
      </div>
    </div>
  );
}

function labelFor(data: Data, source: string): string {
  return data.sources.find((s) => s.source === source)?.label ?? source;
}

function StateBadge({ state }: { state: State }) {
  return (
    <Badge
      tone={STATE_TONE[state]}
      title={state === "off" ? "not in the default sources; see CONTENT-PLAN.md source review" : ""}
    >
      {state}
    </Badge>
  );
}

function RunBadge({ ok }: { ok: number | null }) {
  return (
    <Badge tone={ok === 1 ? "good" : ok === 0 ? "critical" : "neutral"}>
      {ok === 1 ? "ok" : ok === 0 ? "fail" : "running"}
    </Badge>
  );
}

/** The Claims column: count once extracted, otherwise why not. */
function ClaimsCell({ a }: { a: Article }) {
  const x = a.extraction;
  if (x.status === "done")
    return <span className={x.claims_n > 0 ? "text-gray-300" : "text-gray-600"}>{x.claims_n}</span>;
  if (x.status === "failed")
    return (
      <Badge tone="critical" title={x.error}>
        failed ×{x.attempts}
      </Badge>
    );
  if (x.status === "pending") return <span className="text-gray-600">pending</span>;
  return (
    <span className="text-gray-700" title="gated or too short to extract from">
      —
    </span>
  );
}

/** The same fact for a phone's meta line, in words; nothing when extraction was skipped. */
function claimsText(a: Article): ReactNode {
  const x = a.extraction;
  if (x.status === "done") return `${x.claims_n} claim${x.claims_n === 1 ? "" : "s"}`;
  if (x.status === "failed") return <span className="text-red-400">extraction failed ×{x.attempts}</span>;
  if (x.status === "pending") return "claims pending";
  return null;
}

/** Who a player-news item resolved to, or the name it could not place. */
function playerMeta(a: Article, onPlayer?: (id: string) => void): ReactNode {
  if (a.kind !== "player_news" || !a.player_name) return null;
  if (a.player_id)
    return (
      <PlayerName
        id={a.player_id}
        name={a.player_name}
        pos={a.player_position}
        team={a.player_team}
        onPlayer={onPlayer}
        news={false}
      />
    );
  return (
    <span title="not a Sleeper fantasy-position player, or ambiguous">
      {a.player_name} <Badge tone="neutral">unresolved</Badge>
    </span>
  );
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
        <span className="text-xs text-gray-500" title={run.at ? fmtDateTime(run.at) : ""}>
          {run.at ? (ago(run.at) ?? run.at) : "never"}
        </span>
      </div>
      <div className="mt-1 text-xs tabular-nums text-gray-400">
        {run.totals ? (
          <>
            resolved {run.totals.resolved} · unresolved {run.totals.unresolved} · ambiguous {run.totals.ambiguous}
          </>
        ) : (
          <span className="text-gray-500">no totals recorded</span>
        )}
      </div>
      {sources.length === 0 ? (
        <p className="mt-1.5 text-xs text-gray-500">per-source breakdown appears after the next run</p>
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
  if (top.length === 0) return <span className="text-xs text-gray-500">names not recorded</span>;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      <TopNames top={top} />
    </span>
  );
}

function took(start: string, end: string | null): string {
  if (!end) return "…";
  const s = parseTime(start);
  const e = parseTime(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return "—";
  const sec = (e - s) / 1000;
  return sec < 60 ? `${sec.toFixed(sec < 10 ? 1 : 0)}s` : `${(sec / 60).toFixed(1)}m`;
}
