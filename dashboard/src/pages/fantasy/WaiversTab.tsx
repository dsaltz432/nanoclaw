import { useEffect, useMemo, useState } from "react";
import { Badge, C, Card, CellBar, HBars, LineChart, NewsPeek, Note, PeekNote, RangeRow, StatTile, Td, Th, SourceLink } from "./viz";
import { SectionProvider } from "./method";

type Displaces = { slot: string; name: string | null; points: number } | null;

type Candidate = {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  injury_status: string | null;
  projected: number | null;
  bar: number | null;
  over_bar: number | null;
  ros_points: number | null;
  displaces: Displaces;
  bye_week: number | null;
  opp_implied_total: number | null;
  tier: string | null;
  suggested_bid: number | null;
  suggested_pct: number | null;
  market_low: number | null;
  market_high: number | null;
  no_bid_reason: string | null;
  tier_median: number | null;
  tier_p90: number | null;
  tier_n: number;
  tier_thin: boolean;
  tier_mean_next4: number | null;
};

type Slotted = {
  player_id: string;
  slot: string | null;
  name: string;
  position: string | null;
  team: string | null;
  injury_status: string | null;
  projected: number | null;
};

type Waivers = {
  league: {
    key: string;
    name: string;
    season: string;
    teams: number;
    budget: number;
    status: string;
    roster_positions: string[];
  };
  week: number;
  replacement_bar: Record<string, number>;
  replacement_detail: Record<string, { points: number; slot: string; name: string | null }>;
  roster: { player_id: string; name: string; position: string | null; projected: number | null }[];
  lineup: { slots: Slotted[]; bench: Slotted[] };
  candidates: Candidate[];
  price_table: {
    budget: number;
    contests_scored: number;
    contests_total: number;
    rows: {
      tier: string;
      n: number;
      thin: boolean;
      median?: number;
      p75?: number;
      p90?: number;
      p75_pct?: number;
      mean_next4_pts?: number | null;
    }[];
  };
  contest_summary: {
    n: number;
    tie_pct?: number;
    total_overpay?: number;
    seasons?: number;
    note?: string;
  };
  rival_budgets: {
    rivals: { owner: string; is_me: boolean; used: number; total: number; pct_left: number }[];
    flush_rivals: number;
    note: string;
    degenerate: boolean;
  };
  budget_burn: {
    owner: string;
    owner_id: string;
    handle: string;
    team: string;
    person: string | null;
    merged_accounts?: number;
    is_me: boolean;
    active: boolean;
    seasons: number;
    weeks: number[];
    curve: number[];
    final: number;
    unspent: number;
  }[];
  zero_point_risks: { player_id: string; name: string; position: string | null; reasons: string[] }[];
  merged_identities: {
    name: string;
    canonical_handles: string[];
    merged_handles: string[];
  }[];
  moves: Moves;
  news_by_player: Record<string, PeekNote[]>;
  principles: string[];
  error?: string;
};

export type Move = {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  injury_status: string | null;
  projected: number | null;
  ros_points: number | null;
  gain: number;
  drop: {
    player_id: string;
    name: string;
    position: string | null;
    projected: number | null;
    market_value: number | null;
  };
  availability: "free_agent" | "waivers";
  clears_at: string | null;
  dropped_by: string | null;
  suggested_bid: number | null;
  suggested_pct: number | null;
  tier: string | null;
  tier_n: number;
  tier_thin: boolean;
  market_value: number | null;
  asset_delta: number | null;
  news: { published_at: string; headline: string; url: string | null }[];
  why: string;
};

type Moves = {
  free_agents: Move[];
  waiver_claims: Move[];
  base_lineup_total?: number;
  budget?: number;
  reason?: string;
  inference_note?: string;
  method_note?: string;
  asset_blocked?: number;
  asset_note?: string | null;
};

