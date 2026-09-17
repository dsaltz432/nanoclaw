import { useEffect, useState } from "react";
import { Badge, Card, Td, Th } from "./viz";
import { ACTION_TONE, srcShort } from "./labels";

/**
 * Trade intel — the decision layer above the trade builder.
 *
 * Sell candidates you own (the sites say sell), buy targets rivals own (the
 * sites say buy), each with the consensus rank, FantasyCalc market value and
 * the strongest rationale. Below the sell talk, the softer signal: players
 * whose talk is drop/sit rather than sell, or whose consensus rank fell. In
 * the dynasty league, also the value gaps: where FantasyPros' dynasty ECR
 * ranks a player well above where the FantasyCalc market prices him (cheap to
 * acquire), and the reverse on your roster (a sell window) — and the draft
 * picks you hold, priced by the market. Every row has a "price this" that
 * drops it into the builder below on the side it can only ever be on.
 */

type Rank = { median: number; best: number; worst: number; spread: number; n: number } | null;
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
  market_trend_30d: number | null;
  claims: { n: number; n_sources: number; net: number; by_action: Record<string, number>; by_horizon: Record<string, number>; evidence: { action: string; horizon: string; rationale: string; source: string }[] } | null;
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
  rounds: number;
  seasons: string[];
  total_market: number;
  note: string;
};

type Data = {
  scope: string;
  sell: Row[];
  buy: Row[];
  value_gaps: { buy_cheap: Row[]; sell_high: Row[]; note: string } | null;
  weakening?: Row[];
  weakening_note?: string;
  /** Dynasty league only. */
  picks?: Picks | null;
  error?: string;
};

export type PriceSide = "give" | "get";

