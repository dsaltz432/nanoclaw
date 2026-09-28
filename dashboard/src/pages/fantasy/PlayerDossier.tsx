import { useEffect, useState, type ReactNode } from "react";
import { Badge, ErrorBox, FoldToggle, HoverInfo, Loading, SubHead, useIsNarrow } from "./viz";
import { SectionProvider } from "./method";
import { ACTION_TONE, cap, fmtDate, horizonLabel, projLabel, SCOPE_LABEL, srcLabel, srcShort } from "./labels";
import { ClaimsSummary, NoteLine, type Note as WireNote } from "./NoteLine";

/**
 * Player dossier — everything the store knows about one player, in one
 * panel, opened from any player name on the Fantasy tab.
 *
 * About the league being viewed: who has him there and his number this
 * week, his games (last four and next five), the rankings for the lists that
 * league plays, his trade value in its FantasyCalc format, then the extracted
 * claims with their rationale and a link to the article, and recent wire
 * notes. All strings from third parties arrive defanged; claims are rendered
 * as "source says", never as the tool's own view.
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

type MarketPoint = { date: string; value: number; position_rank: number | null };

/**
 * One week of his season (ff consensus.game_log): a played week carries the
 * points he scored in the viewed league and his usage; an upcoming one the
 * date and, once posted, the O/U and spread (from his team's side, + when
 * favoured).
 */
type GameRow =
  | { week: number; bye: true; played: boolean }
  | {
      week: number;
      bye: false;
      played: boolean;
      gameday: string;
      gametime: string | null;
      opponent: string;
      home: boolean;
      points?: number | null;
      snap_pct?: number | null;
      target_share?: number | null;
      touches?: number | null;
      /** His Sleeper stat line for the week (played weeks only). */
      box?: Record<string, number>;
      /** How kind this opponent is to his position (ff consensus.matchup_strength). */
      opp?: { allowed: number; rank: number; tier: number; games: number } | null;
      total: number | null;
      spread: number | null;
    };

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
  claims: {
    n_sources: number;
    by_action: Record<string, number>;
    evidence: Evidence[];
  } | null;
  /** Newest first, in the shape NoteLine renders. */
  news: NonNullable<WireNote>[];
  leagues: Record<
    string,
    {
      status: string;
      owner: string | null;
      is_me: boolean;
      /** The league's own name, as the picker shows it. */
      name?: string;
      proj: Record<string, number>;
      /** His game has kicked off: `actual_points` is what he has scored in this league. */
      locked?: boolean;
      actual_points?: number | null;
    }
  >;
  games: GameRow[];
  /** FantasyCalc value in the viewed league's format, every stored daily snapshot. */
  market?: { format: string; history: MarketPoint[]; change_7d: number | null; change_30d: number | null } | null;
  error?: string;
};

/** Claims shown before "show N more". */
const CLAIMS_SHOWN = 5;

/**
 * His FantasyCalc value over the stored daily snapshots. The Y axis spans his
 * own low to high (padded), not zero: a value from 6,100 to 6,900 is the whole
 * story, and from zero it would draw a flat line. Hover a point for its date.
 */
