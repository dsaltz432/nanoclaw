import { useEffect, useState } from "react";
import { Badge, Card, FoldToggle, Td, Th } from "./viz";
import RightNow from "./RightNow";
import { ACTION_TONE, CHANGE_TONE, ago, changeLabel, srcShort } from "./labels";

/**
 * Today — the landing view. Five questions, in the order you ask them:
 *
 *   1. Does anything need me right now?          (RightNow, unchanged)
 *   2. Where do the sites disagree with my lineup? (roster with flags)
 *   3. What are the moves, and do the sites agree? (waiver engine + overlay)
 *   4. Who is being talked about that I could add? (claims among free agents)
 *
 * "Since yesterday" sits between the two: the payload is built by the ff-news
 * job and stored (`_generated_at`), and once a day a snapshot is filed, so the
 * digest can say what changed rather than only what is.
 *
 * Trade talk and the crowd board used to be repeated here in full; they are
 * byte-for-byte the Trades and Moves lists, so Today now shows one line each
 * with a count and a link. Rank movers appear once two snapshots exist.
 * Everything is a link into the player dossier. The numbers that decide a
 * move still come from the waiver engine; the sites annotate them.
 */

type Rank = { median: number; best: number; worst: number; spread: number; n: number } | null;
type ClaimsSlim = {
  n: number;
  n_sources: number;
  net: number;
  by_action: Record<string, number>;
  evidence: { action: string; horizon: string; confidence: number | null; rationale: string; source: string; title: string; url: string }[];
};
type Overlay = { rank: Rank; delta: number | null; ranks: Record<string, number>; claims: ClaimsSlim | null; proj: Record<string, number>; proj_spread: number | null } | null;

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
  projected: number;
  gain: number;
  drop: { player_id: string; name: string; position: string; projected: number } | null;
  availability: string;
  clears_at: string | null;
  suggested_pct: number | null;
  suggested_bid: number | null;
  why: string;
  overlay: Overlay;
};

type Talk = { player_id: string; name: string; pos: string; team: string | null; injury_status: string | null; rank: Rank; claims: ClaimsSlim & { n_articles?: number }; proj: Record<string, number> };
type TradeRow = { player_id: string; name: string; pos: string; team: string | null; owner: string | null; rank: Rank; claims: ClaimsSlim };
type Crowd = { player_id: string; name: string; pos: string; team: string | null; availability: string; verdict: string; why: string | null; overlay: Overlay };
type Mover = { player_id: string; name: string; pos: string; team: string | null; status: string; owner: string | null; rank: Rank; delta: number };
type Change = { kind: string; player_id: string | null; name: string | null; text: string };

type Data = {
  league: string;
  week: number;
  hours: number;
  roster: RosterRow[];
  lineup_total: number | null;
  moves: { free_agents: Move[]; waiver_claims: Move[]; budget: number | null };
  talk: Talk[];
  trade: { sell: TradeRow[]; buy: TradeRow[] };
  crowd: Crowd[];
  movers: Mover[];
  snapshot: string | null;
  prev_snapshot: string | null;
  rank_sources: string[];
  coverage: { articles: number; claims: number; sources: number };
  changes?: { since: string | null; items: Change[] };
  _generated_at?: string | null;
  _cached?: boolean;
  error?: string;
};

const FLAG_TONE: Record<string, "good" | "warning" | "critical" | "info" | "neutral"> = {
  start: "good",
  rising: "good",
  sit: "warning",
  sell: "warning",
  falling: "warning",
  drop: "critical",
  injury: "critical",
};

