import { useEffect, useState } from "react";
import { Badge } from "./viz";
import { ACTION_TONE, SCOPE_LABEL, horizonLabel, projShort, srcLabel } from "./labels";
import { Delta, MatchupCell, RoleBadge, type Matchup, type Usage } from "./NoteLine";

/**
 * Player dossier — everything the store knows about one player, in one
 * panel, opened from any player name on the Fantasy tab.
 *
 * Rankings per scope across sources, the extracted claims with their
 * rationale and a link to the article, recent wire notes, and roster status
 * plus league-correct projections in each of the three leagues. All strings
 * from third parties arrive defanged; claims are rendered as "source says",
 * never as the tool's own view.
 */

type Consensus = { median: number; best: number; worst: number; spread: number; n: number } | null;

type RankScope = {
  pos: string;
  ranks: Record<string, number>;
  overall: Record<string, Record<string, number>>;
  fp: { rank: number; min: number; max: number; avg: number; std: number; tier: number | null; experts: number } | null;
  consensus: Consensus;
  delta: number | null;
  snapshot: string;
  prev_snapshot: string | null;
};

type Evidence = {
  action: string;
  horizon: string;
  confidence: number | null;
  rationale: string;
  source: string;
  title: string;
  url: string;
  author: string;
  published_at: string | null;
  flagged: boolean;
};

type RankPoint = { snapshot_date: string; median: number; best: number; worst: number; n: number };

type Data = {
  player: {
    player_id: string;
    full_name: string;
    position: string;
    team: string | null;
    injury_status: string | null;
    age: number | null;
    years_exp: number | null;
    rookie: boolean;
  };
  season: string;
  week: number;
  rankings: Record<string, RankScope>;
  /** Consensus per snapshot, oldest first, up to 14; a scope with no history is absent. */
  rank_history: Partial<Record<"weekly" | "ros" | "dynasty", RankPoint[]>>;
  claims: {
    n: number;
    n_sources: number;
    n_articles: number;
    by_action: Record<string, number>;
    by_horizon: Record<string, number>;
    bullish: number;
    bearish: number;
    net: number;
    evidence: Evidence[];
  } | null;
  news: { published_at: string; headline: string; story?: string; flagged?: boolean }[];
  leagues: Record<string, { status: string; owner: string | null; is_me: boolean; proj: Record<string, number> }>;
  usage: (NonNullable<Usage> & { opponent: string | null })[];
  matchup: Matchup;
  role_change_points: number;
  error?: string;
};

/** "09-16" from "2026-09-16". */
const mmdd = (d: string) => d.slice(5, 10);

/**
 * Consensus rank over the last snapshots. The Y axis is inverted — rank 1 sits
 * at the top, since lower is better — so a line that climbs reads as the sites
 * warming to him, which is the direction a reader expects. The whole thing is
 * 120px wide so three of them fit across the dialog on a desktop and one fits
 * a phone sheet with room to spare.
 */
function Sparkline({ points }: { points: RankPoint[] }) {
  if (points.length === 1) return <div className="mt-1 text-[11px] text-gray-600">1 snapshot</div>;
  if (points.length < 2) return null;
  const W = 120;
  const H = 28;
  const LABEL_H = 12;
  const padX = 3;
  const padY = 3;
  const meds = points.map((p) => p.median);
  const lo = Math.min(...meds);
  const hi = Math.max(...meds);
  const x = (i: number) => padX + (i / (points.length - 1)) * (W - padX * 2);
  // Flat history: draw it through the middle rather than divide by zero.
  const y = (v: number) => (hi === lo ? H / 2 : padY + ((v - lo) / (hi - lo)) * (H - padY * 2));
  const coords = points.map((p, i) => `${x(i).toFixed(1)},${y(p.median).toFixed(1)}`);
  const last = points[points.length - 1]!;
  const first = points[0]!;
  return (
    <svg
      width={W}
      height={H + LABEL_H}
      viewBox={`0 0 ${W} ${H + LABEL_H}`}
      className="mt-1 block max-w-full"
      role="img"
      aria-label={`consensus rank over ${points.length} snapshots`}
      data-sparkline
    >
      <title>{points.map((p) => `${p.snapshot_date}: ${p.median}`).join("\n")}</title>
      <polyline fill="none" stroke="#3987e5" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" points={coords.join(" ")} />
      <circle cx={x(points.length - 1)} cy={y(last.median)} r={2.2} fill="#3987e5" />
      <text x={padX} y={H + LABEL_H - 2} fontSize={8} fill="#6b7280" textAnchor="start">
        {mmdd(first.snapshot_date)}
      </text>
      <text x={W - padX} y={H + LABEL_H - 2} fontSize={8} fill="#6b7280" textAnchor="end">
        {mmdd(last.snapshot_date)}
      </text>
    </svg>
  );
}

