import { useEffect, useState, type ReactNode } from "react";
import { Badge, Card, ErrorBox, FoldToggle, HoverInfo, Loading, MetaLine, Note, QuietLine, Td, Th } from "./viz";
import { ACTION_TONE } from "./labels";
import { SectionProvider } from "./method";
import { ClaimQuote, PlayerName, RankText, type Claim } from "./NoteLine";

/**
 * Trade intel — the decision layer above the trade builder.
 *
 * Sell candidates you own (the sites say sell), the softer "weakening" signal
 * (drop/sit talk, or a consensus rank that fell), and buy targets rivals own
 * (the sites say buy), each with the consensus rank, FantasyCalc market value
 * and the strongest rationale. In the dynasty league, also the value gaps:
 * where FantasyPros' dynasty ECR ranks a player well above where the
 * FantasyCalc market prices him (cheap to acquire), and the reverse on your
 * roster (a sell window) — and the draft picks you hold, priced by the market.
 * Every row has a "price this" that drops it into the builder below on the
 * side it can only ever be on.
 */

type Rank = { median: number; best: number; worst: number } | null;
export type Row = {
  player_id: string;
  name: string;
  pos: string;
  team: string | null;
  status: string;
  owner: string | null;
  rank: Rank;
  delta: number | null;
  overall: number | null;
  market_value: number | null;
  market_rank: number | null;
  /** Value change over the last week / 30 days, from the stored daily snapshots
   *  (not FantasyCalc's own trend30Day, which is not a plain difference of its
   *  values and disagrees with the dossier's chart). */
  market_trend_7d?: number | null;
  market_change_30d?: number | null;
  /** Evidence is filtered server-side to the action that put the row on its list, newest first. */
  claims: { n: number; n_sources: number; by_action: Record<string, number>; evidence: Claim[] } | null;
  gap?: number;
  /** Weakening rows only: the reasons, already worded ("drop talk ×2"). */
  why?: string[];
};

export type Pick = {
  season: string;
  round: number;
  original_roster_id: string;
  original_owner: string;
  holder_roster_id: string;
  holder: string;
  market_value: number | null;
  market_rank: number | null;
  band: null | { early: number | null; mid: number | null; late: number | null };
  asset_id: string;
  name: string;
  via_trade: boolean;
};

type Picks = {
  held: Pick[];
  sent: Pick[];
  total_market: number;
  note: string;
};

type Data = {
  sell: Row[];
  buy: Row[];
  value_gaps: { buy_cheap: Row[]; sell_high: Row[]; note: string } | null;
  weakening?: Row[];
  weakening_note?: string;
  sell_note?: string;
  /** Dynasty league only. */
  picks?: Picks | null;
  error?: string;
};

/**
 * "FantasyCalc trade value 1,262 / Last 7 days: up 659 (+109%) / Last 30
 * days: up 473 (+60%)": the "mkt 1,262 ▲659" on a row, spelled out.
 */
function marketInfo(value: number, week: number | null | undefined, month: number | null | undefined): string {
  const change = (label: string, t: number | null | undefined) => {
    if (t == null) return `${label}: no history yet`;
    if (Math.round(t) === 0) return `${label}: unchanged`;
    const before = value - t;
    const pct = before > 0 ? ` (${t > 0 ? "+" : "−"}${Math.abs(Math.round((100 * t) / before))}%)` : "";
    return `${label}: ${t > 0 ? "up" : "down"} ${Math.abs(Math.round(t)).toLocaleString()}${pct}`;
  };
  return [`FantasyCalc trade value ${Math.round(value).toLocaleString()}`, change("Last 7 days", week), change("Last 30 days", month)].join("\n");
}

export type PriceSide = "give" | "get";

/** Buy targets shown before "show all". */
const BUY_FOLD = 5;

const fmtValue = (v: number | null | undefined) => (v != null ? Math.round(v).toLocaleString() : "—");

/**
 * "price this" beside a row. Compact on a phone ("price", 12px) with the
 * coarse-pointer hit area from `ff-hit` rather than padding, and `shrink-0`
 * in a row whose left column takes the rest, so it never wraps onto a line
 * of its own.
 */
function PriceBtn({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="ff-inline ff-hit shrink-0 whitespace-nowrap rounded border border-gray-700 px-1.5 py-0.5 text-xs text-gray-400 hover:text-gray-200 sm:text-[11px] pointer-coarse:min-w-[2.5rem]"
    >
      Price<span className="hidden sm:inline"> this</span>
    </button>
  );
}