export default function TodayTab({
  league,
  onPlayer,
  onTab,
}: {
  league: string;
  onPlayer: (id: string) => void;
  /** Switches the page's tab; the one-line summaries below link to Trades / Moves. */
  onTab?: (tab: "trades" | "moves") => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [allTalk, setAllTalk] = useState(false);
  const [rightNowCollapsed, setRightNowCollapsed] = useState(false);

  useEffect(() => {
    setData(null);
    fetch(`/api/fantasy/today?league=${encodeURIComponent(league)}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : (setErr(null), setData(d))))
      .catch((e) => setErr(String(e)));
  }, [league]);

  if (err) return <div className="p-6 text-sm text-red-400">{err}</div>;

  const Name = ({ id, name, pos, team }: { id: string; name: string | null; pos?: string | null; team?: string | null }) => (
    <>
      <button onClick={() => onPlayer(id)} className="text-left text-gray-100 hover:text-indigo-300 hover:underline">
        {name ?? id}
      </button>
      {(pos || team) && (
        <span className="ml-1.5 text-xs text-gray-500">
          {pos}
          {team ? ` · ${team}` : ""}
        </span>
      )}
    </>
  );

  const Claims = ({ c }: { c: ClaimsSlim | null | undefined }) =>
    c ? (
      <span className="inline-flex flex-wrap items-center gap-1">
        {Object.entries(c.by_action)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([a, n]) => (
            <Badge key={a} tone={ACTION_TONE[a] ?? "neutral"}>
              {a}
              {n > 1 ? ` ×${n}` : ""}
            </Badge>
          ))}
        <span className="text-[11px] text-gray-600">
          {c.n_sources} {c.n_sources === 1 ? "site" : "sites"}
        </span>
      </span>
    ) : (
      <span className="text-xs text-gray-700">quiet</span>
    );

  const RankCell = ({ o }: { o: Overlay }) =>
    o?.rank ? (
      <span className="whitespace-nowrap tabular-nums text-gray-300" title={`spread ${o.rank.best}–${o.rank.worst} across ${o.rank.n} sources`}>
        {o.rank.median}
        <span className="text-gray-600"> ({o.rank.best}–{o.rank.worst})</span>
        {o.delta != null && o.delta !== 0 && (
          <span className={o.delta > 0 ? "text-green-400" : "text-red-400"}>
            {" "}
            {o.delta > 0 ? "▲" : "▼"}
            {Math.abs(o.delta)}
          </span>
        )}
      </span>
    ) : (
      <span className="text-gray-700">—</span>
    );

  const TabLink = ({ tab, children }: { tab: "trades" | "moves"; children: string }) =>
    onTab ? (
      <button onClick={() => onTab(tab)} className="ff-inline text-indigo-400 hover:text-indigo-300 hover:underline">
        {children} →
      </button>
    ) : (
      <span className="text-gray-300">{children}</span>
    );

  // The first three moves are the brief; the full list is the Moves tab's job.
  const MOVES_SHOWN = 3;
  const TALK_SHOWN = 3;
  const allMoves = data ? [...data.moves.free_agents, ...data.moves.waiver_claims] : [];
  const moves = allMoves.slice(0, MOVES_SHOWN);
  // Thirteen rows all dropping the same bench player is one fact, not a column.
  const firstDrop = allMoves[0]?.drop ?? null;
  const sharedDrop =
    allMoves.length > 1 && firstDrop && allMoves.every((m) => m.drop?.player_id === firstDrop.player_id) ? firstDrop : null;
  const talk = data ? (allTalk ? data.talk : data.talk.slice(0, TALK_SHOWN)) : [];
  const changes = data?.changes?.items ?? [];
  const built = ago(data?._generated_at);

  return (
    <div className="space-y-4">
      {/* 1 ── what needs me */}
      <RightNow league={league} collapsed={rightNowCollapsed} onToggle={() => setRightNowCollapsed((v) => !v)} key={`rn-${league}`} />

      {!data ? (
        <div className="p-6 text-sm text-gray-500">Loading…</div>
      ) : (
        <>
          {/* 1b ── since yesterday: the diff against the last daily snapshot */}
          <Card
            title="Since yesterday"
            subtitle={
              data.changes?.since
                ? `What moved in this digest since the ${data.changes.since} snapshot.`
                : "The digest is snapshotted once a day; tomorrow this compares against today."
            }
            right={built && <span className="whitespace-nowrap text-[11px] text-gray-600">digest built {built}</span>}
          >
            {!data.changes?.since ? (
              <p className="text-xs text-gray-600">First day — no comparison yet.</p>
            ) : changes.length === 0 ? (
              <p className="text-xs text-gray-600">Nothing changed since {data.changes.since}.</p>
            ) : (
              <ul className="space-y-1">
                {changes.map((c, i) => (
                  <li key={`${c.kind}-${c.player_id ?? i}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                    <Badge tone={CHANGE_TONE[c.kind] ?? "neutral"}>{changeLabel(c.kind)}</Badge>
                    {c.player_id ? <Name id={c.player_id} name={c.name} /> : <span className="text-gray-100">{c.name}</span>}
                    <span className="text-xs text-gray-400">{c.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* 2 ── my roster, expert view */}
          <Card
            title="Your roster, as the sites see it"
            subtitle={
              <>
                Flags mark disagreement between the sites and your lineup. Rank is the median position rank across{" "}
                {data.rank_sources.map(srcShort).join(", ")}
                {data.prev_snapshot ? "; the arrow is the move since the previous snapshot." : "."}
              </>
            }
            right={
              <button onClick={() => setShowAll((v) => !v)} className="rounded-md border border-gray-800 px-2 py-1 text-xs text-gray-400 hover:border-gray-700 hover:text-gray-200">
                {showAll ? "flagged only" : "show everyone"}
              </button>
            }
          >
            <div className="ff-stack-wrap overflow-x-auto">
              <table className="ff-stack w-full">
                <thead>
                  <tr>
                    <Th>Player</Th>
                    <Th>Slot</Th>
                    <Th className="text-right">Proj</Th>
                    <Th>Rank</Th>
                    <Th>Sites say</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.roster
                    .filter((r) => showAll || r.flags.length)
                    .map((r) => (
                      <tr key={r.player_id} className="border-t border-gray-800/60 align-top">
                        <Td data-label="" className="ff-row-head whitespace-nowrap">
                          <Name id={r.player_id} name={r.name} pos={r.position} team={r.team} />
                        </Td>
                        <Td data-label="Slot" className="text-xs text-gray-500">{r.starter ? "starter" : "bench"}</Td>
                        <Td data-label="Proj" className="text-right tabular-nums text-gray-300">{r.projected?.toFixed(1) ?? "—"}</Td>
                        <Td data-label="Rank" className="whitespace-nowrap text-xs">
                          <RankCell o={r.overlay} />
                        </Td>
                        {/* The flag used to be its own column and restated the
                            badges beside it ("sites lean start" next to
                            "start ×5"). It now sits under them as the reading. */}
                        <Td data-label="Sites say" className="text-xs">
                          <div>
                            <Claims c={r.overlay?.claims} />
                            {r.overlay?.claims?.evidence[0] && (
                              <div className="mt-0.5 max-w-[26rem] text-gray-500" title={r.overlay.claims.evidence[0].title}>
                                <span className="text-gray-600">{srcShort(r.overlay.claims.evidence[0].source)}:</span>{" "}
                                {r.overlay.claims.evidence[0].rationale}
                              </div>
                            )}
                            {r.flags.length > 0 && (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {r.flags.map((f, i) => (
                                  <Badge key={i} tone={FLAG_TONE[f.kind] ?? "neutral"}>
                                    {f.text}
                                  </Badge>
                                ))}
                              </div>
                            )}
                          </div>
                        </Td>
                      </tr>
                    ))}
                  {!showAll && data.roster.every((r) => !r.flags.length) && (
                    <tr>
                      <Td data-label="" className="text-xs text-gray-600" colSpan={5}>
                        No disagreement this week: nothing the sites say contradicts your lineup.
                      </Td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          {/* 3 ── moves */}
          <Card
            title="Moves"
            subtitle={
              <>
                The waiver engine's best add/drop pairs by lineup gain, with what the sites say about each add. Gain decides; the sites annotate.
                {sharedDrop && (
                  <>
                    {" "}
                    All drop <span className="text-gray-300">{sharedDrop.name}</span> ({sharedDrop.projected.toFixed(1)}).
                  </>
                )}
              </>
            }
          >
            {allMoves.length === 0 ? (
              <p className="text-xs text-gray-600">No add improves your starting lineup right now.</p>
            ) : (
              <>
                <div className="ff-stack-wrap overflow-x-auto">
                  <table className="ff-stack w-full">
                    <thead>
                      <tr>
                        <Th>Add</Th>
                        <Th className="text-right">Gain</Th>
                        {!sharedDrop && <Th>Drop</Th>}
                        <Th>When</Th>
                        <Th>Rank</Th>
                        <Th>Sites say</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {moves.map((m) => (
                        <tr key={m.player_id + m.availability} className="border-t border-gray-800/60 align-top">
                          <Td data-label="" className="ff-row-head whitespace-nowrap">
                            <Name id={m.player_id} name={m.name} pos={m.position} team={m.team} />
                          </Td>
                          <Td data-label="Gain" className="text-right tabular-nums text-green-400">+{m.gain.toFixed(1)}</Td>
                          {!sharedDrop && (
                            <Td data-label="Drop" className="text-xs text-gray-400">
                              {m.drop ? (
                                <>
                                  {m.drop.name} <span className="text-gray-600">({m.drop.projected.toFixed(1)})</span>
                                </>
                              ) : (
                                "—"
                              )}
                            </Td>
                          )}
                          <Td data-label="When" className="text-xs">
                            {m.availability === "free_agent" ? (
                              <Badge tone="good">add now</Badge>
                            ) : (
                              <span className="text-gray-400">
                                <Badge tone="warning">claim</Badge>
                                {/* The clear time on its own line: inline it made
                                    the column 200px wide for a 60px badge. */}
                                <span className="block text-gray-500">
                                  {m.clears_at ?? ""}
                                  {m.suggested_pct != null && <> · bid {m.suggested_pct}%</>}
                                </span>
                              </span>
                            )}
                          </Td>
                          <Td data-label="Rank" className="whitespace-nowrap text-xs">
                            <RankCell o={m.overlay} />
                          </Td>
                          <Td data-label="Sites say" className="text-xs">
                            <div>
                              <Claims c={m.overlay?.claims} />
                              {m.overlay?.claims?.evidence[0] && (
                                <div className="mt-0.5 max-w-[26rem] text-gray-500">
                                  <span className="text-gray-600">{srcShort(m.overlay.claims.evidence[0].source)}:</span>{" "}
                                  {m.overlay.claims.evidence[0].rationale}
                                </div>
                              )}
                            </div>
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {allMoves.length > MOVES_SHOWN && (
                  <p className="mt-2 text-xs text-gray-500">
                    {allMoves.length - MOVES_SHOWN} more on <TabLink tab="moves">Moves</TabLink>
                  </p>
                )}
              </>
            )}
          </Card>

          {/* 4 ── talk */}
          <Card title="Available and being talked about" subtitle="Free agents in this league with claims in the window, most positive first.">
            {data.talk.length === 0 ? (
              <p className="text-xs text-gray-600">Nothing in the window.</p>
            ) : (
              <>
                <ul className="space-y-2">
                  {talk.map((t) => (
                    <li key={t.player_id} className="text-sm">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <Name id={t.player_id} name={t.name} pos={t.pos} team={t.team} />
                        {t.injury_status && <Badge tone="warning">{t.injury_status}</Badge>}
                      </div>
                      <div className="text-xs">
                        <Claims c={t.claims} />
                      </div>
                      {t.claims.evidence[0] && (
                        <div className="text-xs text-gray-500">
                          <span className="text-gray-600">{srcShort(t.claims.evidence[0].source)}:</span>{" "}
                          {t.claims.evidence[0].rationale}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <FoldToggle total={data.talk.length} shown={talk.length} expanded={allTalk} onToggle={() => setAllTalk((v) => !v)} />
              </>
            )}
          </Card>

          {/* 5 ── one line each for what lives on another tab */}
          <div className="space-y-1 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2.5 text-sm text-gray-400 sm:px-4">
            <p>
              Trade talk: {data.trade.sell.length} sell {data.trade.sell.length === 1 ? "candidate" : "candidates"} on your roster,{" "}
              {data.trade.buy.length} buy {data.trade.buy.length === 1 ? "target" : "targets"} on rivals' · <TabLink tab="trades">Trades</TabLink>
            </p>
            <p>
              Crowd: {data.crowd.length} actionable demand {data.crowd.length === 1 ? "signal" : "signals"} · <TabLink tab="moves">Moves</TabLink>
            </p>
          </div>

          {/* Movers need two snapshots; an empty card saying so was half a row. */}
          {data.prev_snapshot && (
            <Card title="Consensus movers" subtitle="Biggest changes in median rank since the previous snapshot.">
              {data.movers.length === 0 ? (
                <p className="text-xs text-gray-600">No rank moved by 2 or more.</p>
              ) : (
                <ul className="space-y-1">
                  {data.movers.map((m) => (
                    <li key={m.player_id} className="flex items-baseline gap-2 text-sm">
                      <Name id={m.player_id} name={m.name} pos={m.pos} team={m.team} />
                      <span className="text-xs text-gray-600">{m.status === "mine" ? "mine" : m.status === "free_agent" ? "available" : m.owner}</span>
                      <span className={`ml-auto shrink-0 tabular-nums ${m.delta > 0 ? "text-green-400" : "text-red-400"}`}>
                        {m.delta > 0 ? "▲" : "▼"} {Math.abs(m.delta)} → {m.rank?.median}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </>
      )}
    </div>
  );
}