function ValueChart({ points }: { points: MarketPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  // A narrower logical canvas on a phone keeps the 10-unit labels ~10px.
  const narrow = useIsNarrow();
  if (points.length < 2) return null;
  const W = narrow ? 360 : 640;
  const H = 120;
  const padL = 44;
  const padR = 8;
  const padT = 8;
  const padB = 18;
  const vals = points.map((p) => p.value);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || Math.max(1, hi * 0.05);
  const min = lo - span * 0.1;
  const max = hi + span * 0.1;
  const x = (i: number) => padL + (i / (points.length - 1)) * (W - padL - padR);
  const y = (v: number) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${x(0)},${H - padB} ${line} ${x(points.length - 1)},${H - padB}`;
  const shown = hover ?? points.length - 1;
  const at = points[shown]!;
  const ticks = [lo, (lo + hi) / 2, hi];
  const nTicks = Math.min(points.length, narrow ? 4 : 5);
  const dateTicks = Array.from(new Set(Array.from({ length: nTicks }, (_, k) => Math.round((k * (points.length - 1)) / (nTicks - 1)))));
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: H }} onMouseLeave={() => setHover(null)}>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="#1f2937" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill="#6b7280">
              {Math.round(t).toLocaleString()}
            </text>
          </g>
        ))}
        {/* Evenly spaced date ticks (five across, four on a phone), the ends
            anchored inward so they stay inside the chart. */}
        {dateTicks.map((i, k) => (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={H - padB} y2={H - padB + 3} stroke="#374151" strokeWidth={1} />
            <text
              x={x(i)}
              y={H - 4}
              fontSize={10}
              fill="#6b7280"
              textAnchor={k === 0 ? "start" : k === dateTicks.length - 1 ? "end" : "middle"}
            >
              {fmtDate(points[i]!.date)}
            </text>
          </g>
        ))}
        <polygon points={area} fill="#3987e5" fillOpacity={0.12} />
        <polyline points={line} fill="none" stroke="#3987e5" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(shown)} cy={y(at.value)} r={3.5} fill="#3987e5" stroke="#111827" strokeWidth={1.5} />
        {points.map((_, i) => (
          <rect
            key={i}
            x={x(i) - (W - padL - padR) / (2 * (points.length - 1))}
            y={padT}
            width={(W - padL - padR) / (points.length - 1)}
            height={H - padT - padB}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      <div className="mt-0.5 text-[11px] tabular-nums text-gray-500">
        {fmtDate(at.date)}: <span className="text-gray-300">{Math.round(at.value).toLocaleString()}</span>
        {at.position_rank != null && <> · {at.position_rank} at his position</>}
      </div>
    </div>
  );
}

/** "▲575" in green, "▼354" in red, "—" when the history does not reach back. */
function Change({ label, v }: { label: string; v: number | null }) {
  return (
    <span className="whitespace-nowrap tabular-nums">
      <span className="text-gray-500">{label}</span>{" "}
      {v == null ? (
        <span className="text-gray-600">—</span>
      ) : v === 0 ? (
        <span className="text-gray-400">0</span>
      ) : (
        <span className={v > 0 ? "text-green-400" : "text-red-400"}>
          {v > 0 ? "▲" : "▼"}
          {Math.abs(v).toLocaleString()}
        </span>
      )}
    </span>
  );
}

/** FantasyCalc's "redraft-sf-22tm" as "redraft, superflex, 22 teams". */
const formatLabel = (f: string) =>
  f
    .split("-")
    .map((p) => (p === "1qb" ? "1QB" : p === "sf" ? "superflex" : /^\d+tm$/.test(p) ? `${parseInt(p)} teams` : p))
    .join(", ");

type LeagueRow = Data["leagues"][string];

/**
 * Who has him in the league being viewed, and his number this week there:
 * "Owned by Lazria · proj 16.2". Once his game has kicked off, what he scored.
 * It replaced a row per league: the other two leagues are a picker away.
 */
function HereLine({ lg, week }: { lg: LeagueRow; week: number }) {
  const sources = Object.entries(lg.proj);
  const main = lg.proj.rotowire ?? sources[0]?.[1];
  return (
    <p className="mt-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-xs text-gray-400">
      {lg.status === "mine" ? (
        <Badge tone="good">Yours</Badge>
      ) : lg.status === "free_agent" ? (
        <Badge tone="info">Free agent</Badge>
      ) : (
        <span>
          Owned by <span className="text-gray-200">{lg.owner ?? "a rival"}</span>
        </span>
      )}
      {lg.locked && lg.actual_points != null ? (
        <span className="tabular-nums" title="his game has kicked off; points so far in this league">
          wk {week} played <span className="text-gray-100">{lg.actual_points.toFixed(1)}</span>
        </span>
      ) : main != null ? (
        <HoverInfo info={sources.map(([s, v]) => `${projLabel(s)} ${v.toFixed(1)}`).join("\n")} className="tabular-nums">
          wk {week} proj <span className="text-gray-100">{main.toFixed(1)}</span>
        </HoverInfo>
      ) : null}
    </p>
  );
}

type Played = Extract<GameRow, { bye: false }>;
/** One stat column: its header, what it shows for a played week, and where it hides. */
type StatCol = { label: string; title: string; cell: (g: Played) => ReactNode; phone?: boolean };

const n = (b: Record<string, number> | undefined, ...keys: string[]) => {
  const vals = keys.map((k) => b?.[k]).filter((v): v is number => v != null);
  return vals.length ? vals.reduce((a, v) => a + v, 0) : null;
};
const num = (v: number | null) => (v == null ? "—" : Math.round(v));
const ratio = (b: Record<string, number> | undefined, made: string, att: string) =>
  b?.[att] != null ? `${b[made] ?? 0}/${b[att]}` : "—";
const yds = (b: Record<string, number> | undefined) => {
  const rush = b?.rush_yd;
  const rec = b?.rec_yd;
  const total = n(b, "rush_yd", "rec_yd");
  if (total == null) return "—";
  const split = [rush ? `${Math.round(rush)} rush` : "", rec ? `${Math.round(rec)} rec` : ""].filter(Boolean).join(" · ");
  return split.includes("·") ? <HoverInfo info={split}>{Math.round(total)}</HoverInfo> : Math.round(total);
};
const snap = (g: Played) => (g.snap_pct != null ? `${g.snap_pct}%` : "—");

/**
 * What each position's games table shows, besides Pts. A running back runs and
 * catches (carries and catches, yards together with the split on hover); a
 * receiver's volume is targets and catches; a quarterback plays every snap, so
 * snap % and touches say nothing about him, where passing and rushing do;
 * kickers and defences have their own box scores. `phone: false` columns hide
 * below sm so the table fits a 390px sheet.
 */
const STAT_COLS: Record<string, StatCol[]> = {
  QB: [
    { label: "C/A", title: "completions / attempts", cell: (g) => ratio(g.box, "pass_cmp", "pass_att"), phone: false },
    { label: "Yds", title: "passing yards", cell: (g) => num(n(g.box, "pass_yd")) },
    { label: "TD", title: "passing touchdowns", cell: (g) => num(n(g.box, "pass_td") ?? 0) },
    { label: "INT", title: "interceptions thrown", cell: (g) => num(n(g.box, "pass_int") ?? 0) },
    {
      label: "Rush",
      title: "rushing yards (and touchdowns)",
      cell: (g) => {
        const td = n(g.box, "rush_td");
        return (
          <>
            {num(n(g.box, "rush_yd"))}
            {td ? <span className="text-gray-500"> · {td} TD</span> : null}
          </>
        );
      },
    },
  ],
  RB: [
    { label: "Snap", title: "share of the offense's snaps", cell: snap },
    { label: "Car", title: "carries", cell: (g) => num(n(g.box, "rush_att")) },
    { label: "Rec", title: "receptions", cell: (g) => num(n(g.box, "rec")) },
    { label: "Yds", title: "rushing + receiving yards (split on hover)", cell: (g) => yds(g.box) },
    { label: "TD", title: "rushing + receiving touchdowns", cell: (g) => num(n(g.box, "rush_td", "rec_td") ?? 0) },
  ],
  WR: [
    { label: "Snap", title: "share of the offense's snaps", cell: snap, phone: false },
    { label: "Tgt", title: "targets", cell: (g) => num(n(g.box, "rec_tgt")) },
    { label: "Rec", title: "receptions", cell: (g) => num(n(g.box, "rec")) },
    { label: "Yds", title: "receiving + rushing yards (split on hover)", cell: (g) => yds(g.box) },
    { label: "TD", title: "receiving + rushing touchdowns", cell: (g) => num(n(g.box, "rec_td", "rush_td") ?? 0) },
  ],
  K: [
    { label: "FG", title: "field goals made / attempted", cell: (g) => ratio(g.box, "fgm", "fga") },
    { label: "XP", title: "extra points made / attempted", cell: (g) => ratio(g.box, "xpm", "xpa") },
    { label: "Long", title: "longest field goal made", cell: (g) => num(n(g.box, "fgm_lng")) },
  ],
  DEF: [
    { label: "PA", title: "points allowed", cell: (g) => num(n(g.box, "pts_allow")) },
    { label: "Sack", title: "sacks", cell: (g) => num(n(g.box, "sack") ?? 0) },
    { label: "INT", title: "interceptions", cell: (g) => num(n(g.box, "int") ?? 0) },
    { label: "FR", title: "fumbles recovered", cell: (g) => num(n(g.box, "fum_rec") ?? 0) },
    { label: "TD", title: "defensive and return touchdowns", cell: (g) => num(n(g.box, "def_td", "def_st_td") ?? 0) },
  ],
};
STAT_COLS.TE = STAT_COLS.WR!;

/** Opponent colour by matchup: green soft, red tough, one shade per six teams. */
const TIER_CLS: Record<number, string> = {
  2: "text-green-400",
  1: "text-green-200",
  0: "text-gray-200",
  [-1]: "text-red-200",
  [-2]: "text-red-400",
};
const ordinal = (k: number) => `${k}${k % 100 >= 11 && k % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][k % 10] ?? "th"}`;
const posPlural: Record<string, string> = { QB: "QBs", RB: "RBs", WR: "WRs", TE: "TEs", K: "kickers" };

function Opponent({ g, pos }: { g: Played; pos: string }) {
  const label = `${g.home ? "vs" : "@"} ${g.opponent}`;
  if (!g.opp) return <>{label}</>;
  const info =
    pos === "DEF"
      ? `${g.opponent}'s offense gives defenses ${g.opp.allowed} pts/game, ${ordinal(g.opp.rank)} most of 32`
      : `${g.opponent} allows ${g.opp.allowed} pts/game to ${posPlural[pos] ?? pos}, ${ordinal(g.opp.rank)} most of 32`;
  return (
    <HoverInfo info={`${info}\n(this season, ${g.opp.games} game${g.opp.games === 1 ? "" : "s"})`} className={TIER_CLS[g.opp.tier] ?? ""}>
      {label}
    </HoverInfo>
  );
}

