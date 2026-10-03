import { useEffect, useState, type ReactNode } from "react";
import { ClaimQuote, ClaimsSummary, PlayerName, RankText } from "./NoteLine";
import { Badge, Card, ErrorBox, FoldToggle, Loading, MetaLine, Note, QuietLine, Td, Th } from "./viz";
import RightNow, { type NowData } from "./RightNow";
import { CHANGE_TONE, ago, changeLabel, fmtDate, fmtDateTime, signed, srcShort } from "./labels";

/**
 * Today — the landing view, one fetch (the ff-news job's stored digest,
 * `_generated_at`), top to bottom:
 *
 *   Right now        a starter at risk that the bench does not cover
 *   Since yesterday  the diff against the last daily snapshot of this digest
 *   Your roster      only the flagged rows (drop talk, a falling consensus
 *                    rank, an injury designation); the full roster and
 *                    start/sit are Lineup's
 *   Moves            the waiver engine's top three add/drop pairs, annotated
 *                    with what the sites say; the full list is on Moves
 *   Elsewhere        links to Trades (sell talk on your players, else buy
 *                    targets) and Moves (crowd signals). The digest counts
 *                    them with the destination tabs' own rules, so a number
 *                    matches what you land on.
 *
 * Every name opens the player dossier. The numbers that decide a move come
 * from the waiver engine; the sites annotate them.
 */

type Rank = { median: number; best: number; worst: number } | null;
type ClaimsSlim = {
  n_sources: number;
  by_action: Record<string, number>;
  evidence: { action: string; horizon: string; rationale: string; source: string; title: string; url: string }[];
};
type Overlay = { rank: Rank; delta: number | null; claims: ClaimsSlim | null } | null;

type RosterRow = {
  player_id: string;
  name: string;
  position: string;
  team: string | null;
  injury_status: string | null;
  projected: number | null;
  starter: boolean;
  overlay: Overlay;
  flags: { kind: string; text: string }[];
};

type Move = {
  player_id: string;
  name: string;
  position: string;
  team: string | null;
  injury_status: string | null;
  gain: number;
  drop: { player_id: string; name: string; position: string; projected: number | null } | null;
  availability: string;
  clears_at_iso: string | null;
  /** Dollars, what you type in Sleeper; pct is the share of this league's budget. */
  suggested_bid: number | null;
  suggested_pct: number | null;
  overlay: Overlay;
};

type Change = { kind: string; player_id: string | null; name: string | null; text: string };

type Data = {
  needs_you?: NowData;
  roster: RosterRow[];
  moves: { free_agents: Move[]; waiver_claims: Move[] };
  /** The Trades and Moves lists, as counts (the rows live on those tabs). */
  counts: { sell: number; buy: number; buy_cap: number; crowd: number };
  prev_snapshot: string | null;
  rank_sources: string[];
  changes?: { since: string | null; items: Change[] };
  _generated_at?: string | null;
  error?: string;
};

// The digest's roster flags are drop, falling and injury. A falling rank
// ("consensus rank fell 8") is what puts the row here, but the Rank arrow
// already says it; the injury designation is PlayerName's badge beside the
// name. Only drop talk is printed as a flag.
const FLAG_TONE: Record<string, "critical" | "neutral"> = { drop: "critical" };
const UNPRINTED_FLAGS = new Set(["falling", "injury"]);

/** The first three moves are the brief; the full list is the Moves tab's job. */
const MOVES_SHOWN = 3;
const ROSTER_SHOWN = 5;
const CHANGES_SHOWN = 6;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Tab = "trades" | "moves";

function TabLink({ tab, onTab, children }: { tab: Tab; onTab?: (tab: Tab) => void; children: string }) {
  return onTab ? (
    <button
      type="button"
      onClick={() => onTab(tab)}
      className="ff-inline ff-hit -my-2 py-2 text-left text-indigo-400 hover:text-indigo-300 hover:underline"
    >
      {children} →
    </button>
  ) : (
    <span className="text-gray-300">{children}</span>
  );
}

function FlagBadges({ flags }: { flags: RosterRow["flags"] }) {
  return (
    <>
      {flags
        .filter((f) => !UNPRINTED_FLAGS.has(f.kind))
        .map((f, i) => (
          <Badge key={i} tone={FLAG_TONE[f.kind] ?? "neutral"}>
            {f.text}
          </Badge>
        ))}
    </>
  );
}

const printsFlags = (r: RosterRow) => r.flags.some((f) => !UNPRINTED_FLAGS.has(f.kind));