const PRICE_BTN =
  "rounded border border-gray-700 px-1.5 py-0.5 text-[11px] text-gray-400 hover:text-gray-200";

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

  useEffect(() => {
    setData(null);
    fetch(`/api/fantasy/trade-intel?league=${encodeURIComponent(league)}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : (setErr(null), setData(d))))
      .catch((e) => setErr(String(e)));
  }, [league]);

  if (err) return <div className="text-sm text-red-400">{err}</div>;
  if (!data) return <div className="text-sm text-gray-500">Loading trade intel…</div>;

  const Name = ({ r }: { r: Row }) => (
    <>
      <button onClick={() => onPlayer?.(r.player_id)} className="text-left text-gray-100 hover:text-indigo-300 hover:underline">
        {r.name}
      </button>
      <span className="ml-1.5 text-xs text-gray-500">
        {r.pos}
        {r.team ? ` · ${r.team}` : ""}
      </span>
    </>
  );

  const Meta = ({ r }: { r: Row }) => (
    <span className="whitespace-nowrap text-[11px] text-gray-500">
      {r.rank && (
        <span>
          {r.pos}
          {r.rank.median}
        </span>
      )}
      {r.market_value != null && <span className="ml-2">mkt {Math.round(r.market_value)}</span>}
      {r.market_trend_30d != null && r.market_trend_30d !== 0 && (
        <span className={r.market_trend_30d > 0 ? "ml-1 text-green-500" : "ml-1 text-red-400"}>
          {r.market_trend_30d > 0 ? "▲" : "▼"}
          {Math.abs(Math.round(r.market_trend_30d))}
        </span>
      )}
    </span>
  );

  const Evidence = ({ r }: { r: Row }) =>
    r.claims?.evidence[0] ? (
      <div className="text-xs text-gray-500">
        <span className="text-gray-600">{srcShort(r.claims.evidence[0].source)}:</span> {r.claims.evidence[0].rationale}
      </div>
    ) : null;

  const PriceBtn = ({ r, side }: { r: Row; side: PriceSide }) =>
    onPrice ? (
      <button
        type="button"
        onClick={() => onPrice(r, side)}
        className={PRICE_BTN}
        title={side === "give" ? "Put him in “You give” below" : "Put him in “You get” below"}
      >
        price this
      </button>
    ) : null;

  const List = ({ rows, empty, action }: { rows: Row[]; empty: string; action: "sell" | "buy" }) =>
    rows.length === 0 ? (
      <p className="text-xs text-gray-600">{empty}</p>
    ) : (
      <ul className="space-y-1.5">
        {rows.map((r) => (
          <li key={r.player_id} className="text-sm">
            <div className="flex flex-wrap items-baseline gap-2">
              <Name r={r} />
              {r.owner && r.status !== "mine" && <span className="text-xs text-gray-500">{r.owner}</span>}
              <Badge tone={ACTION_TONE[action]}>
                {action}
                {(r.claims?.by_action[action] ?? 0) > 1 ? ` ×${r.claims?.by_action[action]}` : ""}
              </Badge>
              {r.claims && <span className="text-[11px] text-gray-600">{r.claims.n_sources} {r.claims.n_sources === 1 ? "site" : "sites"}</span>}
              <PriceBtn r={r} side={action === "sell" ? "give" : "get"} />
            </div>
            {/* Meta on its own line. As an ml-auto tail it wrapped under the
                name on most rows and the list zig-zagged name / meta / why. */}
            <div className="shrink-0">
              <Meta r={r} />
            </div>
            <Evidence r={r} />
          </li>
        ))}
      </ul>
    );

  const weakening = data.weakening ?? [];
  const picks = data.picks ?? null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Sell talk and the softer "weakening" signal share a column so the
          two reads on your own roster sit together. */}
      <div className="space-y-4 self-start">
        <Card title="Sell talk on your roster" subtitle="Players you own the sites say sell.">
          <List rows={data.sell} empty="No sell talk on your roster in the window." action="sell" />
        </Card>
        <Card title="Weakening" subtitle="Softer than a sell call.">
          {weakening.length === 0 ? (
            <p className="text-xs text-gray-600">Nothing on your roster is softening in the window.</p>
          ) : (
            <ul className="space-y-1.5">
              {weakening.map((r) => (
                <li key={r.player_id} className="text-sm">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <Name r={r} />
                    {(r.why ?? []).map((w, i) => (
                      <Badge key={i} tone="neutral">
                        {w}
                      </Badge>
                    ))}
                    <PriceBtn r={r} side="give" />
                  </div>
                  <div className="shrink-0">
                    <Meta r={r} />
                  </div>
                  <Evidence r={r} />
                </li>
              ))}
            </ul>
          )}
          {data.weakening_note && <p className="mt-3 text-[11px] leading-relaxed text-gray-600">{data.weakening_note}</p>}
        </Card>
      </div>
      <Card title="Buy targets on rival rosters" subtitle="Players rivals own the sites say buy. Owner shown; the builder below prices the deal.">
        <List rows={data.buy} empty="No buy talk about rivals' players in the window." action="buy" />
      </Card>
      {data.value_gaps && (
        <>
          <Card title="Cheap by the market" subtitle="Rivals' players the dynasty experts rank well above the market price. gap = FantasyCalc rank − ECR rank.">
            {data.value_gaps.buy_cheap.length === 0 ? (
              <p className="text-xs text-gray-600">No large gaps.</p>
            ) : (
              <ul className="space-y-1">
                {data.value_gaps.buy_cheap.map((r) => (
                  <li key={r.player_id} className="flex flex-wrap items-baseline gap-2 text-sm">
                    <Name r={r} />
                    <span className="text-xs text-gray-500">{r.owner}</span>
                    <PriceBtn r={r} side="get" />
                    <span className="basis-full text-xs tabular-nums text-gray-400 sm:ml-auto sm:basis-auto">
                      ECR {r.overall} · mkt #{r.market_rank} <span className="text-green-400">+{r.gap}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Sell high" subtitle="Your players the market prices well above where the dynasty experts rank them.">
            {data.value_gaps.sell_high.length === 0 ? (
              <p className="text-xs text-gray-600">No large gaps.</p>
            ) : (
              <ul className="space-y-1">
                {data.value_gaps.sell_high.map((r) => (
                  <li key={r.player_id} className="flex flex-wrap items-baseline gap-2 text-sm">
                    <Name r={r} />
                    <PriceBtn r={r} side="give" />
                    <span className="basis-full text-xs tabular-nums text-gray-400 sm:ml-auto sm:basis-auto">
                      ECR {r.overall} · mkt #{r.market_rank} <span className="text-amber-300">{r.gap}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
      {picks && (
        <Card
          title="Your picks"
          subtitle={`${picks.held.length} picks · market ${picks.total_market.toLocaleString()}`}
          className="lg:col-span-2"
        >
          {picks.held.length === 0 ? (
            <p className="text-xs text-gray-600">You hold no draft picks.</p>
          ) : (
            <div className="ff-stack-wrap overflow-x-auto">
              <table className="ff-stack w-full border-collapse">
                <thead>
                  <tr className="border-b border-gray-800">
                    <Th>Pick</Th>
                    <Th className="text-right">Value</Th>
                    <Th className="text-right">Rank</Th>
                    <Th>&nbsp;</Th>
                  </tr>
                </thead>
                <tbody>
                  {picks.held.map((p) => {
                    const band = p.band && (p.band.early != null || p.band.late != null) ? p.band : null;
                    return (
                      // Two picks in the same round (your own slot plus one
                      // traded in) share an asset id, so the key needs the
                      // originating roster too.
                      <tr key={`${p.asset_id}-${p.original_roster_id}`} className="border-b border-gray-800/60">
                        <Td data-label="" className="ff-row-head">
                          <span className="text-gray-100">
                            {p.name}
                            {p.via_trade && <span className="ml-1.5 text-xs font-normal text-gray-500">via {p.original_owner}</span>}
                          </span>
                        </Td>
                        <Td data-label="Value" className="text-right tabular-nums">
                          <span className="whitespace-nowrap">
                            <span className="text-gray-300">{p.market_value != null ? Math.round(p.market_value).toLocaleString() : "—"}</span>
                            {band && (
                              <span className="ml-2 text-[11px] text-gray-500">
                                early {band.early != null ? Math.round(band.early).toLocaleString() : "—"} · late{" "}
                                {band.late != null ? Math.round(band.late).toLocaleString() : "—"}
                              </span>
                            )}
                          </span>
                        </Td>
                        <Td data-label="Rank" className="text-right tabular-nums text-gray-500">
                          <span>{p.market_rank != null ? `#${p.market_rank}` : "—"}</span>
                        </Td>
                        <Td data-label="">
                          <span>
                            {onPricePick && (
                              <button type="button" onClick={() => onPricePick(p)} className={PRICE_BTN} title="Put this pick in “You give” below">
                                price this
                              </button>
                            )}
                          </span>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {picks.sent.length > 0 && (
            <p className="mt-3 text-xs text-gray-500">
              Your own slots held by others: {picks.sent.map((s) => `${s.name} (${s.holder})`).join(", ")}
            </p>
          )}
          {picks.note && <p className="mt-3 text-[11px] leading-relaxed text-gray-600">{picks.note}</p>}
        </Card>
      )}
    </div>
  );
}
