import { useEffect, useState } from "react";
import { Badge, Card, FoldToggle, StatTile, Td, Th } from "./viz";
import { ACTION_TONE, srcShort } from "./labels";
import { NoteLine, type Note } from "./NoteLine";
import WaiversTab from "./WaiversTab";
import { Select } from "./Select";

/**
 * Moves — add / drop / claim / stash, in one place.
 *
 * Each candidate row carries the four things that used to live on four
 * tabs: lineup gain and FAAB price (the waiver engine), consensus rank and
 * what the sites say (the content layer), and crowd velocity (Sleeper adds,
 * ESPN ownership). Gain decides; the rest annotates. The full engine — price
 * table, rivals' budgets, burn curves, the searchable board — is one fold
 * away at the bottom, unchanged.
 *
 * For the dynasty league the rank column is rest-of-season and the board is
 * ordered by rest-of-season points; a this-week gain is not the question.
 */

type Rank = { median: number; best: number; worst: number; spread: number; n: number } | null;
type Overlay = {
  rank: Rank;
  delta: number | null;
  ranks: Record<string, number>;
  claims: { n: number; n_sources: number; net: number; by_action: Record<string, number>; by_horizon: Record<string, number>; evidence: { action: string; horizon: string; rationale: string; source: string }[] } | null;
  crowd: { verdict: string | null; why: string | null; adds_24: number | null; pct_owned: number | null } | null;
  note: Note;
} | null;

type Move = {
  player_id: string;
  name: string;
  position: string;
  team: string | null;
  injury_status: string | null;
  projected: number;
  ros_points: number | null;
  gain: number;
  drop: { player_id: string; name: string; position: string; projected: number } | null;
  availability: string;
  clears_at: string | null;
  suggested_pct: number | null;
  why: string;
  overlay: Overlay;
};

type Cand = {
  player_id: string;
  name: string;
  position: string;
  team: string | null;
  injury_status: string | null;
  projected: number | null;
  ros_points: number | null;
  bar: number | null;
  over_bar: number | null;
  displaces: { slot: string; name: string; points: number } | null;
  availability: string;
  clears_at: string | null;
  bid_applies: boolean;
  market_low: number | null;
  market_high: number | null;
  overlay: Overlay;
};

type Drop = { player_id: string; name: string; position: string; team: string | null; projected: number | null; overlay: Overlay; drop_talk: number; hold_talk: number };
type Stash = { kind: "contingent" | "stash_talk"; player_id?: string; name?: string; position?: string; team?: string | null; rank?: Rank; overlay: Overlay; [k: string]: unknown };
type Crowd = { player_id: string; name: string; position: string | null; team: string | null; availability: string; verdict: string; why: string | null; overlay: Overlay };

/** A player released by the roster chopped last week (guillotine only). */
type Released = {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  injury_status: string | null;
  claimed_by: string | null;
  claimed_by_me: boolean;
  board: null | {
    projected: number | null;
    bar: number | null;
    over_bar: number | null;
    displaces: { slot: string; name: string; points: number } | null;
    availability: string | null;
    clears_at: string | null;
    bid_applies: boolean;
    suggested_bid: number | null;
    suggested_pct: number | null;
    market_bid_if_contested: number | null;
    tier: string | null;
    tier_p90: number | null;
    tier_n: number | null;
    tier_thin: boolean | null;
    ros_points: number | null;
    no_bid_reason: string | null;
  };
  guidance: null | {
    band: "alpha" | "average" | "conservative" | "token";
    band_pct: number;
    ceiling: number;
    market_p75: number | null;
    market_p90: number | null;
    tier_n: number | null;
    tier_thin: boolean | null;
    board_suggested: number | null;
    bid: number | null;
    bid_pct_of_budget: number | null;
    bid_pct_of_mine: number | null;
    rivals_who_can_outbid: number;
    rivals_flush: number;
    why: string[];
  };
};

type Chopped =
  | {
      week: number | null;
      eliminated: string[];
      budget: number;
      my_budget_left: number;
      rivals_flush: number;
      rivals_alive: number;
      players: Released[];
      bands: Record<string, number>;
      note: string;
    }
  | { week: null; players: []; note: string };

type Guillotine = {
  chopped: Chopped;
  qb_premium: {
    superflex: boolean;
    teams: number;
    qb_starters_max: number;
    nfl_starting_jobs: number;
    qb_vs_rb: number | null;
    qb_replacement: number | null;
    rb_replacement: number | null;
    note: string;
  };
} | null;

