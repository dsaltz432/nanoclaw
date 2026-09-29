import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import TradeIntel, { type Pick as IntelPick, type PriceSide, type Row as IntelRow } from "./TradeIntel";
import { Select } from "./Select";
import { ACTION_TONE, signed, cap } from "./labels";
import { PlayerName } from "./NoteLine";
import {
  Badge,
  Balance,
  C,
  Card,
  ErrorBox,
  FoldToggle,
  HoverInfo,
  Loading,
  MetaLine,
  NewsPeek,
  Note,
  QuietLine,
  SubHead,
  Td,
  Th,
  useIsNarrow,
} from "./viz";

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
  injury_status: string | null;
  league_vor: number | null;
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

/** What the sites said about a priced player: the action mix and the newest claims. */
type EvalClaims = {
  by_action: Record<string, number>;
  evidence: { source: string; rationale: string }[];
};

type Priced = RosterPlayer & {
  /** What the sites said about him in the claims window; null when nothing. */
  claims: EvalClaims | null;
};

type Evaluation = {
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
};

type TradesData = {
  mode: string;
  rosters: Roster[];
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
    note: string;
  };
  opportunities: Opportunities;
};

type Package = {
  counterparty: string;
  owner_id: string;
  give: RosterPlayer[];
  get: RosterPlayer[];
  my_gain: number;
  their_gain: number;
  market_delta: number;
  market_pct: number | null;
  /** Pinned searches only: my lineup gain in market units. */
  market_equivalent: number | null;
  /** Their lineup gets slightly worse (within the tolerance) but they gain
   *  market value: shown, marked, rather than hidden. */
  close_call?: boolean;
};

type Generated = {
  packages: Package[];
  counterparty: string | null;
  searched: number;
  considered: number;
  objective: string;
  method: string;
  units_note: string;
  pool_note?: string;
  rate_note?: string | null;
  season_note: string | null;
  reason?: string;
  /** Legal packages checked, and for a pinned search that found none, the one
   *  that came closest to improving their lineup. */
  tried?: number;
  /** How much a package may cost their lineup and still be a close call. */
  tolerance?: { points: number; weeks: number; per_week: number };
  closest?: { counterparty: string; give: Asset[]; get: Asset[]; their_gain: number; my_gain: number } | null;
};

