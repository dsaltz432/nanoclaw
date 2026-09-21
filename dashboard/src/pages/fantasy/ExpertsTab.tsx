import { useEffect, useState } from "react";
import { SrcLink } from "./NoteLine";
import { Badge, Card, FoldToggle, Td, Th } from "./viz";
import { ACTION_TONE, SCOPE_LABEL, claimLean, claimMix, projShort, srcShort } from "./labels";
import { Segmented, Select } from "./Select";

/**
 * Experts — the consensus board. Where the sites rank a player, how much
 * they disagree, and what they are saying, joined to roster status and the
 * league-correct projections so expert opinion and the numbers sit on one
 * row. Nothing here recommends; the disagreement is the point.
 *
 * Two views of the same rows. The board is one list ordered by the server
 * (the legend says how). "By position" fetches the whole scope and groups it
 * client-side into one card per position, each row prefixed with its ordinal
 * in that position (RB1, RB2, …) so there is no cross-position ordering to
 * misread — a position rank of 12 means something different for a QB and a WR.
 *
 * The board can be pinned to an earlier snapshot date; "movement" is then
 * measured against the snapshot before that one.
 */

type Claims = {
  n: number;
  n_sources: number;
  n_articles: number;
  by_action: Record<string, number>;
  /** Week-horizon claims published before this player's last kickoff. */
  stale_by_action?: Record<string, number>;
  n_stale?: number;
  by_horizon: Record<string, number>;
  bullish: number;
  bearish: number;
  net: number;
  latest: string | null;
  evidence: { action: string; horizon: string; confidence: number | null; rationale: string; source: string; title: string; url: string }[];
};

type Row = {
  player_id: string;
  name: string | null;
  pos: string | null;
  team: string | null;
  injury_status: string | null;
  status: "mine" | "rostered" | "free_agent";
  owner: string | null;
  rank: { median: number; best: number; worst: number; spread: number; n: number } | null;
  ranks: Record<string, number>;
  fp: { min: number; max: number; std: number; tier: number } | null;
  delta: number | null;
  claims: Claims | null;
  proj: Record<string, number>;
  proj_spread: number | null;
  age: number | null;
  years_exp: number | null;
  rookie: boolean;
};

type Slim = { player_id: string; name: string | null; pos: string | null; team: string | null; status: string; owner: string | null; rank: Row["rank"]; delta: number | null; claims: Claims | null };

type Data = {
  league: string;
  week: number;
  scope: string;
  snapshot: string | null;
  prev_snapshot: string | null;
  /** Every snapshot date for the scope, newest first. */
  snapshots: string[];
  hours: number;
  rank_sources: string[];
  counts: { ranked: number; with_claims: number; rows: number };
  rows: Row[];
  buzz: { bullish: Slim[]; bearish: Slim[]; most_discussed: Slim[] };
  legend: Record<string, string>;
  error?: string;
};

type Scope = "weekly" | "ros" | "dynasty";
type Mode = "board" | "bypos";

const POSITIONS = ["", "QB", "RB", "WR", "TE", "K", "DEF"];
/** Section order in by-position mode. Anything else lands under "Other". */
const POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];
const FOLD = 25;

/**
 * Within a position: by consensus rank, unranked last; among the unranked,
 * the most-discussed first, then by name so the order is stable.
 */
function byRank(a: Row, b: Row): number {
  if (a.rank && b.rank && a.rank.median !== b.rank.median) return a.rank.median - b.rank.median;
  if (!!a.rank !== !!b.rank) return a.rank ? -1 : 1;
  const ca = a.claims?.n ?? 0;
  const cb = b.claims?.n ?? 0;
  if (ca !== cb) return cb - ca;
  return (a.name ?? "").localeCompare(b.name ?? "");
}

function groupByPosition(rows: Row[]): { pos: string; rows: Row[] }[] {
  const buckets = new Map<string, Row[]>();
  for (const r of rows) {
    const key = r.pos && POS_ORDER.includes(r.pos) ? r.pos : "Other";
    const list = buckets.get(key) ?? [];
    list.push(r);
    buckets.set(key, list);
  }
  const out: { pos: string; rows: Row[] }[] = [];
  for (const pos of [...POS_ORDER, "Other"]) {
    const list = buckets.get(pos);
    if (list && list.length) out.push({ pos, rows: list.sort(byRank) });
  }
  return out;
}