const moveBadge = (m: Move) =>
  m.availability === "free_agent" ? <Badge tone="good">add now</Badge> : <Badge tone="warning">claim</Badge>;

/** The bid in dollars (what you type in Sleeper), its share of the budget in the tooltip. */
function BidText({ m }: { m: Move }) {
  return (
    <span
      className="whitespace-nowrap tabular-nums"
      title={m.suggested_pct != null ? `${+m.suggested_pct.toFixed(1)}% of this league's budget` : undefined}
    >
      bid ${m.suggested_bid}
    </span>
  );
}

export default function TodayTab({
  league,
  onPlayer,
  onTab,
}: {
  league: string;
  onPlayer: (id: string) => void;
  /** Switches the page's tab; the Moves card and the Elsewhere line link to Trades / Moves. */
  onTab?: (tab: Tab) => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [allChanges, setAllChanges] = useState(false);
  const [allRoster, setAllRoster] = useState(false);

  useEffect(() => {
    setData(null);
    fetch(`/api/fantasy/today?league=${encodeURIComponent(league)}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : (setErr(null), setData(d))))
      .catch((e) => setErr(String(e)));
  }, [league]);

  if (err) return <ErrorBox>{err}</ErrorBox>;

  const allMoves = data ? [...data.moves.free_agents, ...data.moves.waiver_claims] : [];
  const moves = allMoves.slice(0, MOVES_SHOWN);
  // Thirteen rows all dropping the same bench player is one fact, not a column.
  const firstDrop = allMoves[0]?.drop ?? null;
  const sharedDrop =
    allMoves.length > 1 && firstDrop && allMoves.every((m) => m.drop?.player_id === firstDrop.player_id) ? firstDrop : null;
  const allChangeItems = data?.changes?.items ?? [];
  const changes = allChanges ? allChangeItems : allChangeItems.slice(0, CHANGES_SHOWN);
  const since = data?.changes?.since ?? null;
  const built = ago(data?._generated_at);
  const builtTag = built && <span className="whitespace-nowrap text-[11px] text-gray-600">digest built {built}</span>;
  const allFlagged = data ? data.roster.filter((r) => r.flags.length) : [];
  const flagged = allRoster ? allFlagged : allFlagged.slice(0, ROSTER_SHOWN);

  // Elsewhere: sell talk on my players is the Trades line when there is any;
  // otherwise buy targets, counted only below the Trades tab's cap (at the
  // cap the number says nothing but the cap).
  const counts = data?.counts;
  const tradesLink = !counts
    ? ""
    : counts.sell > 0
      ? `Trades: sell talk on ${counts.sell} of your players`
      : counts.buy === 0
        ? ""                            // nothing to go and look at
        : counts.buy < counts.buy_cap
          ? `Trades: ${plural(counts.buy, "buy target")}`
          : "Trades: buy targets";

  const rankCell = (o: Overlay, pos: string, className = "") => (
    <Td data-label="Rank" empty={!o?.rank} className={`text-xs ${className}`}>
      <RankText pos={pos} median={o?.rank?.median} best={o?.rank?.best} worst={o?.rank?.worst} delta={o?.delta} />
    </Td>
  );

  const sitesSay = (c: ClaimsSlim | null | undefined, extra?: ReactNode) => (
    // Unlabelled on a phone, as on Lineup and Moves: the chips and the quote
    // say what they are, and the label would cost every card a line.
    <Td data-label="" block className="text-xs">
      <div className="max-w-[26rem]">
        <ClaimsSummary byAction={c?.by_action} nSources={c?.n_sources} />
        {c?.evidence[0] && (
          <div className="mt-0.5">
            <ClaimQuote e={c.evidence[0]} />
          </div>
        )}
        {extra}
      </div>
    </Td>
  );

  return (
    <div className="space-y-4">
      <RightNow data={data?.needs_you} loading={!data} onPlayer={onPlayer} />

      {!data ? (
        <Loading />
      ) : (
        <>
          {/* the diff against the last daily snapshot */}
          {!since || allChangeItems.length === 0 ? (
            <QuietLine title="Since yesterday" right={builtTag}>
              {!since ? "First day — tomorrow this compares against today." : `Nothing changed since ${fmtDate(since)}.`}
            </QuietLine>
          ) : (
            <Card title="Since yesterday" subtitle={`since ${fmtDate(since)}`} right={builtTag}>
              <ul className="space-y-2">
                {changes.map((c, i) => (
                  // Two lines on a phone; one on a desktop, where the detail
                  // fits beside the name.
                  <li key={`${c.kind}-${c.player_id ?? i}`} className="sm:flex sm:items-baseline sm:gap-x-2">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                      <Badge tone={CHANGE_TONE[c.kind] ?? "neutral"}>{changeLabel(c.kind)}</Badge>
                      {c.player_id ? (
                        <PlayerName id={c.player_id} name={c.name} onPlayer={onPlayer} />
                      ) : (
                        <span className="text-gray-100">{c.name}</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-gray-400 sm:mt-0">{c.text}</div>
                  </li>
                ))}
              </ul>
              <FoldToggle
                total={allChangeItems.length}
                shown={changes.length}
                expanded={allChanges}
                onToggle={() => setAllChanges((v) => !v)}
              />
            </Card>
          )}

          {/* my roster, flagged rows only — Lineup has everyone */}
          {allFlagged.length === 0 ? (
            <QuietLine title="Your roster, as the sites see it">No drop talk, rank fall or injury designation on your roster.</QuietLine>
          ) : (
            <Card
              title="Your roster, as the sites see it"
              info="Your players with drop talk, a falling consensus rank or an injury designation."
            >
              <Note>
                {`Rank is the median position rank across ${data.rank_sources.map(srcShort).join(", ")}; the tooltip gives the range across sites${
                  data.prev_snapshot ? ", and the arrow is the move since the previous snapshot, shown when it is at least one place" : ""
                }.`}
              </Note>
              <div className="ff-stack-wrap overflow-x-auto">
                <table className="ff-stack w-full">
                  <thead>
                    <tr>
                      <Th>Player</Th>
                      <Th className="hidden text-right sm:table-cell">Proj</Th>
                      <Th className="hidden sm:table-cell">Rank</Th>
                      <Th>Sites say</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {flagged.map((r) => {
                      const injury = r.injury_status ?? r.flags.find((f) => f.kind === "injury")?.text ?? null;
                      return (
                        <tr key={r.player_id} className="border-t border-gray-800/60 align-top">
                          {/* On a phone the row head is the whole row but the
                              sites' call: name and rank, then proj and flags. */}
                          <Td data-label="" className="ff-row-head">
                            <div className="flex items-baseline gap-2">
                              <div className="min-w-0 flex-1">
                                <PlayerName
                                  id={r.player_id}
                                  name={r.name}
                                  pos={r.position}
                                  team={r.team}
                                  injury={injury}
                                  onPlayer={onPlayer}
                                />
                                {!r.starter && (
                                  <span className="ml-1.5 rounded border border-gray-800 px-1 text-[10px] uppercase tracking-wide text-gray-500">
                                    bench
                                  </span>
                                )}
                              </div>
                              {r.overlay?.rank && (
                                <span className="shrink-0 text-xs sm:hidden">
                                  <RankText
                                    pos={r.position}
                                    median={r.overlay.rank.median}
                                    best={r.overlay.rank.best}
                                    worst={r.overlay.rank.worst}
                                    delta={r.overlay.delta}
                                  />
                                </span>
                              )}
                            </div>
                            <MetaLine className="mt-0.5 sm:hidden">
                              {r.projected != null && <span className="tabular-nums">proj {r.projected.toFixed(1)}</span>}
                              {printsFlags(r) && (
                                <span className="inline-flex flex-wrap gap-1">
                                  <FlagBadges flags={r.flags} />
                                </span>
                              )}
                            </MetaLine>
                          </Td>
                          <Td
                            data-label="Proj"
                            empty={r.projected == null}
                            className="hidden text-right tabular-nums text-gray-300 sm:table-cell"
                          >
                            {r.projected?.toFixed(1) ?? "—"}
                          </Td>
                          {rankCell(r.overlay, r.position, "hidden sm:table-cell")}
                          {/* On a desktop the flags sit under the sites' call as the reading of it. */}
                          {sitesSay(
                            r.overlay?.claims,
                            printsFlags(r) && (
                              <div className="mt-1 hidden flex-wrap gap-1 sm:flex">
                                <FlagBadges flags={r.flags} />
                              </div>
                            ),
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <FoldToggle
                total={allFlagged.length}
                shown={flagged.length}
                expanded={allRoster}
                onToggle={() => setAllRoster((v) => !v)}
              />
            </Card>
          )}

          {/* the top moves */}
          {allMoves.length === 0 ? (
            <QuietLine title="Moves">No add improves your starting lineup right now.</QuietLine>
          ) : (
            <Card
              title="Moves"
              info="The waiver engine's best add/drop pairs by lineup gain, with what the sites say about each add."
              subtitle={
                sharedDrop && (
                  <>
                    All drop <PlayerName id={sharedDrop.player_id} name={sharedDrop.name} onPlayer={onPlayer} />
                    {sharedDrop.projected != null && ` (${sharedDrop.projected.toFixed(1)})`}
                  </>
                )
              }
            >
              <div className="ff-stack-wrap overflow-x-auto">
                {/* On a phone the row head is the whole row but the sites'
                    call: the add and his gain, then when, bid, drop and rank. */}
                <table className="ff-stack w-full">
                  <thead>
                    <tr>
                      <Th>Add</Th>
                      <Th className="hidden text-right sm:table-cell">Gain</Th>
                      {!sharedDrop && <Th className="hidden sm:table-cell">Drop</Th>}
                      <Th className="hidden sm:table-cell">When</Th>
                      <Th className="hidden sm:table-cell">Rank</Th>
                      <Th>Sites say</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {moves.map((m) => (
                      <tr key={m.player_id + m.availability} className="border-t border-gray-800/60 align-top">
                        <Td data-label="" className="ff-row-head">
                          <div className="flex items-baseline gap-2">
                            <div className="min-w-0 flex-1">
                              <PlayerName
                                id={m.player_id}
                                name={m.name}
                                pos={m.position}
                                team={m.team}
                                injury={m.injury_status}
                                onPlayer={onPlayer}
                              />
                            </div>
                            <span className="shrink-0 text-sm tabular-nums text-green-400 sm:hidden">{signed(m.gain)}</span>
                          </div>
                          <MetaLine className="mt-0.5 sm:hidden">
                            <span>{moveBadge(m)}</span>
                            {m.availability !== "free_agent" && m.clears_at_iso && <span>{fmtDateTime(m.clears_at_iso)}</span>}
                            {m.availability !== "free_agent" && m.suggested_bid != null && <BidText m={m} />}
                            {m.drop && !sharedDrop && (
                              <span>
                                drop <PlayerName id={m.drop.player_id} name={m.drop.name} onPlayer={onPlayer} />
                              </span>
                            )}
                            {m.overlay?.rank && (
                              <span>
                                <RankText
                                  pos={m.position}
                                  median={m.overlay.rank.median}
                                  best={m.overlay.rank.best}
                                  worst={m.overlay.rank.worst}
                                  delta={m.overlay.delta}
                                />
                              </span>
                            )}
                          </MetaLine>
                        </Td>
                        <Td data-label="Gain" className="hidden text-right tabular-nums text-green-400 sm:table-cell">
                          {signed(m.gain)}
                        </Td>
                        {!sharedDrop && (
                          <Td data-label="Drop" className="hidden text-xs text-gray-400 sm:table-cell">
                            {m.drop ? (
                              <>
                                <PlayerName id={m.drop.player_id} name={m.drop.name} onPlayer={onPlayer} />{" "}
                                {m.drop.projected != null && (
                                  <span className="text-gray-600">({m.drop.projected.toFixed(1)})</span>
                                )}
                              </>
                            ) : (
                              <span className="text-gray-700">—</span>
                            )}
                          </Td>
                        )}
                        <Td data-label="When" className="hidden text-xs sm:table-cell">
                          {moveBadge(m)}
                          {/* The clear time and bid on their own line: inline
                              they made the column 200px wide for a 60px badge. */}
                          {m.availability !== "free_agent" && (
                            <MetaLine className="mt-0.5">
                              {m.clears_at_iso && <span>{fmtDateTime(m.clears_at_iso)}</span>}
                              {m.suggested_bid != null && <BidText m={m} />}
                            </MetaLine>
                          )}
                        </Td>
                        {rankCell(m.overlay, m.position, "hidden sm:table-cell")}
                        {sitesSay(m.overlay?.claims)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {allMoves.length > MOVES_SHOWN && (
                <p className="mt-2 text-xs text-gray-500">
                  The full list is on{" "}
                  <TabLink tab="moves" onTab={onTab}>
                    Moves
                  </TabLink>
                </p>
              )}
            </Card>
          )}

          {/* counts for what lives on another tab */}
          <QuietLine title="Elsewhere">
            <span className="flex flex-col items-start gap-y-1 sm:flex-row sm:flex-wrap sm:gap-x-4">
              {tradesLink && (
                <TabLink tab="trades" onTab={onTab}>
                  {tradesLink}
                </TabLink>
              )}
              {counts && counts.crowd > 0 && (
                <TabLink tab="moves" onTab={onTab}>{`Moves: ${plural(counts.crowd, "crowd signal")}`}</TabLink>
              )}
            </span>
          </QuietLine>
        </>
      )}
    </div>
  );
}