/** The dossier and builder handlers every row needs. */
type RowCtx = {
  onPlayer?: (id: string) => void;
  onPrice?: (row: Row, side: PriceSide) => void;
};

function Meta({ r }: { r: Row }) {
  return (
    <MetaLine>
      {r.rank && (
        <span>
          <RankText pos={r.pos} median={r.rank.median} best={r.rank.best} worst={r.rank.worst} delta={r.delta} />
        </span>
      )}
      {r.market_value != null && (
        <HoverInfo info={marketInfo(r.market_value, r.market_trend_7d, r.market_change_30d)} className="whitespace-nowrap tabular-nums">
          mkt {fmtValue(r.market_value)}
          {/* The week's change: in season a week is one game, where thirty
              days is four. Both are in the hover. */}
          {r.market_trend_7d != null && Math.round(r.market_trend_7d) !== 0 && (
            <span className={r.market_trend_7d > 0 ? "ml-1 text-green-500" : "ml-1 text-red-400"}>
              {r.market_trend_7d > 0 ? "▲" : "▼"}
              {Math.abs(Math.round(r.market_trend_7d)).toLocaleString()}
            </span>
          )}
        </HoverInfo>
      )}
    </MetaLine>
  );
}

/** The newest claim for the action that listed him; the dossier has the rest. */
function Quote({ r }: { r: Row }) {
  const e = r.claims?.evidence?.[0];
  return e ? (
    <div className="mt-0.5">
      <ClaimQuote e={e} />
    </div>
  ) : null;
}

/**
 * One intel row: everything about the player in a left column that takes the
 * width, the price button pinned to the right.
 */
function IntelRow({
  r,
  side,
  head,
  children,
  ctx,
}: {
  r: Row;
  side: PriceSide;
  head?: ReactNode;
  children?: ReactNode;
  ctx: RowCtx;
}) {
  const { onPlayer, onPrice } = ctx;
  return (
    <li className="flex items-start gap-2 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span>
            <PlayerName id={r.player_id} name={r.name} pos={r.pos} team={r.team} onPlayer={onPlayer} />
          </span>
          {r.owner && r.status !== "mine" && <span className="text-xs text-gray-500">{r.owner}</span>}
          {head}
        </div>
        {children}
      </div>
      {onPrice && (
        <PriceBtn
          onClick={() => onPrice(r, side)}
          title={side === "give" ? "Put him in “You give” below" : "Put him in “You get” below"}
        />
      )}
    </li>
  );
}

/** A sell or buy row: the action that listed him, how many sites, rank/market, one quote. */
function TalkRow({ r, action, ctx }: { r: Row; action: "sell" | "buy"; ctx: RowCtx }) {
  const n = r.claims?.by_action[action] ?? 0;
  return (
    <IntelRow
      r={r}
      side={action === "sell" ? "give" : "get"}
      ctx={ctx}
      head={
        <>
          <Badge tone={ACTION_TONE[action]}>
            {action}
            {n > 1 ? ` ×${n}` : ""}
          </Badge>
          {r.claims && (
            <span className="text-[11px] text-gray-600">
              {r.claims.n_sources} {r.claims.n_sources === 1 ? "site" : "sites"}
            </span>
          )}
        </>
      }
    >
      <Meta r={r} />
      <Quote r={r} />
    </IntelRow>
  );
}

/**
 * A dynasty value-gap row: the experts' overall dynasty rank against the
 * market's overall rank. Both are overall (not positional), because the gap
 * is their difference and has to be readable off the two numbers beside it.
 */
function GapRow({ r, side, ctx }: { r: Row; side: PriceSide; ctx: RowCtx }) {
  return (
    <IntelRow r={r} side={side} ctx={ctx}>
      <MetaLine className="tabular-nums">
        <span title="FantasyPros dynasty ECR, overall">dynasty #{r.overall}</span>
        <span title="FantasyCalc market value, overall rank">market #{r.market_rank}</span>
        {r.gap != null && (
          <span className={side === "get" ? "text-green-400" : "text-amber-300"} title="Market rank minus dynasty rank">
            {r.gap > 0 ? `+${r.gap}` : r.gap}
          </span>
        )}
      </MetaLine>
    </IntelRow>
  );
}

