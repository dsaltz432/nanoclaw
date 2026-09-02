import { useEffect, useMemo, useState } from "react";
import { Badge, C, Card, Note, Td, Th } from "./viz";

/**
 * Trends — where demand is moving, and whether it has reached your league yet.
 *
 * The distinction this tab exists to hold: it ranks DEMAND, not production.
 * FINDINGS.md §4 tested usage signals against the residual of a projection and
 * found nothing — target share, touch trend, WOPR and touch volume all correlate
 * ~0 with beating a projection, and the steepest decliners had the most positive
 * residual. So nothing here claims a player will outscore his projection. It
 * says who other managers are about to want, which is what decides whether you
 * can have him and what he will cost.
 *
 * Four crowds, and the useful part is where they disagree. A player the national
 * platforms own at 57% who is still a free agent in your twelve-team league is
 * not a forecast about football; it is an observation that your league has not
 * looked, and it is the only one of these facts you can act on today.
 */

type Row = {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  injury_status: string | null;
  availability: "free_agent" | "waivers" | "rostered";
  rostered_by: string | null;
  sleeper: {
    rank_6: number | null;
    rank_24: number | null;
    rank_168: number | null;
    adds_24: number | null;
    adds_168: number | null;
    acceleration: number | null;
    drop_rank_24: number | null;
  };
  espn: { pct_owned: number | null; pct_change: number | null; pct_started: number | null };
  market: { value: number | null; trend_30d_points: number | null; trend_30d_pct: number | null };
  ros_points: number | null;
  vor: number | null;
  beats_rostered: number;
  rostered_at_pos: number;
  my_leagues: string[];
  rival_has_him: string[];
  local_adds: { league: string; owner: string; type: string; at: number | null }[];
  verdict: string;
  why: string;
};

type Mover = {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  value: number;
  trend_30d: number;
};

type TrendsData = {
  league_key: string;
  league_name: string;
  week: number;
  rows: Row[];
  total: number;
  counts: Record<string, number>;
  movers?: { up: Mover[]; down: Mover[]; note: string };
  sources: { source: string; label: string; last_run: string | null; ok: boolean; rows: number }[];
  limits: string[];
  error?: string;
};

/** Verdict → how loudly to say it. Only the top three are actions. */
const TONE: Record<string, string> = {
  "move now": C.critical,
  "your league is slow": C.s3,
  rising: C.s3,
  "being dropped": C.warning,
  "market up": C.s1,
  "market down": C.ink2,
  peaked: C.ink2,
  fading: C.ink2,
  watch: C.ink2,
  rostered: C.ink2,
};

const ACTIONS = new Set(["move now", "your league is slow", "rising"]);

/**
 * `why` arrives from the API shaped as "<this player's fact> — <what that kind
 * of fact means>", and the second half is per-VERDICT, not per-player: every
 * "being dropped" row carried the same twenty words about the crowd giving up.
 * Five rows of identical prose stop being an explanation and become wallpaper
 * you learn to skip, which costs the unique half its readership too.
 *
 * The split is done on the data rather than against a hard-coded list of server
 * strings, so new verdicts need no change here: a tail is only lifted out when
 * two or more visible rows actually share it. A row whose explanation is unique
 * keeps it inline, where it is still doing work.
 */
const WHY_SPLIT = " — ";

function splitWhy(why: string): { head: string; tail: string | null } {
  const i = why.indexOf(WHY_SPLIT);
  if (i < 0) return { head: why, tail: null };
  return { head: why.slice(0, i), tail: why.slice(i + WHY_SPLIT.length) };
}

