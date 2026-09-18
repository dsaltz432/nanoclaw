import { useEffect, useState } from "react";
import { Badge, Card, StatTile, Td, Th } from "./viz";
import { ACTION_TONE, projShort, srcShort } from "./labels";
import { MatchupCell, NoteLine, RoleBadge, UsageCell, type Matchup, type Note, type Usage } from "./NoteLine";

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
  usage: Usage;
  matchup: Matchup;
  note: Note;
};

type Stream = {
  player_id: string;
  name: string;
  team: string | null;
  rank: Rank;
  proj: Record<string, number>;
  claims: { n: number; net: number; by_action: Record<string, number>; evidence: { rationale: string; source: string }[] } | null;
  usage: Usage;
  matchup: Matchup;
  note: Note;
};

/** One surviving roster in the guillotine league, by projected set total. */
type RosterRow = {
  roster_id: string;
  owner_id: string;
  owner: string;
  is_me: boolean;
  set: number;
  optimal: number;
  starters_without_projection: number;
};

/** Guillotine only; null in the other two leagues. */
type Survival = {
  week: number;
  teams_alive: number;
  eliminated_so_far: number;
  mine: RosterRow | null;
  lowest_rival: RosterRow | null;
  margin_above_lowest: number | null;
  margin_if_optimal: number | null;
  my_rank_from_bottom: number | null;
  median_set: number | null;
  distribution: RosterRow[];
  last_week: null | { week: number; chop_line: number; chopped: string; my_points: number | null; my_rank_from_bottom: number | null; teams: number };
  note: string;
} | null;

