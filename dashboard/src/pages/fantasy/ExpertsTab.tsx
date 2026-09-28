import { useEffect, useState, type ReactNode } from "react";
import { ClaimQuote, ClaimsSummary, PlayerName, RankText, type Claim } from "./NoteLine";
import { Badge, Card, ErrorBox, FoldToggle, Loading, MetaLine, Note, Td, Th, useIsNarrow } from "./viz";
import { PROJ_SHORT, SCOPE_LABEL, cap, claimLean, fmtDate, projLabel, projShort, srcLabel, srcShort } from "./labels";
import { Segmented, Select } from "./Select";

/**
 * Rankings — the consensus board. Where the sites rank a player, how much
 * they disagree, and what they are saying, joined to roster status and the
 * league-correct projections so expert opinion and the numbers sit on one
 * row. Nothing here recommends; the disagreement is the point.
 *
 * One card, one list. The position control picks what is fetched: All is the
 * server's cross-position order (the FLEX / overall list), numbered by that
 * list's rank; a position is that position's own list, ordered by its median
 * position rank. Every row prints its rank position-prefixed (WR11) because a
 * position rank of 12 means something different for a QB and a WR.
 *
 * The board can be pinned to an earlier snapshot date.
 */

type Claims = {
  n_sources: number;
  by_action: Record<string, number>;
  /** Week-horizon claims published before this player's last kickoff. */
  stale_by_action?: Record<string, number>;
  evidence: Claim[];
};

type Row = {
  player_id: string;
  name: string | null;
  pos: string | null;
  team: string | null;
  injury_status: string | null;
  status: "mine" | "rostered" | "free_agent";
  rank: { median: number; best: number; worst: number } | null;
  ranks: Record<string, number>;
  /** Cross-position lists ("FLEX", "SUPERFLEX", "OVERALL") -> source -> rank. */
  overall: Record<string, Record<string, number>>;
  delta: number | null;
  claims: Claims | null;
  proj: Record<string, number>;
  age: number | null;
  rookie: boolean;
};

type Data = {
  league: string;
  /** The week the projections are for. */
  week: number | null;
  scope: string;
  snapshot: string | null;
  /** Every snapshot date for the scope, newest first. */
  snapshots: string[];
  /** `ranked` counts the whole scope; `rows` and `with_claims` count the filtered list. */
  counts: { ranked: number; with_claims: number; rows: number };
  rows: Row[];
  legend: Record<string, string>;
  error?: string;
};

type Scope = "weekly" | "ros" | "dynasty";

const POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FOLD = 25;
/** Projection sources in one fixed order, so a column of numbers lines up. */
const PROJ_ORDER = Object.keys(PROJ_SHORT);
/** Ranking sites in one fixed order, for the By source sub-columns. */
const RANK_ORDER = ["fantasypros", "cbs", "footballguys", "ffballers", "draftsharks", "fantasylife"];

/**
 * A row of fixed-width sub-columns: the site labels in a header, the numbers
 * under them in every row, so By source and Proj read down as columns and
 * never wrap. A site that has nothing for a player shows a dash in its slot.
 */
function SubCols({ keys, width, children }: { keys: string[]; width: string; children: (k: string) => ReactNode }) {
  return (
    <div className="grid justify-end gap-x-1.5 tabular-nums" style={{ gridTemplateColumns: `repeat(${keys.length}, ${width})` }}>
      {keys.map((k) => (
        <span key={k} className="text-right">
          {children(k)}
        </span>
      ))}
    </div>
  );
}
const HOURS_OPTIONS = [
  { value: "72", label: "3 days" },
  { value: "168", label: "7 days" },
  { value: "336", label: "14 days" },
];
const INCLUDE_OPTIONS = [
  { value: "", label: "Everyone" },
  { value: "available", label: "Available" },
];
/** Segments at least as wide as a thumb; "K" alone was 28px. */
const SEG_MIN = "[&_button]:min-w-[2.25rem]";
/** Phones: a little less side padding, for the row scope shares with include. */
const SEG_TIGHT = "max-sm:[&_button]:px-2";

