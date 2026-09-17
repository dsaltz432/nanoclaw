import { useEffect, useState } from "react";
import { Badge, Card, FoldToggle, Td, Th } from "./viz";
import { ACTION_TONE, SCOPE_LABEL, projShort, srcShort } from "./labels";
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
  const [mode, setMode] = useState<Mode>("board");
  const [position, setPosition] = useState<string>("");
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

  useEffect(() => {
    const q = new URLSearchParams({ league, scope, hours: String(hours), limit: mode === "bypos" ? "400" : "120" });
    if (mode === "board" && position) q.set("position", position);
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
  }, [league, scope, mode, position, include, hours, snapshot]);

  if (err) return <div className="p-6 text-sm text-red-400">{err}</div>;

  const dynasty = scope === "dynasty";
  const showMove = !!data?.prev_snapshot;
  const snapshotOptions = snapshots.map((d, i) => ({ value: d, label: i === 0 ? `${d} (latest)` : d }));
  const snapshotValue = snapshot || snapshots[0] || "";
  const snapshotLine = data ? `snapshot ${data.snapshot ?? "—"} · vs ${data.prev_snapshot ?? "no earlier snapshot"}` : "";

  const header = (
    <tr>
      <Th>Player</Th>
      {dynasty && <Th className="text-right" title="age this season; R = rookie">Age</Th>}
      <Th>Status</Th>
      <Th className="text-right">Rank</Th>
      <Th className="text-right">Spread</Th>
      {/* A column of 120 dashes until a second snapshot lands. */}
      {showMove && (
        <Th className="text-right" title="move since the previous snapshot">
          Move
        </Th>
      )}
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
      {showMove && (
        <Td data-label="Move" className="text-right text-xs tabular-nums">
          {r.delta == null ? (
            <span className="text-gray-700">—</span>
          ) : (
            <span className={r.delta > 0 ? "text-green-400" : r.delta < 0 ? "text-red-400" : "text-gray-500"}>
              {r.delta > 0 ? "+" : ""}
              {r.delta}
            </span>
          )}
        </Td>
      )}
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
            <div className="mb-0.5 flex flex-wrap gap-1">
              {Object.entries(r.claims.by_action)
                .sort((a, b) => b[1] - a[1])
                .map(([a, n]) => (
                  <Badge key={a} tone={ACTION_TONE[a] ?? "neutral"}>
                    {a}
                    {n > 1 ? ` ×${n}` : ""}
                  </Badge>
                ))}
              <span className={`ml-1 tabular-nums ${r.claims.net > 0 ? "text-green-400" : r.claims.net < 0 ? "text-red-400" : "text-gray-500"}`}>
                {r.claims.net > 0 ? "+" : ""}
                {r.claims.net}
              </span>
            </div>
            {r.claims.evidence[0] && (
              <div className="text-gray-400" title={r.claims.evidence[0].title}>
                <span className="text-gray-600">{srcShort(r.claims.evidence[0].source)}:</span>{" "}
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

  const sections = data && mode === "bypos" ? groupByPosition(data.rows) : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          aria-label="Ranking scope"
          value={scope}
          onChange={(v) => setScope(v as Scope)}
          options={[
            { value: "weekly", label: SCOPE_LABEL.weekly },
            { value: "ros", label: SCOPE_LABEL.ros },
            { value: "dynasty", label: SCOPE_LABEL.dynasty },
          ]}
        />
        <Segmented
          aria-label="View"
          value={mode}
          onChange={(v) => setMode(v as Mode)}
          options={[
            { value: "board", label: "board" },
            { value: "bypos", label: "by position", hint: "one section per position, ranked within it" },
          ]}
        />
        {/* The position filter is what by-position mode replaces. */}
        {mode === "board" && (
          <Select
            aria-label="Position"
            value={position}
            onChange={setPosition}
            options={POSITIONS.map((p) => ({ value: p, label: p || "all positions" }))}
          />
        )}
        <Segmented
          aria-label="Include"
          value={include}
          onChange={setInclude}
          options={[
            { value: "", label: "everyone" },
            { value: "available", label: "available to add" },
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
          {/* ── buzz ─────────────────────────────────────────────────── */}
          {/* Only "most discussed" survives here: the lean-positive and
              lean-negative lists were the third appearance of the names Today
              and Moves already carry. No owner column — that is in the board
              and it truncated every name. */}
          {data.buzz.most_discussed.length > 0 && (
            <div className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-2">
              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">Most discussed</div>
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {data.buzz.most_discussed.slice(0, 6).map((r) => (
                  <li key={r.player_id} className="flex items-baseline gap-1.5 text-xs">
                    <button onClick={() => onPlayer(r.player_id)} className="text-left text-gray-200 hover:text-indigo-300 hover:underline">
                      {r.name}
                    </button>
                    <span className="text-gray-600">{r.pos}</span>
                    <span className="whitespace-nowrap tabular-nums text-gray-400">
                      {r.claims?.n} claims · {r.claims?.n_sources} sources
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

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
                {snapshotLine} · {data.rows.length} players across {sections.length} positions. Each section is ranked on its own;
                the prefix is the player's place within his position.
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
