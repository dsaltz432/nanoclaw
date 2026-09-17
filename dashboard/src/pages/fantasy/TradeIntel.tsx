import { useEffect, useState } from "react";
import { Badge, Card } from "./viz";
import { ACTION_TONE, srcShort } from "./labels";

/**
 * Trade intel — the decision layer above the trade builder.
 *
 * Sell candidates you own (the sites say sell), buy targets rivals own (the
 * sites say buy), each with the consensus rank, FantasyCalc market value and
 * the strongest rationale. In the dynasty league, also the value gaps: where
 * FantasyPros' dynasty ECR ranks a player well above where the FantasyCalc
 * market prices him (cheap to acquire), and the reverse on your roster
 * (a sell window). The builder below prices any deal both ways as before.
 */

type Rank = { median: number; best: number; worst: number; spread: number; n: number } | null;
type Row = {
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
};

type Data = {
  scope: string;
  sell: Row[];
  buy: Row[];
  value_gaps: { buy_cheap: Row[]; sell_high: Row[]; note: string } | null;
  error?: string;
};


export default function TradeIntel({ league, onPlayer }: { league: string; onPlayer?: (id: string) => void }) {
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

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card title="Sell talk on your roster" subtitle="Players you own the sites say sell." className="self-start">
        <List rows={data.sell} empty="No sell talk on your roster in the window." action="sell" />
      </Card>
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
    </div>
  );
}