export default function PlayerDossier({ playerId, onClose }: { playerId: string; onClose: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    fetch(`/api/fantasy/dossier?player=${encodeURIComponent(playerId)}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : (setErr(null), setData(d))))
      .catch((e) => setErr(String(e)));
  }, [playerId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // A defence's number is what it faces; everyone else's is his own team's.
  const implied = data?.matchup ? (data.player.position === "DEF" ? data.matchup.opp_implied_total : data.matchup.implied_total) : null;

  return (
    <div className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div
        className="ff-scope max-h-[92dvh] w-full max-w-3xl overflow-y-auto rounded-t-2xl border border-gray-800 bg-gray-950 p-4 shadow-2xl sm:rounded-2xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {err && <div className="text-sm text-red-400">{err}</div>}
        {!err && !data && <div className="text-sm text-gray-500">Loading…</div>}
        {data && (
          <>
            <div className="mb-4 flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-semibold text-gray-100">{data.player.full_name}</h3>
                <p className="text-xs text-gray-500">
                  {data.player.position}
                  {data.player.team ? ` · ${data.player.team}` : ""}
                  {data.player.age != null && ` · age ${data.player.age}`}
                  {data.player.rookie && (
                    <>
                      {" "}
                      <Badge tone="info" title="rookie: 0 years of experience">
                        rookie
                      </Badge>
                    </>
                  )}
                  {data.player.injury_status && (
                    <>
                      {" "}
                      · <Badge tone="warning">{data.player.injury_status}</Badge>
                    </>
                  )}
                  {" · "}week {data.week}
                </p>
              </div>
              <button
                onClick={onClose}
                className="rounded-md border border-gray-800 px-2 py-1 text-xs text-gray-400 hover:border-gray-700 hover:text-gray-200"
              >
                close
              </button>
            </div>

            {/* ── leagues ────────────────────────────────────────────── */}
            {/* One compact row per league. Three tiles repeated near-identical
                projections and took a third of the phone sheet. */}
            <div className="mb-4 divide-y divide-gray-800/70 rounded-lg border border-gray-800 bg-gray-900 px-3">
              {Object.entries(data.leagues).map(([key, lg]) => (
                <div key={key} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-1.5 text-xs">
                  <span className="w-16 font-medium uppercase tracking-wide text-gray-500">{key}</span>
                  <Badge tone={lg.status === "mine" ? "good" : lg.status === "free_agent" ? "info" : "neutral"}>
                    {lg.status === "mine" ? "mine" : lg.status === "free_agent" ? "available" : lg.owner ?? "rostered"}
                  </Badge>
                  <span className="ml-auto whitespace-nowrap tabular-nums text-gray-400">
                    {Object.keys(lg.proj).length ? (
                      Object.entries(lg.proj).map(([s, v]) => (
                        <span key={s} className="ml-2">
                          <span className="text-gray-600">{projShort(s)}</span> {v.toFixed(1)}
                        </span>
                      ))
                    ) : (
                      <span className="text-gray-600">no projection</span>
                    )}
                  </span>
                </div>
              ))}
            </div>

            {/* ── this week / usage ──────────────────────────────────── */}
            {/* Context, not a projection input: the opponent and Vegas
                implied total for the target week, then nflverse snap and
                target share for the last few completed weeks. */}
            {data.matchup && (
              <div className="mb-4 text-xs text-gray-400">
                <span className="text-gray-500">week {data.week}:</span>{" "}
                {data.matchup.bye ? (
                  <Badge tone="warning">BYE</Badge>
                ) : (
                  <>
                    {/* The cell prints "vs DET · 29.5"; here the number is
                        spelled out as "implied" so the strip reads as prose. */}
                    <MatchupCell matchup={{ ...data.matchup, implied_total: null, opp_implied_total: null }} position={data.player.position} />
                    {implied != null && (
                      <span className="tabular-nums">
                        {" "}
                        · implied{" "}
                        <span className="text-gray-200" title={data.player.position === "DEF" ? "what the defense faces" : undefined}>
                          {implied.toFixed(1)}
                        </span>
                      </span>
                    )}
                    {data.matchup.gameday && (
                      <span className="text-gray-600">
                        {" "}
                        · {data.matchup.gameday}
                        {data.matchup.gametime ? ` ${data.matchup.gametime}` : ""}
                      </span>
                    )}
                  </>
                )}
              </div>
            )}
            {(data.usage?.length ?? 0) > 0 && (
              <div className="mb-4">
                <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">Usage</h4>
                <table className="w-full max-w-md text-xs tabular-nums">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-gray-600">
                      <th className="py-1 pr-3 font-medium">Week</th>
                      <th className="py-1 pr-3 font-medium">Opp</th>
                      <th className="py-1 pr-3 font-medium">Snaps</th>
                      <th className="py-1 pr-3 font-medium">Targets</th>
                      <th className="py-1 pr-3 font-medium">Touches</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.usage.map((u) => (
                      <tr key={u.week} className="border-t border-gray-800/60 text-gray-300">
                        <td className="py-1 pr-3 text-gray-500">{u.week}</td>
                        <td className="py-1 pr-3 text-gray-500">{u.opponent ?? "—"}</td>
                        <td className="whitespace-nowrap py-1 pr-3" title={u.snaps != null ? `${u.snaps} snaps` : undefined}>
                          {u.played && u.snap_pct != null ? (
                            <>
                              {u.snap_pct}%
                              <Delta d={u.snap_delta} />
                            </>
                          ) : (
                            <span className="text-gray-700">{u.played ? "—" : "DNP"}</span>
                          )}
                          {u.role_change && (
                            <>
                              {" "}
                              <RoleBadge change={u.role_change} />
                            </>
                          )}
                        </td>
                        <td className="whitespace-nowrap py-1 pr-3" title={u.targets != null ? `${u.targets} targets` : undefined}>
                          {data.player.position !== "QB" && u.target_share != null ? (
                            <>
                              {u.target_share}%
                              <Delta d={u.target_delta} />
                            </>
                          ) : (
                            <span className="text-gray-700">—</span>
                          )}
                        </td>
                        <td className="py-1 pr-3" title={u.carries != null ? `${u.carries} carries` : undefined}>
                          {u.touches ?? <span className="text-gray-700">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-1 text-[11px] text-gray-600">
                  nflverse snap counts and target share; a move of {data.role_change_points}+ snap points is flagged. Context, not a projection input.
                </p>
              </div>
            )}

            {/* ── rankings ───────────────────────────────────────────── */}
            {/* Three mini-cards, one per list. As a six-column table this was
                904px wide inside a 768px dialog (and a 390px sheet). */}
            {Object.keys(data.rankings).length > 0 && (
              <div className="mb-4">
                <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">Where the sites rank him</h4>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {(["weekly", "ros", "dynasty"] as const)
                    .map((s) => [s, data.rankings[s]] as const)
                    .filter((pair): pair is readonly [typeof pair[0], RankScope] => !!pair[1])
                    .map(([s, r]) => (
                      <div key={s} className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 text-xs">
                        <div className="flex items-baseline gap-2">
                          <span className="font-medium text-gray-300">
                            {SCOPE_LABEL[s]} <span className="text-gray-600">{r.pos}</span>
                          </span>
                          <span className="ml-auto whitespace-nowrap tabular-nums">
                            <span className="text-base text-gray-100">{r.consensus?.median ?? "—"}</span>
                            {r.consensus && <span className="text-gray-500"> ({r.consensus.best}–{r.consensus.worst})</span>}
                            {r.delta != null && r.delta !== 0 && (
                              <span className={r.delta > 0 ? "text-green-400" : "text-red-400"}>
                                {" "}
                                {r.delta > 0 ? "+" : ""}
                                {r.delta}
                              </span>
                            )}
                          </span>
                        </div>
                        {data.rank_history?.[s] && <Sparkline points={data.rank_history[s]!} />}
                        <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-gray-400">
                          {Object.entries(r.ranks)
                            .sort((a, b) => a[1] - b[1])
                            .map(([src, rk]) => (
                              <span key={src} className="whitespace-nowrap">
                                <span className="text-gray-600">{srcLabel(src)}</span> {rk}
                              </span>
                            ))}
                        </div>
                        {r.fp && (
                          <div className="mt-1 text-gray-500">
                            FP experts {r.fp.min}–{r.fp.max}
                            <span className="text-gray-600"> · avg {r.fp.avg}, σ {r.fp.std}</span>
                            {/* tier is null on weekly and ROS lists; it printed "tier null". */}
                            {r.fp.tier != null && <> · tier {r.fp.tier}</>}
                            {r.fp.experts ? <> · {r.fp.experts} experts</> : null}
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            )}

            {/* ── claims ─────────────────────────────────────────────── */}
            <div className="mb-4">
              <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">
                What the sites say
                {data.claims && (
                  <span className="ml-2 normal-case tracking-normal text-gray-600">
                    {data.claims.n} claims · {data.claims.n_sources} sources · net{" "}
                    <span className={data.claims.net > 0 ? "text-green-400" : data.claims.net < 0 ? "text-red-400" : ""}>
                      {data.claims.net > 0 ? "+" : ""}
                      {data.claims.net}
                    </span>
                  </span>
                )}
              </h4>
              {!data.claims ? (
                <p className="text-xs text-gray-600">No claims in the window. The sites have not written about him.</p>
              ) : (
                <ul className="space-y-2">
                  {data.claims.evidence.map((e, i) => (
                    <li key={i} className="rounded-lg border border-gray-800/70 bg-gray-900/60 px-3 py-2 text-sm">
                      <div className="mb-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                        <Badge tone={ACTION_TONE[e.action] ?? "neutral"}>{e.action}</Badge>
                        <span className="text-gray-500">{horizonLabel(e.horizon)}</span>
                        {e.confidence != null && (
                          <span className="text-gray-600" title="how strongly the author committed">
                            {Math.round(e.confidence * 100)}%
                          </span>
                        )}
                        {e.flagged && <Badge tone="warning">reads as instruction</Badge>}
                        <span className="ml-auto text-gray-600">{srcLabel(e.source)}</span>
                      </div>
                      <div className="text-gray-200">{e.rationale}</div>
                      <a
                        href={e.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[11px] text-gray-500 hover:text-indigo-300 hover:underline"
                      >
                        {e.title}
                        {e.author ? ` — ${e.author}` : ""}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* ── wire notes ─────────────────────────────────────────── */}
            {data.news.length > 0 && (
              <div>
                <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-500">Recent wire notes</h4>
                <ul className="space-y-1.5">
                  {data.news.slice(0, 6).map((n, i) => (
                    <li key={i} className="text-xs">
                      <span className="text-gray-600">{(n.published_at || "").slice(0, 10)}</span>{" "}
                      <span className="text-gray-300">{n.headline}</span>
                      {n.flagged && (
                        <>
                          {" "}
                          <Badge tone="warning">flagged</Badge>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
