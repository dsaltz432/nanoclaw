import type { ReactNode } from "react";
import { Badge, C, Card, HBars, LineChart, Note, RangeRow, SubHead, Td, Th, useIsNarrow } from "./viz";
import { SectionProvider } from "./method";

/**
 * FAAB market — the reference half of the waiver engine, folded away at the
 * bottom of Moves: what each projection tier has cost in this league's own
 * sealed-bid history, who can still outbid you, and how fast each manager
 * usually burns his budget.
 *
 * Reference only. It renders from the `market` block the Moves payload
 * already carries and fetches nothing; the add/drop list itself is the Moves
 * Board, which is the only one.
 */

export type Market = {
  price_table: {
    budget: number;
    contests_scored?: number;
    contests_total?: number;
    rows: {
      tier: string;
      n: number;
      thin: boolean;
      median?: number;
      p75?: number;
      p90?: number;
      mean_next4_pts?: number | null;
    }[];
  } | null;
  contest_summary: { note?: string } | null;
  rival_budgets: {
    rivals: { owner: string; is_me: boolean; used: number; total: number; pct_left: number }[];
    note: string;
    degenerate: boolean;
  } | null;
  budget_burn: {
    owner: string;
    owner_id: string;
    handle: string;
    person: string | null;
    is_me: boolean;
    active: boolean;
    weeks: number[];
    /** Seasons of bidding history behind the curve. */
    seasons: number;
    curve: number[];
    final: number;
  }[] | null;
  principles: string[] | null;
};

/** A heading inside the one collapsible card; its notes file under it in Methodology. */
function Section({ title, caption, children }: { title: string; caption?: string; children: ReactNode }) {
  return (
    <SectionProvider name={title}>
      <section className="min-w-0">
        <SubHead>{title}</SubHead>
        {caption && <p className="mt-0.5 text-xs text-gray-500">{caption}</p>}
        <div className="mt-2">{children}</div>
      </section>
    </SectionProvider>
  );
}

