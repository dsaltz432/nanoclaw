import { useState } from "react";
import { SectionProvider } from "./method";
import { PlayerName } from "./NoteLine";
import { Badge, FoldToggle, Loading, Note, SourceLink } from "./viz";

/**
 * "Right now" — the top of the Today tab: a starter of yours with a new
 * designation, a material projection move or a role-changing report, where
 * your bench does not already cover him.
 *
 * The failure it exists to fix was that the single most important item on a
 * given day required cross-referencing three tabs to notice: the news layer
 * knew a starter was hurt, that his projection had fallen, and that a named
 * successor was the fourth-most-added player in the country, while the waiver
 * board still showed him as a healthy starter. Every fact was on screen and
 * none of them were next to each other.
 *
 * The data is the Today payload's `needs_you` (rightnow.right_now), so the
 * section arrives with the rest of the tab in one fetch. `items` holds every
 * item, worst first; the first ITEMS_SHOWN show and the rest fold.
 */

const ITEMS_SHOWN = 3;

type Claimed = { player_id: string; name: string; rostered_by: string | null };

type Item = {
  action: string;
  severity: "critical" | "warning";
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  projected: number | null;
  headline: string | null;
  url: string | null;
  evidence: string[];
};

/** A starter at risk whose bench cover already has it handled. */
type Covered = {
  player_id: string;
  name: string;
  cover: string;
  cover_projected: number;
};

export type NowData = {
  items: Item[];
  covered?: Covered[];
  successors_gone?: Claimed[];
  week?: number;
  reason?: string | null;
  method_note?: string;
  open_question?: string;
};

export default function RightNow({
  data,
  loading,
  onPlayer,
}: {
  data: NowData | undefined;
  loading: boolean;
  onPlayer: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  if (!data && !loading) return null;

  const allItems = data?.items ?? [];
  const items = showAll ? allItems : allItems.slice(0, ITEMS_SHOWN);
  const covered = data?.covered ?? [];
  const gone = data?.successors_gone ?? [];
  const nothing = allItems.length === 0;

  // One cover can hold two starters ("Aaron Jones, Tony Pollard (J.K. Dobbins)"),
  // so group by the bench player rather than repeat him.
  const byCover = new Map<string, Covered[]>();
  for (const c of covered) byCover.set(c.cover, [...(byCover.get(c.cover) ?? []), c]);

  const nothingText =
    data?.reason ??
    (covered.length
      ? "Nothing needs you today."
      : "Nothing needs you today — no starter of yours has a designation, a material projection move or a role-changing report.");

  return (
    <section className="rounded-lg border border-indigo-500/25 bg-indigo-500/[0.04]">
      {/* When nothing needs you, the one sentence rides in the header and the
          card is a single line: a header plus a body for "nothing" was 87px. */}
      <header
        className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 sm:px-4 sm:py-2.5 ${
          data && nothing && !covered.length ? "" : "border-b border-indigo-500/15"
        }`}
      >
        <h3 className="text-sm font-semibold text-indigo-200">Right now</h3>
        {data?.week != null && !nothing && <span className="text-xs text-gray-500">week {data.week}</span>}
        {data && nothing && <span className="min-w-0 text-xs text-gray-400">{nothingText}</span>}
        {collapsed && items[0] && (
          <span className="line-clamp-2 text-xs leading-snug text-gray-400">
            {items[0].position} {items[0].name} — {items[0].action}
          </span>
        )}
        {/* An empty card has nothing to fold away. */}
        {!nothing && (
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-expanded={!collapsed}
            className="ff-inline ff-hit ml-auto text-xs text-indigo-400 hover:text-indigo-300"
          >
            {collapsed ? "Expand" : "Collapse"}
          </button>
        )}
      </header>

      {/* Server-authored method text lives on the Methodology page. */}
      <SectionProvider name="Right now">
        {data?.method_note && <Note>{data.method_note}</Note>}
        {data?.open_question && <Note>{data.open_question}</Note>}
      </SectionProvider>

      {!data ? (
        <div className="px-3 py-2.5 sm:px-4 sm:py-3">
          <Loading rows={1} />
        </div>
      ) : collapsed || (nothing && !covered.length) ? null : (
        <div className="space-y-3 px-3 py-2.5 sm:px-4 sm:py-3">

          {items.map((i) => (
            <div key={i.player_id}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm font-medium">
                <Badge tone={i.severity}>{i.severity}</Badge>
                <PlayerName id={i.player_id} name={i.name} pos={i.position} team={i.team} onPlayer={onPlayer} />
                {i.projected != null && (
                  <span className="text-xs font-normal tabular-nums text-gray-500">
                    starting at {i.projected.toFixed(1)}
                  </span>
                )}
              </div>
              {i.headline && (
                <p className="mt-1 text-sm leading-relaxed text-gray-300">
                  {i.headline}
                  {i.url && <SourceLink href={i.url} />}
                </p>
              )}
              {i.evidence.length > 0 && (
                <p className="mt-1 text-xs text-gray-500">{i.evidence.join(" · ")}</p>
              )}
              <p className="mt-1.5 text-sm text-gray-200">
                <span className="mr-1.5 text-xs uppercase tracking-wide text-gray-500">Do</span>
                {i.action}
              </p>
            </div>
          ))}
          <FoldToggle
            total={allItems.length}
            shown={items.length}
            expanded={showAll}
            onToggle={() => setShowAll((v) => !v)}
          />

          {byCover.size > 0 && (
            <p className="text-xs text-gray-500">
              Covered off the bench:{" "}
              {[...byCover.entries()].map(([cover, starters], n) => (
                <span key={cover}>
                  {n > 0 && "; "}
                  {starters.map((s, k) => (
                    <span key={s.player_id}>
                      {k > 0 && ", "}
                      <PlayerName id={s.player_id} name={s.name} onPlayer={onPlayer} />
                    </span>
                  ))}{" "}
                  ({cover}, {starters[0]?.cover_projected.toFixed(1)})
                </span>
              ))}
            </p>
          )}

          {gone.length > 0 && (
            <p className="border-t border-gray-800 pt-3 text-xs text-gray-500">
              Already claimed:{" "}
              {gone.map((s, n) => (
                <span key={s.player_id}>
                  {n > 0 && ", "}
                  <PlayerName id={s.player_id} name={s.name} onPlayer={onPlayer} />
                  {s.rostered_by && ` (${s.rostered_by})`}
                </span>
              ))}
              . That window has closed — worth knowing before you plan around it.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
