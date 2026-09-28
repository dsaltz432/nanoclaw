import { useEffect, useState, type ReactNode } from "react";
import { Badge, Card, ErrorBox, FoldToggle, Loading, MetaLine, Note, QuietLine, Td, Th, useIsNarrow } from "./viz";
import { Select } from "./Select";
import { fmtDateTime, signed } from "./labels";
import { ClaimQuote, ClaimsSummary, NoteLine, PlayerName, RankText, type Claim, type Note as WireNote } from "./NoteLine";
import FaabMarket, { type Market } from "./WaiversTab";

/**
 * Moves — add / drop / claim / stash, in one place.
 *
 * The Board is the only add/drop list. Each row carries lineup gain and FAAB
 * price (the waiver engine), consensus rank and what the sites say (the
 * content layer), and crowd demand (Sleeper adds, ESPN ownership) as a line
 * under the name. Gain decides; the rest annotates. Availability owns when he
 * can be had and what his tier costs; Move owns the engine's call and the bid
 * in dollars. The FAAB market reference (price table, rivals' budgets, burn
 * curves) is one collapsible card at the bottom.
 *
 * For the dynasty league the rank column is rest-of-season and the board is
 * ordered by rest-of-season points; a this-week gain is not the question.
 */

type Rank = { median: number; best: number; worst: number } | null;
type Overlay = {
  rank: Rank;
  delta: number | null;
  claims: { n_sources: number; by_action: Record<string, number>; evidence: Claim[] } | null;
  crowd: { verdict: string | null; why: string | null; pct_owned: number | null } | null;
  note: WireNote;
} | null;

/** An add the engine pairs with a drop; keyed onto the Board row it belongs to. */
type Move = {
  player_id: string;
  gain: number;
  drop: { player_id: string; name: string; projected: number | null } | null;
  availability: string;
  suggested_bid: number | null;
  suggested_pct: number | null;
};

type Displaces = { slot: string; name: string | null; points: number } | null;

type Cand = {
  player_id: string;
  name: string;
  position: string;
  team: string | null;
  injury_status: string | null;
  projected: number | null;
  ros_points: number | null;
  over_bar: number | null;
  displaces: Displaces;
  availability: string;
  clears_at_iso: string | null;
  bid_applies: boolean;
  tier: string | null;
  market_low: number | null;
  market_high: number | null;
  overlay: Overlay;
};

type Drop = {
  player_id: string;
  name: string;
  position: string;
  team: string | null;
  injury_status: string | null;
  projected: number | null;
  ros_points?: number | null;
  /** Out / IR / Doubtful: projects near zero because he is hurt, not because he is weak. */
  hurt?: boolean;
  overlay: Overlay;
  drop_talk: number;
  hold_talk: number;
};
type Stash = {
  kind: "contingent" | "stash_talk";
  player_id?: string;
  name?: string;
  position?: string;
  team?: string | null;
  /** Contingent only: "if X is ruled out", and the engine's arithmetic behind it. */
  trigger?: string;
  reasoning?: string;
  overlay: Overlay;
};
type Crowd = { player_id: string; name: string; position: string | null; team: string | null; why: string | null; overlay: Overlay };

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
    over_bar: number | null;
    availability: string | null;
    clears_at_iso: string | null;
  };
  guidance: null | {
    band: "alpha" | "average" | "conservative" | "token";
    bid: number | null;
    bid_pct_of_budget: number | null;
    rivals_who_can_outbid: number;
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
      note: string;
    }
  | { week: null; players: []; note: string };

type Guillotine = {
  chopped: Chopped;
  qb_premium: { qb_vs_rb: number | null; note: string };
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
  budget: number | null;
  add_now: Move[];
  claim_wednesday: Move[];
  board: Cand[];
  drops: Drop[];
  stash: Stash[];
  crowd: Crowd[];
  market?: Market;
  notes: { inference: string | null };
  error?: string;
};

const BOARD_SHOWN = 15;
const STASH_SHOWN = 3;
const CHOPPED_SHOWN = 8;

/** FLEX is a filter, not a position: anyone who could fill a flex slot. */
const FLEX_MEMBERS = ["RB", "WR", "TE"];
const POSITION_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];

