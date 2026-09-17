import { useEffect, useState } from "react";
import { Badge, Card, FoldToggle, Td, Th } from "./viz";
import { ACTION_TONE, SCOPE_LABEL, projShort, srcShort } from "./labels";
import { Segmented, Select } from "./Select";

/**
 * Experts — the consensus board. Where the sites rank a player, how much
 * they disagree, and what they are saying, joined to roster status and the
 * league-correct projections so expert opinion and the numbers sit on one
 * row. Nothing here recommends; the disagreement is the point.
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
};

type Slim = { player_id: string; name: string | null; pos: string | null; team: string | null; status: string; owner: string | null; rank: Row["rank"]; delta: number | null; claims: Claims | null };

type Data = {
  league: string;
  week: number;
  scope: string;
  snapshot: string | null;
  prev_snapshot: string | null;
  hours: number;
  rank_sources: string[];
  counts: { ranked: number; with_claims: number; rows: number };
  rows: Row[];
  buzz: { bullish: Slim[]; bearish: Slim[]; most_discussed: Slim[] };
  legend: Record<string, string>;
  error?: string;
};

const POSITIONS = ["", "QB", "RB", "WR", "TE", "K", "DEF"];

export default function ExpertsTab({ league, onPlayer }: { league: string; onPlayer: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scope, setScope] = useState<"weekly" | "ros" | "dynasty">(league === "dynasty" ? "dynasty" : "weekly");
  const [position, setPosition] = useState<string>("");
  const [include, setInclude] = useState<string>("");
  const [hours, setHours] = useState<number>(168);
  const [allRows, setAllRows] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams({ league, scope, hours: String(hours), limit: "120" });
    if (position) q.set("position", position);
    if (include) q.set("include", include);
    setData(null);
    fetch(`/api/fantasy/consensus?${q.toString()}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : (setErr(null), setData(d))))
      .catch((e) => setErr(String(e)));
  }, [league, scope, position, include, hours]);

  if (err) return <div className="p-6 text-sm text-red-400">{err}</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          aria-label="Ranking scope"
          value={scope}
          onChange={(v) => setScope(v as typeof scope)}
          options={[
            { value: "weekly", label: SCOPE_LABEL.weekly },
            { value: "ros", label: SCOPE_LABEL.ros },
            { value: "dynasty", label: SCOPE_LABEL.dynasty },
          ]}
        />
        <Select
          aria-label="Position"
          value={position}
          onChange={setPosition}
          options={POSITIONS.map((p) => ({ value: p, label: p || "all positions" }))}
        />
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
        {data && (
          <span className="ml-auto text-[11px] text-gray-600">
            snapshot {data.snapshot ?? "—"}
            {data.prev_snapshot ? ` vs ${data.prev_snapshot}` : " · movement needs a second snapshot"} ·{" "}
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

          {/* ── the board ────────────────────────────────────────────── */}
          <Card
            title="Consensus board"
            subtitle={
              <>
                {data.counts.rows} players · {data.counts.ranked} ranked · {data.counts.with_claims} with claims. Rank is the
                median position rank across sources; spread is best–worst. Ordered by {data.legend.order}.
              </>
            }
          >
            <div className="ff-stack-wrap overflow-x-auto">
              <table className="ff-stack w-full">
                <thead>
                  <tr>
                    <Th>Player</Th>
                    <Th>Status</Th>
                    <Th className="text-right">Rank</Th>
                    <Th className="text-right">Spread</Th>
                    {/* A column of 120 dashes until a second snapshot lands. */}
                    {data.prev_snapshot && (
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
                </thead>
                <tbody>
                  {(allRows ? data.rows : data.rows.slice(0, 25)).map((r) => (
                    <tr key={r.player_id} className="border-t border-gray-800/60 align-top">
                      <Td data-label="" className="ff-row-head whitespace-nowrap">
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
                      {data.prev_snapshot && (
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
                  ))}
                </tbody>
              </table>
            </div>
            <FoldToggle total={data.rows.length} shown={allRows ? data.rows.length : Math.min(25, data.rows.length)} expanded={allRows} onToggle={() => setAllRows((v) => !v)} mode="all" />
          </Card>
        </>
      )}
    </div>
  );
}