/** A method note registered under a list's title when the list itself is not rendered as a card. */
function SectionNote({ title, note }: { title: string; note?: string }) {
  return note ? (
    <SectionProvider name={title}>
      <Note>{note}</Note>
    </SectionProvider>
  ) : null;
}

/** An empty list is one line, not a card; its method note still registers under the same title. */
function Quiet({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <>
      <QuietLine title={title}>{children}</QuietLine>
      <SectionNote title={title} note={note} />
    </>
  );
}

export default function TradeIntel({
  league,
  onPlayer,
  onPrice,
  onPricePick,
}: {
  league: string;
  onPlayer?: (id: string) => void;
  /** Drop a player into the builder. Sell-side rows are yours (give); buy-side rows are a rival's (get). */
  onPrice?: (row: Row, side: PriceSide) => void;
  /** Drop one of your draft picks into the builder's give side. */
  onPricePick?: (p: Pick) => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [allBuy, setAllBuy] = useState(false);

  useEffect(() => {
    setData(null);
    fetch(`/api/fantasy/trade-intel?league=${encodeURIComponent(league)}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : (setErr(null), setData(d))))
      .catch((e) => setErr(String(e)));
  }, [league]);

  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!data) return <Loading label="Loading trade intel…" rows={4} />;

  const ctx: RowCtx = { onPlayer, onPrice };
  const weakening = data.weakening ?? [];
  const picks = data.picks ?? null;
  const buyShown = allBuy ? data.buy : data.buy.slice(0, BUY_FOLD);

  const SELL = "Sell talk on your roster";
  const WEAK = "Weakening";
  // Both lists read your own roster, so when both are empty one line says so;
  // their method notes still register under each list's own title.
  const quietRoster = data.sell.length === 0 && weakening.length === 0;

  return (
    <div className="space-y-4">
      {quietRoster ? (
        <>
          {/* Named for the card it stands in for: "Your roster" is the roster panel below. */}
          <QuietLine title={SELL}>No sell talk and nothing weakening in the window.</QuietLine>
          <SectionNote title={SELL} note={data.sell_note} />
          <SectionNote title={WEAK} note={data.weakening_note} />
        </>
      ) : data.sell.length === 0 ? (
        <Quiet title={SELL} note={data.sell_note}>
          No sell talk on your roster in the window.
        </Quiet>
      ) : (
        <Card title={SELL} info="Rest-of-season sell talk at least matching the buy talk.">
          <ul className="space-y-2">
            {data.sell.map((r) => (
              <TalkRow key={r.player_id} r={r} action="sell" ctx={ctx} />
            ))}
          </ul>
          {data.sell_note && <Note>{data.sell_note}</Note>}
        </Card>
      )}

      {quietRoster ? null : weakening.length === 0 ? (
        <Quiet title={WEAK} note={data.weakening_note}>
          Nothing on your roster is softening in the window.
        </Quiet>
      ) : (
        <Card title={WEAK} info="Softer than a sell call: drop or sit talk, or a falling rank.">
          <ul className="space-y-2">
            {weakening.map((r) => (
              <IntelRow
                key={r.player_id}
                r={r}
                side="give"
                ctx={ctx}
                head={(r.why ?? []).map((w, i) => (
                  <Badge key={i} tone="neutral">
                    {w}
                  </Badge>
                ))}
              >
                <Meta r={r} />
                <Quote r={r} />
              </IntelRow>
            ))}
          </ul>
          {data.weakening_note && <Note>{data.weakening_note}</Note>}
        </Card>
      )}

      {data.buy.length === 0 ? (
        <QuietLine title="Buy targets on rival rosters">No buy talk about rivals' players in the window.</QuietLine>
      ) : (
        <Card title="Buy targets on rival rosters">
          <ul className="space-y-2">
            {buyShown.map((r) => (
              <TalkRow key={r.player_id} r={r} action="buy" ctx={ctx} />
            ))}
          </ul>
          <FoldToggle
            total={data.buy.length}
            shown={buyShown.length}
            expanded={allBuy}
            onToggle={() => setAllBuy((v) => !v)}
            mode="all"
          />
        </Card>
      )}

      {data.value_gaps && (
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          {data.value_gaps.buy_cheap.length === 0 ? (
            <Quiet title="Cheap by the market" note={data.value_gaps.note}>
              No large gaps.
            </Quiet>
          ) : (
            <Card title="Cheap by the market" info="Rivals' players the dynasty experts rank well above their market price.">
              <ul className="space-y-1.5">
                {data.value_gaps.buy_cheap.map((r) => (
                  <GapRow key={r.player_id} r={r} side="get" ctx={ctx} />
                ))}
              </ul>
              <Note>{data.value_gaps.note}</Note>
            </Card>
          )}
          {data.value_gaps.sell_high.length === 0 ? (
            <QuietLine title="Sell high">No large gaps.</QuietLine>
          ) : (
            <Card title="Sell high" info="Your players the market prices well above the dynasty experts' rank.">
              <ul className="space-y-1.5">
                {data.value_gaps.sell_high.map((r) => (
                  <GapRow key={r.player_id} r={r} side="give" ctx={ctx} />
                ))}
              </ul>
              <Note>{data.value_gaps.note}</Note>
            </Card>
          )}
        </div>
      )}

      {picks &&
        (picks.held.length === 0 ? (
          <Quiet title="Your picks" note={picks.note}>
            You hold no draft picks.
          </Quiet>
        ) : (
          <Card title="Your picks" subtitle={`${picks.held.length} picks · market ${picks.total_market.toLocaleString()}`}>
            <PickList picks={picks.held} onPricePick={onPricePick} />
            {picks.sent.length > 0 && (
              <p className="mt-3 text-xs text-gray-500">
                Your own slots held by others: {picks.sent.map((s) => `${s.name} (${s.holder})`).join(", ")}
              </p>
            )}
            <Note>{picks.note}</Note>
          </Card>
        ))}
    </div>
  );
}

/**
 * The picks you hold. A compact two-line row on a phone (pick and value on
 * line one, the early/late band under it, price on the right); a table on
 * anything wider.
 */
function PickList({ picks, onPricePick }: { picks: Pick[]; onPricePick?: (p: Pick) => void }) {
  const bandOf = (p: Pick) => (p.band && (p.band.early != null || p.band.late != null) ? p.band : null);
  // Two picks in the same round (your own slot plus one traded in) share an
  // asset id, so the key needs the originating roster too.
  const keyOf = (p: Pick) => `${p.asset_id}-${p.original_roster_id}`;
  const price = (p: Pick) =>
    onPricePick && <PriceBtn onClick={() => onPricePick(p)} title="Put this pick in “You give” below" />;
  const via = (p: Pick) =>
    p.via_trade && <span className="ml-1.5 text-xs font-normal text-gray-500">via {p.original_owner}</span>;

  return (
    <>
      <ul className="divide-y divide-gray-800/60 sm:hidden">
        {picks.map((p) => {
          const band = bandOf(p);
          return (
            <li key={keyOf(p)} className="flex items-start gap-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="min-w-0 text-gray-100">
                    {p.name}
                    {via(p)}
                  </span>
                  <span className="shrink-0 tabular-nums text-gray-300">{fmtValue(p.market_value)}</span>
                </div>
                {(band || p.market_rank != null) && (
                  <div className="text-[11px] tabular-nums text-gray-500">
                    {band && `early ${fmtValue(band.early)} · late ${fmtValue(band.late)}`}
                    {band && p.market_rank != null && " · "}
                    {p.market_rank != null && `#${p.market_rank}`}
                  </div>
                )}
              </div>
              {price(p)}
            </li>
          );
        })}
      </ul>
      <div className="hidden overflow-x-auto sm:block">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-gray-800">
              <Th>Pick</Th>
              <Th className="text-right">Value</Th>
              <Th className="text-right">Rank</Th>
              <Th>&nbsp;</Th>
            </tr>
          </thead>
          <tbody>
            {picks.map((p) => {
              const band = bandOf(p);
              return (
                <tr key={keyOf(p)} className="border-b border-gray-800/60">
                  <Td>
                    <span className="text-gray-100">
                      {p.name}
                      {via(p)}
                    </span>
                  </Td>
                  <Td className="text-right tabular-nums">
                    <span className="text-gray-300">{fmtValue(p.market_value)}</span>
                    {band && (
                      <span className="ml-2 whitespace-nowrap text-[11px] text-gray-500">
                        early {fmtValue(band.early)} · late {fmtValue(band.late)}
                      </span>
                    )}
                  </Td>
                  <Td className="text-right tabular-nums text-gray-500">
                    {p.market_rank != null ? `#${p.market_rank}` : "—"}
                  </Td>
                  <Td className="text-right">{price(p)}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