/** Points over the replacement bar: green when he clears it, gray when he does not. */
function OverBar({ v }: { v: number | null | undefined }) {
  if (v == null) return null;
  return <span className={`ml-1 whitespace-nowrap text-[11px] ${v > 0 ? "text-green-400" : "text-gray-500"}`}>{signed(v)}</span>;
}

/** Whether the overlay has anything the sites said: a claim or a wire note. */
const hasSites = (o: Overlay) => !!(o?.claims || o?.note);

/** What the sites say, the newest quote, and the newest wire note. */
function Sites({ o }: { o: Overlay }) {
  if (!hasSites(o)) return <span className="text-xs text-gray-700">quiet</span>;
  return (
    <div className="min-w-0">
      {o?.claims && (
        <>
          <ClaimsSummary byAction={o.claims.by_action} nSources={o.claims.n_sources} />
          {o.claims.evidence[0] && (
            <div className="mt-0.5 max-w-[26rem]">
              <ClaimQuote e={o.claims.evidence[0]} />
            </div>
          )}
        </>
      )}
      <NoteLine note={o?.note ?? null} />
    </div>
  );
}

function crowdTone(verdict: string): "warning" | "info" | "neutral" {
  if (verdict.startsWith("move now")) return "warning";
  if (verdict.startsWith("rising")) return "info";
  return "neutral";
}

/** Demand, not production: the crowd verdict and how widely he is owned. `why` goes in the tooltip. */
function CrowdBadge({ o, withWhy = true }: { o: Overlay; withWhy?: boolean }) {
  if (!o?.crowd?.verdict) return null;
  return (
    <span className="whitespace-nowrap text-xs" title={withWhy ? o.crowd.why ?? undefined : undefined}>
      <Badge tone={crowdTone(o.crowd.verdict)}>{o.crowd.verdict}</Badge>
      {o.crowd.pct_owned != null && <span className="ml-1 text-gray-600">{o.crowd.pct_owned}% owned</span>}
    </span>
  );
}

/** A bid in dollars (what you type in Sleeper), its share of the budget in the tooltip. */
function Bid({ bid, pct, budget }: { bid: number; pct: number | null; budget: number | null }) {
  const share = pct ?? (budget ? (100 * bid) / budget : null);
  return (
    <span
      className="whitespace-nowrap tabular-nums"
      title={share != null ? `${+share.toFixed(1)}% of the${budget != null ? ` $${budget}` : ""} budget` : undefined}
    >
      bid ${bid}
    </span>
  );
}

const moveBadge = (m: Move) =>
  m.availability === "free_agent" ? <Badge tone="good">add now</Badge> : <Badge tone="warning">claim</Badge>;

/**
 * The engine's add/drop call for a Board row: the badge, the lineup gain, the
 * drop and the bid. When he clears waivers is Availability's, and a drop
 * every move shares (`sharedDrop`) is said once in the subtitle.
 */
function MoveCell({
  m,
  sharedDrop,
  budget,
  onPlayer,
}: {
  m: Move | null;
  sharedDrop: boolean;
  budget: number | null;
  onPlayer: (id: string) => void;
}) {
  if (!m) return <span className="text-gray-700" title="does not improve your starting lineup">—</span>;
  return (
    <div>
      {moveBadge(m)}
      <span className="ml-1 tabular-nums text-green-400">{signed(m.gain)}</span>
      <MetaLine className="mt-0.5">
        {m.drop && !sharedDrop && (
          <span>
            drop <PlayerName id={m.drop.player_id} name={m.drop.name} onPlayer={onPlayer} />
            {m.drop.projected != null && ` (${m.drop.projected.toFixed(1)})`}
          </span>
        )}
        {m.availability !== "free_agent" && m.suggested_bid != null && (
          <Bid bid={m.suggested_bid} pct={m.suggested_pct} budget={budget} />
        )}
      </MetaLine>
    </div>
  );
}

/** Free now, or on waivers: when he clears and what his tier has cost here. */
function Availability({ c }: { c: Cand }) {
  if (c.availability === "free_agent") return <span className="text-green-400">free</span>;
  return (
    <div className="text-gray-400">
      waivers
      {c.clears_at_iso && (
        <div className="whitespace-nowrap text-gray-500" title="when his waiver period clears">
          {fmtDateTime(c.clears_at_iso)}
        </div>
      )}
      {c.bid_applies && c.market_low != null && c.market_high != null && (
        <div
          className="whitespace-nowrap tabular-nums text-gray-600"
          title={`What ${c.tier ? `the ${c.tier} tier` : "his tier"} has gone for in this league: $${c.market_low} median, $${c.market_high} p75. A market price, not a bid.`}
        >
          ${c.market_low}–{c.market_high}
        </div>
      )}
    </div>
  );
}