const BAND_TONE: Record<NonNullable<Released["guidance"]>["band"], "critical" | "warning" | "info" | "neutral"> = {
  alpha: "critical",
  average: "warning",
  conservative: "info",
  token: "neutral",
};

type Data = {
  week: number;
  guillotine?: Guillotine;
  horizon: "week" | "ros";
  rank_scope: string;
  lineup_total: number | null;
  budget: number | null;
  add_now: Move[];
  claim_wednesday: Move[];
  board: Cand[];
  drops: Drop[];
  stash: Stash[];
  crowd: Crowd[];
  notes: { inference: string | null; method: string | null };
  note_hours: number;
  error?: string;
};


export default function MovesTab({ league, onPlayer }: { league: string; onPlayer: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showEngine, setShowEngine] = useState(false);
  const [boardPos, setBoardPos] = useState("");
  const [allMoves, setAllMoves] = useState(false);
  const [allBoard, setAllBoard] = useState(false);
  const [allStash, setAllStash] = useState(false);

  useEffect(() => {
    setData(null);
    fetch(`/api/fantasy/moves?league=${encodeURIComponent(league)}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : (setErr(null), setData(d))))
      .catch((e) => setErr(String(e)));
  }, [league]);

  if (err) return <div className="p-6 text-sm text-red-400">{err}</div>;
  if (!data) return <div className="p-6 text-sm text-gray-500">Loading…</div>;

  const Name = ({ id, name, pos, team, inj }: { id: string; name: string; pos?: string | null; team?: string | null; inj?: string | null }) => (
    <>
      <button onClick={() => onPlayer(id)} className="text-left text-gray-100 hover:text-indigo-300 hover:underline">
        {name}
      </button>
      <span className="ml-1.5 text-xs text-gray-500">
        {pos}
        {team ? ` · ${team}` : ""}
      </span>
      {inj && (
        <>
          {" "}
          <Badge tone="warning">{inj}</Badge>
        </>
      )}
    </>
  );

  const Rank = ({ o }: { o: Overlay }) =>
    o?.rank ? (
      <span className="whitespace-nowrap tabular-nums text-gray-300" title={Object.entries(o.ranks).map(([s, v]) => `${srcShort(s)} ${v}`).join(", ")}>
        {o.rank.median}
        <span className="text-gray-600"> ({o.rank.best}–{o.rank.worst})</span>
        {o.delta != null && o.delta !== 0 && <span className={o.delta > 0 ? "text-green-400" : "text-red-400"}> {o.delta > 0 ? "▲" : "▼"}{Math.abs(o.delta)}</span>}
      </span>
    ) : (
      <span className="text-gray-700">—</span>
    );

  // The newest injury / out / role / return wire note rides in the Sites
  // cell (same shape as Lineup's NoteLine) so no table gains a column.
  const Sites = ({ o }: { o: Overlay }) =>
    o?.claims ? (
      <span>
        <span className="inline-flex flex-wrap gap-1">
          {Object.entries(o.claims.by_action)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([a, n]) => (
              <Badge key={a} tone={ACTION_TONE[a] ?? "neutral"}>
                {a}
                {n > 1 ? ` ×${n}` : ""}
              </Badge>
            ))}
          <span className="text-[11px] text-gray-600">{o.claims.n_sources} {o.claims.n_sources === 1 ? "site" : "sites"}</span>
        </span>
        {o.claims.evidence[0] && (
          <div className="mt-0.5 max-w-[26rem] text-[11px] text-gray-500">
            <span className="text-gray-600">{srcShort(o.claims.evidence[0].source)}:</span> {o.claims.evidence[0].rationale}
          </div>
        )}
        <NoteLine note={o.note} />
      </span>
    ) : o?.note ? (
      <span>
        <NoteLine note={o.note} className="max-w-[26rem] whitespace-normal text-[11px] font-normal text-gray-400" />
      </span>
    ) : (
      <span className="text-xs text-gray-700">quiet</span>
    );

  const CrowdCell = ({ o }: { o: Overlay }) =>
    o?.crowd?.verdict ? (
      <span className="text-xs" title={o.crowd.why ?? ""}>
        <Badge tone={o.crowd.verdict.startsWith("move now") ? "critical" : o.crowd.verdict.startsWith("rising") ? "info" : o.crowd.verdict.startsWith("your league") ? "warning" : "neutral"}>
          {o.crowd.verdict}
        </Badge>
        {o.crowd.pct_owned != null && <span className="ml-1 text-gray-600">{o.crowd.pct_owned}% owned</span>}
      </span>
    ) : (
      <span className="text-xs text-gray-700">—</span>
    );

  const MOVES_SHOWN = 5;
  const BOARD_SHOWN = 8;
  const STASH_SHOWN = 3;
  const movesAll = [...data.add_now, ...data.claim_wednesday];
  // The engine's add/drop pairs used to be their own table above the board,
  // which showed the same players twice. They are now a column on the board.
  const moveById = new Map<string, Move>();
  for (const m of movesAll) if (!moveById.has(m.player_id)) moveById.set(m.player_id, m);
  const MoveCell = ({ m }: { m: Move | null }) =>
    m ? (
      <div>
        {m.availability === "free_agent" ? <Badge tone="good">add now</Badge> : <Badge tone="warning">claim</Badge>}
        <span className="ml-1 tabular-nums text-green-400">+{m.gain.toFixed(1)}</span>
        <div className="text-gray-500">
          {m.drop && !sharedDrop && (
            <>
              drop {m.drop.name} <span className="text-gray-600">({m.drop.projected.toFixed(1)})</span>
            </>
          )}
          {m.availability !== "free_agent" && (
            <>
              {m.drop && !sharedDrop ? " · " : ""}
              {m.clears_at ?? ""}
              {m.suggested_pct != null && <> · bid {m.suggested_pct}%</>}
            </>
          )}
        </div>
      </div>
    ) : (
      <span className="text-gray-700" title="does not improve your starting lineup">—</span>
    );
  // Thirteen rows all dropping the same bench player is one fact, not a column.
  const firstDrop = movesAll[0]?.drop ?? null;
  const sharedDrop =
    movesAll.length > 1 && firstDrop && movesAll.every((m) => m.drop?.player_id === firstDrop.player_id) ? firstDrop : null;
  // Rest-of-season points put five team defences above every skill player on
  // the dynasty board; nobody is stashing a kicker for 2027.
  const boardPool = data.horizon === "ros" ? data.board.filter((c) => c.position !== "DEF" && c.position !== "K") : data.board;
  const boardAll = boardPool
    .filter((c) => !boardPos || c.position === boardPos)
    .sort((x, y) => (moveById.has(y.player_id) ? 1 : 0) - (moveById.has(x.player_id) ? 1 : 0));
  const board = allBoard ? boardAll : boardAll.slice(0, BOARD_SHOWN);
  const positions = Array.from(new Set(boardPool.map((c) => c.position))).sort();
  // "FLEX Kayshon Boutte (7.0)" on 35 of 40 rows made an 80px column four
  // lines tall. The value most rows share is stated once in the subtitle and
  // only the exceptions say who they would push out, under the name.
  const displacesKey = (d: Cand["displaces"]) => (d ? `${d.slot} ${d.name}` : "");
  const displacesCount = new Map<string, number>();
  for (const c of boardAll) if (c.displaces) displacesCount.set(displacesKey(c.displaces), (displacesCount.get(displacesKey(c.displaces)) ?? 0) + 1);
  const commonKey = [...displacesCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const sharedDisplaces =
    data.horizon !== "ros" && commonKey && boardAll.length > 1 && commonKey[1] * 2 >= boardAll.length
      ? boardAll.find((c) => displacesKey(c.displaces) === commonKey[0])?.displaces ?? null
      : null;
  const isException = (c: Cand) => sharedDisplaces != null && displacesKey(c.displaces) !== displacesKey(sharedDisplaces);
  const stash = allStash ? data.stash : data.stash.slice(0, STASH_SHOWN);

  // Guillotine: last week's chopped roster is the week's market, priced by
  // the same board as the fold and capped by the FantasyLife bands.
  const g = data.guillotine ?? null;
  const chopped = g?.chopped ?? null;
  const choppedFull = chopped && chopped.week != null && "eliminated" in chopped ? chopped : null;

  const Fate = ({ p }: { p: Released }) =>
    p.claimed_by != null ? (
      <Badge tone="neutral">claimed by {p.claimed_by_me ? "you" : p.claimed_by}</Badge>
    ) : p.board == null ? (
      <span className="text-gray-600">unpriced</span>
    ) : p.board.availability === "free_agent" ? (
      <span className="text-green-400">free agent</span>
    ) : (
      <span className="text-gray-400">on waivers{p.board.clears_at ? ` until ${p.board.clears_at}` : ""}</span>
    );

  return (
    <div className="space-y-4">
      {g && chopped && (
        <Card
          title="Chopped roster"
          subtitle={
            choppedFull
              ? `week ${choppedFull.week} chop: ${choppedFull.eliminated.join(", ")} · your budget left $${choppedFull.my_budget_left} of $${choppedFull.budget} · ${choppedFull.rivals_flush} of ${choppedFull.rivals_alive} rivals still hold 50%+`
              : undefined
          }
        >
          {chopped.players.length === 0 ? (
            <p className="text-xs text-gray-600">{chopped.note}</p>
          ) : (
            <>
              <div className="ff-stack-wrap overflow-x-auto">
                <table className="ff-stack w-full">
                  <thead>
                    <tr>
                      <Th>Player</Th>
                      <Th>Fate</Th>
                      <Th className="text-right">Proj</Th>
                      <Th className="text-right">Bid</Th>
                      <Th>Rivals</Th>
                      <Th>Why</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {chopped.players.map((p) => (
                      <tr key={p.player_id} className="border-t border-gray-800/60 align-top">
                        <Td data-label="" className="ff-row-head whitespace-nowrap">
                          <Name id={p.player_id} name={p.name} pos={p.position} team={p.team} inj={p.injury_status} />
                        </Td>
                        <Td data-label="Fate" className="text-xs">
                          <Fate p={p} />
                        </Td>
                        <Td data-label="Proj" className="whitespace-nowrap text-right tabular-nums">
                          {p.board?.projected != null ? (
                            <span>
                              <span className="text-gray-200">{p.board.projected.toFixed(1)}</span>
                              {p.board.over_bar != null && (
                                <span className="ml-1 text-[11px] text-gray-500">
                                  ({p.board.over_bar >= 0 ? "+" : ""}
                                  {p.board.over_bar.toFixed(1)})
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="text-gray-700">—</span>
                          )}
                        </Td>
                        <Td data-label="Bid" className="text-right text-xs">
                          {p.guidance?.bid != null ? (
                            <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5 gap-y-0.5">
                              <span className="font-semibold tabular-nums text-gray-100">${p.guidance.bid}</span>
                              {p.guidance.bid_pct_of_budget != null && <span className="text-gray-500">{p.guidance.bid_pct_of_budget}% of budget</span>}
                              <Badge tone={BAND_TONE[p.guidance.band]}>{p.guidance.band}</Badge>
                            </span>
                          ) : (
                            <span className="text-gray-700">—</span>
                          )}
                        </Td>
                        <Td data-label="Rivals" className="whitespace-nowrap text-xs text-gray-400">
                          {p.guidance ? `${p.guidance.rivals_who_can_outbid} can outbid` : "—"}
                        </Td>
                        <Td data-label="Why" className="text-[11px] text-gray-500">
                          {p.guidance && p.guidance.why.length > 0 ? (
                            <div className="max-w-[26rem]">
                              {p.guidance.why.map((w, i) => (
                                <div key={i}>{w}</div>
                              ))}
                            </div>
                          ) : (
                            <span className="text-gray-700">—</span>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-gray-600">{chopped.note}</p>
            </>
          )}
        </Card>
      )}

      {g && (
        <Card title="Superflex QB premium">
          <p className="text-sm text-gray-200">
            {g.qb_premium.teams} teams · up to {g.qb_premium.qb_starters_max} QB starters vs {g.qb_premium.nfl_starting_jobs} NFL jobs
            {g.qb_premium.qb_vs_rb != null && <> · QB worth {g.qb_premium.qb_vs_rb}x RB here</>}
          </p>
          <p className="mt-1 text-xs text-gray-500">{g.qb_premium.note}</p>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Lineup now" value={data.lineup_total?.toFixed(1) ?? "—"} hint={`week ${data.week}`} />
        <StatTile
          label="Adds that help"
          value={movesAll.length}
          hint={sharedDrop ? `all for the same drop slot` : "improve your starting lineup"}
          tone={movesAll.length ? "good" : "default"}
        />
        <StatTile label="Drop talk" value={data.drops.filter((d) => d.drop_talk > 0).length} hint="bench players the sites say drop" />
        <StatTile label="Crowd" value={data.crowd.length} hint="actionable demand signals" />
      </div>

      <Card
        title="Board"
        subtitle={
          <>
            {data.horizon === "ros"
              ? "Available players ordered by rest-of-season points under this league's scoring, with the rest-of-season consensus rank. Defences and kickers are left out."
              : "Available players who clear the replacement bar, by projection under this league's scoring."}
            {" "}Move is the engine's call: who to drop for him and whether he is a free add or a Wednesday claim with a bid as percent of budget.
            {sharedDrop && (
              <>
                {" "}Every move here drops <span className="text-gray-300">{sharedDrop.name}</span> ({sharedDrop.projected.toFixed(1)}).
              </>
            )}
            {data.horizon !== "ros" &&
              (sharedDisplaces ? (
                <>
                  {" "}
                  {boardAll.some(isException) ? "Most" : "Everyone"} here would displace{" "}
                  <span className="text-gray-300">{sharedDisplaces.slot} {sharedDisplaces.name}</span> ({sharedDisplaces.points.toFixed(1)})
                  {boardAll.some(isException) ? "; the exceptions say who." : "."}
                </>
              ) : (
                " Displaces says which of your starters he would push out."
              ))}
          </>
        }
        right={
          <Select
            aria-label="Board position"
            size="sm"
            value={boardPos}
            onChange={setBoardPos}
            options={[{ value: "", label: "all positions" }, ...positions.map((p) => ({ value: p, label: p }))]}
          />
        }
      >
        <div className="ff-stack-wrap overflow-x-auto">
          <table className="ff-stack w-full">
            <thead>
              <tr>
                <Th>Player</Th>
                <Th>Move</Th>
                <Th className="text-right">{data.horizon === "ros" ? "ROS pts" : "Proj"}</Th>
                {!sharedDisplaces && <Th>Displaces</Th>}
                <Th>Availability</Th>
                <Th>Rank</Th>
                <Th>Sites say</Th>
                <Th className="hidden xl:table-cell">Crowd</Th>
              </tr>
            </thead>
            <tbody>
              {board.map((c) => (
                <tr key={c.player_id} className="border-t border-gray-800/60 align-top">
                  <Td data-label="" className="ff-row-head whitespace-nowrap">
                    <Name id={c.player_id} name={c.name} pos={c.position} team={c.team} inj={c.injury_status} />
                    {isException(c) && (
                      <div className="text-[11px] font-normal text-gray-500">
                        displaces {c.displaces ? `${c.displaces.slot} ${c.displaces.name} (${c.displaces.points.toFixed(1)})` : "nobody"}
                      </div>
                    )}
                  </Td>
                  <Td data-label="Move" className="text-xs">
                    <MoveCell m={moveById.get(c.player_id) ?? null} />
                  </Td>
                  <Td data-label={data.horizon === "ros" ? "ROS pts" : "Proj"} className="whitespace-nowrap text-right tabular-nums text-gray-200">
                    {data.horizon === "ros" ? (c.ros_points?.toFixed(0) ?? "—") : (c.projected?.toFixed(1) ?? "—")}
                    {data.horizon !== "ros" && c.over_bar != null && <span className="text-[11px] text-green-500"> +{c.over_bar.toFixed(1)}</span>}
                  </Td>
                  {!sharedDisplaces && (
                    <Td data-label="Displaces" className="text-xs text-gray-500">
                      {c.displaces ? `${c.displaces.slot} ${c.displaces.name} (${c.displaces.points.toFixed(1)})` : "—"}
                    </Td>
                  )}
                  <Td data-label="Availability" className="text-xs">
                    {c.availability === "free_agent" ? (
                      <span className="whitespace-nowrap text-green-400">free · add now</span>
                    ) : (
                      <span className="text-gray-400">
                        waivers{c.clears_at ? ` · ${c.clears_at}` : ""}
                        {c.bid_applies && c.market_low != null && <span className="text-gray-500"> · ${c.market_low}–{c.market_high}</span>}
                      </span>
                    )}
                  </Td>
                  <Td data-label="Rank" className="text-xs">
                    <Rank o={c.overlay} />
                  </Td>
                  <Td data-label="Sites say" className="text-xs">
                    <div>
                      <Sites o={c.overlay} />
                      {c.overlay?.crowd?.verdict && (
                        <div className="mt-1 xl:hidden">
                          <CrowdCell o={c.overlay} />
                        </div>
                      )}
                    </div>
                  </Td>
                  <Td data-label="Crowd" className="hidden whitespace-nowrap xl:table-cell">
                    <CrowdCell o={c.overlay} />
                  </Td>
                </tr>
              ))}
              {boardAll.length === 0 && (
                <tr>
                  <Td data-label="" className="text-xs text-gray-600" colSpan={8}>
                    Nobody at this position clears the bar.
                  </Td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <FoldToggle total={boardAll.length} shown={board.length} expanded={allBoard} onToggle={() => setAllBoard((v) => !v)} mode="all" />
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="Drop candidates" subtitle="Your bench, weakest projection first. Drop talk from the sites is called out; hold or stash talk argues the other way.">
          <ul className="space-y-1.5">
            {data.drops.map((d) => (
              <li key={d.player_id} className="flex flex-wrap items-baseline gap-2 text-sm">
                <Name id={d.player_id} name={d.name} pos={d.position} team={d.team} />
                <span className="tabular-nums text-xs text-gray-500">{d.projected?.toFixed(1) ?? "0.0"}</span>
                {d.drop_talk > 0 && <Badge tone="critical">drop talk{d.drop_talk > 1 ? ` ×${d.drop_talk}` : ""}</Badge>}
                {d.hold_talk > 0 && <Badge tone="info">hold/stash talk</Badge>}
                <span className="ml-auto text-xs">
                  <Rank o={d.overlay} />
                </span>
                {d.overlay?.note && <NoteLine note={d.overlay.note} className="basis-full whitespace-normal text-[11px] text-gray-400" />}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Stash" subtitle="Contingent value the board would never surface (a handcuff behind a hurt starter) and free agents the sites say stash.">
          {data.stash.length === 0 ? (
            <p className="text-xs text-gray-600">Nothing to stash right now.</p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {stash.map((s, i) => (
                  <li key={`${s.kind}-${s.player_id ?? i}`} className="text-sm">
                    <div className="flex flex-wrap items-baseline gap-2">
                      {s.player_id && s.name ? <Name id={s.player_id} name={s.name} pos={s.position} team={s.team ?? undefined} /> : <span className="text-gray-300">{String(s.name ?? "")}</span>}
                      <Badge tone={s.kind === "contingent" ? "warning" : "info"}>{s.kind === "contingent" ? "contingent" : "stash talk"}</Badge>
                    </div>
                    <div className="text-xs">
                      <Sites o={s.overlay} />
                    </div>
                    {typeof s.why === "string" && <div className="text-xs text-gray-500">{s.why}</div>}
                  </li>
                ))}
              </ul>
              <FoldToggle total={data.stash.length} shown={stash.length} expanded={allStash} onToggle={() => setAllStash((v) => !v)} />
            </>
          )}
        </Card>
      </div>

      <Card title="What the crowd is doing" subtitle="Added by a rival in another of your leagues, rising nationally, or owned everywhere but here. Demand, not production.">
        {data.crowd.length === 0 ? (
          <p className="text-xs text-gray-600">Nothing actionable.</p>
        ) : (
          <ul className="space-y-1.5">
            {data.crowd.map((c) => (
              <li key={c.player_id} className="text-sm">
                <div className="flex flex-wrap items-baseline gap-2">
                  <Name id={c.player_id} name={c.name} pos={c.position} team={c.team} />
                  <CrowdCell o={c.overlay} />
                </div>
                {/* Sites on their own line: as an ml-auto tail they wrapped
                    first and left the why-text stranded under a gap. */}
                <div className="text-xs">
                  <Sites o={c.overlay} />
                </div>
                {c.why && <div className="text-xs text-gray-500">{c.why}</div>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="rounded-lg border border-gray-800">
        <button onClick={() => setShowEngine((v) => !v)} className="flex w-full items-center justify-between px-4 py-3 text-left text-sm text-gray-300 hover:text-gray-100">
          <span>
            Full waiver engine and market
            <span className="ml-2 text-xs text-gray-500">price table · rivals' budgets · burn curves · searchable board · roster</span>
          </span>
          <span className="text-xs text-gray-500">{showEngine ? "hide" : "show"}</span>
        </button>
        {showEngine && (
          <div className="border-t border-gray-800 p-3">
            <WaiversTab league={league} key={`w-${league}`} />
          </div>
        )}
      </div>
      {data.notes.inference && <p className="text-[11px] text-gray-600">{data.notes.inference}</p>}
    </div>
  );
}
