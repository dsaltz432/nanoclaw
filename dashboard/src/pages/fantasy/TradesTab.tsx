import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Balance, C, Card, NewsPeek, Note, PeekNote, Td, Th } from "./viz";

type Asset = {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  is_pick: boolean;
  market_value: number | null;
  ros_points: number | null;
  owner?: string | null;
};

type RosterPlayer = Asset & {
  age: number | null;
  injury_status: string | null;
  league_vor: number | null;
  market_trend_30d: number | null;
};

type Roster = {
  owner_id: string;
  owner: string;
  is_me: boolean;
  players: RosterPlayer[];
  total_market: number;
  startable_vor: number;
  above_replacement: number;
};

type Priced = RosterPlayer & {
  replacement: number | null;
  market_rank: number | null;
  known: boolean;
};

type Evaluation = {
  league_key: string;
  league_name: string;
  mode: "dynasty" | "redraft";
  market_format: string;
  give: Priced[];
  get: Priced[];
  totals: {
    give_vor: number;
    get_vor: number;
    vor_delta: number;
    give_market: number;
    get_market: number;
    market_delta: number;
    market_pct: number | null;
  };
  primary: "market" | "vor";
  notes: string[];
  limitation: string;
};

type PosDetail = {
  required: number;
  have: number;
  starting?: number;
  starter_vor: number;
  surplus_startable: number;
  surplus_vor: number;
  short: number;
  flex_slots: number;
  depth_vor: number;
  next_man_up: string | null;
  top_starter: string | null;
  top_starter_vor: number;
  injury_cost: number;
  covered: number;
  strength_pct: number;
  rank: number;
  of: number;
  grade: "hole" | "weak" | "average" | "strong";
  shape: "empty" | "top-heavy" | "balanced" | "deep";
  market: "buy-starter" | "buy-depth" | "sell" | "hold";
  reading: string;
};

type TradesData = {
  league: string;
  mode: string;
  market_format: string;
  rosters: Roster[];
  news_by_player: Record<string, PeekNote[]>;
  counterparties: {
    counterparties: {
      owner_id: string;
      owner: string;
      handle?: string;
      person?: string | null;
      trades: number;
      proposed: number;
      accepted: number;
      accept_share: number | null;
      thin: boolean;
    }[];
    n_trades: number;
    me: { proposed: number; accepted: number; trades: number };
    note: string;
  };
  insights: {
    position: string;
    rostered: number;
    startable_slots: number;
    replacement: number;
    spare: { player_id: string; name: string; ros_points: number | null; vor: number | null; market_value: number | null }[];
    spare_market: number;
    headline: string;
    detail: string;
  }[];
  needs: {
    replacement: Record<string, number>;
    reason?: string;
    legend?: { grade: string; means: string }[];
    rosters: {
      owner_id: string;
      owner: string;
      is_me: boolean;
      team: {
        lineup_vor: number;
        bench_vor: number;
        holes: string[];
        rank: number;
        of: number;
        strongest?: string;
        weakest?: string;
      };
      positions: Record<string, PosDetail>;
    }[];
  };
  suggestions: {
    suggestions: {
      counterparty: string;
      owner_id: string;
      i_send: string;
      i_receive: string;
      my_surplus_vor: number;
      their_surplus_vor: number;
      fit_score: number;
      their_trades: number;
      their_accept_share: number | null;
      thin_history: boolean;
    }[];
    note: string;
    volume_warning: string;
  };
};

type Package = {
  counterparty: string;
  owner_id: string;
  give: RosterPlayer[];
  get: RosterPlayer[];
  my_gain: number;
  their_gain: number;
  value_out: number;
  value_in: number;
  value_delta: number;
  market_out: number;
  market_in: number;
  market_delta: number;
  market_pct: number | null;
  market_equivalent: number | null;
  score: number;
};

type Generated = {
  packages: Package[];
  counterparty: string | null;
  searched: number;
  considered: number;
  objective: string;
  method: string;
  limitation: string;
  units_note: string;
  market_note: string;
  pool_note?: string;
  rate_note?: string | null;
  exchange_rate?: number | null;
  season_note: string | null;
  value_basis: string;
  reason?: string;
};

