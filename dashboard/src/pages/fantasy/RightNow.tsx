import { useEffect, useState } from "react";
import { Badge, C, Note, SourceLink } from "./viz";

/**
 * "Right now" — the three things that matter today, drawn from every tab.
 *
 * It sits above the subtabs on purpose. The failure it exists to fix was that
 * the single most important item on a given day required cross-referencing three
 * tabs to notice: the news layer knew a starter was hurt, that his projection had
 * fallen, and that a named successor was the fourth-most-added player in the
 * country, while the waiver board still showed him as a healthy starter. Every
 * fact was on screen and none of them were next to each other.
 */

type Successor = {
  name: string;
  position: string | null;
  team: string | null;
  trigger: string;
  value_now: number | null;
  value_if_triggered: number;
  expected: number;
  my_bar: number | null;
  availability: string;
  rostered_by: string | null;
  option_bid_pct: number;
  trending_rank: number | null;
  trending_count: number | null;
  trigger_reason: string | null;
  headline: string;
  published_at: string;
  projection_predates_note: boolean;
  reasoning: string;
  clears_bar_if_triggered: boolean;
};

type Item = {
  kind: string;
  action: string;
  severity: "critical" | "warning";
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  projected: number | null;
  bye_week: number | null;
  headline: string | null;
  url: string | null;
  published_at: string | null;
  evidence: string[];
  successors: Successor[];
};

type NowData = {
  items: Item[];
  contingent: Successor[];
  successors_gone: Successor[];
  more: number;
  week: number;
  reason?: string;
  method_note?: string;
  open_question?: string;
  error?: string;
};

export default function RightNow({
  league,
  collapsed,
  onToggle,
}: {
  league: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const [data, setData] = useState<NowData | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setData(null);
    fetch(`/api/fantasy/now?league=${encodeURIComponent(league)}`)
      .then((r) => r.json())
      .then((d) => (d.error ? undefined : setData(d)))
      .catch(() => undefined);
  }, [league]);

  if (!data) return null;

  const nothing = data.items.length === 0 && data.contingent.length === 0;

  return (
    <section className="mb-5 rounded-lg border border-indigo-500/25 bg-indigo-500/[0.04]">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-indigo-500/15 px-3 py-2 sm:px-4 sm:py-2.5">
        <h3 className="text-sm font-semibold text-indigo-200">Right now</h3>
        <span className="text-xs text-gray-500">
          week {data.week} · drawn from every tab
        </span>
        {data.more > 0 && <span className="text-xs text-gray-600">{data.more} more below</span>}
        {collapsed && data.items[0] && (
          <span className="line-clamp-2 text-xs leading-snug text-gray-400">
            {data.items[0].position} {data.items[0].name} — {data.items[0].action}
          </span>
        )}
        {!collapsed && (
          <button
            onClick={() => setOpen((v) => !v)}
            className="ml-auto text-xs text-indigo-400 hover:text-indigo-300"
          >
            {open ? "hide method" : "how this is chosen"}
          </button>
        )}
        <button
          onClick={onToggle}
          className={`text-xs text-indigo-400 hover:text-indigo-300 ${collapsed ? "ml-auto" : ""}`}
        >
          {collapsed ? "expand" : "collapse"}
        </button>
      </header>

      {collapsed ? null : (

      <div className="space-y-3 px-3 py-2.5 sm:px-4 sm:py-3">
        {nothing && (
          <p className="text-sm text-gray-400">
            {data.reason ??
              "Nothing needs you today — no starter of yours has a designation, a material projection move or a role-transferring report."}
          </p>
        )}

        {data.items.map((i) => (
          <div key={i.player_id}>
            <div className="flex flex-wrap items-baseline gap-2">
              {/* Same scale as the Alerts tab — "check" was a third severity
                  word that meant nothing next to warning/critical. */}
              <Badge tone={i.severity}>{i.severity}</Badge>
              <span className="text-base font-medium text-gray-100">
                {i.position} {i.name}
              </span>
              <span className="text-xs text-gray-500">{i.team}</span>
              {i.projected != null && (
                <span className="text-xs tabular-nums text-gray-500">
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
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-gray-500">
              {i.evidence.map((e, n) => (
                <li key={n}>· {e}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-sm text-gray-200">
              <span className="mr-1.5 text-xs uppercase tracking-wide text-gray-500">Do</span>
              {i.action}
            </p>
          </div>
        ))}

        {data.contingent.length > 0 && (
          <div className="border-t border-gray-800 pt-3">
            <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
              Contingent value — an option on a future week, not this one
            </h4>
            <ul className="space-y-2">
              {data.contingent.map((s, n) => (
                <li key={n} className="rounded border border-gray-800 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="text-gray-100">
                      {s.position} {s.name}
                    </span>
                    <span className="text-xs text-gray-600">{s.team}</span>
                    <Badge tone={s.clears_bar_if_triggered ? "info" : "neutral"}>{s.trigger}</Badge>
                    {s.availability === "free_agent" ? (
                      <Badge tone="good">free agent</Badge>
                    ) : (
                      <Badge tone="neutral">waivers</Badge>
                    )}
                    {s.trending_rank && (
                      <span className="text-xs" style={{ color: C.warning }}>
                        #{s.trending_rank} trending — {s.trending_count?.toLocaleString()} adds
                      </span>
                    )}
                    <span className="ml-auto text-xs text-gray-500">
                      bid ≤ {s.option_bid_pct}% of budget
                    </span>
                  </div>
                  {/* The prose already states all four numbers; a strip
                      repeating them four pixels above was the same figures
                      twice. */}
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">{s.reasoning}</p>
                  <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-gray-600">
                    {s.trigger_reason && <span>triggered by: {s.trigger_reason}</span>}
                    {s.projection_predates_note && (
                      <span style={{ color: C.warning }}>projection predates this report</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {data.successors_gone.length > 0 && (
          <p className="border-t border-gray-800 pt-3 text-xs text-gray-500">
            Already claimed:{" "}
            {data.successors_gone
              .map((s) => `${s.name} (${s.rostered_by})`)
              .join(", ")}
            . That window has closed — worth knowing before you plan around it.
          </p>
        )}

        {open && (
          <div className="border-t border-gray-800 pt-3">
            {data.method_note && <Note>{data.method_note}</Note>}
            {data.open_question && <Note>{data.open_question}</Note>}
          </div>
        )}
      </div>
      )}
    </section>
  );
}