/**
 * The cross-position list the server ordered All by. It names the list in
 * `legend.order` ("cross-position list (FLEX) first…"); dynasty is OVERALL.
 */
function overallList(d: Data): string {
  const m = /\(([A-Z_]+)/.exec(d.legend?.order ?? "");
  return m?.[1] ?? (d.scope === "dynasty" ? "OVERALL" : "FLEX");
}

const SUB_RANK_W = "1.75rem";
const SUB_PROJ_W = "2.5rem";
const mine = (r: Row) => r.status === "mine";

/** The same pick the server sorts on: FantasyPros where it ranks him, else the best other site. */
function overallRank(r: Row, list: string): number | null {
  const o = r.overall?.[list];
  if (!o) return null;
  const vals = Object.values(o);
  if (!vals.length) return null;
  return o.fantasypros ?? Math.min(...vals);
}

/**
 * The lean, or — when nothing has been said since his last kickoff (Monday
 * and Tuesday, mostly) — what was said before it, dimmed and dated, rather
 * than a blank that cannot be told from "nobody is writing about him".
 */
function Lean({ c }: { c: Claims }) {
  if (claimLean(c.by_action)) return <ClaimsSummary byAction={c.by_action} nSources={c.n_sources} />;
  const old = c.stale_by_action;
  if (!old || !claimLean(old)) return <ClaimsSummary byAction={c.by_action} />;
  return (
    <span className="inline-flex flex-wrap items-center gap-1 opacity-50" title="published before this player's last game">
      <ClaimsSummary byAction={old} />
      <span className="text-[11px] italic text-gray-500">before his last game</span>
    </span>
  );
}

export default function ExpertsTab({ league, onPlayer }: { league: string; onPlayer: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scope, setScopeRaw] = useState<Scope>(league === "dynasty" ? "dynasty" : "weekly");
  // One position at a time, fetched as its own list, so QB / K / DEF are
  // never truncated off the end of a FLEX-ordered board. "" is All, the one
  // cross-position list the server sorts for us. QB by default: All is a
  // cross-position order, and a position rank of 12 means something
  // different for a quarterback than for a receiver.
  const [posTab, setPosTab] = useState<string>("QB");
  const [include, setInclude] = useState<string>("");
  const [hours, setHours] = useState<number>(168);
  // "" means "latest": the first fetch carries no snapshot param and the
  // payload's own list populates the picker.
  const [snapshot, setSnapshot] = useState<string>("");
  // Kept outside `data` so the picker survives a refetch instead of
  // collapsing to an empty list on every change.
  const [snapshots, setSnapshots] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  // Phones only: the secondary filters fold behind one "Filters" link.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const narrow = useIsNarrow();

  // Snapshot dates belong to a scope (weekly lists land on different days
  // than dynasty ones), so a pinned date is meaningless once the scope moves.
  const setScope = (s: Scope) => {
    setScopeRaw(s);
    setSnapshot("");
    setSnapshots([]);
  };

  useEffect(() => {
    const q = new URLSearchParams({ league, scope, hours: String(hours), limit: posTab ? "200" : "120" });
    if (posTab) q.set("position", posTab);
    if (include) q.set("include", include);
    if (snapshot) q.set("snapshot", snapshot);
    // On a filter change the previous list stays on screen, dimmed, until
    // this one lands; a response to a superseded request is dropped.
    let live = true;
    setBusy(true);
    fetch(`/api/fantasy/consensus?${q.toString()}`)
      .then((r) => r.json())
      .then((d: Data) => {
        if (!live) return;
        if (d.error) {
          setErr(d.error);
          return;
        }
        setErr(null);
        setData(d);
        if (Array.isArray(d.snapshots)) setSnapshots(d.snapshots);
      })
      .catch((e) => live && setErr(String(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [league, scope, posTab, include, hours, snapshot]);

  const dynasty = scope === "dynasty";
  const all = posTab === "";
  const snapshotOptions = snapshots.map((d, i) => ({ value: d, label: i === 0 ? `${fmtDate(d)} (latest)` : fmtDate(d) }));
  const snapshotValue = snapshot || snapshots[0] || "";
  const weekLabel = data?.week != null ? `${narrow ? "Wk" : "Week"} ${data.week}` : "This week";

  // Non-default filters, echoed as chips beside the folded "Filters" link.
  const chips = [
    hours !== 168 && `claims ${HOURS_OPTIONS.find((o) => o.value === String(hours))?.label}`,
    snapshot && `snapshot ${fmtDate(snapshot)}`,
  ].filter(Boolean) as string[];

  // The claims window and snapshot date qualify the whole board rather than
  // narrow it, so on desktop they sit in the card header and the filters
  // proper (scope, position, everyone/available) fit one toolbar row.
  const windowPickers = (
    <>
      <Select
        aria-label="Claims window"
        label="Claims"
        value={String(hours)}
        onChange={(v) => setHours(Number(v))}
        options={HOURS_OPTIONS}
      />
      {snapshotOptions.length > 0 && (
        <Select
          aria-label="Snapshot date"
          label="Snapshot"
          value={snapshotValue}
          onChange={(v) => setSnapshot(v === snapshots[0] ? "" : v)}
          options={snapshotOptions}
        />
      )}
    </>
  );
  const headerRight = !narrow && <div className="flex items-center gap-2">{windowPickers}</div>;

  const controls = (
    <div className="mb-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          aria-label="Ranking scope"
          value={scope}
          onChange={(v) => setScope(v as Scope)}
          className={`${SEG_MIN} ${SEG_TIGHT}`}
          options={[
            // Dynasty lists only mean something in the dynasty league, where
            // they are also the default; the other two leagues never see them.
            ...(league === "dynasty" ? [{ value: "dynasty", label: cap(SCOPE_LABEL.dynasty) }] : []),
            // The week by number ("Week 3"), short on a phone ("Wk 3") so scope
            // and Everyone/Available share one row there even with the dynasty
            // option. Before the first payload the number is not known yet.
            { value: "weekly", label: weekLabel },
            { value: "ros", label: "ROS" },
          ]}
        />
        <Segmented
          aria-label="Position"
          value={posTab}
          onChange={(v) => {
            setPosTab(v);
            setExpanded(false);
          }}
          // On a phone the position chips take the second row, after
          // everyone/available, which fits beside scope on the first.
          className={`${SEG_MIN} max-sm:order-last`}
          options={[{ value: "", label: "All" }, ...POS_ORDER.map((p) => ({ value: p, label: p }))]}
        />
        <Segmented
          aria-label="Include"
          value={include}
          onChange={setInclude}
          className={SEG_TIGHT}
          options={INCLUDE_OPTIONS}
        />
        {narrow && (
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            className="ff-inline ff-hit order-last text-xs text-indigo-400 hover:text-indigo-300"
          >
            {filtersOpen ? "Hide filters" : "Filters"}
          </button>
        )}
        {narrow &&
          !filtersOpen &&
          chips.map((c) => (
            <span key={c} className="order-last rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-300">
              {c}
            </span>
          ))}
      </div>
      {narrow && filtersOpen && (
        <div className="flex flex-wrap items-center gap-2">
          {windowPickers}
        </div>
      )}
    </div>
  );

  if (!data) {
    return (
      <Card title="Consensus board" right={headerRight}>
        {controls}
        {err ? <ErrorBox>{err}</ErrorBox> : <Loading rows={6} />}
      </Card>
    );
  }

  const list = overallList(data);
  // Projections are this week's points: beside a dynasty list they would be
  // read as long-term value, so dynasty drops the column.
  const showProj = !dynasty;
  const projHead = data.week != null ? `Proj wk ${data.week}` : "Proj (this wk)";
  // Only the sources that price someone on this list, in the fixed order.
  const projSources = showProj ? PROJ_ORDER.filter((s) => data.rows.some((r) => s in r.proj)) : [];
  const projTitle = `${data.legend.proj ?? "league-correct projection"}: ${projSources.map(projShort).join(" · ")}`;
  // Only the ranking sites that rank someone on this list, in the fixed order.
  const rankSources = RANK_ORDER.filter((s) => data.rows.some((r) => s in r.ranks));
  const rows = expanded ? data.rows : data.rows.slice(0, FOLD);
  const posLabel = all ? "" : `${posTab} · `;

  const renderRow = (r: Row) => {
    const num = all ? overallRank(r, list) : null;
    const hasProj = projSources.some((s) => s in r.proj);
    // Phone meta line only; desktop gives each source its own sub-column.
    const projLine = hasProj && projSources.map((s) => r.proj[s]?.toFixed(1) ?? "–").join(" · ");
    const rank = r.rank && <RankText pos={r.pos} median={r.rank.median} best={r.rank.best} worst={r.rank.worst} delta={r.delta} />;
    const quote = r.claims?.evidence[0];
    return (
      <tr
        key={r.player_id}
        // Your own players: a green edge and a faint tint instead of a Status
        // column naming every owner.
        className={`border-t border-gray-800/60 align-top ${mine(r) ? "bg-emerald-500/[0.06] shadow-[inset_2px_0_0_0_rgb(16_185_129_/_0.7)]" : ""}`}
        data-pos={r.pos ?? ""}
      >
        {/* On a phone this cell is the whole row: name and rank, then one
            line of meta, then the quote. The other cells are desktop columns. */}
        <Td data-label="" className="ff-row-head min-w-[11rem] sm:min-w-[18rem]">
          <div className="flex items-baseline gap-1.5">
            {all && (
              <span className="w-7 shrink-0 text-[11px] font-medium tabular-nums text-gray-500" title={`${list} rank`}>
                {num ?? ""}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <PlayerName id={r.player_id} name={r.name} pos={r.pos} team={r.team} injury={r.injury_status} onPlayer={onPlayer} />
            </div>
            <span className="shrink-0 text-sm sm:hidden">{rank}</span>
          </div>
          <MetaLine className="mt-0.5 sm:hidden">
            {dynasty && r.age != null && (
              <span>
                age {r.age}
                {r.rookie ? " (R)" : ""}
              </span>
            )}
            {projLine && (
              <span className="whitespace-nowrap tabular-nums">
                {data.week != null ? `wk ${data.week} proj` : "proj"} {projLine}
              </span>
            )}
            {r.rank && r.rank.best !== r.rank.worst && (
              <span className="tabular-nums">
                range {r.rank.best}–{r.rank.worst}
              </span>
            )}
            {r.claims && (
              <span className="whitespace-nowrap">
                <Lean c={r.claims} />
              </span>
            )}
          </MetaLine>
          {quote && (
            <div className="mt-0.5 font-normal sm:hidden">
              <ClaimQuote e={quote} />
            </div>
          )}
        </Td>
        {dynasty && (
          <Td data-label="Age" empty={r.age == null} className="hidden whitespace-nowrap text-right text-xs tabular-nums text-gray-300 sm:table-cell">
            {r.age ?? <span className="text-gray-700">—</span>}
            {r.rookie && (
              <>
                {" "}
                <Badge tone="info" title="rookie: 0 years of experience">
                  R
                </Badge>
              </>
            )}
          </Td>
        )}
        <Td data-label="Rank" empty={!r.rank} className="hidden text-right sm:table-cell">
          {rank ?? <span className="text-gray-700">—</span>}
        </Td>
        <Td data-label="By source" empty={!Object.keys(r.ranks).length} className="hidden text-xs text-gray-300 sm:table-cell">
          <SubCols keys={rankSources} width={SUB_RANK_W}>
            {(s) => r.ranks[s] ?? <span className="text-gray-700">–</span>}
          </SubCols>
        </Td>
        {showProj && (
          <Td data-label={projHead} empty={!hasProj} className="hidden text-xs text-gray-400 sm:table-cell">
            <SubCols keys={projSources} width={SUB_PROJ_W}>
              {(s) => (r.proj[s] != null ? r.proj[s]!.toFixed(1) : <span className="text-gray-700">–</span>)}
            </SubCols>
          </Td>
        )}
        <Td data-label="Sites say" block empty={!r.claims} className="hidden w-full min-w-[11rem] text-xs sm:table-cell">
          {r.claims ? (
            <>
              <div className="mb-0.5">
                <Lean c={r.claims} />
              </div>
              {quote && <ClaimQuote e={quote} />}
            </>
          ) : (
            <span className="text-gray-700">—</span>
          )}
        </Td>
      </tr>
    );
  };

  return (
    <Card
      title="Consensus board"
      right={headerRight}
      subtitle={
        <>
          {posLabel}
          {data.rows.length < data.counts.rows ? `${data.rows.length} of ${data.counts.rows}` : data.counts.rows} players
          listed · {data.counts.with_claims} with claims ·{" "}
          <span className="border-l-2 border-emerald-500/70 pl-1 text-gray-400">yours</span>
          {/* Desktop shows the date in the snapshot picker beside this line. */}
          {narrow && <> · snapshot {data.snapshot ? fmtDate(data.snapshot) : "—"}</>}
        </>
      }
    >
      {/* Static text: the drawer keeps every distinct string a note has
          registered, so interpolating the payload would stack variants. */}
      <Note>
        Rank is the median of each ranking site's position rank; By source lists them and hovering a rank gives the
        best–worst range. All is ordered by the cross-position list (FantasyPros FLEX, SUPERFLEX in a superflex league,
        OVERALL for dynasty), then by claim volume, and the number before each name is that list's rank; quarterbacks,
        kickers and defenses are not on the FLEX list and follow. A single position is ordered by median position rank,
        so tied players share a rank. Proj is this week's league-correct points from each projection source, one
        sub-column each, in the weekly and rest-of-season views. Your own players are marked with a green edge. Dynasty
        lists carry no projection, since one week's points say little about long-term value.
      </Note>
      {controls}
      {err && <ErrorBox className="mb-3">{err}</ErrorBox>}
      <div className={`transition-opacity ${busy ? "opacity-60" : ""}`} aria-busy={busy}>
        {data.rows.length === 0 ? (
          <p className="text-xs text-gray-500">No players match these filters.</p>
        ) : (
          <>
            <div className="ff-stack-wrap overflow-x-auto">
              <table className="ff-stack w-full">
                <thead>
                  <tr>
                    <Th title={all ? `the number is the ${list} rank this list is ordered by` : undefined}>Player</Th>
                    {dynasty && (
                      <Th className="text-right" title="age this season; R = rookie">
                        Age
                      </Th>
                    )}
                    <Th className="text-right" title="median position rank across sites; hover a rank for the range">
                      Rank
                    </Th>
                    <Th className="text-right" title="each site's position rank">
                      <div>By source</div>
                      <SubCols keys={rankSources} width={SUB_RANK_W}>
                        {(s) => (
                          <span className="font-normal normal-case tracking-normal text-gray-600" title={srcLabel(s)}>
                            {srcShort(s)}
                          </span>
                        )}
                      </SubCols>
                    </Th>
                    {showProj && (
                      <Th className="whitespace-nowrap text-right" title={projTitle}>
                        <div>{projHead}</div>
                        <SubCols keys={projSources} width={SUB_PROJ_W}>
                          {(s) => (
                            <span className="font-normal normal-case tracking-normal text-gray-600" title={projLabel(s)}>
                              {projShort(s)}
                            </span>
                          )}
                        </SubCols>
                      </Th>
                    )}
                    <Th>Sites say</Th>
                  </tr>
                </thead>
                <tbody>{rows.map(renderRow)}</tbody>
              </table>
            </div>
            <FoldToggle
              total={data.rows.length}
              shown={rows.length}
              expanded={expanded}
              onToggle={() => setExpanded((v) => !v)}
              mode="all"
            />
          </>
        )}
      </div>
    </Card>
  );
}