export default function TradesTab({ league }: { league: string }) {
  const [data, setData] = useState<TradesData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [give, setGive] = useState<Asset[]>([]);
  const [get, setGet] = useState<Asset[]>([]);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [pinMine, setPinMine] = useState<RosterPlayer[]>([]);
  const [pinTheirs, setPinTheirs] = useState<RosterPlayer[]>([]);
  // Pins live alongside the working deal rather than in a separate panel: the
  // players you are building around and the players you want held constant in a
  // search are the same players, and splitting them into two lists made you
  // enter each one twice.
  const [generated, setGenerated] = useState<Generated | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    setGive([]);
    setGet([]);
    setEvaluation(null);
    setPartnerId(null);
    setPinMine([]);
    setPinTheirs([]);
    setGenerated(null);
    setData(null);
    fetch(`/api/fantasy/trades?league=${encodeURIComponent(league)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setErr(d.error);
        setErr(null);
        setData(d);
        const first = (d.rosters as Roster[]).find((r) => !r.is_me);
        setPartnerId(first?.owner_id ?? null);
      })
      .catch((e) => setErr(String(e)));
  }, [league]);

  useEffect(() => {
    if (!give.length && !get.length) {
      setEvaluation(null);
      return;
    }
    const q = new URLSearchParams({
      league,
      give: give.map((g) => g.player_id).join(","),
      get: get.map((g) => g.player_id).join(","),
    });
    fetch(`/api/fantasy/trade-eval?${q}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : setEvaluation(d)))
      .catch((e) => setErr(String(e)));
  }, [league, give, get]);

  const mine = data?.rosters.find((r) => r.is_me) ?? null;
  const partner = data?.rosters.find((r) => r.owner_id === partnerId) ?? null;

  // The first rival player in "You get" fixes the counterparty for the rest of
  // that side. Every trade in these leagues is two-team — 98 completed trades
  // and not one three-way — so a second roster on the receiving side is not a
  // trade that can be proposed.
  const lockedTo = useMemo(() => {
    for (const a of get) {
      const owner = data?.rosters.find((r) =>
        r.players.some((p) => p.player_id === a.player_id)
      );
      if (owner && !owner.is_me) return owner.owner_id;
    }
    return null;
  }, [get, data]);
  const lockedToName = data?.rosters.find((r) => r.owner_id === lockedTo)?.owner ?? null;
  const mode = data?.mode ?? (league === "dynasty" ? "dynasty" : "redraft");

  // Adding one of their players to "You get" tells us who you are dealing with,
  // so the roster panel follows. Building a deal against the wrong roster was
  // the easiest mistake to make in the previous version.
  const ownerOfPlayer = useCallback(
    (pid: string) => data?.rosters.find((r) => r.players.some((p) => p.player_id === pid)),
    [data]
  );

  const add = useCallback(
    (side: "give" | "get", a: Asset) => {
      // Belt and braces: the search is already restricted by side, but the
      // roster panels and generated packages also feed this path.
      const owner = ownerOfPlayer(a.player_id);
      const isPick = a.is_pick || /^(DP|FP)_/.test(a.player_id);
      if (!isPick && owner) {
        if (side === "give" && !owner.is_me) return;
        if (side === "get" && owner.is_me) return;
      }
      const setter = side === "give" ? setGive : setGet;
      setter((prev) => (prev.some((x) => x.player_id === a.player_id) ? prev : [...prev, a]));
      if (side === "get" && owner && !owner.is_me) setPartnerId(owner.owner_id);
    },
    [ownerOfPlayer]
  );

  const togglePin = useCallback(
    (side: "mine" | "theirs", p: Asset) => {
      const setter = side === "mine" ? setPinMine : setPinTheirs;
      const already = (side === "mine" ? pinMine : pinTheirs).some(
        (x) => x.player_id === p.player_id
      );
      setter((prev) =>
        already
          ? prev.filter((x) => x.player_id !== p.player_id)
          : [...prev, p as RosterPlayer]
      );
      // A pin is also a piece of the deal. Adding it to the matching column
      // keeps one list instead of two — unpinning leaves the chip in place, so
      // you can still price a player you no longer want held constant.
      if (!already) {
        const col = side === "mine" ? setGive : setGet;
        const cur = side === "mine" ? give : get;
        if (!cur.some((x) => x.player_id === p.player_id)) col([...cur, p]);
      }
      if (side === "theirs") {
        const owner = ownerOfPlayer(p.player_id);
        if (owner && !owner.is_me) setPartnerId(owner.owner_id);
      }
    },
    [ownerOfPlayer, pinMine, pinTheirs, give, get]
  );

  const runGenerate = useCallback(
    (opts?: { counterparty?: string | null }) => {
      setGenerating(true);
      setGenerated(null);
      const params = new URLSearchParams({ league, limit: "12" });
      if (pinMine.length) params.set("pin_mine", pinMine.map((p) => p.player_id).join(","));
      if (pinTheirs.length) params.set("pin_theirs", pinTheirs.map((p) => p.player_id).join(","));
      const cp = opts?.counterparty;
      if (cp) params.set("counterparty", cp);
      fetch(`/api/fantasy/trade-generate?${params}`)
        .then((r) => r.json())
        .then((d) => (d.error ? setErr(d.error) : setGenerated(d)))
        .catch((e) => setErr(String(e)))
        .finally(() => setGenerating(false));
    },
    [league, pinMine, pinTheirs]
  );

  const loadPackage = useCallback((p: Package) => {
    setGive(p.give);
    setGet(p.get);
    setPartnerId(p.owner_id);
  }, []);

  if (err) return <div className="p-6 text-sm text-red-400">{err}</div>;
  if (!data) return <div className="p-6 text-sm text-gray-500">Loading trade data…</div>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
        <Badge tone={mode === "dynasty" ? "info" : "neutral"}>
          {mode === "dynasty" ? "DYNASTY MODE" : "REDRAFT MODE"}
        </Badge>
        <span className="text-sm text-gray-400">
          {mode === "dynasty"
            ? "Market value leads — a dynasty asset is mostly future seasons, which no rest-of-season projection can see. Draft picks are priced and included."
            : "League VOR leads — rest-of-season points above replacement, under this league's own scoring. Market value is shown because your counterparty is probably using it."}
        </span>
        <span className="ml-auto text-xs text-gray-600">values: {data.market_format}</span>
      </div>

      <TradeBuilder
        league={league}
        give={give}
        get={get}
        setGive={setGive}
        setGet={setGet}
        evaluation={evaluation}
        lockedTo={lockedTo}
        lockedToName={lockedToName}
        pinMine={pinMine}
        pinTheirs={pinTheirs}
        onTogglePin={togglePin}
        onGenerate={runGenerate}
        generating={generating}
        generated={generated}
        onLoad={loadPackage}
        partnerName={data.rosters.find((r) => r.owner_id === partnerId)?.owner ?? null}
        partnerId={partnerId}
      />

      {/* ── the two rosters, side by side, click to build the deal ─── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <RosterPanel
          title="My roster"
          roster={mine}
          mode={mode}
          actionLabel="give"
          selected={give.map((g) => g.player_id)}
          onPick={(p) => add("give", p)}
          pinned={pinMine.map((p) => p.player_id)}
          onPin={(p) => togglePin("mine", p)}
          news={data.news_by_player}
        />
        <RosterPanel
          title="Their roster"
          roster={partner}
          mode={mode}
          actionLabel="get"
          selected={get.map((g) => g.player_id)}
          onPick={(p) => add("get", p)}
          pinned={pinTheirs.map((p) => p.player_id)}
          onPin={(p) => togglePin("theirs", p)}
          news={data.news_by_player}
          picker={
            <select
              value={partnerId ?? ""}
              onChange={(e) => setPartnerId(e.target.value)}
              className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200"
            >
              {data.rosters
                .filter((r) => !r.is_me)
                .map((r) => (
                  <option key={r.owner_id} value={r.owner_id}>
                    {r.owner}
                  </option>
                ))}
            </select>
          }
        />
      </div>

      <RosterInsights data={data} />

      <NeedsGrid data={data} />

      <Card
        title="Positional fit"
        subtitle="Startable surplus you cannot start, against a gap somebody else cannot fill"
      >
        {data.suggestions.suggestions.length === 0 ? (
          <p className="text-sm text-gray-500">
            No clean positional mismatch right now. That is a normal result, not a bug —{" "}
            {data.suggestions.volume_warning}
          </p>
        ) : (
          <ul className="grid gap-2 md:grid-cols-2">
            {data.suggestions.suggestions.map((s, i) => (
              <li key={i} className="rounded border border-gray-800 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <button
                    onClick={() => setPartnerId(s.owner_id)}
                    className="text-gray-100 underline decoration-gray-700 underline-offset-2 hover:decoration-indigo-400"
                    title="Load this manager's roster above"
                  >
                    {s.counterparty}
                  </button>
                  <span className="text-gray-500">— send</span>
                  <Badge tone="neutral">{s.i_send}</Badge>
                  <span className="text-gray-500">for</span>
                  <Badge tone="info">{s.i_receive}</Badge>
                </div>
                <div className="mt-1 text-xs text-gray-500">
                  fit {s.fit_score} · your spare {s.i_send} VOR {s.my_surplus_vor} · their spare {s.i_receive}{" "}
                  VOR {s.their_surplus_vor} · {s.their_trades} completed trades
                  {s.their_accept_share != null && `, ${s.their_accept_share.toFixed(0)}% accepted`}
                </div>
              </li>
            ))}
          </ul>
        )}
        <Note>{data.suggestions.note}</Note>
        <Note>{data.suggestions.volume_warning}</Note>
      </Card>

      {/* ── background, not deal-making: keep it last ──────────────── */}
      <Card
        title="Who actually accepts"
        subtitle="Background on how each manager behaves — useful before you open a conversation, not while you are pricing one"
      >
        <div className="overflow-x-auto ff-stack-wrap">
          <table className="ff-stack w-full min-w-[520px] border-collapse">
            <thead>
              <tr className="border-b border-gray-800">
                <Th>Manager</Th>
                <Th className="text-right">Trades</Th>
                <Th className="text-right">Proposed</Th>
                <Th className="text-right">Accepted</Th>
                <Th className="text-right">Accept share</Th>
                <Th>&nbsp;</Th>
              </tr>
            </thead>
            <tbody>
              {data.counterparties.counterparties.map((c) => (
                <tr key={c.owner_id} className="border-b border-gray-800/60">
                  <Td data-label="" className="ff-row-head">
                    {c.owner}
                    {c.person && c.handle && (
                      <span className="ml-1.5 text-xs text-gray-600">{c.handle}</span>
                    )}
                  </Td>
                  <Td data-label="Trades" className="text-right tabular-nums text-gray-500">{c.trades}</Td>
                  <Td data-label="Proposed" className="text-right tabular-nums text-gray-500">{c.proposed}</Td>
                  <Td data-label="Accepted" className="text-right tabular-nums text-gray-500">{c.accepted}</Td>
                  <Td data-label="Accept share" className="whitespace-nowrap text-right tabular-nums">
                    <span style={{ color: (c.accept_share ?? 0) >= 70 ? C.s3 : C.ink2 }}>
                      {c.accept_share != null ? `${c.accept_share.toFixed(0)}%` : "—"}
                    </span>
                    {c.thin && (
                      <>
                        {" "}
                        <Badge tone="warning" title="Fewer than 8 completed trades — anecdote, not a model">
                          thin
                        </Badge>
                      </>
                    )}
                  </Td>
                  <Td data-label="">
                    <button
                      onClick={() => setPartnerId(c.owner_id)}
                      className="text-xs text-indigo-400 hover:text-indigo-300"
                    >
                      load roster
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Note>{data.counterparties.note}</Note>
      </Card>
    </div>
  );
}

/* ── roster panel ───────────────────────────────────────────────────── */

const POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];

