import { useEffect, useState } from "react";
import { Badge, Card, StatTile, Td, Th } from "./viz";
import { ACTION_TONE, projShort, srcShort } from "./labels";

/**
 * Lineup — start / sit this week.
 *
 * The projection-optimal lineup (the engine's number of record) against the
 * one you actually have set, with the other two projection sources and the
 * consensus rank on every row, and the sites' this-week claims beside them.
 * Disagreements — a starter the sites say sit, a bench player they say
 * start — are called out with who he would displace. Streaming picks at
 * QB/TE/DEF/K show the best available with what the sites say.
 */

type Rank = { median: number; best: number; worst: number; spread: number; n: number } | null;
type Claims = {
  n: number;
  n_sources: number;
  net: number;
  by_action: Record<string, number>;
  week: number;
  evidence: { action: string; horizon: string; confidence: number | null; rationale: string; source: string; title: string; url: string }[];
} | null;

type Row = {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  injury_status: string | null;
  slot: string | null;
  proj: Record<string, number>;
  projected: number | null;
  proj_spread: number | null;
  rank: Rank;
  ranks: Record<string, number>;
  delta: number | null;
  claims: Claims;
  current_starter: boolean;
  optimal_starter: boolean;
  points?: number;
};

type Stream = { player_id: string; name: string; team: string | null; rank: Rank; proj: Record<string, number>; claims: { n: number; net: number; by_action: Record<string, number>; evidence: { rationale: string; source: string }[] } | null };

type Data = {
  week: number;
  optimal: Row[];
  bench: Row[];
  totals: { optimal: number; current: number };
  changes: { in?: Row; out?: Row; reason: string }[];
  disagreements: { kind: "sit" | "start"; player: Row; over?: Row | null; text: string }[];
  streaming: Record<string, Stream[]>;
  note: string;
  error?: string;
};