export default function TradesTab({
  league,
  status,
  onPlayer,
}: {
  league: string;
  /** The league's Sleeper status ("pre_draft", "in_season", ...), when the shell passes it. */
  status?: string;
  onPlayer?: (id: string) => void;
}) {
  const [data, setData] = useState<TradesData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [give, setGive] = useState<Asset[]>([]);
  const [get, setGet] = useState<Asset[]>([]);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [partnerId, setPartnerId] = useState<string | null>(null);
  const [pinMine, setPinMine] = useState<RosterPlayer[]>([]);
  const [pinTheirs, setPinTheirs] = useState<RosterPlayer[]>([]);
  // Pins live alongside the working deal: the players you are building around
  // and the players you want held constant in a search are the same players.
  const [generated, setGenerated] = useState<Generated | null>(null);
  const [generating, setGenerating] = useState(false);
  // A rejected deal ("you cannot trade away a player you do not roster") or a
  // failed search belongs inside the builder, not in place of the whole tab.
  const [evalErr, setEvalErr] = useState<string | null>(null);
  const [genErr, setGenErr] = useState<string | null>(null);

  // A pin is a piece of the deal held constant, so it can only exist while the
  // player is in the deal: removing a chip (its ×, the roster row, Clear deal,
  // loading another package) unpins him. Otherwise a pin outlives its chip and
  // silently constrains every later search.
  useEffect(() => {
    const inGive = new Set(give.map((a) => a.player_id));
    const inGet = new Set(get.map((a) => a.player_id));
    setPinMine((prev) => (prev.every((p) => inGive.has(p.player_id)) ? prev : prev.filter((p) => inGive.has(p.player_id))));
    setPinTheirs((prev) => (prev.every((p) => inGet.has(p.player_id)) ? prev : prev.filter((p) => inGet.has(p.player_id))));
  }, [give, get]);

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
      setEvalErr(null);
      return;
    }
    const q = new URLSearchParams({
      league,
      give: give.map((g) => g.player_id).join(","),
      get: get.map((g) => g.player_id).join(","),
    });
    fetch(`/api/fantasy/trade-eval?${q}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) {
          setEvaluation(null);
          return setEvalErr(d.error);
        }
        setEvalErr(null);
        setEvaluation(d);
      })
      .catch((e) => setEvalErr(String(e)));
  }, [league, give, get]);

  const mine = data?.rosters.find((r) => r.is_me) ?? null;
  const partner = data?.rosters.find((r) => r.owner_id === partnerId) ?? null;

  // The first rival player in "You get" fixes the counterparty for the rest of
  // that side. Every trade in these leagues is two-team, so a second roster on
  // the receiving side is not a trade that can be proposed.
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
  // The intel above renders before the rosters arrive, so a "price this" on a
  // buy target can land before add() knows whose player he is. Once it does,
  // the partner panel follows the counterparty the deal is locked to.
  useEffect(() => {
    if (lockedTo) setPartnerId(lockedTo);
  }, [lockedTo]);
  const mode = data?.mode ?? (league === "dynasty" ? "dynasty" : "redraft");
  // Before the draft every roster is empty; after it, a missing roster is a
  // manager who is not in this season (a stale pick, a chopped team).
  const preDraft = status === "pre_draft" || (!!data && data.rosters.every((r) => r.players.length === 0));

  // Adding one of their players to "You get" tells us who you are dealing with,
  // so the roster panel follows.
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

  const remove = useCallback((side: "give" | "get", id: string) => {
    (side === "give" ? setGive : setGet)((prev) => prev.filter((x) => x.player_id !== id));
  }, []);

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
      setGenErr(null);
      const params = new URLSearchParams({ league, limit: "12" });
      if (pinMine.length) params.set("pin_mine", pinMine.map((p) => p.player_id).join(","));
      if (pinTheirs.length) params.set("pin_theirs", pinTheirs.map((p) => p.player_id).join(","));
      const cp = opts?.counterparty;
      if (cp) params.set("counterparty", cp);
      fetch(`/api/fantasy/trade-generate?${params}`)
        .then((r) => r.json())
        .then((d) => (d.error ? setGenErr(d.error) : setGenerated(d)))
        .catch((e) => setGenErr(String(e)))
        .finally(() => setGenerating(false));
    },
    [league, pinMine, pinTheirs]
  );

  const loadPackage = useCallback((p: Package) => {
    setGive(p.give);
    setGet(p.get);
    setPartnerId(p.owner_id);
  }, []);

  // "price this" on an intel row: the row becomes a builder asset, lands on
  // the side it can only be on (add() checks ownership against the rosters,
  // and a "get" also sets the counterparty), and the builder scrolls up into
  // view so the valuation is the next thing you read.
  const builderRef = useRef<HTMLDivElement>(null);
  const scrollToBuilder = useCallback(() => {
    builderRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const priceRow = useCallback(
    (row: IntelRow, side: PriceSide) => {
      add(side, {
        player_id: row.player_id,
        name: row.name,
        position: row.pos,
        team: row.team,
        is_pick: false,
        market_value: row.market_value,
        ros_points: null,
        owner: row.owner,
      });
      scrollToBuilder();
    },
    [add, scrollToBuilder]
  );

  const pricePick = useCallback(
    (p: IntelPick) => {
      add("give", {
        player_id: p.asset_id,
        name: p.name,
        position: "PICK",
        team: null,
        is_pick: true,
        market_value: p.market_value,
        ros_points: null,
      });
      scrollToBuilder();
    },
    [add, scrollToBuilder]
  );

  // "price this" on a trade-opportunity lead. A two-way lead is a whole
  // one-for-one, so it replaces the deal (as loading a found package does);
  // a one-way lead adds its player to his side, as Trade intel's rows do.
  const priceLead = useCallback(
    (giveId: string | null, getId: string | null, ownerId: string | null) => {
      const find = (pid: string) => {
        for (const r of data?.rosters ?? []) {
          const p = r.players.find((x) => x.player_id === pid);
          if (p) return p;
        }
        return undefined;
      };
      const g = giveId ? find(giveId) : undefined;
      const t = getId ? find(getId) : undefined;
      if (g && t) {
        setGive([g]);
        setGet([t]);
      } else if (g) {
        add("give", g);
      } else if (t) {
        add("get", t);
      }
      // A give-only lead names the rival first in line; show his roster
      // unless the deal is already with somebody else.
      if (ownerId && (t || !get.length)) setPartnerId(ownerId);
      scrollToBuilder();
    },
    [data, add, get, scrollToBuilder]
  );

  // Choosing a manager from the opportunities card or the accept-share table loads
  // his roster into the right-hand panel, which sits above both.
  const rostersRef = useRef<HTMLDivElement>(null);
  const loadPartner = useCallback((ownerId: string) => {
    setPartnerId(ownerId);
    rostersRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="space-y-4">
      {/* The decision first: sell talk on your roster, buy targets on rivals',
          and for dynasty the ECR-vs-market value gaps and your picks. It
          fetches on its own, so it does not wait for the rosters below. */}
      <TradeIntel league={league} onPlayer={onPlayer} onPrice={priceRow} onPricePick={pricePick} />
      {err ? (
        <ErrorBox>{err}</ErrorBox>
      ) : !data ? (
        <Card title="Trade builder">
          <Loading label="Loading trade builder…" rows={5} />
        </Card>
      ) : (
        <>
          <div ref={builderRef} className="scroll-mt-4">
            <TradeBuilder
              league={league}
              give={give}
              get={get}
              setGive={setGive}
              setGet={setGet}
              evaluation={evaluation}
              evalErr={evalErr}
              lockedTo={lockedTo}
              lockedToName={lockedToName}
              pinMine={pinMine}
              pinTheirs={pinTheirs}
              onTogglePin={togglePin}
              onGenerate={runGenerate}
              generating={generating}
              generated={generated}
              genErr={genErr}
              onLoad={loadPackage}
              onPlayer={onPlayer}
              partnerName={partner?.owner ?? null}
              partnerId={partnerId}
            />
          </div>

          {/* ── the two rosters, click to build the deal. Side by side from
              lg, where each panel drops a value column and truncates names. ── */}
          <div ref={rostersRef} className="grid scroll-mt-4 gap-4 lg:grid-cols-2">
            <RosterPanel
              title="Your roster"
              roster={mine}
              mode={mode}
              preDraft={preDraft}
              actionLabel="give"
              selected={give.map((g) => g.player_id)}
              onPick={(p) => add("give", p)}
              onUnpick={(p) => remove("give", p.player_id)}
              pinned={pinMine.map((p) => p.player_id)}
              onPin={(p) => togglePin("mine", p)}
              onPlayer={onPlayer}
            />
            <RosterPanel
              title="Their roster"
              roster={partner}
              mode={mode}
              preDraft={preDraft}
              actionLabel="get"
              selected={get.map((g) => g.player_id)}
              onPick={(p) => add("get", p)}
              onUnpick={(p) => remove("get", p.player_id)}
              pinned={pinTheirs.map((p) => p.player_id)}
              onPin={(p) => togglePin("theirs", p)}
              onPlayer={onPlayer}
              picker={
                <Select
                  aria-label="Trade partner"
                  size="sm"
                  value={partnerId ?? ""}
                  onChange={setPartnerId}
                  options={data.rosters.filter((r) => !r.is_me).map((r) => ({ value: r.owner_id, label: r.owner }))}
                />
              }
            />
          </div>

          <TradeOpportunities data={data} onPartner={loadPartner} onPlayer={onPlayer} onPrice={priceLead} />

          <AcceptShare data={data} onPartner={loadPartner} />
        </>
      )}
    </div>
  );
}

/* ── counterparty history ───────────────────────────────────────────── */

/** Background, not deal-making: how often each manager's trades go through. */
function AcceptShare({ data, onPartner }: { data: TradesData; onPartner: (ownerId: string) => void }) {
  if (!data.counterparties.counterparties.length)
    return <QuietLine title="Who actually accepts">No completed trades in this league yet.</QuietLine>;
  return (
    <Card title="Who actually accepts" info="How often each manager's trades go through, before you open a conversation." secondary>
      {/* One row per manager. On a phone the numbers move under the name as a
          meta line and only the name and "load" stay in columns. */}
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-gray-800">
            <Th>Manager</Th>
            <Th className="hidden text-right sm:table-cell">Trades</Th>
            <Th className="hidden text-right sm:table-cell">Accept share</Th>
            <Th>
              <span className="sr-only">Load roster</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {data.counterparties.counterparties.map((c) => {
            const share = <AcceptPct c={c} />;
            const tradesTitle = `${c.proposed} proposed · ${c.accepted} accepted`;
            return (
              <tr key={c.owner_id} className="border-b border-gray-800/60">
                <Td>
                  <span className="text-gray-200" title={c.handle && c.handle !== c.owner ? `Sleeper: ${c.handle}` : undefined}>
                    {c.owner}
                  </span>
                  {c.person && c.handle && (
                    <span className="ml-1.5 hidden text-xs text-gray-600 sm:inline">{c.handle}</span>
                  )}
                  <MetaLine className="tabular-nums sm:hidden">
                    <span title={tradesTitle}>
                      {c.trades} {c.trades === 1 ? "trade" : "trades"}
                    </span>
                    {(c.accept_share != null || c.thin) && <span>{share}</span>}
                  </MetaLine>
                </Td>
                <Td className="hidden text-right tabular-nums text-gray-500 sm:table-cell" title={tradesTitle}>
                  {c.trades}
                </Td>
                <Td className="hidden whitespace-nowrap text-right tabular-nums sm:table-cell">{share}</Td>
                <Td className="text-right align-top sm:align-middle">
                  <button
                    type="button"
                    onClick={() => onPartner(c.owner_id)}
                    className="ff-inline ff-hit whitespace-nowrap text-xs text-indigo-400 hover:text-indigo-300"
                  >
                    Load<span className="hidden sm:inline"> roster</span>
                  </button>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Note>{data.counterparties.note}</Note>
    </Card>
  );
}

type Counterparty = TradesData["counterparties"]["counterparties"][number];

/** "100%" (green from 70%) and the thin-history badge; '—' when there is no share to show. */
function AcceptPct({ c }: { c: Counterparty }) {
  return (
    <>
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
    </>
  );
}

/* ── roster panel ───────────────────────────────────────────────────── */

const POS_ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];

/** Roster rows shown before "show all". */
const ROSTER_FOLD = 12;

/** A row action (give / get / pin): the same small outlined button, wide enough for a thumb. */
const ROW_BTN = "min-w-[2.5rem] rounded px-1.5 py-0.5 text-center text-[11px] ring-1 ring-inset";

function RosterPanel({
  title,
  roster,
  mode,
  preDraft,
  actionLabel,
  selected,
  onPick,
  onUnpick,
  pinned = [],
  onPin,
  picker,
  onPlayer,
}: {
  title: string;
  roster: Roster | null;
  mode: string;
  preDraft: boolean;
  actionLabel: "give" | "get";
  selected: string[];
  onPick: (p: RosterPlayer) => void;
  /** Takes a player back out of the deal (and so unpins him). */
  onUnpick: (p: RosterPlayer) => void;
  pinned?: string[];
  onPin?: (p: RosterPlayer) => void;
  picker?: React.ReactNode;
  onPlayer?: (id: string) => void;
}) {
  const [pos, setPos] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);

  const players = useMemo(() => {
    if (!roster) return [];
    const query = q.trim().toLowerCase();
    return roster.players.filter(
      (p) => (!pos || p.position === pos) && (!query || p.name.toLowerCase().includes(query))
    );
  }, [roster, pos, q]);

  const shown = all ? players : players.slice(0, ROSTER_FOLD);

  const available = useMemo(() => {
    if (!roster) return [];
    return POS_ORDER.filter((p) => roster.players.some((x) => x.position === p));
  }, [roster]);

  if (!roster) {
    return (
      <Card title={title} right={picker} rightStacks>
        <p className="text-xs text-gray-500">
          {preDraft
            ? "No roster yet — the league has not drafted."
            : "No roster for this manager in the current season."}
        </p>
      </Card>
    );
  }

  const dynasty = mode === "dynasty";
  // Three value columns do not fit a half-width panel (lg to xl) or a phone:
  // the primary one always shows, the other two from sm, and the one that
  // matters least in this format (VOR in dynasty, Market in a weekly league)
  // steps aside while the panels sit side by side below xl.
  const SECONDARY = "hidden sm:table-cell";
  const SPARE = "hidden sm:table-cell lg:hidden xl:table-cell";
  // Market values run to "10,234"; ROS is three digits, VOR up to "-213".
  const MARKET = { label: "Market", w: "w-[4rem]", value: fmtMarket };
  const ROS = { label: "ROS", w: "w-[3rem]", value: fmtRos };
  const VOR = { label: "VOR", w: "w-[3.25rem]", value: fmtVor };
  const cols = [
    { ...(dynasty ? MARKET : ROS), cls: "", tone: "text-gray-300" },
    { ...(dynasty ? ROS : VOR), cls: SECONDARY, tone: "text-gray-500" },
    { ...(dynasty ? VOR : MARKET), cls: SPARE, tone: "text-gray-500" },
  ];

  return (
    <Card
      title={title}
      subtitle={
        <span
          className="tabular-nums"
          title={`${roster.above_replacement} above replacement, worth ${roster.startable_vor.toFixed(0)} VOR`}
        >
          {roster.players.length} players · market {roster.total_market.toLocaleString()}
        </span>
      }
      right={picker}
      rightStacks
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter…"
          aria-label={`Filter ${title.toLowerCase()} by name`}
          className="w-28 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100 placeholder:text-gray-600"
        />
        {available.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setPos(pos === p ? null : p)}
            aria-pressed={pos === p}
            className={`min-w-[2.25rem] rounded px-1.5 py-0.5 text-center text-[11px] font-medium ring-1 ring-inset transition-colors ${
              pos === p
                ? "bg-indigo-500/15 text-indigo-300 ring-indigo-500/40"
                : "bg-gray-800 text-gray-400 ring-gray-700 hover:text-gray-200"
            }`}
          >
            {p}
          </button>
        ))}
      </div>

      {/* table-fixed: the value and action columns keep their widths and the
          player column takes what is left, so a long name truncates instead of
          pushing the panel wider than its half of the page. */}
      <table className="w-full table-fixed border-collapse">
        <thead>
          <tr className="border-b border-gray-800">
            <Th>Player</Th>
            {cols.map((c) => (
              <Th key={c.label} className={`${c.w} text-right ${c.cls}`}>
                {c.label}
              </Th>
            ))}
            <Th className={`pr-0 ${onPin ? "w-[6.25rem]" : "w-[3.25rem]"}`}>
              <span className="sr-only">Actions</span>
            </Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((p) => {
            const chosen = selected.includes(p.player_id);
            const isPinned = pinned.includes(p.player_id);
            const meta = [p.position, p.team].filter(Boolean).join(" · ");
            return (
              <tr
                key={p.player_id}
                className={`border-b border-gray-800/60 ${
                  isPinned ? "bg-amber-500/5" : chosen ? "bg-indigo-500/5" : "hover:bg-gray-800/40"
                }`}
              >
                <Td>
                  {/* The name truncates; position, team, designation and the
                      news peek travel as one unit, onto the next line when
                      the name needs the room. */}
                  <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
                    <span className="min-w-0 max-w-full truncate [&>button]:max-w-full [&>button]:truncate" title={p.name}>
                      <PlayerName id={p.player_id} name={p.name} onPlayer={onPlayer} news={false} />
                    </span>
                    <span className="inline-flex shrink-0 items-baseline gap-1 whitespace-nowrap text-xs text-gray-500">
                      {meta && <span>{meta}</span>}
                      {p.injury_status && <Badge tone="warning">{p.injury_status}</Badge>}
                      <NewsPeek id={p.player_id} name={p.name} />
                    </span>
                  </div>
                </Td>
                {cols.map((c) => (
                  <Td key={c.label} className={`text-right tabular-nums ${c.tone} ${c.cls}`}>
                    {c.value(p)}
                  </Td>
                ))}
                <Td className="pl-1 pr-0">
                  <div className="flex justify-end gap-1">
                    {/* In the deal: the same button takes him back out. */}
                    <button
                      type="button"
                      onClick={() => (chosen ? onUnpick(p) : onPick(p))}
                      aria-pressed={chosen}
                      className={`${ROW_BTN} ${
                        chosen
                          ? "text-indigo-300 ring-indigo-500/40 hover:text-red-300 hover:ring-red-500/40"
                          : "text-gray-400 ring-gray-700 hover:text-gray-100 hover:ring-gray-500"
                      }`}
                    >
                      {chosen ? "Remove" : cap(actionLabel)}
                    </button>
                    {onPin && (
                      <button
                        type="button"
                        onClick={() => onPin(p)}
                        aria-pressed={isPinned}
                        title="Pin — every generated package will contain this player"
                        className={`${ROW_BTN} ${
                          isPinned
                            ? "bg-amber-500/10 text-amber-300 ring-amber-500/40"
                            : "text-gray-500 ring-gray-800 hover:text-gray-200 hover:ring-gray-600"
                        }`}
                      >
                        {isPinned ? "Pinned" : "Pin"}
                      </button>
                    )}
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {players.length === 0 && <p className="py-3 text-xs text-gray-500">Nothing matches that filter.</p>}
      <FoldToggle total={players.length} shown={shown.length} expanded={all} onToggle={() => setAll((v) => !v)} mode="all" />
    </Card>
  );
}

const fmtMarket = (p: RosterPlayer) => p.market_value?.toLocaleString() ?? "—";
const fmtRos = (p: RosterPlayer) => p.ros_points?.toFixed(0) ?? "—";
const fmtVor = (p: RosterPlayer) => (p.league_vor != null ? p.league_vor.toFixed(0) : "—");

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
        placeholder={placeholder ?? "Search players or picks…"}
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

/* ── trade opportunities ────────────────────────────────────────────────
 *
 * Replaces "Positional strength, every roster" and "Your surplus → who needs
 * it". Both graded rosters on rest-of-season points above replacement, which
 * says who is strong, not where a specific bench player of yours walks into a
 * specific rival's lineup. This compares players: your best spare at a
 * position against the weakest starting slot a player there could take on
 * their roster (a TE can take a FLEX, a QB the SUPER_FLEX), on this week's
 * projection and on the average of the last three games — and the reverse,
 * their spare against your weakest slot. Every number comes from the payload
 * (`opportunities`, ff/trades.py); this only formats it.
 */

type OppMeasure = "week" | "form";

type OppPlayer = {
  name: string;
  pos: string | null;
  team: string | null;
  week: number | null;
  form: number | null;
  games: number;
  /** Why he has no number this week: "bye", an injury designation, "no projection". */
  why: string | null;
  market_value: number | null;
};

type OppBar = { slot: string; id: string | null; pts: number };

type DirMeasure = { starter: string | null; slot: string; bar: number; gap: number } | null;

type Direction = {
  spare: string | null;
  week?: DirMeasure;
  form?: DirMeasure;
  signal: "both" | "week" | "form" | null;
};

type SlotAvg = { avg: number; games: number } | null;

type OppCell = { give: Direction; get: Direction; absent: string[]; slot_avg: SlotAvg };

type PairMeasure = { mine: number; theirs: number; my_sits: string[]; their_sits: string[] };

type Lead =
  | {
      kind: "two-way";
      owner_id: string;
      owner: string;
      give: string;
      get: string;
      my_gain: number;
      their_gain: number;
      score: number;
      by_measure: Partial<Record<OppMeasure, PairMeasure>>;
      market_delta: number | null;
    }
  | {
      kind: "give";
      player: string;
      position: string;
      rivals: { owner_id: string; owner: string; signal: Direction["signal"]; score: number }[];
      signal: Direction["signal"];
      score: number;
      owner: string;
    }
  | {
      kind: "get";
      owner_id: string;
      owner: string;
      position: string;
      player: string;
      signal: Direction["signal"];
      score: number;
    };

type OppRival = { owner_id: string; owner: string; cells: Record<string, OppCell>; two_way: boolean; signals: number };

type StrengthCell = {
  /** Points a game from the dedicated slots at this position, last n weeks, whoever started. */
  form: number | null;
  games: number;
  /** This week's projection, averaged over those slots' starters. */
  week: number | null;
  form_rank: number | null;
  week_rank: number | null;
  starters: string[];
  spare: string | null;
};

type StrengthTeam = { owner_id: string; owner: string; is_me: boolean; cells: Record<string, StrengthCell> };

type Opportunities = {
  week: number;
  n: number;
  min_gap: number;
  positions: string[];
  measures: OppMeasure[];
  max_games: number;
  me: {
    owner_id: string;
    cells: Record<string, { spare: string | null; bars: Partial<Record<OppMeasure, OppBar | null>>; slot_avg: SlotAvg }>;
  } | null;
  rivals: OppRival[];
  leads: Lead[];
  leads_total: number;
  players: Record<string, OppPlayer>;
  /** Where each team is weak: every team and position, ranked across the league. */
  strength?: { teams: StrengthTeam[]; n_teams: number };
  volume_warning?: string;
  reason?: string;
};

/** Rank → the green-to-red scale the player popup's opponents use, one shade per fifth of the league. */
const RANK_CLS = ["text-green-400", "text-green-200", "text-gray-200", "text-red-200", "text-red-400"];
const rankCls = (rank: number | null, n: number) =>
  rank == null || n < 2 ? "text-gray-500" : RANK_CLS[Math.min(4, Math.floor(((rank - 1) / (n - 1)) * 5))];
const ordinal = (k: number) => `${k}${k % 100 >= 11 && k % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][k % 10] ?? "th"}`;

/** Leads shown before "show more". */
const LEAD_FOLD = 5;
/** Teams in "Where each team is weak" before "Show all" (you plus eleven: a whole 12-team league). */
const STRENGTH_FOLD = 12;
/** Rivals a "give" lead names inline before "+N more". */
const LEAD_RIVALS = 3;

/** Green when both measures agree, a dimmer green when only one does. Only gaps in your favour are coloured. */
const SIGNAL_CLS: Record<string, string> = {
  both: "text-green-400",
  week: "text-green-600",
  form: "text-green-600",
};

const f1 = (x: number | null | undefined) => (x == null ? "—" : x.toFixed(1));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "+2.1 / +4.6": the gap this week, then on form; a measure without a number is "—". */
function gapPair(d: Direction) {
  return `${d.week ? signed(d.week.gap) : "—"} / ${d.form ? signed(d.form.gap) : "—"}`;
}

function TradeOpportunities({
  data,
  onPartner,
  onPlayer,
  onPrice,
}: {
  data: TradesData;
  onPartner: (ownerId: string) => void;
  onPlayer?: (id: string) => void;
  /** Put the players in the builder: both for a two-way lead, one side otherwise. */
  onPrice: (give: string | null, get: string | null, ownerId: string | null) => void;
}) {
  const narrow = useIsNarrow();
  const [allLeads, setAllLeads] = useState(false);
  const [allRivals, setAllRivals] = useState(false);
  const o = data.opportunities;
  const title = "Trade opportunities";
  if (!o || o.reason || !o.me) return <QuietLine title={title}>{o?.reason ?? "Nothing to compare yet."}</QuietLine>;

  const P = o.players;
  const games = Math.min(o.n, o.max_games);
  const formLabel = games > 0 ? `last ${plural(games, "game")}` : "no games yet";
  const name = (id: string | null | undefined) => (id ? P[id]?.name ?? id : "nobody");
  /** "21.9 this week · 25.4 avg, 3 games" for one player. */
  const line = (id: string) => {
    const p = P[id];
    if (!p) return id;
    const wk = p.week != null ? `${f1(p.week)} this week` : `${p.why ?? "no projection"} this week`;
    const fm = p.form != null ? `${f1(p.form)} avg, ${plural(p.games, "game")}` : "no games yet";
    return `${p.name} (${p.pos ?? "?"}) — ${wk} · ${fm}`;
  };
  const whoAt = (m: DirMeasure, mine: boolean) =>
    !m ? "" : m.starter ? `${mine ? "your " : ""}${name(m.starter)} at ${slotName(m.slot)}, ${f1(m.bar)}` : `an empty ${slotName(m.slot)} slot`;

  /** The hover for one direction of one cell: the spare, who he would replace on each measure, the gap. */
  const dirInfo = (d: Direction, dir: "give" | "get", owner: string, cell: OppCell | null, pos: string) => {
    if (!d.spare) return "";
    const lines = [`${dir === "give" ? "Your" : `${owner}'s`} spare: ${line(d.spare)}`];
    const mine = dir === "get";
    if (d.week) lines.push(`This week he would start over ${whoAt(d.week, mine)} → ${signed(d.week.gap)}`);
    if (d.form) lines.push(`On form (${formLabel}) over ${whoAt(d.form, mine)} → ${signed(d.form.gap)}`);
    const sa = mine ? o.me?.cells[pos]?.slot_avg : cell?.slot_avg;
    if (sa)
      lines.push(
        `${mine ? "Your" : "Their"} ${pos} slot has scored ${f1(sa.avg)} a game (last ${plural(sa.games, "week")})`
      );
    if (!mine && cell?.absent.length)
      lines.push(`Missing this week: ${cell.absent.map((a) => `${name(a)} (${P[a]?.why ?? "out"})`).join(", ")}`);
    return lines.join("\n");
  };

  const rivalById = new Map(o.rivals.map((r) => [r.owner_id, r]));
  const leads = allLeads ? o.leads : o.leads.slice(0, LEAD_FOLD);

  return (
    <Card
      title={title}
      subtitle={`week ${o.week} projection · ${formLabel}`}
      info="Where your bench beats a rival's weakest starter, and where theirs beats yours. Each gap reads this week / on form: the projection, then the average of the last three games, both in this league's scoring."
    >
      {/* ── leads: two-way first, then your spares, then theirs ── */}
      {o.leads.length === 0 ? (
        <p className="text-xs text-gray-500">
          No gap of {o.min_gap} point or more either way: nobody&rsquo;s bench beats a starter, yours or theirs.
        </p>
      ) : (
        <ul className="space-y-2.5">
          {leads.map((l, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <div className="min-w-0 flex-1">
                <LeadBody
                  l={l}
                  o={o}
                  rivalById={rivalById}
                  dirInfo={dirInfo}
                  onPlayer={onPlayer}
                  formLabel={formLabel}
                />
              </div>
              <PriceBtn
                onClick={() =>
                  l.kind === "two-way"
                    ? onPrice(l.give, l.get, l.owner_id)
                    : l.kind === "give"
                      ? onPrice(l.player, null, l.rivals[0]?.owner_id ?? null)
                      : onPrice(null, l.player, l.owner_id)
                }
                title={
                  l.kind === "two-way"
                    ? "Load this one-for-one into the builder"
                    : l.kind === "give"
                      ? "Put him in “You give” in the builder"
                      : "Put him in “You get” in the builder"
                }
              />
            </li>
          ))}
        </ul>
      )}
      <FoldToggle
        total={o.leads.length}
        shown={leads.length}
        expanded={allLeads}
        onToggle={() => setAllLeads((v) => !v)}
      />

      {/* ── your side: grouped by weakest slot, so a FLEX incumbent that is the
          bar for RB, WR and TE at once is named once, with each spare beside it ── */}
      <SubHead className="mt-4 mb-1.5">Your side</SubHead>
      <ul className="space-y-1">
        {sideGroups(o).map(({ positions, bw, bf, spares, slotAvg }) => {
          const one = positions.length === 1 ? positions[0] : null;
          const at = (b: OppBar) => (b.id ? `${name(b.id)} at ${slotName(b.slot)}, ${f1(b.pts)}` : `empty ${slotName(b.slot)} slot`);
          const barInfo = [
            bw ? `This week: ${at(bw)}` : "",
            bf ? `On form (${formLabel}): ${at(bf)}` : "",
            ...slotAvg.map(([p, sa]) => `Your ${p} slot has scored ${f1(sa.avg)} a game (last ${plural(sa.games, "week")})`),
          ]
            .filter(Boolean)
            .join("\n");
          // The slot is named unless it is the row's own position ("QB" on the QB line).
          const slot = bw && bw.slot !== one ? `${slotLabel(bw.slot)} ` : "";
          return (
            <li key={positions.join()} className="flex gap-2 text-xs">
              <span className="w-[4.5rem] shrink-0 whitespace-nowrap font-medium text-gray-400">{positions.join(", ")}</span>
              <MetaLine className="min-w-0 flex-1 tabular-nums">
                <span>
                  <span className="text-gray-600">weakest slot </span>
                  <HoverInfo info={barInfo}>
                    {slot}
                    {bw?.id ? name(bw.id) : bw ? "empty" : "—"} {bw ? f1(bw.pts) : "—"} /{" "}
                    {/* On form the weakest starter can be somebody else: name him. */}
                    {bf && bw && bf.id !== bw.id ? `${bf.id ? name(bf.id) : "empty"} ` : ""}
                    {bf ? f1(bf.pts) : "—"}
                  </HoverInfo>
                </span>
                {spares.length === 0 ? (
                  <span className="text-gray-600">no spare</span>
                ) : (
                  spares.map(([p, id]) => (
                    <span key={id}>
                      <span className="text-gray-600">spare {one ? "" : `${p} `}</span>
                      <span className="text-xs">
                        <PlayerName id={id} name={name(id)} onPlayer={onPlayer} />
                      </span>{" "}
                      <HoverInfo info={line(id)}>
                        {f1(P[id]?.week)} / {f1(P[id]?.form)}
                      </HoverInfo>
                    </span>
                  ))
                )}
              </MetaLine>
            </li>
          );
        })}
      </ul>

      {/* ── where each team is weak: every team and position, coloured by
          league rank, so a need shows even when no spare of yours fits it ── */}
      {o.strength && o.strength.teams.length > 0 && (
        <StrengthGrid
          o={o}
          teams={allRivals ? o.strength.teams : o.strength.teams.slice(0, STRENGTH_FOLD)}
          narrow={narrow}
          name={name}
          line={line}
          dirInfo={dirInfo}
          rivalById={rivalById}
          onPartner={onPartner}
        />
      )}
      {o.strength && o.strength.teams.length > STRENGTH_FOLD && (
        <FoldToggle
          mode="all"
          total={o.strength.teams.length}
          shown={allRivals ? o.strength.teams.length : STRENGTH_FOLD}
          expanded={allRivals}
          onToggle={() => setAllRivals((v) => !v)}
        />
      )}

      <Note>
        Where each team is weak: each team&rsquo;s own slots at a position (not flex), what they actually scored a
        game over the last {o.n} completed weeks whoever was started, coloured from the best fifth of the league
        (green) to the worst (red). A + marks a position where a spare of yours would start for them.
      </Note>
      <Note>
        &ldquo;Give&rdquo; is your best spare at a position — a player neither this week&rsquo;s lineup nor the
        form lineup starts — against the weakest slot a player there could take on their roster; &ldquo;get&rdquo; is
        the reverse. Flex and superflex slots count, so a tight end can be measured against a FLEX held by a back.
        Each lineup is re-solved per measure: this week&rsquo;s projection (Sleeper&rsquo;s, in this league&rsquo;s
        scoring) and the average of each player&rsquo;s last {o.n} completed games, rescored from the box score. A
        bye or an injury drops a player from this week&rsquo;s lineup only; players ruled out or parked on IR are
        left out of both. Green is a gap both measures agree on, dim green one measure. A gap has to average{" "}
        {o.min_gap} point or more to show.
      </Note>
      <Note>
        A two-way lead is a one-for-one that raises both starting lineups on the average of the two measures — the
        only kind both managers have a reason to accept. They are rare by construction: most of a lineup is
        zero-sum week to week. Kickers and defences are left out. The trade finder in the builder searches
        rest-of-season, two-for-two.
      </Note>
      {o.volume_warning && <Note>{o.volume_warning}</Note>}
    </Card>
  );
}

const SLOT_NAMES: Record<string, string> = { SUPER_FLEX: "superflex", FLEX: "flex", REC_FLEX: "flex", WRRB_FLEX: "flex" };
const slotName = (s: string) => SLOT_NAMES[s] ?? s;
const SLOT_LABELS: Record<string, string> = { SUPER_FLEX: "SUPERFLEX", REC_FLEX: "FLEX", WRRB_FLEX: "FLEX" };
/** The slot as a lineup label ("FLEX Rashod Bateman"). */
const slotLabel = (s: string) => SLOT_LABELS[s] ?? s;

const barKey = (b: OppBar | null | undefined) => (b ? `${b.slot}:${b.id ?? ""}:${b.pts}` : "-");

/**
 * "Your side", one line per distinct weakest slot. In a lineup whose FLEX is
 * its weakest spot, that one incumbent is the bar for RB, WR and TE alike;
 * a line per position repeated him three times.
 */
function sideGroups(o: Opportunities) {
  const groups: {
    positions: string[];
    bw: OppBar | null;
    bf: OppBar | null;
    spares: [string, string][];
    slotAvg: [string, { avg: number; games: number }][];
  }[] = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  for (const p of o.positions) {
    const c = o.me?.cells[p];
    if (!c) continue;
    const key = `${barKey(c.bars.week)}|${barKey(c.bars.form)}`;
    let g = byKey.get(key);
    if (!g) {
      g = { positions: [], bw: c.bars.week ?? null, bf: c.bars.form ?? null, spares: [], slotAvg: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.positions.push(p);
    if (c.spare) g.spares.push([p, c.spare]);
    if (c.slot_avg) g.slotAvg.push([p, c.slot_avg]);
  }
  return groups;
}

/**
 * Where each team is weak. One row per team (yours first), one cell per
 * position: what that team's own slots there have actually scored a game over
 * the last few weeks, coloured by where that ranks in the league. The hover
 * has this week's projection for the same slots, who fills them, the best
 * bench player, and whether a spare of yours would start there (marked +).
 */
function StrengthGrid({
  o,
  teams,
  narrow,
  name,
  line,
  dirInfo,
  rivalById,
  onPartner,
}: {
  o: Opportunities;
  teams: StrengthTeam[];
  narrow: boolean;
  name: (id: string | null | undefined) => string;
  line: (id: string) => string;
  dirInfo: (d: Direction, dir: "give" | "get", owner: string, cell: OppCell | null, pos: string) => string;
  rivalById: Map<string, OppRival>;
  onPartner: (ownerId: string) => void;
}) {
  const n = o.strength!.n_teams;
  // Team slots count weeks, not a player's games.
  const weeks = Math.max(0, ...o.strength!.teams.flatMap((t) => Object.values(t.cells).map((c) => c.games)));
  const weeksLabel = weeks > 0 ? `last ${plural(weeks, "week")}` : "no weeks yet";
  const info = (t: StrengthTeam, p: string) => {
    const c = t.cells[p];
    if (!c) return "";
    const who = t.is_me ? "Your" : `${t.owner}'s`;
    const slots = c.starters.length === 1 ? "slot has" : "slots have";
    const lines = [
      c.form != null
        ? `${who} ${p} ${slots} scored ${f1(c.form)} a game (last ${plural(c.games, "week")}), ${ordinal(c.form_rank!)} of ${n}`
        : `${who} ${p} ${c.starters.length === 1 ? "slot" : "slots"}: no completed weeks yet`,
      c.week != null
        ? `This week they project ${f1(c.week)}, ${ordinal(c.week_rank!)} of ${n}: ${c.starters.map((id) => name(id)).join(", ") || "nobody"}`
        : "",
      c.spare ? `Best bench: ${line(c.spare)}` : "No bench player here",
    ].filter(Boolean);
    const r = t.is_me ? null : rivalById.get(t.owner_id);
    const cell = r?.cells[p];
    // Where a spare of yours would start here, or theirs for you: the gap itself.
    if (cell?.give.signal) lines.push("", dirInfo(cell.give, "give", t.owner, cell, p));
    if (cell?.get.signal) lines.push("", dirInfo(cell.get, "get", t.owner, cell, p));
    return lines.join("\n");
  };
  const fits = (t: StrengthTeam, p: string) => !t.is_me && !!rivalById.get(t.owner_id)?.cells[p]?.give.signal;
  const value = (t: StrengthTeam, p: string) => {
    const c = t.cells[p];
    if (!c) return <span className="text-gray-700">—</span>;
    return (
      <>
        <HoverInfo info={info(t, p)} className={rankCls(c.form_rank, n)}>
          {f1(c.form)}
        </HoverInfo>
        {fits(t, p) && <span className="ml-0.5 text-green-400">+</span>}
      </>
    );
  };
  const teamName = (t: StrengthTeam) =>
    t.is_me ? (
      <span className="font-medium text-gray-200">You</span>
    ) : rivalById.get(t.owner_id) ? (
      <RivalName r={rivalById.get(t.owner_id)!} onPartner={onPartner} />
    ) : (
      <span>{t.owner}</span>
    );
  return (
    <>
      <SubHead className="mt-4 mb-1.5">Where each team is weak · points a game, {weeksLabel}</SubHead>
      {narrow ? (
        <ul className="divide-y divide-gray-800/60">
          {teams.map((t) => (
            <li key={t.owner_id} className={`flex items-baseline gap-2 py-1.5 text-xs ${t.is_me ? "bg-green-500/5" : ""}`}>
              <span className="min-w-0 flex-1 truncate">{teamName(t)}</span>
              {o.positions.map((p) => (
                <span key={p} className="w-[3.25rem] shrink-0 whitespace-nowrap text-right tabular-nums">
                  <span className="text-[10px] text-gray-600">{p} </span>
                  {value(t, p)}
                </span>
              ))}
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-gray-800">
                <Th>Team</Th>
                {o.positions.map((p) => (
                  <Th key={p} className="text-right">
                    {p}
                  </Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.owner_id} className={`border-b border-gray-800/60 ${t.is_me ? "bg-green-500/5" : ""}`}>
                  <Td className="whitespace-nowrap">{teamName(t)}</Td>
                  {o.positions.map((p) => (
                    <Td key={p} className="whitespace-nowrap text-right text-xs tabular-nums">
                      {value(t, p)}
                    </Td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function RivalName({ r, onPartner }: { r: OppRival; onPartner: (ownerId: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPartner(r.owner_id)}
      className="ff-inline ff-hit text-left text-sm text-gray-200 underline decoration-gray-700 underline-offset-2 hover:decoration-indigo-400"
    >
      {r.owner}
    </button>
  );
}

/** One lead: who, which players, and the gaps with their breakdown on hover. */
function LeadBody({
  l,
  o,
  rivalById,
  dirInfo,
  onPlayer,
  formLabel,
}: {
  l: Lead;
  o: Opportunities;
  rivalById: Map<string, OppRival>;
  dirInfo: (d: Direction, dir: "give" | "get", owner: string, cell: OppCell | null, pos: string) => string;
  onPlayer?: (id: string) => void;
  formLabel: string;
}) {
  const P = o.players;
  const who = (id: string) => (
    <PlayerName id={id} name={P[id]?.name ?? id} pos={P[id]?.pos} onPlayer={onPlayer} />
  );
  if (l.kind === "two-way") {
    const names = (ids: string[]) => ids.map((x) => P[x]?.name ?? x).join(", ") || "nobody";
    const side = (mine: boolean) =>
      (["week", "form"] as const)
        .filter((k) => l.by_measure[k])
        .map((k) => {
          const m = l.by_measure[k]!;
          const gain = mine ? m.mine : m.theirs;
          const sits = mine ? m.my_sits : m.their_sits;
          return `${k === "week" ? "This week" : `On form (${formLabel})`}: ${signed(gain)} · out of the lineup: ${names(sits)}`;
        })
        .join("\n");
    /** "+1.5 / +6.6": the lineup change this week, then on form, as every gap on the card reads. */
    const pair = (mine: boolean) =>
      (["week", "form"] as const)
        .map((k) => {
          const m = l.by_measure[k];
          return m ? signed(mine ? m.mine : m.theirs) : "—";
        })
        .join(" / ");
    const inOut = (id: string) => {
      const p = P[id];
      return p ? `${p.name}: ${f1(p.week)} this week${p.why ? ` (${p.why})` : ""} · ${f1(p.form)} avg, ${plural(p.games, "game")}` : id;
    };
    return (
      <>
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span className="text-gray-300">{l.owner}</span>
          <span className="text-xs text-gray-500">send</span>
          <span>{who(l.give)}</span>
          <span className="text-xs text-gray-500">for</span>
          <span>{who(l.get)}</span>
          <span className="text-[11px] text-gray-500">two-way</span>
        </div>
        <MetaLine className="tabular-nums">
          <HoverInfo info={`Your lineup, ${inOut(l.get)} in\n${side(true)}\nRanked on the average: ${signed(l.my_gain)}`}>
            you {pair(true)}
          </HoverInfo>
          <HoverInfo info={`${l.owner}'s lineup, ${inOut(l.give)} in\n${side(false)}\nRanked on the average: ${signed(l.their_gain)}`}>
            them {pair(false)}
          </HoverInfo>
          {l.market_delta != null && (
            <HoverInfo info={`Market value: ${P[l.get]?.market_value?.toLocaleString() ?? "—"} in, ${P[l.give]?.market_value?.toLocaleString() ?? "—"} out`}>
              mkt {l.market_delta > 0 ? "+" : ""}
              {Math.round(l.market_delta).toLocaleString()}
            </HoverInfo>
          )}
        </MetaLine>
      </>
    );
  }
  if (l.kind === "give") {
    const shown = l.rivals.slice(0, LEAD_RIVALS);
    const rest = l.rivals.slice(LEAD_RIVALS);
    const cellOf = (ownerId: string) => rivalById.get(ownerId)?.cells[l.position] ?? null;
    const rival = (x: (typeof l.rivals)[number]) => {
      const c = cellOf(x.owner_id);
      return (
        <HoverInfo key={x.owner_id} info={c ? dirInfo(c.give, "give", x.owner, c, l.position) : ""} className={SIGNAL_CLS[x.signal ?? ""]}>
          <span className="text-gray-400">{x.owner}</span> {c ? gapPair(c.give) : ""}
        </HoverInfo>
      );
    };
    return (
      <>
        <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
          <span className="text-xs text-gray-500">your spare</span>
          <span>{who(l.player)}</span>
          <span className="text-xs text-gray-500">would start for {plural(l.rivals.length, "rival")}</span>
        </div>
        <MetaLine className="tabular-nums">
          {shown.map(rival)}
          {rest.length > 0 && (
            <HoverInfo
              info={rest
                .map((x) => {
                  const c = cellOf(x.owner_id);
                  return `${x.owner} ${c ? gapPair(c.give) : ""}`;
                })
                .join("\n")}
            >
              +{rest.length} more
            </HoverInfo>
          )}
        </MetaLine>
      </>
    );
  }
  const c = rivalById.get(l.owner_id)?.cells[l.position] ?? null;
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <span className="text-gray-300">{l.owner}</span>
        <span className="text-xs text-gray-500">has a spare</span>
        <span>{who(l.player)}</span>
        <span className="text-xs text-gray-500">who would start for you</span>
      </div>
      {c && (
        <MetaLine className="tabular-nums">
          <HoverInfo info={dirInfo(c.get, "get", l.owner, c, l.position)} className={SIGNAL_CLS[c.get.signal ?? ""]}>
            {gapPair(c.get)}
          </HoverInfo>
        </MetaLine>
      )}
    </>
  );
}

/** "Price this" beside a lead, as on Trade intel's rows. */
function PriceBtn({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      className="ff-inline ff-hit shrink-0 whitespace-nowrap rounded border border-gray-700 px-1.5 py-0.5 text-xs text-gray-400 hover:text-gray-200 sm:text-[11px] pointer-coarse:min-w-[2.5rem]"
    >
      Price<span className="hidden sm:inline"> this</span>
    </button>
  );
}

/* ── trade builder ──────────────────────────────────────────────────────
 *
 * The players you are building a deal around and the players you want held
 * constant while searching are the same players, so one panel does both: a
 * chip in either column is priced, and it can be pinned so every generated
 * package keeps it.
 */

/** "A + B" with each name opening the dossier (picks have none). */
function AssetNames({ assets, onPlayer }: { assets: Asset[]; onPlayer?: (id: string) => void }) {
  return (
    <span>
      {assets.map((a, i) => (
        <Fragment key={a.player_id}>
          {i > 0 && <span className="text-gray-500"> + </span>}
          <PlayerName id={a.player_id} name={a.name} onPlayer={isPickId(a) ? undefined : onPlayer} />
        </Fragment>
      ))}
    </span>
  );
}

const isPickId = (a: Asset) => a.is_pick || /^(DP|FP)_/.test(a.player_id);

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
  genErr,
  evalErr,
  onLoad,
  onPlayer,
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
  genErr: string | null;
  evalErr: string | null;
  onLoad: (p: Package) => void;
  onPlayer?: (id: string) => void;
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
      right={
        !empty && (
          <button
            type="button"
            onClick={() => {
              setGive([]);
              setGet([]);
            }}
            className="rounded border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:text-gray-200"
          >
            Clear deal
          </button>
        )
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <BuilderSide
          title="You give"
          side="mine"
          placeholder="Search your roster or a pick…"
          league={league}
          items={give}
          onAdd={(a) => setGive([...give.filter((x) => x.player_id !== a.player_id), a])}
          onRemove={(id) => setGive(give.filter((x) => x.player_id !== id))}
          onTogglePin={(a) => onTogglePin("mine", a)}
          pinnedIds={pinnedIds}
          priced={evaluation?.give}
          accent={C.critical}
          onPlayer={onPlayer}
        />
        <BuilderSide
          title="You get"
          side="theirs"
          counterparty={lockedTo}
          placeholder={
            lockedTo ? `Search ${lockedToName}'s roster…` : "Search a rival's roster or a pick…"
          }
          league={league}
          items={get}
          onAdd={(a) => setGet([...get.filter((x) => x.player_id !== a.player_id), a])}
          onRemove={(id) => setGet(get.filter((x) => x.player_id !== id))}
          onTogglePin={(a) => onTogglePin("theirs", a)}
          pinnedIds={pinnedIds}
          priced={evaluation?.get}
          accent={C.s1}
          onPlayer={onPlayer}
        />
      </div>

      {/* ── valuation ─────────────────────────────────────────────── */}
      {evalErr && !empty && <ErrorBox className="mt-4">{evalErr}</ErrorBox>}
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
                  {primary === "market" ? `${delta > 0 ? "+" : ""}${t.market_delta.toLocaleString()}` : signed(t.vor_delta)}
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
              You receive {signed(t.market_pct, 0)}% of what you send, by market value.
            </p>
          )}

          {evaluation.notes.map((n, i) => (
            <Note key={i}>{n}</Note>
          ))}
        </div>
      )}

      {/* ── search ────────────────────────────────────────────────── */}
      <div className="mt-4 border-t border-gray-800 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onGenerate()}
            disabled={generating}
            className="rounded bg-indigo-500/15 px-3 py-1.5 text-xs font-medium text-indigo-300 ring-1 ring-inset ring-indigo-500/40 hover:bg-indigo-500/25 disabled:opacity-50"
          >
            {generating
              ? "Searching…"
              : anyPinned
              ? `Find trades around ${pinnedIds.length} pinned`
              : "Find trades across the league"}
          </button>
          {partnerId && (
            <button
              type="button"
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

        {genErr && <ErrorBox className="mt-3">{genErr}</ErrorBox>}
        {generated && (
          <div className="mt-3">
            {generated.reason ? (
              <p className="text-sm text-amber-300/80">{generated.reason}</p>
            ) : generated.packages.length === 0 ? (
              anyPinned ? (
                <div className="space-y-1 text-xs text-gray-500">
                  <p>
                    None of the {generated.tried ?? 0} packages with the pinned players improves{" "}
                    {generated.counterparty ?? "the other manager"}'s lineup on rest-of-season points, or
                    costs it under {generated.tolerance?.points ?? 0} while giving them market value, so
                    they have no reason to accept.
                  </p>
                  {generated.closest && (
                    <p className="flex flex-wrap items-baseline gap-x-1.5">
                      <span>Closest: send</span>
                      <AssetNames assets={generated.closest.give} onPlayer={onPlayer} />
                      <span>for</span>
                      <AssetNames assets={generated.closest.get} onPlayer={onPlayer} />
                      <span className="tabular-nums">
                        · their lineup {signed(generated.closest.their_gain)} · yours{" "}
                        {signed(generated.closest.my_gain)}
                      </span>
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-gray-500">
                  Nothing viable across {generated.searched} team
                  {generated.searched === 1 ? "" : "s"}. No package improves both lineups — the normal
                  answer in a league where everyone drafted sensibly.
                </p>
              )
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
                        <span className="min-w-[9rem] font-medium text-gray-300">{p.counterparty}</span>
                        <span className="text-xs text-gray-500">send</span>
                        <AssetNames assets={p.give} onPlayer={onPlayer} />
                        <span className="text-xs text-gray-500">for</span>
                        <AssetNames assets={p.get} onPlayer={onPlayer} />
                        <button
                          type="button"
                          onClick={() => onLoad(p)}
                          className="ml-auto min-w-[2.5rem] rounded px-2 py-0.5 text-[11px] text-gray-400 ring-1 ring-inset ring-gray-700 hover:text-gray-100 hover:ring-gray-500"
                        >
                          Load above
                        </button>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-4 text-xs tabular-nums">
                        <span style={{ color: p.my_gain >= 0 ? C.s3 : C.critical }}>my lineup {signed(p.my_gain)}</span>
                        <span className="text-gray-500">their lineup {signed(p.their_gain)}</span>
                        {p.close_call && (
                          <HoverInfo
                            info={`Their lineup gets ${Math.abs(p.their_gain).toFixed(1)} rest-of-season points worse — under the ${
                              generated.tolerance?.points ?? ""
                            } allowed (${generated.tolerance?.per_week ?? 1} a week) — but they gain market value. Close enough that it comes down to how they rate the players.`}
                            className="text-amber-300/80"
                          >
                            close call
                          </HoverInfo>
                        )}
                        <span
                          style={{ color: p.market_delta >= 0 ? C.s1 : C.warning }}
                          title={
                            p.market_equivalent != null
                              ? `Your lineup change is worth ≈ ${p.market_equivalent > 0 ? "+" : ""}${p.market_equivalent.toLocaleString()} in market units, at the rate implied by your own roster`
                              : undefined
                          }
                        >
                          market {p.market_delta > 0 ? "+" : ""}
                          {p.market_delta.toLocaleString()}
                          {p.market_pct != null && (
                            <span className="ml-1 text-gray-600">({signed(p.market_pct, 0)}%)</span>
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
  onPlayer,
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
  onPlayer?: (id: string) => void;
}) {
  const byId = useMemo(() => {
    const m = new Map<string, Priced>();
    (priced ?? []).forEach((p) => m.set(p.player_id, p));
    return m;
  }, [priced]);

  return (
    // min-w-0: a grid item defaults to min-width auto, so a row of
    // non-shrinking chips (price, badges, pin) would widen the column past
    // the phone viewport instead of truncating the name.
    <div className="min-w-0 rounded-lg border border-gray-800 p-3">
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
        <p className="mt-3 text-xs text-gray-500">nothing yet</p>
      ) : (
        <ul className="mt-3 space-y-1.5">
          {items.map((a) => {
            const p = byId.get(a.player_id);
            const isPinned = pinnedIds.includes(a.player_id);
            return (
              <li
                key={a.player_id}
                className={`flex min-w-0 items-center gap-2 overflow-hidden rounded border px-2 py-1.5 ${
                  isPinned
                    ? "border-amber-500/40 bg-amber-500/5"
                    : "border-gray-800 bg-gray-950/40"
                }`}
              >
                <span className="w-9 shrink-0 text-xs text-gray-500">{a.position}</span>
                {/* The name opens the dossier; pin and × stay separate targets. */}
                <span className="min-w-0 truncate text-sm">
                  <PlayerName id={a.player_id} name={a.name} onPlayer={isPickId(a) ? undefined : onPlayer} />
                </span>
                <span className="flex-1" />
                <span className="shrink-0 text-right text-xs tabular-nums text-gray-400">
                  {p?.market_value != null ? p.market_value.toLocaleString() : "—"}
                  {p?.league_vor != null && (
                    // A row with badges is 45px too wide for a 390px phone
                    // even with the name at zero width, so the VOR figure
                    // (repeated in the valuation panel below) yields there.
                    <span className={`ml-2 text-gray-600 ${p.claims ? "hidden sm:inline" : ""}`}>
                      VOR {p.league_vor.toFixed(1)}
                    </span>
                  )}
                </span>
                {/* What the sites say: the two most-repeated actions. Badges
                    never shrink, so it is the name that truncates; on a phone
                    only the top action fits alongside the price. */}
                {p?.claims && (
                  <span className="flex shrink-0 items-center gap-1" data-claims={a.player_id}>
                    {Object.entries(p.claims.by_action)
                      .sort((x, y) => y[1] - x[1])
                      .slice(0, 2)
                      .map(([action, n], i) => (
                        <span key={action} className={i === 0 ? "contents" : "hidden sm:contents"}>
                          <Badge
                            tone={ACTION_TONE[action] ?? "neutral"}
                            title={
                              p.claims?.evidence[0]
                                ? `${p.claims.evidence[0].source}: ${p.claims.evidence[0].rationale}`
                                : undefined
                            }
                          >
                            {action}
                            {n > 1 ? ` ×${n}` : ""}
                          </Badge>
                        </span>
                      ))}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onTogglePin(a)}
                  title="Pin — every generated package will contain this player"
                  className={`shrink-0 ${ROW_BTN} ${
                    isPinned
                      ? "bg-amber-500/10 text-amber-300 ring-amber-500/40"
                      : "text-gray-500 ring-gray-800 hover:text-gray-200 hover:ring-gray-600"
                  }`}
                >
                  {isPinned ? "Pinned" : "Pin"}
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(a.player_id)}
                  className="shrink-0 px-1 text-gray-600 hover:text-red-400 pointer-coarse:min-w-[2.5rem]"
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