export default function FaabMarket({ market, budget, week }: { market: Market; budget: number | null; week: number }) {
  const narrow = useIsNarrow();
  const prices = market.price_table?.rows ?? [];
  const rivals = market.rival_budgets;
  const burn = market.budget_burn ?? [];
  const total = budget ?? market.price_table?.budget ?? null;
  const priceMax = Math.max(1, ...prices.map((r) => r.p90 ?? 0));
  // Identity comes from the id the server resolved, never from matching a
  // display string.
  const burnMine = burn.find((b) => b.is_me);
  const burnLive = burn.filter((b) => b.active);
  // Managers who left the league stay in the table for their history, below
  // everyone still bidding.
  const burnRows = [...burnLive, ...burn.filter((b) => !b.active)];
  // One season of history is that season, not an average of one.
  const burnSpan = burn.every((b) => b.seasons === 1) ? "last season" : "averaged across seasons";
  // The column that matters is where a typical season stands at this point
  // of this one.
  const burnAt = (b: (typeof burn)[number]) => {
    const i = b.weeks.indexOf(week);
    return b.curve[i >= 0 ? i : b.curve.length - 1];
  };
  const dollars = (v: number | undefined) => (v != null ? `$${v}` : "—");

  return (
    <Card collapsible title="FAAB market" subtitle="price table · rivals' budgets · burn curves">
      {(market.principles ?? []).map((x, i) => (
        <Note key={i}>{x}</Note>
      ))}
      {market.contest_summary?.note && <Note>{market.contest_summary.note}</Note>}

      <div className="space-y-6">
        {prices.length > 0 && (
          <Section
            title="What each tier costs"
            caption={
              market.price_table?.contests_total != null
                ? `Winning bids in this league's sealed-bid history, by projection tier (${market.price_table.contests_scored ?? 0} of ${market.price_table.contests_total} contests priced).`
                : "Winning bids in this league's sealed-bid history, by projection tier."
            }
          >
            {/* A real grid on a phone too, at text-xs: the three prices are
                the table, and n, the spread bar and next-4 are desktop detail
                (n stays in the tier's tooltip and the thin badge). */}
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-gray-800">
                  <Th>Tier</Th>
                  <Th className="hidden text-right sm:table-cell">n</Th>
                  <Th className="text-right">Median</Th>
                  <Th className="text-right">p75</Th>
                  <Th className="text-right">p90</Th>
                  <Th className="hidden sm:table-cell">Spread</Th>
                  <Th className="hidden text-right sm:table-cell">Next 4 wks</Th>
                </tr>
              </thead>
              <tbody>
                {prices.map((r) => (
                  <tr key={r.tier} className="border-b border-gray-800/60">
                    <Td className="whitespace-nowrap text-xs">
                      <Badge tone={r.tier === "11+" ? "good" : "neutral"} title={`${r.n} winning bid${r.n === 1 ? "" : "s"} at ${r.tier} projected points`}>
                        {r.tier}
                      </Badge>
                      {r.thin && r.n > 0 && (
                        <Badge tone="warning" className="ml-1" title={`only ${r.n} winning bid${r.n === 1 ? "" : "s"}: read these prices loosely`}>
                          thin
                        </Badge>
                      )}
                    </Td>
                    <Td className="hidden text-right text-xs tabular-nums text-gray-500 sm:table-cell">{r.n}</Td>
                    <Td className="text-right text-xs tabular-nums">{dollars(r.median)}</Td>
                    <Td className="text-right text-xs tabular-nums text-gray-100">{dollars(r.p75)}</Td>
                    <Td className="text-right text-xs tabular-nums text-gray-500">{dollars(r.p90)}</Td>
                    <Td className="hidden sm:table-cell">
                      {r.median != null && r.p75 != null && r.p90 != null && (
                        <RangeRow median={r.median} p75={r.p75} p90={r.p90} max={priceMax} width={160} />
                      )}
                    </Td>
                    <Td className="hidden text-right text-xs tabular-nums sm:table-cell" style={{ color: C.s3 }}>
                      {r.mean_next4_pts != null ? r.mean_next4_pts.toFixed(1) : "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* The legend belongs to the Spread bars, which a phone does not show. */}
            <div className="mt-2 hidden flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 sm:flex">
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
              Read Spread and Next 4 wks together: if a higher tier costs the same as a lower one but returns more
              over the next four weeks, the league is not pricing on quality.
            </Note>
          </Section>
        )}

        {rivals &&
          (rivals.degenerate ? (
            // Every manager still holds about a full budget: a chart of twelve
            // full bars says nothing, so the section is one line.
            <Section title="Who can still outbid you">
              <p className="text-xs text-gray-500">
                Everyone is within a few points of a full budget, so remaining FAAB distinguishes nobody yet.
              </p>
            </Section>
          ) : (
            <Section
              title="Who can still outbid you"
              caption={total != null ? `Percent of the $${total} budget left, right now.` : "Percent of budget left, right now."}
            >
              <HBars
                rows={rivals.rivals
                  .slice()
                  .sort((a, b) => b.pct_left - a.pct_left)
                  .map((r) => ({
                    label: r.is_me ? `${r.owner} (you)` : r.owner,
                    value: r.pct_left,
                    emphasis: r.is_me,
                    note: `$${r.used} of $${r.total} spent`,
                  }))}
                max={100}
                labelWidth={narrow ? 110 : 170}
                format={(v) => `${v.toFixed(0)}%`}
              />
              <Note>{rivals.note}</Note>
            </Section>
          ))}

        {burn.length > 0 && (
          <Section title={`Budget burn, ${burnSpan}`} caption="Cumulative percent of budget spent by week.">
            <Note>
              A manager who is broke in week 10 cannot outbid you in week 10, which is a better guide than his usual
              bid size.
            </Note>
            {/* Managers who have left the league cannot bid against you; they
                stay in the table below (dimmed) but not in the envelope. */}
            <LineChart
              xLabels={burnLive[0]?.weeks ?? []}
              yMax={100}
              yFormat={(v) => `${Math.round(v)}%`}
              emphasisLabel={burnMine ? `${burnMine.owner} (you)` : undefined}
              series={burnLive.map((b) => ({ label: b.owner, points: b.curve, emphasis: b.is_me }))}
            />
            <table className="mt-3 w-full border-collapse">
              <thead>
                <tr className="border-b border-gray-800">
                  <Th>Manager</Th>
                  <Th className="whitespace-nowrap text-right" title={`Share of budget typically spent by week ${week}, ${burnSpan}`}>
                    By wk {week}
                  </Th>
                  <Th className="text-right" title="Under 75% (amber) leaves a quarter of the budget unspent">
                    Season total
                  </Th>
                </tr>
              </thead>
              <tbody>
                {burnRows.map((b) => {
                  const at = burnAt(b);
                  return (
                    <tr
                      key={b.owner_id}
                      className={`border-b border-gray-800/60 ${b.is_me ? "bg-indigo-500/5" : ""} ${b.active ? "" : "opacity-50"}`}
                    >
                      <Td className={`text-xs ${b.is_me ? "text-gray-100" : ""}`}>
                        <span title={`${b.seasons} season${b.seasons === 1 ? "" : "s"} of history`}>{b.owner}</span>
                        {b.person && b.handle && <span className="ml-1.5 text-gray-600">{b.handle}</span>}
                        {b.is_me && <span className="ml-1 text-indigo-400">you</span>}
                        {!b.active && (
                          <span className="ml-1 text-gray-500" title="No roster this season; historical bids only">
                            left the league
                          </span>
                        )}
                      </Td>
                      <Td className="text-right text-xs tabular-nums">{at != null ? `${at.toFixed(0)}%` : "—"}</Td>
                      <Td className="text-right text-xs tabular-nums">
                        <span style={b.final < 75 ? { color: C.warning } : undefined}>{b.final.toFixed(0)}%</span>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Section>
        )}
      </div>
    </Card>
  );
}