export default function ExpertsTab({ league, onPlayer }: { league: string; onPlayer: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scope, setScopeRaw] = useState<Scope>(league === "dynasty" ? "dynasty" : "weekly");
  // One position at a time, fetched as its own list, so QB / K / DEF are
  // never truncated off the end of a FLEX-ordered board. "" is All, which is
  // the one ordered list the server sorts for us — the old "board" view.
  // QB by default: All is a cross-position order, and a position rank of 12
  // means something different for a quarterback than for a receiver.
  const [posTab, setPosTab] = useState<string>("QB");
  const [include, setInclude] = useState<string>("");
  const [hours, setHours] = useState<number>(168);
  // "" means "latest": the first fetch carries no snapshot param and the
  // payload's own list populates the picker.
  const [snapshot, setSnapshot] = useState<string>("");
  // Kept outside `data` so the picker survives the loading state between
  // fetches instead of collapsing to an empty list on every change.
  const [snapshots, setSnapshots] = useState<string[]>([]);
  const [allRows, setAllRows] = useState(false);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  // Snapshot dates belong to a scope (weekly lists land on different days
  // than dynasty ones), so a pinned date is meaningless once the scope moves.
  const setScope = (s: Scope) => {
    setScopeRaw(s);
    setSnapshot("");
    setSnapshots([]);
  };

  // All = the server-ordered board; a position = that position's own list.
  const mode: Mode = posTab === "" ? "board" : "bypos";

  useEffect(() => {
    const q = new URLSearchParams({ league, scope, hours: String(hours), limit: mode === "bypos" ? "200" : "120" });
    if (posTab) q.set("position", posTab);
    if (include) q.set("include", include);
    if (snapshot) q.set("snapshot", snapshot);
    setData(null);
    fetch(`/api/fantasy/consensus?${q.toString()}`)
      .then((r) => r.json())
      .then((d: Data) => {
        if (d.error) {
          setErr(d.error);
          return;
        }
        setErr(null);
        setData(d);
        if (Array.isArray(d.snapshots)) setSnapshots(d.snapshots);
      })
      .catch((e) => setErr(String(e)));
  }, [league, scope, mode, posTab, include, hours, snapshot]);

  if (err) return <div className="p-6 text-sm text-red-400">{err}</div>;

  const dynasty = scope === "dynasty";
  const snapshotOptions = snapshots.map((d, i) => ({ value: d, label: i === 0 ? `${d} (latest)` : d }));
  const snapshotValue = snapshot || snapshots[0] || "";
  // "vs <date>" named the comparison the Move column drew. With that column
  // gone nothing on this page is measured against the earlier snapshot, so
  // the line says which snapshot you are reading and stops there.
  const snapshotLine = data ? `snapshot ${data.snapshot ?? "—"}` : "";

  const header = (
    <tr>
      <Th>Player</Th>
      {dynasty && <Th className="text-right" title="age this season; R = rookie">Age</Th>}
      <Th>Status</Th>
      <Th className="text-right">Rank</Th>
      <Th className="text-right">Spread</Th>
      <Th>By source</Th>
      <Th>Sites say</Th>
      <Th className="text-right" title="league-correct projection per source">
        Proj
      </Th>
    </tr>
  );

  const renderRow = (r: Row, ordinal?: string) => (
    <tr key={r.player_id} className="border-t border-gray-800/60 align-top" data-pos={r.pos ?? ""} data-ordinal={ordinal}>
      <Td data-label="" className="ff-row-head whitespace-nowrap">
        {ordinal && (
          <span className="mr-1.5 inline-block min-w-[2.6rem] text-[11px] font-medium tabular-nums text-gray-500" data-ordinal-label>
            {ordinal}
          </span>
        )}
        <button onClick={() => onPlayer(r.player_id)} className="text-left text-gray-100 hover:text-indigo-300 hover:underline">
          {r.name ?? r.player_id}
        </button>
        <span className="ml-1.5 text-xs text-gray-500">
          {r.pos}
          {r.team ? ` · ${r.team}` : ""}
        </span>
        {r.injury_status && (
          <>
            {" "}
            <Badge tone="warning">{r.injury_status}</Badge>
          </>
        )}
      </Td>
      {dynasty && (
        <Td data-label="Age" className="whitespace-nowrap text-right text-xs tabular-nums text-gray-300">
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
      <Td data-label="Status" className="whitespace-nowrap text-xs">
        {r.status === "mine" ? (
          <Badge tone="good">mine</Badge>
        ) : r.status === "free_agent" ? (
          <Badge tone="info">available</Badge>
        ) : (
          <span className="text-gray-500">{r.owner}</span>
        )}
      </Td>
      <Td data-label="Rank" className="text-right tabular-nums text-gray-100">{r.rank?.median ?? <span className="text-gray-700">—</span>}</Td>
      <Td data-label="Spread" className="text-right text-xs tabular-nums text-gray-500">{r.rank ? `${r.rank.best}–${r.rank.worst}` : ""}</Td>
      <Td data-label="By source" className="text-[11px] text-gray-500">
        <span className="inline-flex flex-wrap gap-x-1.5">
          {Object.entries(r.ranks)
            .sort((a, b) => a[1] - b[1])
            .map(([s, v]) => (
              <span key={s} className="whitespace-nowrap">
                {srcShort(s)} <span className="text-gray-300">{v}</span>
              </span>
            ))}
        </span>
      </Td>
      <Td data-label="Sites say" className="max-w-[28rem] text-xs">
        {r.claims ? (
          <div>
            <div className="mb-0.5 flex flex-wrap items-center gap-1" title={`all calls: ${claimMix(r.claims.by_action)}`}>
              {/* The lean, and the opposing call only where it is a real
                  split rather than one dissenter. The whole mix is on hover;
                  Lineup, Moves and Trades each own their own slice of it. */}
              {(() => {
                const chip = ([a, n]: [string, number]) => (
                  <Badge key={a} tone={ACTION_TONE[a] ?? "neutral"}>
                    {a}
                    {n > 1 ? ` ×${n}` : ""}
                  </Badge>
                );
                const pair = (l: NonNullable<ReturnType<typeof claimLean>>) => (
                  <>
                    {chip(l.lead)}
                    {l.counter && (
                      <>
                        <span className="text-gray-700">/</span>
                        {chip(l.counter)}
                      </>
                    )}
                  </>
                );
                const lean = claimLean(r.claims.by_action);
                if (lean) return pair(lean);
                // Nothing since his last kickoff — Monday and Tuesday, mostly.
                // Show what was said, dimmed and dated, rather than an empty
                // cell that cannot be told from "nobody is writing about him".
                const old = claimLean(r.claims.stale_by_action ?? {});
                if (!old) return null;
                return (
                  <span className="inline-flex items-center gap-1 opacity-50" title="published before this player's last game">
                    {pair(old)}
                    <span className="text-[11px] italic text-gray-500">before his last game</span>
                  </span>
                );
              })()}
              {Object.keys(r.claims.by_action).length > 0 && (
                <span className={`ml-1 tabular-nums ${r.claims.net > 0 ? "text-green-400" : r.claims.net < 0 ? "text-red-400" : "text-gray-500"}`}>
                  {r.claims.net > 0 ? "+" : ""}
                  {r.claims.net}
                </span>
              )}
            </div>
            {r.claims.evidence[0] && (
              <div className="text-gray-400" title={r.claims.evidence[0].title}>
                <SrcLink e={r.claims.evidence[0]} />{" "}
                {r.claims.evidence[0].rationale}
              </div>
            )}
          </div>
        ) : (
          <span className="text-gray-700">—</span>
        )}
      </Td>
      <Td data-label="Proj" className="text-right text-xs tabular-nums text-gray-400">
        {Object.entries(r.proj).length ? (
          <span className="inline-flex flex-wrap justify-end gap-x-1.5">
            {Object.entries(r.proj).map(([s, v]) => (
              <span key={s} className="whitespace-nowrap">
                <span className="text-gray-600">{projShort(s)}</span> {v.toFixed(0)}
              </span>
            ))}
            {r.proj_spread != null && r.proj_spread >= 4 && (
              <span className="text-amber-300" title="projection sources disagree">±{r.proj_spread}</span>
            )}
          </span>
        ) : (
          <span className="text-gray-700">—</span>
        )}
      </Td>
    </tr>
  );

  const table = (rows: Row[], section?: string) => (
    <div className="ff-stack-wrap overflow-x-auto">
      <table className="ff-stack w-full" data-section={section}>
        <thead>{header}</thead>
        <tbody>{rows.map((r, i) => renderRow(r, section ? `${section === "Other" ? "" : section}${i + 1}` : undefined))}</tbody>
      </table>
    </div>
  );

  const sections = data && mode === "bypos" ? groupByPosition(data.rows).filter((sec) => sec.pos === posTab) : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          aria-label="Ranking scope"
          value={scope}
          onChange={(v) => setScope(v as Scope)}
          options={[
            // Dynasty lists only mean something in the dynasty league, where
            // they are also the default; the other two leagues never see them.
            ...(league === "dynasty" ? [{ value: "dynasty", label: SCOPE_LABEL.dynasty }] : []),
            { value: "weekly", label: SCOPE_LABEL.weekly },
            { value: "ros", label: SCOPE_LABEL.ros },
          ]}
        />
        {/* One control, not two. "board" and "by position" were two views of
            the same rows differing only in whether the position filter was a
            dropdown or tabs, and you had to pick a view before you could pick
            a position. All is just another position. */}
        <Segmented
          aria-label="Position"
          value={posTab}
          onChange={setPosTab}
          options={[{ value: "", label: "All" }, ...POS_ORDER.map((p) => ({ value: p, label: p }))]}
        />
        <Segmented
          aria-label="Include"
          value={include}
          onChange={setInclude}
          options={[
            { value: "", label: "everyone" },
            { value: "available", label: "available" },
            { value: "mine", label: "my roster" },
          ]}
        />
        <Select
          aria-label="Claims window"
          label="claims"
          value={String(hours)}
          onChange={(v) => setHours(Number(v))}
          options={[
            { value: "72", label: "3 days" },
            { value: "168", label: "7 days" },
            { value: "336", label: "14 days" },
          ]}
        />
        {snapshotOptions.length > 0 && (
          <Select
            aria-label="Snapshot date"
            label="snapshot"
            value={snapshotValue}
            onChange={(v) => setSnapshot(v === snapshots[0] ? "" : v)}
            options={snapshotOptions}
          />
        )}
        {data && (
          <span className="ml-auto text-[11px] text-gray-600">
            {data.rank_sources.map(srcShort).join(" · ")}
          </span>
        )}
      </div>

      {!data ? (
        <div className="p-6 text-sm text-gray-500">Loading…</div>
      ) : (
        <>
          {mode === "board" ? (
            /* ── the board ──────────────────────────────────────────── */
            <Card
              title="Consensus board"
              subtitle={
                <>
                  <span data-snapshot-line>{snapshotLine}</span>. {data.counts.rows} players · {data.counts.ranked} ranked ·{" "}
                  {data.counts.with_claims} with claims. Rank is the median position rank across sources; spread is best–worst.
                  Ordered by {data.legend.order}.
                </>
              }
            >
              {table(allRows ? data.rows : data.rows.slice(0, FOLD))}
              <FoldToggle
                total={data.rows.length}
                shown={allRows ? data.rows.length : Math.min(FOLD, data.rows.length)}
                expanded={allRows}
                onToggle={() => setAllRows((v) => !v)}
                mode="all"
              />
            </Card>
          ) : (
            /* ── by position ────────────────────────────────────────── */
            <>
              <p className="text-[11px] text-gray-600" data-snapshot-line>
                {snapshotLine} · {posTab} only, ranked within the position; the prefix is the player's place in it. Pick another
                position above.
              </p>
              {sections.map(({ pos, rows }) => {
                const open = openSections.has(pos);
                const ranked = rows.filter((r) => r.rank).length;
                const unranked = rows.length - ranked;
                return (
                  <Card
                    key={pos}
                    title={pos}
                    subtitle={
                      <>
                        {ranked} ranked
                        {unranked > 0 ? ` · ${unranked} unranked` : ""}
                      </>
                    }
                  >
                    {table(open ? rows : rows.slice(0, FOLD), pos)}
                    <FoldToggle
                      total={rows.length}
                      shown={open ? rows.length : Math.min(FOLD, rows.length)}
                      expanded={open}
                      onToggle={() =>
                        setOpenSections((s) => {
                          const next = new Set(s);
                          if (next.has(pos)) next.delete(pos);
                          else next.add(pos);
                          return next;
                        })
                      }
                      mode="all"
                    />
                  </Card>
                );
              })}
            </>
          )}
        </>
      )}
    </div>
  );
}