export default function WaiversTab({ league }: { league: string }) {
  const [data, setData] = useState<Waivers | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Default ON. The board carries ~200 rows and roughly 190 of them have
  // negative gain; showing them by default buries the ten that matter.
  const [onlyAboveBar, setOnlyAboveBar] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setPosFilter(null);
    setQuery("");
    fetch(`/api/fantasy/waivers?league=${encodeURIComponent(league)}&limit=200`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.error) setErr(d.error);
        else setData(d);
      })
      .catch((e) => !cancelled && setErr(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [league]);

  // FLEX is a filter, not a position: it means "anyone who could fill a flex
  // slot", which is the group you are actually shopping in when your weakest
  // starter is a flex.
  const FLEX_MEMBERS = ["RB", "WR", "TE"];

  const allPositions = useMemo(() => {
    if (!data) return [];
    const order = ["QB", "RB", "WR", "TE", "K", "DEF"];
    const present = new Set(data.candidates.map((c) => c.position).filter(Boolean) as string[]);
    const base = order.filter((p) => present.has(p));
    const hasFlex = FLEX_MEMBERS.some((p) => present.has(p));
    return hasFlex ? ["FLEX", ...base] : base;
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    // Anything already presented as a suggested move above is not repeated here.
    // The two sections were showing the same ten players with the same numbers,
    // stacked vertically — two presentations of identical data.
    const promoted = new Set(
      [...(data.moves?.free_agents ?? []), ...(data.moves?.waiver_claims ?? [])].map(
        (m) => m.player_id
      )
    );
    const wanted =
      posFilter === "FLEX" ? FLEX_MEMBERS : posFilter ? [posFilter] : null;
    return data.candidates.filter((c) => {
      if (!q && promoted.has(c.player_id)) return false;
      if (wanted && (!c.position || !wanted.includes(c.position))) return false;
      // A name search is an explicit request for that player, so it overrides the
      // bar filter — you asked for him, you get told what he is worth even if he
      // would not crack your lineup.
      if (q) return `${c.name} ${c.team ?? ""}`.toLowerCase().includes(q);
      if (onlyAboveBar && (c.over_bar ?? -1) <= 0) return false;
      return true;
    });
  }, [data, posFilter, query, onlyAboveBar]);

  if (loading) return <div className="p-6 text-sm text-gray-500">Loading waiver board…</div>;
  if (err) return <div className="p-6 text-sm text-red-400">{err}</div>;
  if (!data) return null;

  const budget = data.league.budget;
  const maxOver = Math.max(1, ...rows.map((r) => r.over_bar ?? 0));
  const priceMax = Math.max(1, ...data.price_table.rows.map((r) => r.p90 ?? 0));
  // Identity comes from the id the server resolved, never from matching a
  // display string. The previous version compared against a team name hardcoded
  // in the page, which stopped finding you the moment anyone renamed a team.
  const burnMine = data.budget_burn.find((b) => b.is_me);

  // One position at a time — clicking a second chip replaces the first rather
  // than widening the set, which is what "filter by position" is normally taken
  // to mean. Clicking the active chip clears it.
  const togglePos = (p: string) => setPosFilter((prev) => (prev === p ? null : p));

  return (
    <div className="space-y-4">
      {/* Four numbers, no wrapper. These are data — how many real contests the
          price table rests on, and how often bidding the median simply loses —
          and they were hidden behind a disclosure titled "Why these numbers",
          which is where an explanation belongs, not where evidence does. The
          prose that sat under them is in Methodology. */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Genuine contests on record"
          value={data.contest_summary.n}
          hint={`${data.contest_summary.seasons ?? 0} seasons, backup claims excluded`}
        />
        <StatTile
          label="Settled on waiver priority"
          value={`${data.contest_summary.tie_pct ?? 0}%`}
          tone="warning"
          hint="ties — bidding the median loses these"
        />
        <StatTile
          label="Rivals holding 20%+ of budget"
          value={data.rival_budgets.flush_rivals}
          hint="the only claim-time lever on price"
        />
        <StatTile
          label="League-wide overpay"
          value={
            data.contest_summary.total_overpay != null && data.contest_summary.seasons
              ? `$${Math.round(data.contest_summary.total_overpay / data.contest_summary.seasons)}/yr`
              : "—"
          }
          hint={`above the minimum needed to win, across all ${data.league.teams} managers`}
        />
      </div>
      <SectionProvider name="FAAB price table">
        {data.principles.map((x, i) => (
          <Note key={i}>{x}</Note>
        ))}
        {data.contest_summary.note && <Note>{data.contest_summary.note}</Note>}
      </SectionProvider>

      <MyRoster data={data} />

      <SuggestedMoves moves={data.moves} budget={budget} />

      {data.zero_point_risks.length > 0 && (
        <Card
          title="Zero-point starter risk"
          subtitle="Hygiene, not optimisation — this is the one lineup job worth doing"
        >
          <ul className="space-y-1 text-sm">
            {data.zero_point_risks.map((z) => (
              <li key={z.player_id} className="flex flex-wrap items-start gap-2">
                <Badge tone="critical">check</Badge>
                <span className="text-gray-200">
                  {z.position} {z.name}
                </span>
                <span className="text-gray-500">— {z.reasons.join("; ")}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ── the board ──────────────────────────────────────────────── */}
      <Card
        title={`Waiver board — week ${data.week}`}
        subtitle={
          <>
            Everything not already suggested above, ranked by what it would{" "}
            <strong className="text-gray-400">add to your starting lineup</strong> under{" "}
            {data.league.name}&rsquo;s settings. Bids are percent of this league&rsquo;s ${budget} budget.
          </>
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search free agents…"
            className="w-56 rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-sm text-gray-100 placeholder:text-gray-600"
          />
          <div className="flex flex-wrap gap-1">
            {allPositions.map((p) => (
              <button
                key={p}
                onClick={() => togglePos(p)}
                title={p === "FLEX" ? "RB, WR and TE — anyone who can fill a flex slot" : undefined}
                className={`rounded px-2 py-1 text-xs font-medium ring-1 ring-inset transition-colors ${
                  posFilter === p
                    ? "bg-indigo-500/15 text-indigo-300 ring-indigo-500/40"
                    : "bg-gray-800 text-gray-400 ring-gray-700 hover:text-gray-200"
                }`}
              >
                {p}
              </button>
            ))}
            {posFilter && (
              <button
                onClick={() => setPosFilter(null)}
                className="rounded px-2 py-1 text-xs text-gray-500 hover:text-gray-300"
              >
                clear
              </button>
            )}
          </div>
          <label className="ml-auto flex items-center gap-1.5 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={onlyAboveBar}
              onChange={(e) => setOnlyAboveBar(e.target.checked)}
              className="accent-indigo-500"
              disabled={!!query.trim()}
            />
            only players who&rsquo;d start
          </label>
          <span className="text-xs text-gray-600">{rows.length} shown</span>
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-gray-500">
            {query.trim() ? (
              "No free agent matches that search."
            ) : onlyAboveBar ? (
              <>
                Everything that would improve your lineup is already in{" "}
                <strong className="text-gray-400">Suggested roster moves</strong> above, paired with the drop
                it costs. Untick the filter or search a name to browse the rest of the pool.
              </>
            ) : (
              "No free agent projects above your current starters at any slot this week."
            )}
          </p>
        ) : (
          <div className="overflow-x-auto ff-stack-wrap">
            <table className="ff-stack w-full min-w-[900px] border-collapse">
              <thead>
                <tr className="border-b border-gray-800">
                  <Th>Pos</Th>
                  <Th>Player</Th>
                  <Th className="text-right">Proj</Th>
                  <Th className="text-right">Gain</Th>
                  <Th>&nbsp;</Th>
                  <Th title="Which of YOUR starting slots he would fill, and who he displaces. A tight end can fill TE or FLEX, so he is measured against whichever is weaker — a TE at the top of this board usually means your weakest slot is a flex, not that you need a tight end.">
                    Would take
                  </Th>
                  <Th className="text-right" title="Projected fantasy points from this week to the end of the season, under this league's scoring">
                    ROS pts
                  </Th>
                  <Th className="text-right">Bye</Th>
                  <Th className="text-right" title="What this league has historically PAID for a player at this projection — a market prediction, not advice">
                    Market pays
                  </Th>
                  <Th className="text-right" title="What he is worth to YOU. Blank when he would not crack your lineup.">
                    Your bid
                  </Th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 60).map((c) => (
                  <tr key={c.player_id} className="border-b border-gray-800/60 hover:bg-gray-800/40">
                    <Td data-label="Pos" className="text-gray-500">{c.position}</Td>
                    <Td data-label="" className="ff-row-head">
                      <span className="text-gray-100">{c.name}</span>
                      <NewsPeek notes={data.news_by_player?.[c.player_id]} name={c.name} />{" "}
                      <span className="text-xs text-gray-600">{c.team ?? "FA"}</span>
                      {c.injury_status && (
                        <>
                          {" "}
                          <Badge tone="warning" title="Sleeper designation — lags beat reporting">
                            {c.injury_status}
                          </Badge>
                        </>
                      )}
                    </Td>
                    <Td data-label="Proj" className="text-right tabular-nums">{c.projected?.toFixed(1) ?? "—"}</Td>
                    <Td
                      data-label="Gain"
                      className="text-right tabular-nums"
                      style={{ color: (c.over_bar ?? 0) > 0 ? C.s3 : C.muted }}
                    >
                      {c.over_bar != null ? `${c.over_bar > 0 ? "+" : ""}${c.over_bar.toFixed(1)}` : "—"}
                    </Td>
                    <Td data-label="" className="hidden sm:table-cell">
                      <CellBar
                        value={c.over_bar != null && c.over_bar > 0 ? c.over_bar : null}
                        max={maxOver}
                        color={C.s3}
                      />
                    </Td>
                    <Td data-label="Would take" className="whitespace-nowrap text-xs">
                      {c.displaces ? (
                        <>
                          <Badge tone="neutral">{c.displaces.slot}</Badge>{" "}
                          <span className="text-gray-500">
                            from {c.displaces.name ?? "an empty slot"}{" "}
                            <span className="tabular-nums">({c.displaces.points.toFixed(1)})</span>
                          </span>
                        </>
                      ) : (
                        <span className="text-gray-700">no slot</span>
                      )}
                    </Td>
                    <Td data-label="ROS pts" className="text-right tabular-nums text-gray-400">
                      {c.ros_points?.toFixed(0) ?? "—"}
                    </Td>
                    <Td data-label="Bye" className="text-right tabular-nums text-gray-600">{c.bye_week ?? "—"}</Td>
                    <Td data-label="Market pays" className="whitespace-nowrap text-right text-xs text-gray-500">
                      {c.market_low != null ? (
                        <>
                          ${c.market_low}–${c.market_high}
                          {c.tier_n > 0 && (
                            <span className="ml-1 text-gray-600">
                              n={c.tier_n}
                              {c.tier_thin ? " thin" : ""}
                            </span>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </Td>
                    <Td data-label="Your bid" className="whitespace-nowrap text-right tabular-nums">
                      {c.suggested_bid == null ? (
                        <span className="text-xs text-gray-600" title={c.no_bid_reason ?? undefined}>
                          —
                        </span>
                      ) : (
                        <>
                          <span className="font-medium text-gray-100">{c.suggested_pct?.toFixed(1)}%</span>{" "}
                          <span className="text-xs text-gray-500">(${c.suggested_bid})</span>
                        </>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="What each tier actually costs"
          subtitle={`Winning bids in this league's own sealed-bid history, by projection tier. ${data.price_table.contests_scored} of ${data.price_table.contests_total} contests could be priced.`}
        >
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-gray-800">
                <Th>Tier</Th>
                <Th className="text-right">n</Th>
                <Th className="text-right">Median</Th>
                <Th className="text-right">p75</Th>
                <Th className="text-right">p90</Th>
                <Th>Spread</Th>
                <Th className="text-right">Next 4 wks</Th>
              </tr>
            </thead>
            <tbody>
              {data.price_table.rows.map((r) => (
                <tr key={r.tier} className="border-b border-gray-800/60">
                  <Td>
                    <Badge tone={r.tier === "11+" ? "good" : "neutral"}>{r.tier}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-right tabular-nums text-gray-500">
                    {r.n}
                    {r.thin && r.n > 0 && (
                      <>
                        {" "}
                        <Badge tone="warning">thin</Badge>
                      </>
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">{r.median != null ? `$${r.median}` : "—"}</Td>
                  <Td className="text-right tabular-nums text-gray-100">
                    {r.p75 != null ? `$${r.p75}` : "—"}
                  </Td>
                  <Td className="text-right tabular-nums text-gray-500">
                    {r.p90 != null ? `$${r.p90}` : "—"}
                  </Td>
                  <Td>
                    {r.median != null && r.p75 != null && r.p90 != null && (
                      <RangeRow median={r.median} p75={r.p75} p90={r.p90} max={priceMax} />
                    )}
                  </Td>
                  <Td className="text-right tabular-nums" style={{ color: C.s3 }}>
                    {r.mean_next4_pts != null ? r.mean_next4_pts.toFixed(0) : "—"}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex items-center gap-3 text-[11px] text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: C.s3 }} /> median
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: C.s1 }} /> p75 (suggested)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2 rounded-full" style={{ background: C.muted }} /> p90
            </span>
          </div>
          <Note>
            Read the last two columns together. If a higher tier costs the same as a lower one but returns more
            over the next four weeks, the league is not pricing on quality — and the move is to buy different
            players at the market&rsquo;s flat price rather than to outbid anyone.
          </Note>
        </Card>

        {data.rival_budgets.degenerate ? (
          <Card title="Who can still outbid you">
            <p className="text-sm text-gray-500">
              Everyone is within a few points of a full budget, so remaining FAAB distinguishes
              nobody yet. This becomes useful once the field separates — usually around week 4.
            </p>
            <Note>{data.rival_budgets.note}</Note>
          </Card>
        ) : (
        <Card title="Who can still outbid you" subtitle={`Percent of the $${budget} budget remaining, right now`}>
          <HBars
            rows={data.rival_budgets.rivals
              .slice()
              .sort((a, b) => b.pct_left - a.pct_left)
              .map((r) => ({
                label: r.owner,
                value: r.pct_left,
                emphasis: r.is_me,
                note: `$${r.used} of $${r.total} spent`,
              }))}
            max={100}
            format={(v) => `${v.toFixed(0)}%`}
          />
          <Note>{data.rival_budgets.note}</Note>
        </Card>
        )}
      </div>

      {data.budget_burn.length > 0 && (
        <Card
          title="Budget burn, averaged across seasons"
          subtitle="Cumulative percent of budget spent by week. A manager who is broke in week 10 cannot outbid you in week 10 — this beats keying on their usual bid size."
        >
          <LineChart
            xLabels={data.budget_burn[0]?.weeks ?? []}
            yMax={100}
            yFormat={(v) => `${Math.round(v)}%`}
            emphasisLabel={burnMine ? `${burnMine.owner} (you)` : undefined}
            series={data.budget_burn.map((b) => ({
              label: b.owner,
              points: b.curve,
              emphasis: b.is_me,
            }))}
          />
          <div className="mt-3 overflow-x-auto">
            <table className="ff-stack w-full min-w-[420px] border-collapse">
              <thead>
                <tr className="border-b border-gray-800">
                  <Th>Manager</Th>
                  <Th className="text-right">Spent by wk 4</Th>
                  <Th className="text-right">Season total</Th>
                  <Th className="text-right">Left unspent</Th>
                </tr>
              </thead>
              <tbody>
                {data.budget_burn.map((b) => (
                  <tr
                    key={b.owner_id}
                    className={`border-b border-gray-800/60 ${b.is_me ? "bg-indigo-500/5" : ""}`}
                  >
                    <Td data-label="" className={b.is_me ? "ff-row-head text-gray-100" : "ff-row-head"}>
                      {b.owner}
                      {b.person && b.handle && (
                        <span className="ml-1.5 text-xs text-gray-600">{b.handle}</span>
                      )}
                      {b.is_me && <span className="ml-1 text-xs text-indigo-400">you</span>}
                      {!b.active && (
                        <span className="ml-1 text-xs text-gray-600" title="No roster this season — historical bids only">
                          left the league
                        </span>
                      )}
                    </Td>
                    <Td data-label="By wk 4" className="text-right tabular-nums">{b.curve[3]?.toFixed(0)}%</Td>
                    <Td data-label="Season" className="text-right tabular-nums">{b.final.toFixed(0)}%</Td>
                    <Td data-label="Unspent" className="text-right tabular-nums">
                      {b.unspent > 25 ? (
                        <span style={{ color: C.warning }}>{b.unspent.toFixed(0)}%</span>
                      ) : (
                        <span className="text-gray-500">{b.unspent.toFixed(0)}%</span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

    </div>
  );
}

/* ── suggested roster moves ─────────────────────────────────────────── */

function SuggestedMoves({ moves, budget }: { moves: Moves; budget: number }) {
  const fa = moves?.free_agents ?? [];
  const wa = moves?.waiver_claims ?? [];
  if (!moves || (!fa.length && !wa.length)) {
    return (
      <Card title="Suggested roster moves">
        <p className="text-sm text-gray-500">
          {moves?.reason ?? "No add/drop improves your starting lineup this week."}
        </p>
        {moves?.asset_note && <Note>{moves.asset_note}</Note>}
      </Card>
    );
  }
  return (
    <Card
      title="Suggested roster moves"
      subtitle="Each pairs an add with the drop that costs least, then re-solves your lineup. The gain is what the lineup scores, not what the player scores."
      right={
        moves.base_lineup_total != null && (
          <span className="text-xs text-gray-500">
            lineup now <span className="tabular-nums text-gray-300">{moves.base_lineup_total}</span>
          </span>
        )
      }
    >
      <div className="space-y-5">
        <MoveGroup
          heading="Free agents — add right now"
          blurb="No bid, no waiting. If a starter is named on a Thursday the backup is often still a free agent for a few hours."
          tone="good"
          moves={fa}
          budget={budget}
        />
        <MoveGroup
          heading="Waiver claims — process Wednesday"
          blurb="These cost FAAB and clear on the league's waiver run. Bids are percent of budget."
          tone="info"
          moves={wa}
          budget={budget}
        />
      </div>
      {moves.asset_note && <Note>{moves.asset_note}</Note>}
      {moves.inference_note && <Note>{moves.inference_note}</Note>}
      {moves.method_note && <Note>{moves.method_note}</Note>}
    </Card>
  );
}

function MoveGroup({
  heading,
  blurb,
  tone,
  moves,
  budget,
}: {
  heading: string;
  blurb: string;
  tone: "good" | "info";
  moves: Move[];
  budget: number;
}) {
  if (!moves.length) {
    return (
      <div>
        <h4 className="mb-1 flex items-center gap-2 text-sm font-medium text-gray-300">
          <Badge tone={tone}>{tone === "good" ? "now" : "Wednesday"}</Badge>
          {heading}
        </h4>
        <p className="text-xs text-gray-600">nothing here right now</p>
      </div>
    );
  }
  return (
    <div>
      <h4 className="mb-1 flex flex-wrap items-center gap-2 text-sm font-medium text-gray-300">
        <Badge tone={tone}>{tone === "good" ? "now" : "Wednesday"}</Badge>
        {heading}
        <span className="text-xs font-normal text-gray-600">{blurb}</span>
      </h4>
      <ul className="space-y-1.5">
        {moves.map((m) => (
          <li key={m.player_id} className="rounded border border-gray-800 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="tabular-nums font-medium" style={{ color: C.s3 }}>
                +{m.gain.toFixed(1)}
              </span>
              <span className="text-gray-500">ADD</span>
              <span className="text-xs text-gray-500">{m.position}</span>
              <span className="text-gray-100">{m.name}</span>
              <span className="text-xs text-gray-600">{m.team}</span>
              {m.injury_status && <Badge tone="warning">{m.injury_status}</Badge>}
              <span className="text-gray-500">·  DROP</span>
              <span className="text-xs text-gray-500">{m.drop.position}</span>
              <span className="text-gray-400">{m.drop.name}</span>
              {m.drop.projected != null && (
                <span className="text-xs tabular-nums text-gray-600">
                  ({m.drop.projected.toFixed(1)})
                </span>
              )}
              {m.suggested_pct != null && (
                <span className="ml-auto whitespace-nowrap text-sm">
                  <span className="font-medium text-gray-100">{m.suggested_pct.toFixed(1)}%</span>{" "}
                  <span className="text-xs text-gray-500">(${m.suggested_bid})</span>
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-gray-500">
              {m.clears_at && <span>clears {m.clears_at}</span>}
              {m.dropped_by && <span>dropped by {m.dropped_by}</span>}
              {m.ros_points != null && <span>rest of season {m.ros_points.toFixed(0)}</span>}
              {m.asset_delta != null && (
                <span style={{ color: m.asset_delta < 0 ? C.warning : undefined }}>
                  market {m.asset_delta >= 0 ? "+" : ""}
                  {m.asset_delta}
                </span>
              )}
              {m.tier_n > 0 && (
                <span>
                  tier {m.tier} · n={m.tier_n}
                  {m.tier_thin ? " (thin)" : ""}
                </span>
              )}
            </div>
            {m.news.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {m.news.map((n, i) => (
                  <li key={i} className="text-xs leading-relaxed text-gray-500">
                    · {n.headline}
                    {n.url && <SourceLink href={n.url} />}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── my roster ──────────────────────────────────────────────────────── */

function MyRoster({ data }: { data: Waivers }) {
  const { slots, bench } = data.lineup;
  const news = data.news_by_player;
  if (!slots.length && !bench.length) {
    return (
      <Card title="My roster">
        <p className="text-sm text-gray-500">
          No roster in {data.league.name} yet — the league is {data.league.status.replace("_", " ")}.
        </p>
      </Card>
    );
  }
  const weakest = slots.reduce<Slotted | null>(
    (min, s) => (min == null || (s.projected ?? 0) < (min.projected ?? 0) ? s : min),
    null
  );

  return (
    <Card
      title="My roster"
      subtitle={
        <>
          Week {data.week} projections under this league&rsquo;s scoring. Bench is sorted weakest first — a claim
          needs a drop.
        </>
      }
      right={
        weakest && (
          <span className="text-xs text-gray-500">
            weakest starting slot: <span className="text-gray-300">{weakest.slot}</span> {weakest.name}{" "}
            <span className="tabular-nums">({weakest.projected?.toFixed(1)})</span>
          </span>
        )
      }
    >
      <div className="grid gap-6 md:grid-cols-2">
        <div>
          <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-500">Starting lineup</h4>
          <ul className="space-y-0.5">
            {slots.map((s, i) => (
              <li
                key={`${s.player_id}-${i}`}
                className={`flex items-center gap-2 rounded px-2 py-1 text-sm ${
                  weakest && s.player_id === weakest.player_id ? "bg-amber-500/5" : ""
                }`}
              >
                <span className="w-12 shrink-0 text-xs font-medium text-gray-500">{s.slot}</span>
                {/* The name truncates; the badge must NOT be inside it.
                    `truncate` is overflow:hidden, which clipped the popover to
                    the row — correct geometry, correct z-index, invisible. */}
                <span className="min-w-0 truncate text-gray-200">{s.name}</span>
                <NewsPeek notes={news?.[s.player_id]} name={s.name} />
                <span className="flex-1" />
                <span className="shrink-0 text-xs text-gray-600">{s.team}</span>
                {s.injury_status && <Badge tone="warning">{s.injury_status}</Badge>}
                <span className="w-12 shrink-0 text-right tabular-nums text-gray-300">
                  {s.projected?.toFixed(1) ?? "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-500">
            Bench — drop candidates first
          </h4>
          <ul className="space-y-0.5">
            {bench.map((s) => (
              <li key={s.player_id} className="flex items-center gap-2 rounded px-2 py-1 text-sm">
                <span className="w-12 shrink-0 text-xs text-gray-600">{s.position}</span>
                <span className="min-w-0 truncate text-gray-400">{s.name}</span>
                <NewsPeek notes={news?.[s.player_id]} name={s.name} />
                <span className="flex-1" />
                <span className="shrink-0 text-xs text-gray-600">{s.team}</span>
                {s.injury_status && <Badge tone="warning">{s.injury_status}</Badge>}
                <span className="w-12 shrink-0 text-right tabular-nums text-gray-500">
                  {s.projected?.toFixed(1) ?? "—"}
                </span>
              </li>
            ))}
            {bench.length === 0 && <li className="px-2 text-sm text-gray-600">empty</li>}
          </ul>
        </div>
      </div>
      <Note>
        Slots are filled from projections to show where your weakest starter sits — that is the bar every free
        agent is measured against. It is not a start/sit recommendation: measured ex ante your own lineup calls
        beat the projection-optimal one, so there are no points in this for you.
      </Note>
    </Card>
  );
}