export default function TrendsTab({ league }: { league: string }) {
  const [data, setData] = useState<TrendsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [pos, setPos] = useState<string | null>(null);
  const [q, setQ] = useState("");

  useEffect(() => {
    setData(null);
    fetch(`/api/fantasy/trends?league=${encodeURIComponent(league)}&limit=150`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : (setErr(null), setData(d))))
      .catch((e) => setErr(String(e)));
  }, [league]);

  const rows = useMemo(() => {
    if (!data) return [];
    let r = data.rows;
    if (!showAll) r = r.filter((x) => x.verdict !== "watch");
    if (pos) r = r.filter((x) => (pos === "FLEX" ? ["RB", "WR", "TE"].includes(x.position ?? "") : x.position === pos));
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      r = r.filter((x) => x.name.toLowerCase().includes(needle) || (x.team ?? "").toLowerCase().includes(needle));
    }
    return r;
  }, [data, showAll, pos, q]);

  // Explanations shared by two or more visible rows, lifted out of the rows and
  // shown once as a legend. Keyed by tail so the verdicts that share one are
  // named together.
  const sharedWhy = useMemo(() => {
    const byTail = new Map<string, Set<string>>();
    for (const r of rows) {
      const { tail } = splitWhy(r.why);
      if (!tail) continue;
      if (!byTail.has(tail)) byTail.set(tail, new Set());
      byTail.get(tail)!.add(r.verdict);
    }
    const counts = new Map<string, number>();
    for (const r of rows) {
      const { tail } = splitWhy(r.why);
      if (tail) counts.set(tail, (counts.get(tail) ?? 0) + 1);
    }
    return [...byTail.entries()]
      .filter(([tail]) => (counts.get(tail) ?? 0) > 1)
      .map(([tail, verdicts]) => ({ tail, verdicts: [...verdicts] }));
  }, [rows]);

  const sharedTails = useMemo(() => new Set(sharedWhy.map((s) => s.tail)), [sharedWhy]);

  // A column whose every cell says the same thing is a tautology occupying a
  // seventh of the width. In a free-agent board "free agent" is the default
  // case, so it only earns its place once something in view differs.
  const availabilityVaries = useMemo(
    () => new Set(rows.map((r) => `${r.availability}:${r.rostered_by ?? ""}`)).size > 1,
    [rows],
  );

  if (err) return <div className="p-6 text-sm text-red-400">{err}</div>;
  if (!data) return <div className="p-6 text-sm text-gray-500">Loading…</div>;

  const actionable = data.rows.filter((r) => ACTIONS.has(r.verdict)).length;
  const uniformAvailability = rows.length > 0 && !availabilityVaries ? rows[0] : null;

  return (
    <div className="space-y-4">
      <Card
        title="What the crowds are doing"
        subtitle={
          actionable > 0
            ? `${actionable} worth acting on · ${data.total} players moving`
            : `Nothing demands a move · ${data.total} players moving`
        }
        right={
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="player or team…"
              className="w-40 rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-100 placeholder:text-gray-600"
            />
            {["QB", "RB", "WR", "TE", "FLEX"].map((p) => (
              <button
                key={p}
                onClick={() => setPos(pos === p ? null : p)}
                className={`rounded border px-1.5 py-0.5 text-[11px] ${
                  pos === p
                    ? "border-indigo-500/50 bg-indigo-500/10 text-indigo-300"
                    : "border-gray-800 text-gray-500 hover:border-gray-700"
                }`}
              >
                {p}
              </button>
            ))}
            <label className="flex items-center gap-1.5 text-xs text-gray-400">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                className="accent-indigo-500"
              />
              include quiet
            </label>
          </div>
        }
      >
        {rows.length === 0 ? (
          <p className="text-sm text-gray-500">
            Nothing is moving that you could act on in {data.league_name}. That is a real answer in
            preseason — tick &ldquo;include quiet&rdquo; to see the whole board.
          </p>
        ) : (
          <div className="overflow-x-auto ff-stack-wrap">
            <table className="ff-stack w-full min-w-[860px] border-collapse">
              <thead>
                <tr className="border-b border-gray-800">
                  <Th>Player</Th>
                  <Th>Verdict</Th>
                  <Th className="hidden text-right sm:table-cell">Sleeper 24h</Th>
                  <Th className="hidden text-right sm:table-cell">vs week</Th>
                  <Th className="hidden text-right sm:table-cell">ESPN owned</Th>
                  <Th className="hidden text-right sm:table-cell">Beats</Th>
                  {availabilityVaries && <Th>Availability</Th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.player_id} className="border-b border-gray-800/60 align-top">
                    <Td data-label="" className="ff-row-head">
                      <span className="text-xs text-gray-600">{r.position}</span>{" "}
                      <span className="text-gray-100">{r.name}</span>{" "}
                      <span className="text-xs text-gray-600">{r.team}</span>
                      {r.injury_status && (
                        <>
                          {" "}
                          <Badge tone="warning">{r.injury_status}</Badge>
                        </>
                      )}
                      <p className="mt-0.5 max-w-full text-xs leading-relaxed text-gray-500 sm:max-w-lg">
                        {(() => {
                          const { head, tail } = splitWhy(r.why);
                          return tail && sharedTails.has(tail) ? head : r.why;
                        })()}
                      </p>
                      {/* "also rostered by a rival in dynasty" was here and
                          appeared on nearly every row, for the same reason it
                          was demoted from the verdict: the dynasty league
                          carries three times the players, so it reports league
                          depth rather than demand. The version with a timestamp
                          -- a rival ADDING him -- survives, inside `why`. */}
                      {r.my_leagues.length > 0 && (
                        <p className="mt-0.5 text-[11px] text-gray-600">
                          you already have him in {r.my_leagues.join(", ")}
                        </p>
                      )}
                    </Td>
                    <Td data-label="Verdict">
                      <span className="text-xs font-medium" style={{ color: TONE[r.verdict] ?? C.ink2 }}>
                        {r.verdict}
                      </span>
                    </Td>
                    <Td data-label="Sleeper 24h" className="hidden sm:table-cell whitespace-nowrap text-right tabular-nums text-gray-400">
                      {r.sleeper.rank_24 ? (
                        <>
                          #{r.sleeper.rank_24}
                          <span className="ml-1 text-[11px] text-gray-600">
                            {(r.sleeper.adds_24 ?? 0).toLocaleString()}
                          </span>
                        </>
                      ) : (
                        <span className="text-gray-700">—</span>
                      )}
                    </Td>
                    <Td data-label="vs week" className="hidden sm:table-cell whitespace-nowrap text-right tabular-nums">
                      {/* Acceleration: the share of a week's adds that landed in
                          the last day, over what an even trickle would give.
                          Above 2x is a story breaking now rather than one the
                          league already acted on. */}
                      {r.sleeper.acceleration != null ? (
                        <span
                          style={{
                            color:
                              r.sleeper.acceleration >= 2
                                ? C.s3
                                : r.sleeper.acceleration < 0.8
                                ? C.ink2
                                : C.ink,
                          }}
                          title={`#${r.sleeper.rank_168 ?? "—"} over the full week`}
                        >
                          {r.sleeper.acceleration.toFixed(1)}×
                        </span>
                      ) : (
                        <span className="text-gray-700">—</span>
                      )}
                    </Td>
                    <Td data-label="ESPN owned" className="hidden sm:table-cell whitespace-nowrap text-right tabular-nums text-gray-400">
                      {r.espn.pct_owned != null ? (
                        <>
                          {r.espn.pct_owned.toFixed(0)}%
                          {r.espn.pct_change != null && Math.abs(r.espn.pct_change) >= 0.1 && (
                            <span
                              className="ml-1 text-[11px]"
                              style={{ color: r.espn.pct_change > 0 ? C.s3 : C.warning }}
                            >
                              {r.espn.pct_change > 0 ? "+" : ""}
                              {r.espn.pct_change.toFixed(1)}
                            </span>
                          )}
                        </>
                      ) : (
                        <span className="text-gray-700">—</span>
                      )}
                    </Td>
                    <Td
                      data-label="Beats"
                      className="hidden whitespace-nowrap text-right tabular-nums text-gray-500 sm:table-cell"
                      title="Players already rostered in this league, at his position, who project below him"
                    >
                      {r.beats_rostered}
                      <span className="text-gray-700">/{r.rostered_at_pos}</span>
                    </Td>
                    {availabilityVaries && (
                      <Td data-label="Availability" className="whitespace-nowrap text-xs">
                        {r.availability === "free_agent" ? (
                          <Badge tone="good">free agent</Badge>
                        ) : r.availability === "waivers" ? (
                          <Badge tone="neutral">waivers</Badge>
                        ) : (
                          <span className="text-gray-500">{r.rostered_by}</span>
                        )}
                      </Td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {/* The explanations lifted off the rows above, said once each. */}
        {sharedWhy.length > 0 && (
          <dl className="mt-3 space-y-1 border-t border-gray-800/60 pt-2.5">
            {sharedWhy.map(({ tail, verdicts }) => (
              <div key={tail} className="flex flex-wrap gap-x-1.5 text-[11px] leading-relaxed">
                <dt
                  className="shrink-0 font-medium"
                  style={{ color: (verdicts[0] && TONE[verdicts[0]]) || C.ink2 }}
                >
                  {verdicts.join(" / ")}
                </dt>
                <dd className="min-w-0 flex-1 text-gray-600">{tail}</dd>
              </div>
            ))}
          </dl>
        )}
        {uniformAvailability && (
          <Note>
            {uniformAvailability.availability === "free_agent"
              ? "Every player listed is a free agent right now."
              : uniformAvailability.availability === "waivers"
              ? "Every player listed is on waivers right now."
              : "Every player listed is already rostered."}
          </Note>
        )}
        {data.limits.map((l, i) => (
          <Note key={i}>{l}</Note>
        ))}
      </Card>

      {data.movers && (data.movers.up.length > 0 || data.movers.down.length > 0) && (
        <div className="grid gap-4 lg:grid-cols-2">
          <MoverList title="Trade value rising" rows={data.movers.up} tone={C.s3} note={data.movers.note} />
          <MoverList title="Trade value falling" rows={data.movers.down} tone={C.warning} note={data.movers.note} />
        </div>
      )}

      <Card title="Where this comes from" subtitle="Four crowds, and the disagreement between them"
        secondary
      >
        <ul className="space-y-2">
          {data.sources.map((s) => (
            <li key={s.source} className="flex flex-wrap items-baseline gap-2 text-xs">
              <Badge tone={s.ok ? "good" : "warning"}>{s.ok ? "ok" : "stale"}</Badge>
              <span className="text-gray-300">{s.label}</span>
              <span className="text-gray-600">{s.rows.toLocaleString()} rows</span>
              <span className="ml-auto text-gray-600">{s.last_run ? fmt(s.last_run) : "never"}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function MoverList({
  title,
  rows,
  tone,
  note,
}: {
  title: string;
  rows: Mover[];
  tone: string;
  note: string;
}) {
  return (
    <Card title={title} subtitle="This league's own market format">
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.player_id} className="flex items-baseline gap-2 text-sm">
            <span className="w-8 shrink-0 text-xs text-gray-600">{r.position}</span>
            <span className="truncate text-gray-200">{r.name}</span>
            <span className="text-xs text-gray-600">{r.team}</span>
            <span className="ml-auto shrink-0 tabular-nums text-xs text-gray-500">
              {r.value.toLocaleString()}
            </span>
            <span className="w-16 shrink-0 text-right tabular-nums text-xs" style={{ color: tone }}>
              {r.trend_30d > 0 ? "+" : ""}
              {r.trend_30d.toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
      <Note>{note}</Note>
    </Card>
  );
}

function fmt(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