export default function LineupTab({ league, onPlayer }: { league: string; onPlayer: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [allStreams, setAllStreams] = useState(false);

  useEffect(() => {
    setData(null);
    fetch(`/api/fantasy/lineup?league=${encodeURIComponent(league)}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : (setErr(null), setData(d))))
      .catch((e) => setErr(String(e)));
  }, [league]);

  if (err) return <div className="p-6 text-sm text-red-400">{err}</div>;
  if (!data) return <div className="p-6 text-sm text-gray-500">Loading…</div>;

  const Name = ({ r }: { r: Row }) => (
    <>
      <button onClick={() => onPlayer(r.player_id)} className="text-left text-gray-100 hover:text-indigo-300 hover:underline">
        {r.name}
      </button>
      <span className="ml-1.5 text-xs text-gray-500">
        {r.position}
        {r.team ? ` · ${r.team}` : ""}
      </span>
      {r.injury_status && (
        <>
          {" "}
          <Badge tone="warning">{r.injury_status}</Badge>
        </>
      )}
    </>
  );

  const ProjCell = ({ r }: { r: Row }) => (
    <span className="whitespace-nowrap tabular-nums">
      <span className="text-gray-100">{r.projected?.toFixed(1) ?? "—"}</span>
      {/* The other two sources are a desktop detail; on a phone the
          league-correct number and the disagreement flag are the answer. */}
      <span className="ml-1.5 hidden text-[11px] text-gray-600 sm:inline">
        {Object.entries(r.proj)
          .filter(([s]) => s !== "rotowire")
          .map(([s, v]) => `${projShort(s)} ${v.toFixed(0)}`)
          .join(" · ")}
      </span>
      {r.proj_spread != null && r.proj_spread >= 4 && (
        <span className="ml-1 text-amber-300" title="projection sources disagree">
          ±{r.proj_spread}
        </span>
      )}
    </span>
  );

  const RankCell = ({ r }: { r: Row }) =>
    r.rank ? (
      <span className="whitespace-nowrap tabular-nums text-gray-300" title={Object.entries(r.ranks).map(([s, v]) => `${srcShort(s)} ${v}`).join(", ")}>
        {r.position}
        {r.rank.median}
        <span className="text-gray-600"> ({r.rank.best}–{r.rank.worst})</span>
      </span>
    ) : (
      <span className="text-gray-700">—</span>
    );

  const ClaimsCell = ({ c }: { c: Claims }) =>
    c ? (
      <span>
        <span className="inline-flex flex-wrap gap-1">
          {Object.entries(c.by_action)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([a, n]) => (
              <Badge key={a} tone={ACTION_TONE[a] ?? "neutral"}>
                {a}
                {n > 1 ? ` ×${n}` : ""}
              </Badge>
            ))}
        </span>
        {c.evidence[0] && (
          <div className="mt-0.5 max-w-[24rem] text-[11px] text-gray-500">
            <span className="text-gray-600">{srcShort(c.evidence[0].source)}:</span> {c.evidence[0].rationale}
          </div>
        )}
      </span>
    ) : (
      <span className="text-xs text-gray-700">quiet</span>
    );

  const SetCell = ({ r }: { r: Row }) =>
    r.current_starter === r.optimal_starter ? (
      <span className="text-gray-600">{r.current_starter ? "starting" : "bench"}</span>
    ) : r.optimal_starter ? (
      <Badge tone="warning">on your bench</Badge>
    ) : (
      <Badge tone="warning">you start him</Badge>
    );

  const Table = ({ rows, slotCol }: { rows: Row[]; slotCol: boolean }) => (
    <div className="ff-stack-wrap overflow-x-auto">
      <table className="ff-stack w-full">
        <thead>
          <tr>
            {slotCol && <Th>Slot</Th>}
            <Th>Player</Th>
            <Th>Set</Th>
            <Th className="text-right">Proj</Th>
            <Th>Rank</Th>
            <Th>Sites say (this week)</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.player_id} className="border-t border-gray-800/60 align-top">
              {slotCol && <Td data-label="Slot" className="text-xs text-gray-500">{r.slot}</Td>}
              <Td data-label="" className="ff-row-head whitespace-nowrap">
                <Name r={r} />
              </Td>
              <Td data-label="Set" className="text-xs">
                <SetCell r={r} />
              </Td>
              <Td data-label="Proj" className="text-right">
                <ProjCell r={r} />
              </Td>
              <Td data-label="Rank" className="text-xs">
                <RankCell r={r} />
              </Td>
              <Td data-label="Sites say" className="text-xs">
                <ClaimsCell c={r.claims} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const diff = Math.round((data.totals.optimal - data.totals.current) * 10) / 10;

  // "Look at these" used to list changes and disagreements separately, so a
  // player with both (Dak: numbers say bench, sites say start) appeared twice.
  // One row per player, with what the numbers and the sites each say.
  type Look = { r: Row; numbers: { verdict: "start" | "bench"; reason: string } | null; sites: { kind: "sit" | "start"; text: string } | null };
  const look = new Map<string, Look>();
  const lookFor = (r: Row) => {
    let l = look.get(r.player_id);
    if (!l) {
      l = { r, numbers: null, sites: null };
      look.set(r.player_id, l);
    }
    return l;
  };
  for (const c of data.changes) {
    if (c.in) lookFor(c.in).numbers = { verdict: "start", reason: c.reason };
    if (c.out) lookFor(c.out).numbers = { verdict: "bench", reason: c.reason };
  }
  for (const d of data.disagreements) lookFor(d.player).sites = { kind: d.kind, text: d.text };

  // A streaming panel is worth opening only where the set starter projects
  // below the best available; a set QB with nobody better on the wire is
  // noise. Kickers rarely stream, so K is treated the same way.
  const starterProj = (pos: string) =>
    Math.max(0, ...[...data.optimal, ...data.bench].filter((r) => r.current_starter && r.position === pos).map((r) => r.projected ?? 0));
  const weak = (pos: string, rows: Stream[]) => {
    const best = Math.max(0, ...rows.map((s) => s.proj.rotowire ?? 0));
    return rows.length > 0 && best > starterProj(pos);
  };
  const streams = Object.entries(data.streaming);
  const openStreams = allStreams ? streams : streams.filter(([pos, rows]) => weak(pos, rows));

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Your set lineup" value={data.totals.current.toFixed(1)} hint={`week ${data.week}, league-correct`} />
        <StatTile
          label="Projection-optimal"
          value={data.totals.optimal.toFixed(1)}
          hint={diff > 0 ? `+${diff} if you switch` : "matches your lineup"}
          tone={diff >= 1 ? "warning" : "good"}
        />
        <StatTile label="Lineup changes" value={data.changes.length} hint="players the numbers would swap" tone={data.changes.length ? "warning" : "default"} />
        <StatTile label="Sites disagree" value={data.disagreements.length} hint="with the projection-optimal lineup" tone={data.disagreements.length ? "warning" : "default"} />
      </div>

      {look.size > 0 && (
        <Card title="Look at these" subtitle="Where your set lineup, the projections and the sites do not all agree. Nothing here is an override.">
          <div className="ff-stack-wrap overflow-x-auto">
            <table className="ff-stack w-full">
              <thead>
                <tr>
                  <Th>Player</Th>
                  <Th>Set</Th>
                  <Th>Numbers say</Th>
                  <Th>Sites say</Th>
                </tr>
              </thead>
              <tbody>
                {Array.from(look.values()).map(({ r, numbers, sites }) => (
                  <tr key={r.player_id} className="border-t border-gray-800/60 align-top">
                    <Td data-label="" className="ff-row-head whitespace-nowrap">
                      <Name r={r} />
                    </Td>
                    <Td data-label="Set" className="text-xs">
                      <SetCell r={r} />
                    </Td>
                    {/* One wrapper element per cell: a stacked cell is a flex
                        row of label + content, so loose children sit side by
                        side in columns instead of flowing. */}
                    <Td data-label="Numbers say" className="text-xs">
                      {numbers ? (
                        <div>
                          <Badge tone="warning">{numbers.verdict}</Badge>
                          <span className="ml-1.5 text-gray-500">
                            {r.projected?.toFixed(1)} projected · {numbers.reason}
                          </span>
                        </div>
                      ) : (
                        <span className="text-gray-700">agree</span>
                      )}
                    </Td>
                    <Td data-label="Sites say" className="text-xs">
                      {sites ? (
                        <div>
                          <Badge tone={sites.kind === "sit" ? "critical" : "good"}>{sites.kind}</Badge>
                          <span className="ml-1.5 text-gray-500">{sites.text}</span>
                          {r.claims?.evidence[0] && (
                            <div className="mt-0.5 max-w-[24rem] text-gray-500">
                              <span className="text-gray-600">{srcShort(r.claims.evidence[0].source)}:</span>{" "}
                              {r.claims.evidence[0].rationale}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-700">quiet</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Starters" subtitle={`The projection-optimal lineup for week ${data.week}. Proj is Rotowire under this league's scoring, with ESPN and the Fantasy Footballers beside it.`}>
        <Table rows={data.optimal} slotCol />
      </Card>
      <Card title="Bench" subtitle="Highest projection first.">
        <Table rows={data.bench} slotCol={false} />
      </Card>

      <Card
        title="Streaming"
        subtitle={
          allStreams
            ? "Best available at the streamable positions in this league, by consensus rank, with what the sites say."
            : "Positions where the best available projects above your set starter. The rest are folded."
        }
        right={
          streams.length > openStreams.length || allStreams ? (
            <button onClick={() => setAllStreams((v) => !v)} className="rounded-md border border-gray-800 px-2 py-1 text-xs text-gray-400 hover:border-gray-700 hover:text-gray-200">
              {allStreams ? "weak spots only" : `show all ${streams.length}`}
            </button>
          ) : undefined
        }
      >
        {openStreams.length === 0 ? (
          <p className="text-xs text-gray-600">Your set starter out-projects the best available at every streamable position.</p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            {openStreams.map(([pos, rows]) => (
              <div key={pos} className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-2">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-gray-500">
                  {pos}
                  {starterProj(pos) > 0 && <span className="normal-case tracking-normal text-gray-600"> · set starter {starterProj(pos).toFixed(1)}</span>}
                </div>
                {rows.length === 0 ? (
                  <div className="text-xs text-gray-600">nobody ranked available</div>
                ) : (
                  <ul className="space-y-1">
                    {rows.map((s) => (
                      <li key={s.player_id} className="text-xs">
                        <div className="flex items-baseline gap-2">
                          <button onClick={() => onPlayer(s.player_id)} className="min-w-0 text-left text-gray-200 hover:text-indigo-300 hover:underline">
                            {s.name}
                          </button>
                          <span className="text-gray-600">{s.team}</span>
                          {/* shrink-0 so the name, not the rank, gives way. */}
                          <span className="ml-auto shrink-0 whitespace-nowrap tabular-nums text-gray-400">
                            {pos}
                            {s.rank?.median ?? "—"}
                            {s.proj.rotowire != null && <span className="text-gray-600"> · {s.proj.rotowire.toFixed(0)} pts</span>}
                          </span>
                        </div>
                        {s.claims && (
                          <div className="text-gray-500">
                            {Object.entries(s.claims.by_action)
                              .slice(0, 2)
                              .map(([a, n]) => `${a}${n > 1 ? ` ×${n}` : ""}`)
                              .join(", ")}
                            {s.claims.evidence[0] && <> · {s.claims.evidence[0].rationale}</>}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      <p className="text-[11px] text-gray-600">{data.note}</p>
    </div>
  );
}