function RosterPanel({
  title,
  roster,
  mode,
  actionLabel,
  selected,
  onPick,
  pinned = [],
  onPin,
  news,
  picker,
}: {
  title: string;
  roster: Roster | null;
  mode: string;
  actionLabel: "give" | "get";
  selected: string[];
  onPick: (p: RosterPlayer) => void;
  pinned?: string[];
  onPin?: (p: RosterPlayer) => void;
  news?: Record<string, PeekNote[]>;
  picker?: React.ReactNode;
}) {
  const [pos, setPos] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const players = useMemo(() => {
    if (!roster) return [];
    const query = q.trim().toLowerCase();
    return roster.players.filter(
      (p) => (!pos || p.position === pos) && (!query || p.name.toLowerCase().includes(query))
    );
  }, [roster, pos, q]);

  const available = useMemo(() => {
    if (!roster) return [];
    return POS_ORDER.filter((p) => roster.players.some((x) => x.position === p));
  }, [roster]);

  if (!roster) {
    return (
      <Card title={title} right={picker}>
        <p className="text-sm text-gray-500">No roster available — the league has not drafted yet.</p>
      </Card>
    );
  }

  return (
    <Card
      title={title}
      subtitle={
        <>
          {roster.owner} · {roster.players.length} players · market{" "}
          <span className="tabular-nums">{roster.total_market.toLocaleString()}</span> ·{" "}
          <span className="tabular-nums">{roster.above_replacement}</span> above replacement, worth{" "}
          <span className="tabular-nums">{roster.startable_vor.toFixed(0)}</span> VOR
        </>
      }
      right={picker}
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter…"
          className="w-28 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100 placeholder:text-gray-600"
        />
        {available.map((p) => (
          <button
            key={p}
            onClick={() => setPos(pos === p ? null : p)}
            className={`rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset transition-colors ${
              pos === p
                ? "bg-indigo-500/15 text-indigo-300 ring-indigo-500/40"
                : "bg-gray-800 text-gray-400 ring-gray-700 hover:text-gray-200"
            }`}
          >
            {p}
          </button>
        ))}
      </div>

      <div className="max-h-[26rem] overflow-y-auto">
        <table className="w-full border-collapse">
          <thead className="sticky top-0 bg-gray-900">
            <tr className="border-b border-gray-800">
              <Th>Pos</Th>
              <Th>Player</Th>
              <Th className="text-right">{mode === "dynasty" ? "Market" : "ROS"}</Th>
              <Th className="hidden text-right sm:table-cell">
                {mode === "dynasty" ? "ROS" : "Market"}
              </Th>
              <Th className="text-right">VOR</Th>
              <Th>&nbsp;</Th>
              <Th>&nbsp;</Th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => {
              const chosen = selected.includes(p.player_id);
              const isPinned = pinned.includes(p.player_id);
              return (
                <tr
                  key={p.player_id}
                  className={`border-b border-gray-800/60 ${
                    isPinned ? "bg-amber-500/5" : chosen ? "bg-indigo-500/5" : "hover:bg-gray-800/40"
                  }`}
                >
                  <Td className="text-xs text-gray-500">{p.position}</Td>
                  <Td>
                    <span className={chosen ? "text-indigo-300" : "text-gray-200"}>{p.name}</span>
                    <NewsPeek notes={news?.[p.player_id]} name={p.name} />{" "}
                    <span className="text-xs text-gray-600">{p.team}</span>
                    {p.injury_status && (
                      <>
                        {" "}
                        <Badge tone="warning">{p.injury_status}</Badge>
                      </>
                    )}
                  </Td>
                  <Td className="text-right tabular-nums text-gray-300">
                    {mode === "dynasty"
                      ? p.market_value?.toLocaleString() ?? "—"
                      : p.ros_points?.toFixed(0) ?? "—"}
                  </Td>
                  <Td className="hidden text-right tabular-nums text-gray-500 sm:table-cell">
                    {mode === "dynasty"
                      ? p.ros_points?.toFixed(0) ?? "—"
                      : p.market_value?.toLocaleString() ?? "—"}
                  </Td>
                  <Td className="text-right tabular-nums text-gray-500">
                    {p.league_vor != null ? p.league_vor.toFixed(0) : "—"}
                  </Td>
                  <Td>
                    <button
                      onClick={() => onPick(p)}
                      disabled={chosen}
                      className={`rounded px-1.5 py-0.5 text-[11px] ring-1 ring-inset ${
                        chosen
                          ? "cursor-default text-indigo-400 ring-indigo-500/30"
                          : "text-gray-400 ring-gray-700 hover:text-gray-100 hover:ring-gray-500"
                      }`}
                    >
                      {chosen ? "added" : actionLabel}
                    </button>
                  </Td>
                  <Td>
                    {onPin && (
                      <button
                        onClick={() => onPin(p)}
                        title="Pin — every generated package will contain this player"
                        className={`rounded px-1.5 py-0.5 text-[11px] ring-1 ring-inset ${
                          isPinned
                            ? "bg-amber-500/10 text-amber-300 ring-amber-500/40"
                            : "text-gray-500 ring-gray-800 hover:text-gray-200 hover:ring-gray-600"
                        }`}
                      >
                        {isPinned ? "pinned" : "pin"}
                      </button>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {players.length === 0 && <p className="py-3 text-sm text-gray-600">Nothing matches that filter.</p>}
      </div>
    </Card>
  );
}

function AssetSearch({
  league,
  onPick,
  exclude,
  side,
  counterparty,
  placeholder,
}: {
  league: string;
  onPick: (a: Asset) => void;
  exclude: string[];
  /** Which half of the deal this box fills. The server restricts the result set
   *  so a player can only ever be offered on a side he could actually be on. */
  side: "mine" | "theirs";
  counterparty?: string | null;
  placeholder?: string;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Asset[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(
    (value: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const params = new URLSearchParams({ league, limit: "20", side });
        if (counterparty) params.set("counterparty", counterparty);
        if (value.trim()) params.set("q", value.trim());
        fetch(`/api/fantasy/assets?${params}`)
          .then((r) => r.json())
          .then((d) => setResults(d.assets ?? []))
          .catch(() => setResults([]));
      }, 180);
    },
    [league, side, counterparty]
  );

  return (
    <div className="relative">
      <input
        value={q}
        placeholder={placeholder ?? "search players or picks…"}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
          search(e.target.value);
        }}
        onFocus={() => {
          setOpen(true);
          if (!results.length) search(q);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className="w-full rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-sm text-gray-100 placeholder:text-gray-600"
      />
      {open && results.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded border border-gray-700 bg-gray-900 shadow-xl">
          {results
            .filter((r) => !exclude.includes(r.player_id))
            .map((r) => (
              <li key={r.player_id}>
                <button
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onPick(r);
                    setQ("");
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-gray-800"
                >
                  <span className="w-9 shrink-0 text-xs text-gray-500">{r.position}</span>
                  <span className="min-w-0 flex-1 truncate text-gray-200">{r.name}</span>
                  {r.owner && <span className="shrink-0 text-[11px] text-gray-600">{r.owner}</span>}
                  <span className="shrink-0 text-xs tabular-nums text-gray-500">
                    {r.market_value != null ? r.market_value.toLocaleString() : ""}
                  </span>
                </button>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

/* ── positional needs ───────────────────────────────────────────────── */

const GRADE_TONE: Record<string, string> = {
  hole: C.critical,
  weak: C.warning,
  average: C.ink2,
  strong: C.s3,
};

const MARKET_LABEL: Record<string, string> = {
  "buy-starter": "needs a starter",
  "buy-depth": "needs a backup",
  sell: "can sell",
  hold: "settled",
};

/**
 * Positional strength, every roster.
 *
 * The panel this replaces printed one number per cell — startable surplus — and
 * that number could not tell apart the two rosters it most matters to tell
 * apart. A manager with two elite backs and nobody behind them scored the same
 * zero as a manager with six replacement-level ones. They are opposite
 * counterparties: the first will not sell a back at any price and is shopping
 * for depth; the second has nothing you want.
 *
 * So each cell now carries strength (a rank inside this league, because a
 * constant would be wrong in two of the three) and shape (what an injury to
 * their best player would actually cost the lineup), and states the conclusion:
 * what this manager is in the market for at this position.
 */
function NeedsGrid({ data }: { data: TradesData }) {
  const [openRow, setOpenRow] = useState<string | null>(null);
  const positions = useMemo(() => {
    const s = new Set<string>();
    data.needs.rosters.forEach((r) => Object.keys(r.positions).forEach((p) => s.add(p)));
    const order = ["QB", "RB", "WR", "TE", "K", "DEF"];
    return Array.from(s).sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
  }, [data]);

  if (data.needs.reason) {
    return (
      <Card title="Positional strength, every roster">
        <p className="text-sm text-gray-500">{data.needs.reason}</p>
      </Card>
    );
  }

  return (
    <Card
      title="Positional strength, every roster"
      subtitle="Who is shopping for what — click a row for the reasoning"
    >
      <div className="overflow-x-auto ff-stack-wrap">
        <table className="w-full min-w-[720px] border-collapse">
          <thead>
            <tr className="border-b border-gray-800">
              <Th>Manager</Th>
              <Th className="text-right">Lineup</Th>
              {positions.map((p) => (
                <Th key={p} className="text-center">
                  {p}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.needs.rosters.map((r) => {
              const open = openRow === r.owner_id;
              return (
                <Fragment key={r.owner_id}>
                  <tr
                    onClick={() => setOpenRow(open ? null : r.owner_id)}
                    className={`cursor-pointer border-b border-gray-800/60 hover:bg-gray-800/30 ${
                      r.is_me ? "bg-indigo-500/5" : ""
                    }`}
                  >
                    <Td className={r.is_me ? "text-gray-100" : ""}>
                      <span className="mr-1 text-gray-700">{open ? "▾" : "▸"}</span>
                      {r.owner}
                      {r.is_me && <span className="ml-1 text-xs text-indigo-400">you</span>}
                    </Td>
                    <Td className="whitespace-nowrap text-right text-xs tabular-nums text-gray-500">
                      {/* Rank, not raw points: 571 VOR means nothing without
                          the eleven other numbers it is being compared to. */}
                      {r.team.rank}
                      <span className="text-gray-700">/{r.team.of}</span>
                    </Td>
                    {positions.map((p) => {
                      const d = r.positions[p];
                      if (!d || d.grade === undefined)
                        return (
                          <Td key={p} className="text-center text-gray-700">
                            —
                          </Td>
                        );
                      return (
                        <Td key={p} className="px-1 text-center">
                          <PosCell d={d} />
                        </Td>
                      );
                    })}
                  </tr>
                  {open && (
                    <tr className="border-b border-gray-800/60 bg-gray-950/40">
                      <td colSpan={positions.length + 2} className="px-4 py-3">
                        <div className="mb-2 text-xs text-gray-500">
                          Lineup ranks {r.team.rank} of {r.team.of}
                          {r.team.strongest && ` · strongest ${r.team.strongest}`}
                          {r.team.weakest && ` · weakest ${r.team.weakest}`}
                          {r.team.holes.length > 0 && (
                            <span style={{ color: C.critical }}>
                              {" "}
                              · cannot fill {r.team.holes.join(", ")}
                            </span>
                          )}
                        </div>
                        <ul className="space-y-1">
                          {positions
                            .map((p) => ({ p, d: r.positions[p] }))
                            .filter((x): x is { p: string; d: PosDetail } =>
                              x.d != null && x.d.grade !== undefined)
                            .map(({ p, d }) => (
                              <li key={p} className="flex gap-2 text-xs leading-relaxed">
                                <span
                                  className="w-8 shrink-0 font-medium"
                                  style={{ color: GRADE_TONE[d.grade] }}
                                >
                                  {p}
                                </span>
                                <span className="text-gray-400">{d.reading}</span>
                              </li>
                            ))}
                        </ul>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-600">
        {(data.needs.legend ?? []).map((l) => (
          <span key={l.grade} title={l.means}>
            <span style={{ color: GRADE_TONE[l.grade] }}>■</span> {l.grade}
          </span>
        ))}
        <span>· the second line is what they are shopping for</span>
      </div>

      <Note>
        Strength is a rank inside this league, not an absolute: top quarter is strong, bottom quarter weak.
        Shape comes from re-solving each lineup without its best player at that position, so &ldquo;covered&rdquo;
        is the share of him the bench would actually replace and a flex that absorbs the loss counts.
        Replacement level used: {Object.entries(data.needs.replacement)
          .filter(([p]) => p !== "FB" && p !== "K")
          .map(([p, v]) => `${p} ${Math.round(v)}`)
          .join(" · ")}
        .
      </Note>
    </Card>
  );
}

function PosCell({ d }: { d: PosDetail }) {
  const tone = GRADE_TONE[d.grade] ?? C.ink2;
  const tip =
    `${d.reading}\n\n` +
    `rank ${d.rank} of ${d.of} · ${d.have} rostered, ${d.starting ?? 0} starting` +
    (d.flex_slots ? ` (${d.flex_slots} in flex)` : "") +
    `\nbench covers ${Math.round(d.covered * 100)}% of ${d.top_starter ?? "the top starter"}` +
    `\nspare startable: ${d.surplus_startable}` +
    (d.surplus_startable ? ` worth ${Math.round(d.surplus_vor)} VOR` : "");
  return (
    <span className="inline-flex flex-col items-center leading-tight" title={tip}>
      <span className="text-xs font-medium" style={{ color: tone }}>
        {d.short > 0 ? `${d.short} empty` : d.grade}
      </span>
      <span className="text-[10px] text-gray-600">{MARKET_LABEL[d.market] ?? d.market}</span>
    </span>
  );
}

/* ── trade builder ──────────────────────────────────────────────────────
 *
 * One panel, not two. The players you are building a deal around and the
 * players you want held constant while searching are the same players — the
 * earlier split into a "calculator" and a separate "find trades" card meant
 * entering each name twice and reading two valuations that were about the same
 * deal. Here a chip in either column carries both actions: it is priced, and it
 * can be pinned so every generated package keeps it.
 */

function TradeBuilder({
  league,
  give,
  get,
  setGive,
  setGet,
  evaluation,
  pinMine,
  pinTheirs,
  onTogglePin,
  onGenerate,
  generating,
  generated,
  onLoad,
  partnerName,
  partnerId,
  lockedTo,
  lockedToName,
}: {
  league: string;
  give: Asset[];
  get: Asset[];
  setGive: (a: Asset[]) => void;
  setGet: (a: Asset[]) => void;
  evaluation: Evaluation | null;
  pinMine: RosterPlayer[];
  pinTheirs: RosterPlayer[];
  onTogglePin: (side: "mine" | "theirs", p: Asset) => void;
  onGenerate: (opts?: { counterparty?: string | null }) => void;
  generating: boolean;
  generated: Generated | null;
  onLoad: (p: Package) => void;
  partnerName: string | null;
  partnerId: string | null;
  /** Once one of their players is in the deal, the rest of that side must come
   *  from the same roster — every trade in these leagues is two-team. */
  lockedTo: string | null;
  lockedToName: string | null;
}) {
  const t = evaluation?.totals;
  const primary = evaluation?.primary ?? "market";
  const delta = primary === "market" ? t?.market_delta ?? 0 : t?.vor_delta ?? 0;
  const scale =
    primary === "market"
      ? Math.max(1, (t?.give_market ?? 0) + (t?.get_market ?? 0)) / 2
      : Math.max(1, Math.abs(t?.give_vor ?? 0) + Math.abs(t?.get_vor ?? 0)) / 2;

  const verdict =
    !evaluation || (!give.length && !get.length)
      ? null
      : Math.abs(delta) < scale * 0.06
      ? { tone: "neutral" as const, text: "roughly even" }
      : delta > 0
      ? { tone: "good" as const, text: "favours you" }
      : { tone: "critical" as const, text: "favours them" };

  const pinnedIds = [...pinMine, ...pinTheirs].map((p) => p.player_id);
  const anyPinned = pinnedIds.length > 0;
  const empty = give.length === 0 && get.length === 0;

  return (
    <Card
      title="Trade builder"
      subtitle="Price a deal, or pin the pieces you want kept and let it search the league for the rest."
      right={
        !empty && (
          <button
            onClick={() => {
              setGive([]);
              setGet([]);
            }}
            className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:text-gray-200"
          >
            clear deal
          </button>
        )
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <BuilderSide
          title="You give"
          side="mine"
          placeholder="search your roster or a pick…"
          league={league}
          items={give}
          onAdd={(a) => setGive([...give.filter((x) => x.player_id !== a.player_id), a])}
          onRemove={(id) => setGive(give.filter((x) => x.player_id !== id))}
          onTogglePin={(a) => onTogglePin("mine", a)}
          pinnedIds={pinnedIds}
          priced={evaluation?.give}
          accent={C.critical}
        />
        <BuilderSide
          title="You get"
          side="theirs"
          counterparty={lockedTo}
          placeholder={
            lockedTo ? `search ${lockedToName}'s roster…` : "search a rival's roster or a pick…"
          }
          league={league}
          items={get}
          onAdd={(a) => setGet([...get.filter((x) => x.player_id !== a.player_id), a])}
          onRemove={(id) => setGet(get.filter((x) => x.player_id !== id))}
          onTogglePin={(a) => onTogglePin("theirs", a)}
          pinnedIds={pinnedIds}
          priced={evaluation?.get}
          accent={C.s1}
        />
      </div>

      {/* ── valuation ─────────────────────────────────────────────── */}
      {evaluation && t && (
        <div className="mt-4 rounded-lg border border-gray-800 bg-gray-950/60 p-4">
          <div className="flex flex-wrap items-center gap-4">
            <div>
              <div className="text-xs text-gray-500">
                {primary === "market" ? "Market value" : "League VOR"} (primary)
              </div>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span
                  className="text-2xl font-semibold tabular-nums"
                  style={{ color: delta >= 0 ? C.s1 : C.critical }}
                >
                  {delta >= 0 ? "+" : ""}
                  {primary === "market" ? t.market_delta.toLocaleString() : t.vor_delta.toFixed(1)}
                </span>
                {verdict && <Badge tone={verdict.tone}>{verdict.text}</Badge>}
              </div>
            </div>
            <div className="min-w-[240px]">
              <Balance delta={delta} scale={scale} />
              <div className="mt-1 flex justify-between text-[11px] text-gray-600">
                <span>favours them</span>
                <span>favours you</span>
              </div>
            </div>
            <div className="ml-auto grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-gray-400">
              <span>Market out</span>
              <span className="text-right tabular-nums">{t.give_market.toLocaleString()}</span>
              <span>Market in</span>
              <span className="text-right tabular-nums">{t.get_market.toLocaleString()}</span>
              <span>VOR out (this season)</span>
              <span className="text-right tabular-nums">{t.give_vor.toFixed(1)}</span>
              <span>VOR in (this season)</span>
              <span className="text-right tabular-nums">{t.get_vor.toFixed(1)}</span>
            </div>
          </div>

          {primary === "market" && t.market_pct != null && (
            <p className="mt-3 text-xs text-gray-500">
              You receive {t.market_pct >= 0 ? "+" : ""}
              {t.market_pct.toFixed(0)}% of what you send, by market value.
            </p>
          )}

          {evaluation.notes.map((n, i) => (
            <Note key={i}>{n}</Note>
          ))}
          <Note>{evaluation.limitation}</Note>
        </div>
      )}

      {/* ── search ────────────────────────────────────────────────── */}
      <div className="mt-4 border-t border-gray-800 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => onGenerate()}
            disabled={generating}
            className="rounded bg-indigo-500/15 px-3 py-1.5 text-xs font-medium text-indigo-300 ring-1 ring-inset ring-indigo-500/40 hover:bg-indigo-500/25 disabled:opacity-50"
          >
            {generating
              ? "searching…"
              : anyPinned
              ? `find trades around ${pinnedIds.length} pinned`
              : "find trades across the league"}
          </button>
          {partnerId && (
            <button
              onClick={() => onGenerate({ counterparty: partnerId })}
              disabled={generating}
              className="rounded px-2 py-1.5 text-xs text-gray-400 ring-1 ring-inset ring-gray-700 hover:text-gray-100 disabled:opacity-50"
            >
              {partnerName} only
            </button>
          )}
          <span className="text-xs text-gray-600">
            {anyPinned
              ? "every package will contain the pinned players"
              : "pin a chip above, or on a roster below, to hold it constant"}
          </span>
        </div>

        {generated && (
          <div className="mt-3">
            {generated.reason ? (
              <p className="text-sm text-amber-300/80">{generated.reason}</p>
            ) : generated.packages.length === 0 ? (
              <p className="text-sm text-gray-500">
                Nothing viable across {generated.searched} team
                {generated.searched === 1 ? "" : "s"}. With nothing pinned that means no package improves
                both lineups — the normal answer in a league where everyone drafted sensibly.
              </p>
            ) : (
              <>
                <div className="mb-2 flex flex-wrap items-baseline gap-2 text-xs text-gray-500">
                  <Badge tone="info">{generated.objective}</Badge>
                  <span>
                    {generated.packages.length} shown of {generated.considered} viable, across{" "}
                    {generated.searched} team{generated.searched === 1 ? "" : "s"}
                  </span>
                  {generated.counterparty && <span>· {generated.counterparty} only</span>}
                </div>
                <ul className="space-y-1.5">
                  {generated.packages.map((p, i) => (
                    <li key={i} className="rounded border border-gray-800 px-3 py-2 hover:bg-gray-800/30">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                        <span className="min-w-[9rem] text-gray-100">{p.counterparty}</span>
                        <span className="text-xs text-gray-500">send</span>
                        <span className="text-gray-300">{p.give.map((a) => a.name).join(" + ")}</span>
                        <span className="text-xs text-gray-500">for</span>
                        <span className="text-indigo-300">{p.get.map((a) => a.name).join(" + ")}</span>
                        <button
                          onClick={() => onLoad(p)}
                          className="ml-auto rounded px-2 py-0.5 text-[11px] text-gray-400 ring-1 ring-inset ring-gray-700 hover:text-gray-100 hover:ring-gray-500"
                        >
                          load above
                        </button>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-4 text-xs tabular-nums">
                        <span style={{ color: p.my_gain >= 0 ? C.s3 : C.critical }}>
                          my lineup {p.my_gain >= 0 ? "+" : ""}
                          {p.my_gain}
                        </span>
                        <span className="text-gray-500">their lineup +{p.their_gain}</span>
                        {p.market_equivalent != null && (
                          <span
                            className="text-gray-600"
                            title="Your lineup change converted to market units at the rate implied by your own roster"
                          >
                            ≈ {p.market_equivalent >= 0 ? "+" : ""}
                            {p.market_equivalent.toLocaleString()} in value
                          </span>
                        )}
                        <span style={{ color: p.market_delta >= 0 ? C.s1 : C.warning }}>
                          market {p.market_delta >= 0 ? "+" : ""}
                          {p.market_delta.toLocaleString()}
                          {p.market_pct != null && (
                            <span className="ml-1 text-gray-600">
                              ({p.market_pct >= 0 ? "+" : ""}
                              {p.market_pct}%)
                            </span>
                          )}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                <Note>{generated.method}</Note>
                {generated.rate_note && <Note>{generated.rate_note}</Note>}
                <Note>{generated.units_note}</Note>
                {generated.pool_note && <Note>{generated.pool_note}</Note>}
                {generated.season_note && <Note>{generated.season_note}</Note>}
                <Note>{generated.limitation}</Note>
              </>
            )}
          </div>
        )}

        {!generated && !generating && (
          <Note>
            With nothing pinned this looks for win-win packages across the whole league. Pin one of yours to
            ask &ldquo;what can I get for him&rdquo;, or one of theirs to ask &ldquo;what would it take&rdquo;
            — pinning changes the objective from mutual gain to best return, because you have already decided
            you want the move.
          </Note>
        )}
      </div>
    </Card>
  );
}

function BuilderSide({
  title,
  league,
  items,
  onAdd,
  onRemove,
  onTogglePin,
  pinnedIds,
  priced,
  accent,
  side,
  counterparty,
  placeholder,
}: {
  title: string;
  league: string;
  items: Asset[];
  onAdd: (a: Asset) => void;
  onRemove: (id: string) => void;
  onTogglePin: (a: Asset) => void;
  pinnedIds: string[];
  priced?: Priced[];
  accent: string;
  side: "mine" | "theirs";
  counterparty?: string | null;
  placeholder?: string;
}) {
  const byId = useMemo(() => {
    const m = new Map<string, Priced>();
    (priced ?? []).forEach((p) => m.set(p.player_id, p));
    return m;
  }, [priced]);

  return (
    <div className="rounded-lg border border-gray-800 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: accent }} />
        <h4 className="text-sm font-medium text-gray-200">{title}</h4>
      </div>
      <AssetSearch
        league={league}
        onPick={onAdd}
        exclude={items.map((i) => i.player_id)}
        side={side}
        counterparty={counterparty}
        placeholder={placeholder}
      />
      {items.length === 0 ? (
        <p className="mt-3 text-xs text-gray-600">nothing yet</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {items.map((a) => {
            const p = byId.get(a.player_id);
            const isPinned = pinnedIds.includes(a.player_id);
            return (
              <li
                key={a.player_id}
                className={`flex items-center gap-2 rounded border px-2 py-1.5 ${
                  isPinned
                    ? "border-amber-500/40 bg-amber-500/5"
                    : "border-gray-800 bg-gray-950/40"
                }`}
              >
                <span className="w-9 shrink-0 text-xs text-gray-500">{a.position}</span>
                <span className="min-w-0 truncate text-sm text-gray-200">{a.name}</span>
                <span className="flex-1" />
                <span className="shrink-0 text-right text-xs tabular-nums text-gray-400">
                  {p?.market_value != null ? p.market_value.toLocaleString() : "—"}
                  {p?.league_vor != null && (
                    <span className="ml-2 text-gray-600">VOR {p.league_vor.toFixed(1)}</span>
                  )}
                </span>
                <button
                  onClick={() => onTogglePin(a)}
                  title="Pin — every generated package will contain this player"
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] ring-1 ring-inset ${
                    isPinned
                      ? "bg-amber-500/10 text-amber-300 ring-amber-500/40"
                      : "text-gray-500 ring-gray-800 hover:text-gray-200 hover:ring-gray-600"
                  }`}
                >
                  {isPinned ? "pinned" : "pin"}
                </button>
                <button
                  onClick={() => onRemove(a.player_id)}
                  className="shrink-0 px-1 text-gray-600 hover:text-red-400"
                  aria-label={`remove ${a.name}`}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ── roster insights ────────────────────────────────────────────────── */

function RosterInsights({ data }: { data: TradesData }) {
  if (!data.insights?.length) return null;
  return (
    <Card
      title="What your roster is telling you"
      subtitle="The findings the surplus grid contains but does not say out loud"
    >
      <ul className="space-y-3">
        {data.insights.map((i) => (
          <li key={i.position} className="rounded border border-gray-800 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="warning">{i.position} surplus</Badge>
              <span className="text-sm text-gray-100">{i.headline}</span>
              {i.spare_market > 0 && (
                <span className="ml-auto text-xs tabular-nums text-gray-500">
                  {i.spare_market.toLocaleString()} of market value on the bench
                </span>
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">{i.detail}</p>
            <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              {i.spare.map((sp) => (
                <li key={sp.player_id} className="tabular-nums">
                  <span className="text-gray-300">{sp.name}</span>{" "}
                  <span style={{ color: (sp.vor ?? 0) < 0 ? C.critical : C.ink2 }}>
                    VOR {sp.vor != null ? (sp.vor >= 0 ? "+" : "") + sp.vor.toFixed(0) : "—"}
                  </span>
                  {sp.market_value != null && (
                    <span className="ml-1 text-gray-600">· {sp.market_value.toLocaleString()}</span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <Note>
        A position with one starting slot cannot absorb depth — whatever sits behind the starter scores
        nothing for you all season. It is the cheapest thing on a roster to convert into something startable,
        which is why it is the clearest trade action available.
      </Note>
    </Card>
  );
}