type Data = {
  week: number;
  survival?: Survival;
  optimal: Row[];
  bench: Row[];
  totals: { optimal: number; current: number };
  changes: { in?: Row; out?: Row; reason: string }[];
  disagreements: { kind: "sit" | "start"; player: Row; over?: Row | null; text: string }[];
  streaming: Record<string, Stream[]>;
  note: string;
  context_note: string;
  usage_week: number | null;
  usage_prev_week: number | null;
  role_change_points: number;
  note_hours: number;
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
      {/* The newest injury / out / role / return wire note, inline, so a
          starter's status is visible without opening the dossier. */}
      <NoteLine note={r.note} />
    </>
  );

  const ProjCell = ({ r }: { r: Row }) => (
    <span className="whitespace-nowrap tabular-nums">
      <span className="text-gray-100">{r.projected?.toFixed(1) ?? "—"}</span>
      {/* The other two sources are a desktop detail; on a phone the
          league-correct number and the disagreement flag are the answer. */}
      <span className="ml-1.5 hidden text-[11px] text-gray-600 xl:inline">
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
            <Th>Matchup · usage</Th>
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
              {/* Two short facts stacked in one column: side by side they
                  pushed the starters table 170px past its card at 1259px. */}
              <Td data-label="Matchup · usage" className="whitespace-nowrap text-xs tabular-nums">
                <div>
                  <div>
                    <MatchupCell matchup={r.matchup} position={r.position} />
                  </div>
                  <div className="text-gray-400">
                    <UsageCell usage={r.usage} position={r.position} />
                  </div>
                </div>
              </Td>
              <Td data-label="Rank" className="text-xs">
                <RankCell r={r} />
              </Td>
              <Td data-label="Sites say" className="text-xs sm:min-w-[13rem]">
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

  // Guillotine: the question is not "am I optimal" but "am I above the chop
  // line". The lowest six rosters are the line as the projections see it;
  // your own row is appended when you sit comfortably above them.
  const survival = data.survival ?? null;
  const SURVIVAL_ROWS = 6;
  const survivalRows = (() => {
    if (!survival) return [];
    const low = survival.distribution.slice(0, SURVIVAL_ROWS);
    const mine = survival.distribution.find((r) => r.is_me);
    return mine && !low.some((r) => r.roster_id === mine.roster_id) ? [...low, mine] : low;
  })();
  const margin = survival?.margin_above_lowest ?? null;
  const marginTone: "critical" | "warning" | "good" = margin == null ? "good" : margin < 5 ? "critical" : margin < 15 ? "warning" : "good";
  const marginHint =
    survival?.margin_if_optimal != null && margin != null && survival.margin_if_optimal !== margin
      ? `+${survival.margin_if_optimal.toFixed(1)} if optimal`
      : undefined;

  return (
    <div className="space-y-4">
      {survival && (
        <Card
          title="Survival"
          subtitle={`week ${survival.week} · ${survival.teams_alive} teams alive · ${survival.eliminated_so_far} chopped so far`}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Your set lineup" value={survival.mine?.set.toFixed(1) ?? "—"} />
            <StatTile label="Lowest rival" value={survival.lowest_rival?.set.toFixed(1) ?? "—"} hint={survival.lowest_rival?.owner} />
            <StatTile label="Margin above the line" value={margin != null ? `${margin >= 0 ? "+" : ""}${margin.toFixed(1)}` : "—"} tone={marginTone} hint={marginHint} />
            <StatTile
              label="From the bottom"
              value={survival.my_rank_from_bottom != null ? `${survival.my_rank_from_bottom} of ${survival.teams_alive}` : "—"}
              hint={survival.median_set != null ? `median ${survival.median_set.toFixed(1)}` : undefined}
            />
          </div>
          {survivalRows.length > 0 && (
            <ul className="mt-3 space-y-0.5 text-xs">
              {survivalRows.map((r) => (
                <li
                  key={r.roster_id}
                  className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-2 py-1 ${r.is_me ? "bg-indigo-500/10 text-gray-100" : "text-gray-300"}`}
                >
                  <span className="min-w-0 truncate">
                    {r.owner}
                    {r.is_me && <span className="ml-1 text-indigo-400">you</span>}
                  </span>
                  <span className="tabular-nums">
                    · {r.set.toFixed(1)} <span className="text-gray-500">(optimal {r.optimal.toFixed(1)})</span>
                  </span>
                  {r.starters_without_projection > 0 && <Badge tone="warning">{r.starters_without_projection} empty</Badge>}
                </li>
              ))}
            </ul>
          )}
          {survival.last_week && (
            <p className="mt-2 text-xs text-gray-500">
              Week {survival.last_week.week}: chop line {survival.last_week.chop_line} ({survival.last_week.chopped}) · you scored{" "}
              {survival.last_week.my_points != null ? survival.last_week.my_points.toFixed(1) : "—"}, {survival.last_week.my_rank_from_bottom ?? "—"} from the bottom of{" "}
              {survival.last_week.teams}
            </p>
          )}
          <p className="mt-2 text-[11px] text-gray-600">{survival.note}</p>
        </Card>
      )}

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
                      <div>
                        <Name r={r} />
                        {/* A bench player whose snap share jumped is the
                            reason this table exists; flag him at the top. */}
                        {r.usage?.role_change && (
                          <>
                            {" "}
                            <RoleBadge change={r.usage.role_change} />
                          </>
                        )}
                      </div>
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
                    <Td data-label="Sites say" className="text-xs sm:min-w-[16rem]">
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

      <Card
        title="Starters"
        subtitle={
          `The projection-optimal lineup for week ${data.week}. Proj is Rotowire under this league's scoring, with ESPN and the Fantasy Footballers beside it.` +
          (data.usage_week != null
            ? ` Matchup is the opponent and the Vegas implied team total; usage is snap and target share for week ${data.usage_week}` +
              (data.usage_prev_week != null ? ` (change from week ${data.usage_prev_week})` : "") +
              "."
            : "")
        }
      >
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
          <div className="ff-stack-wrap overflow-x-auto">
            <table className="ff-stack w-full">
              <thead>
                <tr>
                  <Th>Pos</Th>
                  <Th>Player</Th>
                  <Th>Rank</Th>
                  <Th className="text-right">Proj</Th>
                  <Th>Matchup</Th>
                  <Th>Sites say</Th>
                </tr>
              </thead>
              <tbody>
                {openStreams.flatMap(([pos, rows]) =>
                  rows.length === 0
                    ? [
                        <tr key={pos} className="border-t border-gray-800/60">
                          <Td data-label="Pos" className="text-xs font-medium text-gray-400">{pos}</Td>
                          <Td data-label="" className="text-xs text-gray-600" colSpan={5}>nobody ranked available</Td>
                        </tr>,
                      ]
                    : rows.map((s, i) => (
                        <tr key={`${pos}-${s.player_id}`} className={`align-top ${i === 0 ? "border-t border-gray-800/60" : "border-t border-gray-800/30"}`}>
                          <Td data-label="Pos" className="whitespace-nowrap text-xs font-medium text-gray-400">
                            {i === 0 ? (
                              <div>
                                {pos}
                                {starterProj(pos) > 0 && <div className="font-normal text-gray-600">set starter {starterProj(pos).toFixed(1)}</div>}
                              </div>
                            ) : (
                              // Stacked on a phone the label needs a value; on a desktop the group header carries it.
                              <span className="sm:hidden">{pos}</span>
                            )}
                          </Td>
                          <Td data-label="" className="ff-row-head whitespace-nowrap">
                            <button onClick={() => onPlayer(s.player_id)} className="text-left text-gray-100 hover:text-indigo-300 hover:underline">
                              {s.name}
                            </button>
                            <span className="ml-1.5 text-xs text-gray-500">
                              {pos}
                              {s.team ? ` · ${s.team}` : ""}
                            </span>
                            {s.note && <NoteLine note={s.note} className="whitespace-normal" />}
                          </Td>
                          <Td data-label="Rank" className="whitespace-nowrap text-xs tabular-nums text-gray-300">
                            {s.rank ? `${pos}${s.rank.median}` : "—"}
                          </Td>
                          <Td data-label="Proj" className="whitespace-nowrap text-right tabular-nums text-gray-100">
                            {s.proj.rotowire != null ? s.proj.rotowire.toFixed(1) : "—"}
                          </Td>
                          <Td data-label="Matchup" className="whitespace-nowrap text-xs tabular-nums">
                            <MatchupCell matchup={s.matchup} position={pos} />
                          </Td>
                          <Td data-label="Sites say" className="text-xs sm:min-w-[13rem]">
                            {s.claims ? (
                              <div>
                                <span className="inline-flex flex-wrap gap-1">
                                  {Object.entries(s.claims.by_action)
                                    .sort((x, y) => y[1] - x[1])
                                    .slice(0, 2)
                                    .map(([a, n]) => (
                                      <Badge key={a} tone={ACTION_TONE[a] ?? "neutral"}>
                                        {a}
                                        {n > 1 ? ` ×${n}` : ""}
                                      </Badge>
                                    ))}
                                </span>
                                {s.claims.evidence[0] && <div className="mt-0.5 max-w-[24rem] text-[11px] text-gray-500">{s.claims.evidence[0].rationale}</div>}
                              </div>
                            ) : (
                              <span className="text-gray-700">quiet</span>
                            )}
                          </Td>
                        </tr>
                      ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <p className="text-[11px] text-gray-600">{data.note}</p>
      <p className="text-[11px] text-gray-600">{data.context_note}</p>
    </div>
  );
}