/** Where an unclaimed released player stands now. */
function Fate({ p }: { p: Released }) {
  if (p.board == null) return <span className="text-gray-600">unpriced</span>;
  if (p.board.availability === "free_agent") return <span className="text-green-400">free agent</span>;
  const until = fmtDateTime(p.board.clears_at_iso);
  return <span className="text-gray-400">on waivers{until ? ` until ${until}` : ""}</span>;
}

const displacesText = (d: Displaces) => (d ? `${d.slot} ${d.name ?? "an empty slot"} (${d.points.toFixed(1)})` : "nobody");

export default function MovesTab({ league, onPlayer }: { league: string; onPlayer: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [boardPos, setBoardPos] = useState<string | null>(null);
  const narrow = useIsNarrow();
  const [query, setQuery] = useState("");
  // Default off: of ~150 available players most would not start for you,
  // and showing them by default buries the handful that would.
  const [includeAll, setIncludeAll] = useState(false);
  const [allBoard, setAllBoard] = useState(false);
  const [allStash, setAllStash] = useState(false);
  const [allChopped, setAllChopped] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/fantasy/moves?league=${encodeURIComponent(league)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) setErr(d.error);
        else setData(d);
      })
      .catch((e) => !cancelled && setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [league]);

  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!data) return <Loading label="Loading moves…" rows={6} />;

  const weekly = data.horizon !== "ros";
  const movesAll = [...data.add_now, ...data.claim_wednesday];
  const moveById = new Map<string, Move>();
  for (const m of movesAll) if (!moveById.has(m.player_id)) moveById.set(m.player_id, m);
  // Thirteen rows all dropping the same bench player is one fact, not a column.
  const firstDrop = movesAll[0]?.drop ?? null;
  const sharedDrop =
    movesAll.length > 1 && firstDrop && movesAll.every((m) => m.drop?.player_id === firstDrop.player_id) ? firstDrop : null;

  // Rest-of-season points put five team defences above every skill player on
  // the dynasty board; nobody is stashing a kicker for 2027.
  const boardPool = weekly ? data.board : data.board.filter((c) => c.position !== "DEF" && c.position !== "K");
  const present = new Set(boardPool.map((c) => c.position));
  const positions = [
    ...(FLEX_MEMBERS.some((p) => present.has(p)) ? ["FLEX"] : []),
    ...POSITION_ORDER.filter((p) => present.has(p)),
  ];
  const wanted = boardPos === "FLEX" ? FLEX_MEMBERS : boardPos ? [boardPos] : null;

  // The board's controls. Desktop: search, position chips and the include
  // toggle in the card header. Phone: the toggle beside the title ("Non-
  // starters"), and search with a position dropdown on one row under it;
  // seven chips and a full-width search were three rows before any player.
  const includeToggle = (
    <label className="flex items-center gap-1.5 whitespace-nowrap text-xs text-gray-400 sm:ml-auto">
      <input
        type="checkbox"
        checked={includeAll}
        onChange={(e) => setIncludeAll(e.target.checked)}
        disabled={!!query.trim()}
        className="accent-indigo-500"
      />
      {narrow ? "Non-starters" : <>Include players who wouldn&rsquo;t start</>}
    </label>
  );
  const boardControls = (
    <div className="flex flex-wrap items-center gap-2 sm:justify-end">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search the board…"
        aria-label="Search the board by name or team"
        className="min-w-0 flex-1 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-sm text-gray-100 placeholder:text-gray-600 sm:w-44 sm:flex-none"
      />
      {narrow ? (
        <Select
          aria-label="Position"
          label="Pos"
          value={boardPos ?? ""}
          onChange={(v) => setBoardPos(v || null)}
          options={[{ value: "", label: "All" }, ...positions.map((p) => ({ value: p, label: p }))]}
        />
      ) : (
        <div role="group" aria-label="Position" className="flex flex-wrap gap-1">
          {[null, ...positions].map((p) => (
            <button
              key={p ?? "all"}
              type="button"
              onClick={() => setBoardPos(p)}
              aria-pressed={boardPos === p}
              title={p === "FLEX" ? "RB, WR and TE: anyone who can fill a flex slot" : undefined}
              className={`min-w-[2.25rem] rounded px-2 py-1 text-center text-xs font-medium ring-1 ring-inset transition-colors ${
                boardPos === p
                  ? "bg-indigo-500/15 text-indigo-300 ring-indigo-500/40"
                  : "bg-gray-800 text-gray-400 ring-gray-700 hover:text-gray-200"
              }`}
            >
              {p ?? "All"}
            </button>
          ))}
        </div>
      )}
      {!narrow && weekly && includeToggle}
    </div>
  );
  const q = query.trim().toLowerCase();
  // "Would start" is a this-week question, so the filter applies only to a
  // weekly board; the dynasty board is a rest-of-season shopping list. A name
  // search is an explicit request for that player and overrides it.
  const wouldStart = (c: Cand) => moveById.has(c.player_id) || (c.over_bar ?? 0) > 0;
  const boardAll = boardPool
    .filter((c) => !wanted || wanted.includes(c.position))
    .filter((c) => (q ? `${c.name} ${c.team ?? ""}`.toLowerCase().includes(q) : !weekly || includeAll || wouldStart(c)))
    .sort((x, y) => (moveById.has(y.player_id) ? 1 : 0) - (moveById.has(x.player_id) ? 1 : 0));
  const board = allBoard ? boardAll : boardAll.slice(0, BOARD_SHOWN);
  const showMove = movesAll.length > 0;

  // "FLEX Kayshon Boutte (7.0)" on 35 of 40 rows made a column four lines
  // tall. The value most rows share is stated once in the subtitle and only
  // the exceptions say who they would push out, under the name. With no
  // majority, every row says it there.
  const displacesKey = (d: Displaces) => (d ? `${d.slot} ${d.name}` : "");
  const displacesCount = new Map<string, number>();
  for (const c of boardAll) if (c.displaces) displacesCount.set(displacesKey(c.displaces), (displacesCount.get(displacesKey(c.displaces)) ?? 0) + 1);
  const commonKey = [...displacesCount.entries()].sort((a, b) => b[1] - a[1])[0];
  const sharedDisplaces =
    weekly && commonKey && boardAll.length > 1 && commonKey[1] * 2 >= boardAll.length
      ? boardAll.find((c) => displacesKey(c.displaces) === commonKey[0])?.displaces ?? null
      : null;
  const isException = (c: Cand) => sharedDisplaces != null && displacesKey(c.displaces) !== displacesKey(sharedDisplaces);
  const displacesLine = (c: Cand) => weekly && c.displaces != null && (sharedDisplaces == null || isException(c));

  const stash = allStash ? data.stash : data.stash.slice(0, STASH_SHOWN);

  // Guillotine: last week's chopped roster is the week's market, priced by
  // the same board rows and capped by the FantasyLife bands.
  const g = data.guillotine ?? null;
  const chopped = g?.chopped ?? null;
  const choppedFull = chopped && chopped.week != null && "eliminated" in chopped ? chopped : null;
  const unclaimed = chopped ? chopped.players.filter((p) => p.claimed_by == null) : [];
  const claimed = chopped ? chopped.players.filter((p) => p.claimed_by != null) : [];
  const choppedRows = allChopped ? unclaimed : unclaimed.slice(0, CHOPPED_SHOWN);
  const qbVsRb = g?.qb_premium.qb_vs_rb;
  // A bid, rivals and reasons only mean something while he is on waivers; a
  // free agent's Fate already says everything ("free agent"), and an
  // unpriced one has no market to reason from.
  const biddable = (p: Released) => p.board?.availability === "waivers" && p.guidance != null;
  // The chop is this week's market only while a released player is still on
  // waivers; once they have all cleared or been claimed it is history and
  // goes below the Board.
  const choppedLive = unclaimed.some((p) => p.board?.availability === "waivers");
  // With nobody left to bid on, Bid, Rivals and Why would be a column of dashes each.
  const anyBid = choppedRows.some(biddable);

  const empty = q
    ? `No match for “${query.trim()}” among the ${boardPool.length} priced available players${boardPos ? ` at ${boardPos}` : ""}.`
    : weekly && !includeAll
      ? "Nobody available would start for you this week."
      : "No available player at this position.";

  let choppedCard: ReactNode = null;
  if (g && chopped && chopped.players.length === 0) choppedCard = <QuietLine title="Chopped roster">{chopped.note}</QuietLine>;
  else if (g && chopped)
    choppedCard = (
      <Card
        title="Chopped roster"
        subtitle={
          choppedFull
            ? `week ${choppedFull.week} chop: ${choppedFull.eliminated.join(", ")} · your budget left $${choppedFull.my_budget_left} of $${choppedFull.budget} · ${choppedFull.rivals_flush} of ${choppedFull.rivals_alive} rivals still hold 50%+${qbVsRb != null ? ` · QB worth ${qbVsRb}x RB here` : ""}`
            : qbVsRb != null
              ? `QB worth ${qbVsRb}x RB here`
              : undefined
        }
      >
        <Note>{chopped.note}</Note>
        <Note>{g.qb_premium.note}</Note>
        {unclaimed.length > 0 ? (
          <div className="ff-stack-wrap overflow-x-auto">
            {/* On a phone the row head is the whole row but the reasons: name
                and projection, then fate, bid and rivals on one meta line. */}
            <table className="ff-stack w-full">
              <thead>
                <tr>
                  <Th>Player</Th>
                  <Th className="hidden sm:table-cell">Fate</Th>
                  <Th className="hidden text-right sm:table-cell">Proj</Th>
                  {anyBid && (
                    <>
                      <Th className="hidden text-right sm:table-cell">Bid</Th>
                      <Th className="hidden sm:table-cell">Rivals</Th>
                      <Th>Why</Th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {choppedRows.map((p) => {
                  const gd = biddable(p) ? p.guidance : null;
                  const proj = p.board?.projected ?? null;
                  const budget = choppedFull?.budget ?? data.budget;
                  return (
                    <tr key={p.player_id} className="border-t border-gray-800/60 align-top">
                      <Td data-label="" className="ff-row-head">
                        <div className="flex items-baseline gap-2">
                          <div className="min-w-0 flex-1">
                            <PlayerName id={p.player_id} name={p.name} pos={p.position} team={p.team} injury={p.injury_status} onPlayer={onPlayer} />
                          </div>
                          {proj != null && (
                            <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-gray-200 sm:hidden">
                              {proj.toFixed(1)}
                              <OverBar v={p.board?.over_bar} />
                            </span>
                          )}
                        </div>
                        <MetaLine className="mt-0.5 sm:hidden">
                          <span>
                            <Fate p={p} />
                          </span>
                          {gd?.bid != null && (
                            <span className="whitespace-nowrap">
                              <Bid bid={gd.bid} pct={gd.bid_pct_of_budget} budget={budget} />{" "}
                              <Badge tone={BAND_TONE[gd.band]}>{gd.band}</Badge>
                            </span>
                          )}
                          {gd && <span>{gd.rivals_who_can_outbid} can outbid</span>}
                        </MetaLine>
                      </Td>
                      <Td data-label="Fate" className="hidden text-xs sm:table-cell">
                        <Fate p={p} />
                      </Td>
                      <Td data-label="Proj" className="hidden text-right tabular-nums sm:table-cell">
                        {proj != null ? (
                          <>
                            <span className="whitespace-nowrap text-gray-200">{proj.toFixed(1)}</span>
                            <OverBar v={p.board?.over_bar} />
                          </>
                        ) : (
                          <span className="text-gray-700">—</span>
                        )}
                      </Td>
                      {anyBid && (
                        <>
                          <Td data-label="Bid" className="hidden text-right text-xs sm:table-cell">
                            {gd?.bid != null ? (
                              <span className="inline-flex flex-wrap items-baseline justify-end gap-x-1.5 gap-y-0.5">
                                <span
                                  className="font-semibold tabular-nums text-gray-100"
                                  title={gd.bid_pct_of_budget != null ? `${gd.bid_pct_of_budget}% of the $${budget} budget` : undefined}
                                >
                                  ${gd.bid}
                                </span>
                                <Badge tone={BAND_TONE[gd.band]}>{gd.band}</Badge>
                              </span>
                            ) : (
                              <span className="text-gray-700">—</span>
                            )}
                          </Td>
                          <Td data-label="Rivals" className="hidden text-xs text-gray-400 sm:table-cell">
                            {gd ? `${gd.rivals_who_can_outbid} can outbid` : <span className="text-gray-700">—</span>}
                          </Td>
                          <Td data-label="" block empty={!gd?.why.length} className="text-[11px] text-gray-500">
                            {gd && gd.why.length > 0 ? (
                              <div className="max-w-[26rem]">
                                {gd.why.map((w, i) => (
                                  <div key={i}>{w}</div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-gray-700">—</span>
                            )}
                          </Td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-xs text-gray-500">Every released player has been claimed.</p>
        )}
        <FoldToggle total={unclaimed.length} shown={choppedRows.length} expanded={allChopped} onToggle={() => setAllChopped((v) => !v)} />
        {claimed.length > 0 && (
          <p className="mt-2 text-xs text-gray-500">
            <span className="text-gray-400">Already claimed:</span>{" "}
            {claimed.map((p, i) => (
              <span key={p.player_id}>
                {i > 0 && ", "}
                <PlayerName id={p.player_id} name={p.name} onPlayer={onPlayer} /> ({p.claimed_by_me ? "you" : p.claimed_by})
              </span>
            ))}
          </p>
        )}
      </Card>
    );

  return (
    <div className="space-y-4">
      {choppedLive && choppedCard}

      {boardPool.length === 0 ? (
        <QuietLine title="Board">No available players are priced for this league yet.</QuietLine>
      ) : (
        <Card
          title="Board"
          info={
            weekly
              ? "Available players, closest to your lineup first, projected under this league's scoring."
              : "Available players by rest-of-season points, with the rest-of-season consensus rank."
          }
          subtitle={
            (sharedDrop || sharedDisplaces) && (
              <>
                {sharedDrop && (
                  <>
                    Every move here drops <span className="text-gray-300">{sharedDrop.name}</span>
                    {sharedDrop.projected != null && ` (${sharedDrop.projected.toFixed(1)})`}.
                  </>
                )}
                {sharedDisplaces && (
                  <>
                    {sharedDrop ? " " : ""}
                    {boardAll.some(isException) ? "Most" : "Everyone"} here would displace{" "}
                    <span className="text-gray-300">{displacesText(sharedDisplaces)}</span>
                    {boardAll.some(isException) ? "; the exceptions say who." : "."}
                  </>
                )}
              </>
            )
          }
          // Search, position and the include toggle ride in the header: a row
          // of their own, plus a subtitle and "Lineup now" (which Lineup
          // shows), cost ~110px before the first player. On a phone only the
          // toggle does; search and position are one row under the title.
          rightStacks={!narrow}
          right={narrow ? weekly && includeToggle : boardControls}
        >
          <Note>
            {weekly
              ? "Proj is this week's projection under this league's scoring; the signed number beside it is how far he clears (green) or misses (gray) the replacement bar at your weakest startable slot. The line under a name says which starter he would push out, where that is not the one the subtitle names."
              : "Ordered by rest-of-season points under this league's scoring. Defences and kickers are left out."}{" "}
            Availability says whether he is free now or on waivers, when the waivers clear, and the range his projection
            tier has gone for in this league (median to p75) — a market price, not a bid. Move is the engine's call: a
            free add or a Wednesday claim, the lineup gain, who to drop for him, and the bid in dollars. The crowd badge
            under a name is demand, not production: rivals' adds in your other leagues, national risers, ESPN ownership.
          </Note>
          {data.notes.inference && <Note>{data.notes.inference}</Note>}
          {narrow && <div className="mb-3">{boardControls}</div>}

          {boardAll.length === 0 ? (
            <p className="text-xs text-gray-500">{empty}</p>
          ) : (
            <div className="ff-stack-wrap overflow-x-auto">
              {/* Fixed widths from lg (the desktop card is ~785px) so every
                  column keeps its size whatever the rows hold, and Sites say
                  takes what is left: ~320px, or ~190px with Move shown. On a
                  phone the row head is the whole row but the sites' call: name
                  and the projection, then the move or availability, rank and
                  crowd on one meta line. */}
              <table className="ff-stack w-full lg:table-fixed">
                <thead>
                  <tr>
                    <Th className="w-[24%]">Player</Th>
                    <Th className="hidden w-[5rem] text-right sm:table-cell">{weekly ? "Proj" : "ROS pts"}</Th>
                    <Th className="hidden w-[7rem] sm:table-cell">Availability</Th>
                    {showMove && <Th className="hidden w-[8.5rem] sm:table-cell">Move</Th>}
                    <Th className="hidden w-[5rem] sm:table-cell">Rank</Th>
                    <Th>Sites say</Th>
                  </tr>
                </thead>
                <tbody>
                  {board.map((c) => {
                    const pts = weekly ? c.projected : c.ros_points;
                    const o = c.overlay;
                    const m = moveById.get(c.player_id) ?? null;
                    return (
                      <tr key={c.player_id} className="border-t border-gray-800/60 align-top">
                        <Td data-label="" className="ff-row-head">
                          <div className="flex items-baseline gap-2">
                            <div className="min-w-0 flex-1">
                              <PlayerName id={c.player_id} name={c.name} pos={c.position} team={c.team} injury={c.injury_status} onPlayer={onPlayer} />
                            </div>
                            {pts != null && (
                              <span className="shrink-0 whitespace-nowrap text-sm tabular-nums text-gray-200 sm:hidden">
                                {pts.toFixed(1)}
                                {weekly ? <OverBar v={c.over_bar} /> : <span className="ml-1 text-[11px] text-gray-500">ROS</span>}
                              </span>
                            )}
                          </div>
                          {displacesLine(c) && (
                            <div className="text-[11px] font-normal text-gray-500">displaces {displacesText(c.displaces)}</div>
                          )}
                          {o?.crowd?.verdict && (
                            <div className="mt-0.5 hidden font-normal sm:block">
                              <CrowdBadge o={o} />
                            </div>
                          )}
                          <MetaLine className="mt-0.5 sm:hidden">
                            {m ? (
                              <span className="whitespace-nowrap">
                                {moveBadge(m)}
                                <span className="ml-1 tabular-nums text-green-400">{signed(m.gain)}</span>
                              </span>
                            ) : (
                              c.availability === "free_agent" && <span className="text-green-400">free</span>
                            )}
                            {/* A claim badge already says waivers; it needs only the clear time. */}
                            {c.availability !== "free_agent" && (c.clears_at_iso || !m) && (
                              <span>
                                {m ? "clears" : "waivers"}
                                {c.clears_at_iso && ` ${m ? "" : "till "}${fmtDateTime(c.clears_at_iso)}`}
                              </span>
                            )}
                            {m && m.availability !== "free_agent" && m.suggested_bid != null && (
                              <Bid bid={m.suggested_bid} pct={m.suggested_pct} budget={data.budget} />
                            )}
                            {m?.drop && !sharedDrop && (
                              <span>
                                drop <PlayerName id={m.drop.player_id} name={m.drop.name} onPlayer={onPlayer} />
                              </span>
                            )}
                            {o?.rank && (
                              <span>
                                <RankText pos={c.position} median={o.rank.median} best={o.rank.best} worst={o.rank.worst} delta={o.delta} />
                              </span>
                            )}
                            {o?.crowd?.verdict && <CrowdBadge o={o} />}
                          </MetaLine>
                        </Td>
                        <Td data-label={weekly ? "Proj" : "ROS pts"} className="hidden text-right tabular-nums text-gray-200 sm:table-cell">
                          <span className="whitespace-nowrap">{pts != null ? pts.toFixed(1) : "—"}</span>
                          {weekly && <OverBar v={c.over_bar} />}
                        </Td>
                        <Td data-label="Availability" className="hidden text-xs sm:table-cell">
                          <Availability c={c} />
                        </Td>
                        {showMove && (
                          <Td data-label="Move" className="hidden text-xs sm:table-cell">
                            <MoveCell m={m} sharedDrop={sharedDrop != null} budget={data.budget} onPlayer={onPlayer} />
                          </Td>
                        )}
                        <Td data-label="Rank" className="hidden text-xs sm:table-cell">
                          <RankText pos={c.position} median={o?.rank?.median} best={o?.rank?.best} worst={o?.rank?.worst} delta={o?.delta} />
                        </Td>
                        <Td data-label="" block empty={!hasSites(o)} className="text-xs">
                          <Sites o={o} />
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <FoldToggle total={boardAll.length} shown={board.length} expanded={allBoard} onToggle={() => setAllBoard((v) => !v)} mode="all" />
        </Card>
      )}

      {!choppedLive && choppedCard}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {data.drops.length === 0 ? (
          <QuietLine title="Drop candidates">No bench players to spare.</QuietLine>
        ) : (
          <Card title="Drop candidates" info="Bench players the lineup can spare, weakest first.">
            <Note>
              Drop talk from the sites is called out; hold or stash talk argues the other way. A player who is Out or
              Doubtful projects near zero because he is hurt, not because he is weak, so he is listed after the healthy
              ones.
            </Note>
            <ul className="space-y-2">
              {data.drops.map((d) => {
                const pts = weekly ? d.projected : d.ros_points ?? null;
                return (
                  <li key={d.player_id} className="text-sm">
                    <div className="flex items-baseline gap-2">
                      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">
                        <span>
                          <PlayerName id={d.player_id} name={d.name} pos={d.position} team={d.team} injury={d.injury_status} onPlayer={onPlayer} />
                        </span>
                        <span className="whitespace-nowrap text-xs tabular-nums text-gray-500">
                          {pts != null ? pts.toFixed(1) : "—"}
                          {!weekly && pts != null && " ROS"}
                        </span>
                        {d.hurt && <Badge tone="neutral">hurt, not weak</Badge>}
                        {d.drop_talk > 0 && <Badge tone="critical">drop talk{d.drop_talk > 1 ? ` ×${d.drop_talk}` : ""}</Badge>}
                        {d.hold_talk > 0 && <Badge tone="info">hold/stash talk</Badge>}
                      </div>
                      <span className="shrink-0 text-xs">
                        <RankText pos={d.position} median={d.overlay?.rank?.median} best={d.overlay?.rank?.best} worst={d.overlay?.rank?.worst} delta={d.overlay?.delta} />
                      </span>
                    </div>
                    <NoteLine note={d.overlay?.note ?? null} />
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {data.stash.length === 0 ? (
          <QuietLine title="Stash">Nothing to stash right now.</QuietLine>
        ) : (
          <Card title="Stash" info="Handcuffs behind a hurt starter, and free agents the sites say stash.">
            <ul className="space-y-2">
              {stash.map((s, i) => (
                <li key={`${s.kind}-${s.player_id ?? i}`} className="text-sm">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span>
                      {s.player_id ? (
                        <PlayerName id={s.player_id} name={s.name ?? null} pos={s.position} team={s.team} onPlayer={onPlayer} />
                      ) : (
                        <span className="text-gray-300">{s.name ?? ""}</span>
                      )}
                    </span>
                    <Badge tone={s.kind === "contingent" ? "warning" : "info"}>{s.kind === "contingent" ? "contingent" : "stash talk"}</Badge>
                  </div>
                  {hasSites(s.overlay) && (
                    <div className="mt-0.5 text-xs">
                      <Sites o={s.overlay} />
                    </div>
                  )}
                  {s.trigger && (
                    <div className="text-xs text-gray-500" title={s.reasoning}>
                      {s.trigger}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            <FoldToggle total={data.stash.length} shown={stash.length} expanded={allStash} onToggle={() => setAllStash((v) => !v)} />
          </Card>
        )}
      </div>

      {data.crowd.length === 0 ? (
        <QuietLine title="What the crowd is doing">Nothing actionable.</QuietLine>
      ) : (
        <Card title="What the crowd is doing" info="Demand, not production: rivals' adds elsewhere, national risers, and players owned everywhere but here.">
          <ul className="space-y-2">
            {data.crowd.map((c) => (
              <li key={c.player_id} className="text-sm">
                {/* One wrapping line: name, verdict, owned %, then the reason,
                    which runs on beside them on a desktop and drops under
                    them on a phone. The sites only when they said something. */}
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span>
                    <PlayerName id={c.player_id} name={c.name} pos={c.position} team={c.team} onPlayer={onPlayer} />
                  </span>
                  <CrowdBadge o={c.overlay} withWhy={false} />
                  {c.why && <span className="min-w-0 max-w-prose text-xs text-gray-500">{c.why}</span>}
                </div>
                {hasSites(c.overlay) && (
                  <div className="mt-0.5 text-xs">
                    <Sites o={c.overlay} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {data.market && <FaabMarket market={data.market} budget={data.budget} week={data.week} />}
    </div>
  );
}