/**
 * His last four weeks and next five, one timeline: points in this league and
 * the box score that matters for his position (STAT_COLS), then the weeks
 * ahead with the date and the line across the same columns. Opponents are
 * coloured by how kind they are to his position. A heavier rule separates
 * what happened from what is next.
 */
function GamesTable({ games, team, pos }: { games: GameRow[]; team: string | null; pos: string }) {
  const cols = STAT_COLS[pos] ?? STAT_COLS.WR!;
  const firstAhead = games.findIndex((g) => !g.played);
  const hide = (c: StatCol) => (c.phone === false ? "hidden sm:table-cell" : "");
  return (
    <section>
      <SubHead className="mb-1">Games</SubHead>
      {/* Capped width: across the whole dialog the numbers sat ~150px apart. */}
      <table className="w-full max-w-lg text-xs tabular-nums">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-gray-600">
            <th className="w-8 py-1 pr-2 text-left font-medium">Wk</th>
            <th className="py-1 pr-2 text-left font-medium">Opp</th>
            <th className="py-1 pr-2 text-right font-medium" title="points in this league's scoring">
              Pts
            </th>
            {cols.map((c) => (
              <th key={c.label} className={`py-1 pl-2 text-right font-medium ${hide(c)}`} title={c.title}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {games.map((g, i) => (
            <tr
              key={g.week}
              className={`${i === firstAhead && i > 0 ? "border-t-2 border-gray-700" : "border-t border-gray-800/60"} ${
                g.played ? "text-gray-300" : "text-gray-400"
              }`}
            >
              <td className="py-1 pr-2 text-gray-500">{g.week}</td>
              {g.bye ? (
                <td colSpan={cols.length + 2} className="py-1">
                  <Badge tone="warning">BYE</Badge>
                </td>
              ) : g.played ? (
                <>
                  <td className="whitespace-nowrap py-1 pr-2">
                    <Opponent g={g} pos={pos} />
                  </td>
                  <td className="py-1 pr-2 text-right text-gray-100">{g.points != null ? g.points.toFixed(1) : "—"}</td>
                  {cols.map((c) => (
                    <td key={c.label} className={`whitespace-nowrap py-1 pl-2 text-right ${hide(c)}`}>
                      {c.cell(g)}
                    </td>
                  ))}
                </>
              ) : (
                <>
                  <td className="whitespace-nowrap py-1 pr-2">
                    <Opponent g={g} pos={pos} />
                  </td>
                  <td colSpan={cols.length + 1} className="py-1 text-right text-gray-500">
                    {fmtDate(g.gameday)}
                    {g.total != null && (
                      <span className="text-gray-400" title={`over/under ${g.total}${g.spread != null ? `; ${team ?? ""} ${spreadText(g.spread)}` : ""}`}>
                        {" "}
                        · O/U {g.total}
                        {g.spread != null && <> · {spreadText(g.spread)}</>}
                      </span>
                    )}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-1 text-[11px] text-gray-500">
        Opponent: <span className="text-green-400">soft</span> → <span className="text-red-400">tough</span> for{" "}
        {pos === "DEF" ? "a defense (points defenses score against that offense)" : `${posPlural[pos] ?? pos} (fantasy points allowed)`}
      </p>
    </section>
  );
}

/** "−7" favoured by seven, "+2.5" the underdog, "PK" a pick'em. */
const spreadText = (sp: number) => (sp === 0 ? "PK" : sp > 0 ? `−${sp}` : `+${-sp}`);

export default function PlayerDossier({
  playerId,
  league,
  onClose,
}: {
  playerId: string;
  /** The league being viewed: its ranking scopes and its trade-value format. */
  league: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [allClaims, setAllClaims] = useState(false);

  useEffect(() => {
    setData(null);
    setErr(null);
    setAllClaims(false);
    fetch(`/api/fantasy/dossier?${new URLSearchParams({ league, player: playerId })}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : setData(d)))
      .catch((e) => setErr(String(e)));
  }, [playerId, league]);
  const here = data?.leagues[league];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6" onClick={onClose}>
      <div
        className={`ff-scope max-h-[92dvh] w-full max-w-3xl overflow-y-auto rounded-t-2xl border border-gray-800 bg-gray-950 p-4 shadow-2xl sm:rounded-2xl sm:p-5 ${
          data ? "" : "min-h-[50dvh]"
        }`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* The title row sticks to the top of the sheet, so "close" is in
            reach however far down the claims you have scrolled. Negative
            margins cancel the sheet's padding so the band runs edge to edge. */}
        <div className="sticky -top-4 z-10 -mx-4 -mt-4 mb-4 flex items-start gap-3 border-b border-gray-800 bg-gray-950 px-4 pb-3 pt-4 sm:-top-5 sm:-mx-5 sm:-mt-5 sm:px-5 sm:pt-5">
          <div className="min-w-0 flex-1">
            {data ? (
              <>
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
                </p>
                {here && <HereLine lg={here} week={data.week} />}
              </>
            ) : (
              <h3 className="text-lg font-semibold text-gray-500">Player</h3>
            )}
          </div>
          <button type="button" onClick={onClose} className="shrink-0 text-xs text-gray-400 hover:text-gray-200">
            Close
          </button>
        </div>
        {err && <ErrorBox>{err}</ErrorBox>}
        {!err && !data && <Loading label="Loading player…" rows={6} />}
        {data && (
          <SectionProvider name="Player dossier">
            {/* One vertical rhythm for every section, instead of a margin each. */}
            <div className="space-y-5">
            {/* ── games ──────────────────────────────────────────────── */}
            {/* His last four weeks and next five in one timeline: what he
                scored in this league and how much he played, then who is next
                and, once posted, the line. Schedule and usage were two tables
                about the same weeks. */}
            {data.games?.length > 0 && <GamesTable games={data.games} team={data.player.team} pos={data.player.position} />}

            {/* ── rankings ───────────────────────────────────────────── */}
            {/* One line per list the viewed league plays (this week and rest of
                season, plus dynasty in the dynasty league): the consensus and
                its move, each site's rank, the FantasyPros expert range. They
                were a card each. */}
            {Object.keys(data.rankings).length > 0 && (
              <section>
                <SubHead className="mb-1">Where the sites rank him</SubHead>
                <div className="divide-y divide-gray-800/60">
                  {(["weekly", "ros", "dynasty"] as const)
                    .map((s) => [s, data.rankings[s]] as const)
                    .filter((pair): pair is readonly [typeof pair[0], RankScope] => !!pair[1])
                    .map(([s, r]) => (
                      <div
                        key={s}
                        className="grid grid-cols-[6.5rem_4.5rem_minmax(0,1fr)] items-baseline gap-x-3 py-1.5 text-xs sm:grid-cols-[7.5rem_5rem_minmax(0,1fr)_auto]"
                      >
                        <span className="text-gray-400">{cap(SCOPE_LABEL[s])}</span>
                        <span className="whitespace-nowrap tabular-nums">
                          <span className="font-medium text-gray-100">
                            {r.consensus ? `${r.pos}${r.consensus.median}` : "—"}
                          </span>
                          {r.delta != null && Math.abs(r.delta) >= 1 && (
                            <span className={r.delta > 0 ? "text-green-400" : "text-red-400"} title="places moved since the previous snapshot">
                              {" "}
                              {r.delta > 0 ? "▲" : "▼"}
                              {Math.abs(Math.round(r.delta))}
                            </span>
                          )}
                        </span>
                        <span className="min-w-0 text-gray-400">
                          {Object.entries(r.ranks)
                            .sort((a, b) => a[1] - b[1])
                            .map(([src, rk]) => (
                              <span key={src} className="mr-2 inline-block whitespace-nowrap">
                                <span className="text-gray-600" title={srcLabel(src)}>
                                  {srcShort(src)}
                                </span>{" "}
                                {rk}
                              </span>
                            ))}
                        </span>
                        {r.fp && (
                          <span
                            className="col-start-3 whitespace-nowrap text-gray-500 sm:col-start-auto sm:text-right"
                            title={`FantasyPros experts: avg ${r.fp.avg}, σ ${r.fp.std}${r.fp.experts ? ` · ${r.fp.experts} experts` : ""}`}
                          >
                            experts {r.fp.min}–{r.fp.max}
                            {/* tier is null on weekly and ROS lists; it printed "tier null". */}
                            {r.fp.tier != null && <> · tier {r.fp.tier}</>}
                          </span>
                        )}
                      </div>
                    ))}
                </div>
              </section>
            )}

            {/* ── trade value ───────────────────────────────────────── */}
            {data.market && data.market.history.length > 1 && (
              <section>
                <div className="mb-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <SubHead>Trade value</SubHead>
                  <span className="text-xs text-gray-400">
                    <span className="tabular-nums text-gray-200">
                      {Math.round(data.market.history[data.market.history.length - 1]!.value).toLocaleString()}
                    </span>
                    <span className="text-gray-500"> FantasyCalc, {formatLabel(data.market.format)}</span>
                  </span>
                  <span className="flex gap-3 text-xs">
                    <Change label="7d" v={data.market.change_7d} />
                    <Change label="30d" v={data.market.change_30d} />
                  </span>
                </div>
                <ValueChart points={data.market.history} />
              </section>
            )}

            {/* ── claims ─────────────────────────────────────────────── */}
            <section>
              {/* The lean, as every tab states it: the lead call, the
                  counter-call where the sites split, and how many sites. */}
              <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <SubHead>What the sites say</SubHead>
                {data.claims && <ClaimsSummary byAction={data.claims.by_action} nSources={data.claims.n_sources} />}
              </div>
              {!data.claims ? (
                <p className="text-xs text-gray-500">No claims in the window. The sites have not written about him.</p>
              ) : (
                <>
                {/* A divided list: a bordered card per claim spent ~20px each on
                    padding and borders around one sentence. */}
                <ul className="divide-y divide-gray-800/60">
                  {(allClaims ? data.claims.evidence : data.claims.evidence.slice(0, CLAIMS_SHOWN)).map((e, i) => (
                    <li key={i} className="py-2 text-sm first:pt-1">
                      <div className="mb-0.5 flex flex-wrap items-center gap-1.5 text-xs">
                        <Badge tone={ACTION_TONE[e.action] ?? "neutral"}>{e.action}</Badge>
                        <span className="text-gray-500">{horizonLabel(e.horizon)}</span>
                        {e.confidence != null && (
                          <span className="text-gray-600" title="how strongly the author committed">
                            {Math.round(e.confidence * 100)}%
                          </span>
                        )}
                        {e.flagged && <Badge tone="warning">reads as an instruction</Badge>}
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
                <FoldToggle
                  total={data.claims.evidence.length}
                  shown={allClaims ? data.claims.evidence.length : Math.min(CLAIMS_SHOWN, data.claims.evidence.length)}
                  expanded={allClaims}
                  onToggle={() => setAllClaims((v) => !v)}
                />
                </>
              )}
            </section>

            {/* ── wire notes ─────────────────────────────────────────── */}
            {data.news.length > 0 && (
              <section>
                <SubHead className="mb-1">Recent wire notes</SubHead>
                <ul className="space-y-1.5">
                  {data.news.slice(0, 6).map((n, i) => (
                    <li key={i}>
                      <NoteLine note={n} className="text-xs text-gray-300" />
                    </li>
                  ))}
                </ul>
              </section>
            )}
            </div>
          </SectionProvider>
        )}
      </div>
    </div>
  );
}
