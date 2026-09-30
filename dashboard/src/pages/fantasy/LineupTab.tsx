import { useEffect, useState, type ReactNode } from "react";
import { Badge, Card, ErrorBox, FoldToggle, HoverInfo, Loading, MetaLine, Note, QuietLine, SubHead, Td, Th } from "./viz";
import { projLabel, signed, srcLabel } from "./labels";
import {
  ClaimQuote,
  ClaimsSummary,
  MatchupCell,
  matchupText,
  PlayerName,
  RankText,
  showsUsage,
  UsageCell,
  usageTitle,
  type Claim,
  type Matchup,
  type Note as WireNote,
  type Usage,
} from "./NoteLine";

/**
 * Lineup — start / sit this week.
 *
 * The lineup you actually have set against the projection-optimal one (the
 * engine's number of record), with the consensus rank on every row and the
 * sites' this-week claims beside it. Every change the engine would make is
 * shown as a paired switch — start him, sit that one, at this slot, for this
 * many points — and both halves are tagged under their names in Starters and
 * Bench, each naming the other. A bench player the experts rank above a
 * starter he could replace joins the same table. Streaming picks at QB/TE/DEF/K
 * show the best available with what the sites say.
 */

type Rank = { median: number; best: number; worst: number } | null;
type Claims = {
  n_sources: number;
  by_action: Record<string, number>;
  evidence: Claim[];
} | null;

type Row = {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  injury_status: string | null;
  slot: string | null;
  proj: Record<string, number>;
  projected: number | null;
  proj_spread: number | null;
  rank: Rank;
  ranks: Record<string, number>;
  delta: number | null;
  claims: Claims;
  /** His game has kicked off: he cannot be moved, and his number is what he scored. */
  locked: boolean;
  actual_points: number | null;
  usage: Usage;
  matchup: Matchup;
  note: WireNote;
};

/** One set-lineup change, paired to the starter it displaces (tabs.pair_swaps). */
type Swap = { slot: string | null; in: Row | null; out: Row | null; gain: number | null };

/**
 * A bench player the experts rank above a starter he could replace, while
 * projecting below him (tabs.rank_flags). `basis` is which list did the
 * comparing: "position" for a fixed slot, "FLEX"/"SUPERFLEX" at a flex, where
 * positional ranks count different populations and cannot be compared.
 */
type RankFlag = {
  slot: string | null;
  in: Row;
  out: Row;
  in_rank: number;
  out_rank: number;
  basis: string;
  gain: number;
};

/** Either half of a comparison: a roster row or a streaming candidate. */
type Side = {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  proj: Record<string, number>;
  rank: Rank;
  ranks: Record<string, number>;
  delta?: number | null;
};

type Stream = {
  player_id: string;
  name: string;
  team: string | null;
  rank: Rank;
  ranks: Record<string, number>;
  delta: number | null;
  proj: Record<string, number>;
  claims: { by_action: Record<string, number>; evidence: Claim[] } | null;
  usage: Usage;
  matchup: Matchup;
  note: WireNote;
};

/** One surviving roster in the guillotine league, by projected set total. */
type RosterRow = {
  roster_id: string;
  owner_id: string;
  owner: string;
  is_me: boolean;
  set: number;
  optimal: number;
  starters_without_projection: number;
};

/** Guillotine only; null in the other two leagues. */
type Survival = {
  week: number;
  teams_alive: number;
  eliminated_so_far: number;
  mine: RosterRow | null;
  lowest_rival: RosterRow | null;
  margin_above_lowest: number | null;
  margin_if_optimal: number | null;
  my_rank_from_bottom: number | null;
  median_set: number | null;
  distribution: RosterRow[];
  last_week: null | { week: number; chop_line: number; chopped: string; my_points: number | null; my_rank_from_bottom: number | null; teams: number };
  note: string;
} | null;

type Data = {
  week: number;
  survival?: Survival;
  /** The lineup actually set, slot by slot — what the Starters table shows. */
  starters: Row[];
  bench: Row[];
  empty_slots: string[];
  reserve?: Row[];
  taxi?: Row[];
  reserve_slots: number;
  taxi_slots: number;
  reserve_note?: string;
  taxi_note?: string;
  totals: { optimal: number; current: number };
  swaps: Swap[];
  rank_flags: RankFlag[];
  streaming: Record<string, Stream[]>;
  note: string;
  context_note: string;
  usage_week: number | null;
  error?: string;
};

/** Sleeper's slot names, as short as a row prefix needs them. */
const slotLabel = (s: string) => (s === "SUPER_FLEX" ? "SFLEX" : s);

/** 1 -> "1st", 2 -> "2nd", 13 -> "13th". */
const ordinal = (n: number) => {
  const sfx = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${sfx[(v - 20) % 10] ?? sfx[v] ?? sfx[0]}`;
};

/**
 * Side-by-side detail for a proposed switch: every projection source and
 * every ranking source that has an opinion on the two players, with which
 * one each favours.
 *
 * The headline number hides how thin a call can be. "Purdy over Dak, +0.5"
 * reads settled; underneath, Sleeper and ESPN prefer Purdy, the Fantasy
 * Footballers prefer Dak by a point, and the four ranking sources split two
 * apiece. That is a coin flip, and the row could not say so.
 */
function SwapDetails({
  a,
  b,
  slot,
  onClose,
  onPlayer,
}: {
  a: Side;
  b: Side;
  slot: string | null;
  onClose: () => void;
  onPlayer: (id: string) => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const last = (n: string) => n.split(" ").slice(-1)[0];
  // Lower is better for a rank and higher is better for a projection, so a
  // signed difference would mean the opposite thing in the two tables. Name
  // the player each source favours instead.
  type Line = { src: string; av: number | null; bv: number | null; favours: "a" | "b" | null };
  const lines = (
    keys: string[],
    get: (s: Side, k: string) => number | null,
    better: (x: number, y: number) => boolean
  ): Line[] =>
    keys.map((src) => {
      const av = get(a, src);
      const bv = get(b, src);
      return {
        src,
        av,
        bv,
        favours: av == null || bv == null || av === bv ? null : better(av, bv) ? "a" : "b",
      };
    });

  const projKeys = [...new Set([...Object.keys(a.proj), ...Object.keys(b.proj)])].sort();
  const rankKeys = [...new Set([...Object.keys(a.ranks), ...Object.keys(b.ranks)])].sort();
  const projLines = lines(projKeys, (s, k) => s.proj[k] ?? null, (x, y) => x > y);
  const rankLines = lines(rankKeys, (s, k) => s.ranks[k] ?? null, (x, y) => x < y);
  const tally = (ls: Line[], side: "a" | "b") => ls.filter((l) => l.favours === side).length;

  const Who = ({ f }: { f: "a" | "b" | null }) =>
    f == null ? (
      <span className="text-gray-700">level</span>
    ) : (
      <span className={f === "a" ? "text-emerald-400" : "text-amber-300"}>{last(f === "a" ? a.name : b.name)}</span>
    );

  const Grid = ({
    title,
    note,
    ls,
    fmt,
    label,
    mark,
  }: {
    title: string;
    note: string;
    ls: Line[];
    fmt: (v: number) => string;
    label: (s: string) => string;
    /** Source whose number the rest of the tab quotes as "projected". */
    mark?: string;
  }) => (
    <div>
      <SubHead>{title}</SubHead>
      <p className="mt-0.5 text-[11px] text-gray-600">{note}</p>
      <table className="mt-2 w-full text-xs">
        <thead>
          <tr className="text-[11px] uppercase tracking-wide text-gray-600">
            <th className="py-1 text-left font-medium">Source</th>
            <th className="py-1 text-right font-medium">{last(a.name)}</th>
            <th className="py-1 text-right font-medium">{last(b.name)}</th>
            <th className="py-1 pl-3 text-left font-medium">Favours</th>
          </tr>
        </thead>
        <tbody>
          {ls.map((l) => (
            <tr key={l.src} className="border-t border-gray-800/60">
              <td className="py-1 text-gray-300">
                {label(l.src)}
                {l.src === mark && (
                  <span className="ml-1 text-[10px] text-gray-600" title="the number of record: what Proj shows elsewhere on this tab">
                    of record
                  </span>
                )}
              </td>
              <td className="py-1 text-right tabular-nums text-gray-100">{l.av == null ? "—" : fmt(l.av)}</td>
              <td className="py-1 text-right tabular-nums text-gray-100">{l.bv == null ? "—" : fmt(l.bv)}</td>
              <td className="py-1 pl-3">
                <Who f={l.favours} />
              </td>
            </tr>
          ))}
          {ls.length === 0 && (
            <tr>
              <td colSpan={4} className="py-1 text-xs text-gray-500">
                No source has both players.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  const Head = ({ s, tone }: { s: Side; tone: "a" | "b" }) => (
    <div className={`border-l-2 pl-2 text-sm ${tone === "a" ? "border-emerald-500/60" : "border-amber-500/60"}`}>
      <div>
        <PlayerName id={s.player_id} name={s.name} pos={s.position} team={s.team} onPlayer={onPlayer} />
      </div>
      {/* Which way the board has moved him since the last snapshot: a call
          this close is often really a question of who is trending. */}
      <div className="mt-1 text-xs">
        {s.rank ? (
          <RankText pos={s.position} median={s.rank.median} best={s.rank.best} worst={s.rank.worst} delta={s.delta} />
        ) : (
          <span className="text-gray-700">unranked</span>
        )}
      </div>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-6"
      onClick={onClose}
    >
      <div
        className="ff-scope max-h-[92dvh] w-full max-w-2xl overflow-y-auto rounded-t-2xl border border-gray-800 bg-gray-950 p-4 shadow-2xl sm:rounded-2xl sm:p-6"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`${a.name} compared with ${b.name}`}
      >
        {/* Sticky, like the dossier's, so "close" stays in reach on a phone
            scrolled down to the rankings. The negative margins cancel the
            sheet's padding so the band runs edge to edge. */}
        <div className="sticky -top-4 z-10 -mx-4 -mt-4 mb-4 flex items-start gap-3 border-b border-gray-800 bg-gray-950 px-4 pb-3 pt-4 sm:-top-6 sm:-mx-6 sm:-mt-6 sm:px-6 sm:pt-6">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold text-gray-100">
              {a.name} <span className="text-gray-500">vs</span> {b.name}
            </h3>
            {slot && <p className="text-xs text-gray-500">at {slotLabel(slot)}</p>}
          </div>
          <button type="button" onClick={onClose} className="shrink-0 text-xs text-gray-400 hover:text-gray-200">
            Close
          </button>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-3">
          <Head s={a} tone="a" />
          <Head s={b} tone="b" />
        </div>

        <div className="space-y-5">
          <Grid
            title="Projections"
            note="Points for this week under this league's own scoring. Each source's raw stat line, re-scored — not its published fantasy total."
            ls={projLines}
            fmt={(v) => v.toFixed(1)}
            label={projLabel}
            mark="rotowire"
          />
          <Grid
            title="Rankings"
            note="Position rank on each site's weekly list. Lower is better."
            ls={rankLines}
            fmt={(v) => String(v)}
            label={srcLabel}
          />
        </div>

        <p className="mt-4 border-t border-gray-800 pt-3 text-xs text-gray-400">
          {tally(projLines, "a")} of {projLines.length} projection{projLines.length === 1 ? "" : "s"} and{" "}
          {tally(rankLines, "a")} of {rankLines.length} ranking{rankLines.length === 1 ? "" : "s"} favour{" "}
          <span className="text-emerald-400">{last(a.name)}</span>.
        </p>
      </div>
    </div>
  );
}

/**
 * Which half of a switch a row is, so a tagged row in Starters or Bench can
 * name the other half instead of only flagging itself. "Start Purdy" and
 * "sit Dak" are one decision; the tables should not make you rebuild the
 * pairing by eye.
 */
type Marker = {
  role: "in" | "out";
  /** "projection" = he out-projects the starter; "rank" = the experts order him ahead. */
  basis: "projection" | "rank";
  slot: string | null;
  gain: number | null;
  counterpart: Row | null;
};

/**
 * The tag under a name when the row is half of a switch: "start him over
 * Dak at QB · +0.5". A plain starting or bench row says nothing — which
 * table it is in already says that.
 */
function SwapTag({ m }: { m: Marker | undefined }) {
  if (!m) return null;
  return (
    <div className="mt-0.5 text-xs font-normal text-gray-500">
      <Badge tone={m.basis === "rank" ? "info" : m.role === "in" ? "good" : "warning"}>
        {m.basis === "rank"
          ? m.role === "in"
            ? "ranked higher"
            : "ranked lower"
          : m.role === "in"
            ? "start him"
            : "sit him"}
      </Badge>
      {m.counterpart && (
        <>
          {" "}
          {m.role === "in" ? "over " : "for "}
          {m.counterpart.name}
          {m.slot ? ` at ${slotLabel(m.slot)}` : ""}
          {m.gain != null && <span className="tabular-nums text-gray-600"> · {signed(m.gain)}</span>}
        </>
      )}
    </div>
  );
}

/** Tint both halves of a switch where they sit, so the pair is findable by eye. */
const rowTint = (m: Marker | undefined) => {
  if (!m) return "";
  // A rank flag is the weaker of the two claims — the projections are still
  // against it — so it reads as its own colour rather than a fainter green.
  if (m.basis === "rank") return "bg-indigo-500/10";
  return m.role === "in" ? "bg-emerald-500/10" : "bg-amber-500/10";
};

// One decimal, not none: rounded whole, projected points sit a column from
// "WR11" and read as ranks, and the rounding hid the disagreement the ±
// flags. The other sources are in the tooltip and in Details. A locked row
// shows what he scored instead, or the projection dimmed until the stat
// line arrives; in the narrow desktop column "played" sits above the number.
function ProjCell({ r }: { r: Row }) {
  if (r.locked)
    return (
      <HoverInfo
        info={`His game has kicked off, so he can't be moved${r.projected != null ? ` · projected ${r.projected.toFixed(1)}` : ""}`}
        className="whitespace-nowrap tabular-nums"
      >
        <span className="text-[11px] text-gray-500 sm:block">played </span>
        {r.actual_points != null ? (
          <span className="text-gray-100">{r.actual_points.toFixed(1)}</span>
        ) : (
          <span className="text-gray-600">{r.projected?.toFixed(1) ?? "—"}</span>
        )}
      </HoverInfo>
    );
  if (r.projected == null) return <span className="text-gray-700">—</span>;
  // Every source, the one the lineup is built on first; "↕" marks a week the
  // sources disagree by 4 or more (highest minus lowest, not a ± margin).
  const sources = Object.entries(r.proj).sort(([a], [b]) => (a === "rotowire" ? -1 : b === "rotowire" ? 1 : 0));
  const split = r.proj_spread != null && r.proj_spread >= 4;
  const info =
    sources.length > 1
      ? [
          ...sources.map(([s, v]) => `${projLabel(s)} ${v.toFixed(1)}${s === "rotowire" ? " (used)" : ""}`),
          ...(split ? [`The sources are ${r.proj_spread!.toFixed(1)} apart: a less certain week`] : []),
        ].join("\n")
      : "";
  return (
    <HoverInfo info={info} className="whitespace-nowrap tabular-nums">
      <span className="text-gray-100">{r.projected.toFixed(1)}</span>
      {split && <span className="ml-1 text-[11px] text-amber-300">↕{r.proj_spread!.toFixed(1)}</span>}
    </HoverInfo>
  );
}

/**
 * A phone's second line under the name: matchup, last week's usage and the
 * consensus rank — the three columns hidden below sm — plus an optional
 * control (Details) at its right edge.
 */
function PhoneMeta({
  pos,
  team,
  matchup,
  usage,
  rank,
  delta,
  action,
  locked = false,
}: {
  pos: string | null;
  team?: string | null;
  matchup: Matchup;
  usage: Usage;
  rank: Rank;
  delta: number | null | undefined;
  action?: ReactNode;
  /** His game has kicked off: this week's matchup is history, so it recedes. */
  locked?: boolean;
}) {
  const use = usage && showsUsage(pos) ? usage : null;
  if (!matchup && !use && !rank && !action) return null;
  const m = matchup && !matchup.bye ? matchupText(matchup, pos, team, " ") : null;
  return (
    <div className="mt-0.5 flex items-center gap-2 sm:hidden">
      <MetaLine className="min-w-0 flex-1">
        {matchup &&
          (matchup.bye ? (
            <span className="text-amber-300">BYE</span>
          ) : (
            <HoverInfo info={m?.title} className={`whitespace-nowrap tabular-nums ${locked ? "opacity-50" : ""}`}>
              {m?.text}
            </HoverInfo>
          ))}
        {use && (
          <span className={`whitespace-nowrap tabular-nums ${locked ? "opacity-50" : ""}`}>
            <HoverInfo info={usageTitle(use, pos)}>
              {use.snap_pct != null ? `snap ${use.snap_pct}%` : "no snaps"}
              {use.target_share != null && ` tgt ${use.target_share}%`}
            </HoverInfo>
          </span>
        )}
        {rank && <RankText pos={pos} median={rank.median} best={rank.best} worst={rank.worst} delta={delta} />}
      </MetaLine>
      {action}
    </div>
  );
}

/**
 * The row head. On a phone the slot (QB, FLEX, BN…) sits in a fixed gutter at
 * the left, as the Slot column does from sm up, so every name lines up. Line
 * 1: the name and — on a phone, where the column is hidden — Proj at the
 * right ("played" once his game has kicked off). Line 2 (phone only):
 * matchup · usage · rank. Then the switch tag, and the newest wire note so a
 * starter's status is visible without opening the dossier.
 */
function RowHead({
  r,
  slot,
  marker,
  onPlayer,
}: {
  r: Row;
  slot: string;
  marker: Marker | undefined;
  onPlayer: (id: string) => void;
}) {
  return (
    <div className="flex gap-2">
      <SlotLabel slot={slot} className="w-9 shrink-0 pt-0.5 sm:hidden" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <div className="min-w-0 flex-1">
            <PlayerName id={r.player_id} name={r.name} pos={r.position} team={r.team} injury={r.injury_status} onPlayer={onPlayer} />
          </div>
          <span className="shrink-0 text-sm sm:hidden">
            <ProjCell r={r} />
          </span>
        </div>
        <PhoneMeta pos={r.position} team={r.team} matchup={r.matchup} usage={r.usage} rank={r.rank} delta={r.delta} locked={r.locked} />
        <SwapTag m={marker} />
      </div>
    </div>
  );
}

/** "FLEX", "BN": the slot a row fills, in the Slot column or the phone gutter. */
function SlotLabel({ slot, className = "" }: { slot: string; className?: string }) {
  return <span className={`text-[11px] font-medium uppercase tracking-wide text-gray-500 ${className}`}>{slot}</span>;
}

/**
 * Sites say: the lead call (and the counter-call where they split), then one
 * quote — one line of it on a phone, where a tap opens the rest, two from sm up.
 */
function SitesCell({ c, nSources }: { c: { by_action: Record<string, number>; evidence: Claim[] } | null; nSources?: number }) {
  return (
    <>
      <ClaimsSummary byAction={c?.by_action} nSources={nSources} />
      {c?.evidence[0] && (
        <div className="mt-0.5 max-sm:[&>.line-clamp-2]:line-clamp-1">
          <ClaimQuote e={c.evidence[0]} />
        </div>
      )}
    </>
  );
}

/**
 * One half of a switch: who, what he projects, where the consensus has him,
 * and the wire note that might be the whole reason for the move.
 */
function SwapSide({ r, tone, onPlayer }: { r: Row; tone: "in" | "out" | "rank"; onPlayer: (id: string) => void }) {
  return (
    <div
      className={`border-l-2 pl-2 ${
        tone === "rank" ? "border-indigo-500/60" : tone === "in" ? "border-emerald-500/60" : "border-amber-500/60"
      }`}
    >
      <div>
        <PlayerName id={r.player_id} name={r.name} pos={r.position} team={r.team} injury={r.injury_status} onPlayer={onPlayer} />
      </div>
      <div className="text-xs tabular-nums text-gray-400">
        {r.projected?.toFixed(1) ?? "—"}
        <span className="text-gray-600"> proj</span>
        {r.rank && (
          <>
            {" · "}
            <RankText pos={r.position} median={r.rank.median} best={r.rank.best} worst={r.rank.worst} delta={r.delta} />
          </>
        )}
      </div>
    </div>
  );
}

function DetailsButton({ a, b, onOpen }: { a: Side; b: Side; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Compare ${a.name} and ${b.name} source by source`}
      className="ff-inline ff-hit shrink-0 rounded-md border border-gray-800 px-2 py-0.5 text-[11px] text-gray-400 hover:border-gray-700 hover:text-gray-200 pointer-coarse:min-w-[2.5rem]"
    >
      Details
    </button>
  );
}

/** Bench and Taxi show this many rows (plus any half of a switch) until opened. */
const FOLD = 8;

/**
 * Starters, Bench, IR and Taxi share one set of column widths, so the four
 * tables line up down the page and fit the card without sideways scroll;
 * Sites say takes whatever is left. On a phone Proj, Matchup and Rank move
 * into the row head (line 1 and line 2) and Sites say runs beneath it.
 */
function RosterTable({
  rows,
  slotOf,
  fold = false,
  side,
  onPlayer,
}: {
  rows: Row[];
  /** The slot each row fills: its lineup slot for starters, BN / IR / TX otherwise. */
  slotOf: (r: Row) => string;
  fold?: boolean;
  side: Map<string, Marker>;
  onPlayer: (id: string) => void;
}) {
  const [all, setAll] = useState(false);
  // Half of a switch stays visible past the fold: the tag on the other half
  // names him, and he should be findable without opening the list.
  const shown = fold && !all ? rows.filter((r, i) => i < FOLD || side.has(r.player_id)) : rows;
  return (
    <>
      <div className="ff-stack-wrap overflow-x-auto">
        <table className="ff-stack w-full table-fixed">
          <thead>
            <tr>
              <Th className="hidden w-[3.5rem] sm:table-cell">Slot</Th>
              <Th className="w-[24%]">Player</Th>
              <Th className="hidden w-[5rem] text-right sm:table-cell">Proj</Th>
              <Th className="hidden w-[18%] sm:table-cell">Matchup</Th>
              <Th className="hidden w-[5rem] sm:table-cell">Rank</Th>
              <Th>Sites say</Th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.player_id} className={`border-t border-gray-800/60 align-top ${rowTint(side.get(r.player_id))}`}>
                <Td className="hidden sm:table-cell">
                  <SlotLabel slot={slotOf(r)} />
                </Td>
                <Td data-label="" className="ff-row-head">
                  <RowHead r={r} slot={slotOf(r)} marker={side.get(r.player_id)} onPlayer={onPlayer} />
                </Td>
                <Td className="hidden text-right sm:table-cell">
                  <ProjCell r={r} />
                </Td>
                {/* Matchup with last week's usage under it: side by side they
                    pushed the table past its card. */}
                {/* A kicked-off player's matchup is history: dimmed, so the rows
                    that can still change stand out. */}
                <Td className={`hidden text-xs tabular-nums sm:table-cell ${r.locked ? "opacity-50" : ""}`}>
                  <MatchupCell matchup={r.matchup} position={r.position} team={r.team} />
                  {r.usage && showsUsage(r.position) && (
                    <div className="mt-0.5">
                      <UsageCell usage={r.usage} position={r.position} />
                    </div>
                  )}
                </Td>
                <Td className="hidden text-xs sm:table-cell">
                  <RankText pos={r.position} median={r.rank?.median} best={r.rank?.best} worst={r.rank?.worst} delta={r.delta} />
                </Td>
                {/* Unlabelled on a phone: the call chips and the quote say
                    what they are, and the label cost every card a line. */}
                <Td data-label="" className="text-xs" block empty={r.claims == null}>
                  <SitesCell c={r.claims} nSources={r.claims?.n_sources} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {fold && <FoldToggle total={rows.length} shown={shown.length} expanded={all} onToggle={() => setAll((v) => !v)} mode="all" />}
    </>
  );
}

/** One survival fact: label over value in a phone's 2x2 grid, "label value" inline from sm up. */
function SurvivalStat({ label, children, title, labelAfter = false }: { label: string; children: ReactNode; title?: string; labelAfter?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-1" title={title}>
      <span className={`text-[11px] text-gray-500 sm:text-sm ${labelAfter ? "max-sm:first-letter:uppercase sm:order-last" : ""}`}>{label}</span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

// Guillotine: the question is not "am I optimal" but "am I above the chop
// line". The lowest six rosters are the line as the projections see it;
// your own row is appended when you sit comfortably above them.
const SURVIVAL_ROWS = 6;

function SurvivalCard({ survival }: { survival: NonNullable<Survival> }) {
  const low = survival.distribution.slice(0, SURVIVAL_ROWS);
  const mine = survival.distribution.find((r) => r.is_me);
  const rows = mine && !low.some((r) => r.roster_id === mine.roster_id) ? [...low, mine] : low;
  const margin = survival.margin_above_lowest;
  const marginTone = margin == null ? "text-gray-300" : margin < 5 ? "text-red-400" : margin < 15 ? "text-amber-300" : "text-emerald-400";
  // Rank from the top reads the right way round: "2nd of 19" is safe at a
  // glance, where "18 from the bottom" had to be worked out.
  const fromTop = (fromBottom: number | null, teams: number) => (fromBottom != null ? teams - fromBottom + 1 : null);
  const myTop = fromTop(survival.my_rank_from_bottom, survival.teams_alive);
  const lastTop = survival.last_week ? fromTop(survival.last_week.my_rank_from_bottom, survival.last_week.teams) : null;
  const rival = survival.lowest_rival;
  return (
    <Card
      title="Survival"
      subtitle={`week ${survival.week} · ${survival.teams_alive} teams alive · ${survival.eliminated_so_far} chopped so far`}
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm tabular-nums text-gray-100 sm:flex sm:flex-wrap sm:gap-x-4 sm:gap-y-1">
        <SurvivalStat label="Your set">{survival.mine?.set.toFixed(1) ?? "—"}</SurvivalStat>
        <SurvivalStat label="Lowest rival" title={rival?.owner}>
          <span className="flex min-w-0 items-baseline gap-1">
            <span className="shrink-0">{rival?.set.toFixed(1) ?? "—"}</span>
            {rival && <span className="min-w-0 truncate text-gray-500">({rival.owner})</span>}
          </span>
        </SurvivalStat>
        <SurvivalStat label="Margin">
          <span className={marginTone}>{margin != null ? signed(margin) : "—"}</span>
          {survival.margin_if_optimal != null && margin != null && survival.margin_if_optimal !== margin && (
            <span className="text-xs text-gray-500"> ({signed(survival.margin_if_optimal)} if optimal)</span>
          )}
        </SurvivalStat>
        {myTop != null && (
          <SurvivalStat
            label="from the top"
            labelAfter
            title={survival.median_set != null ? `median set lineup ${survival.median_set.toFixed(1)}` : undefined}
          >
            {ordinal(myTop)} of {survival.teams_alive}
          </SurvivalStat>
        )}
      </div>
      {rows.length > 0 && (
        <ul className="mt-3 max-w-sm space-y-0.5 text-xs">
          {rows.map((r) => (
            <li
              key={r.roster_id}
              className={`flex items-baseline justify-between gap-2 rounded px-2 py-1 ${r.is_me ? "bg-indigo-500/10 text-gray-100" : "text-gray-300"}`}
            >
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="min-w-0 truncate" title={r.owner}>
                  {r.owner}
                </span>
                {r.is_me && <span className="shrink-0 text-indigo-400">you</span>}
                {r.starters_without_projection > 0 && <Badge tone="warning">{r.starters_without_projection} empty</Badge>}
              </span>
              <span className="shrink-0 tabular-nums">
                {r.set.toFixed(1)}
                {/* Only where starting his best would move the number. */}
                {Math.abs(r.optimal - r.set) >= 1 && <span className="text-gray-500"> (optimal {r.optimal.toFixed(1)})</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {survival.last_week && (
        <p className="mt-2 text-xs text-gray-500">
          Week {survival.last_week.week}: chop line {survival.last_week.chop_line} ({survival.last_week.chopped}) · you scored{" "}
          {survival.last_week.my_points != null ? survival.last_week.my_points.toFixed(1) : "—"}
          {lastTop != null && `, ${ordinal(lastTop)} of ${survival.last_week.teams}`}
        </p>
      )}
      <Note>{survival.note}</Note>
    </Card>
  );
}

export default function LineupTab({ league, onPlayer }: { league: string; onPlayer: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [allStreams, setAllStreams] = useState(false);
  // The two players a Details popup is currently comparing, or null.
  const [compare, setCompare] = useState<{ a: Side; b: Side; slot: string | null } | null>(null);

  // FantasyPage keys this tab by league, so a league switch remounts it and
  // this runs once per league.
  useEffect(() => {
    fetch(`/api/fantasy/lineup?league=${encodeURIComponent(league)}`)
      .then((r) => r.json())
      .then((d: Data) => (d.error ? setErr(d.error) : setData(d)))
      .catch((e) => setErr(String(e)));
  }, [league]);

  if (err) return <ErrorBox>{err}</ErrorBox>;
  if (!data) return <Loading label="Loading lineup…" rows={6} />;

  // Both halves of every switch, indexed by player.
  const side = new Map<string, Marker>();
  for (const s of data.swaps) {
    if (s.in) side.set(s.in.player_id, { role: "in", basis: "projection", slot: s.slot, gain: s.gain, counterpart: s.out });
    if (s.out) side.set(s.out.player_id, { role: "out", basis: "projection", slot: s.slot, gain: s.gain, counterpart: s.in });
  }
  // A rank flag is a switch too, so both halves get marked where they sit —
  // but never over a projection swap, which is the stronger claim.
  for (const f of data.rank_flags) {
    if (!side.has(f.in.player_id))
      side.set(f.in.player_id, { role: "in", basis: "rank", slot: f.slot, gain: f.gain, counterpart: f.out });
    if (!side.has(f.out.player_id))
      side.set(f.out.player_id, { role: "out", basis: "rank", slot: f.slot, gain: f.gain, counterpart: f.in });
  }

  // One row per decision, not per player. Two rules put a row here and
  // nothing else does: the projections move a bench player into the lineup,
  // or the expert rankings order one ahead of a starter he could replace.
  //
  // Start/sit claims used to fill this table and did not belong in it. Every
  // bench player with net-positive "start" claims produced a row, so eleven
  // sites writing "start Trevor Lawrence" read here as a lineup change, in a
  // league where he sits behind a quarterback projecting 3.7 higher and
  // ranked eight places above him. A rank is a head-to-head ordering of two
  // named players; a claim is written without knowing anyone's roster. Claims
  // are still on every row of Starters and Bench, under "Sites say" — as
  // context on a player, which is what they are.
  type Move = {
    key: string;
    slot: string | null;
    in: Row | null;
    out: Row | null;
    gain: number | null;
    /** "numbers" = he out-projects the starter; "ranks" = the experts order him ahead. */
    source: "numbers" | "ranks";
    /** On a ranks row, the two ranks compared and the list they came from. */
    ranks: { in: number; out: number; basis: string } | null;
    evidence: Row | null;
  };
  const moves: Move[] = [
    ...data.swaps.map((sw): Move => ({
      key: `swap-${sw.in?.player_id ?? ""}-${sw.out?.player_id ?? ""}`,
      slot: sw.slot,
      in: sw.in,
      out: sw.out,
      gain: sw.gain,
      source: "numbers",
      ranks: null,
      evidence: sw.in ?? sw.out,
    })),
    ...data.rank_flags.map((f): Move => ({
      key: `rank-${f.in.player_id}-${f.out.player_id}`,
      slot: f.slot,
      in: f.in,
      out: f.out,
      gain: f.gain,
      source: "ranks",
      ranks: { in: f.in_rank, out: f.out_rank, basis: f.basis },
      evidence: f.in,
    })),
  ];
  const swing = data.totals.optimal - data.totals.current;

  // A streaming panel is worth opening only where the best available
  // out-projects the starter a pickup would replace — the weakest one set at
  // the position; a set QB with nobody better on the wire is noise.
  const setStarter = (pos: string): Row | null => {
    const at = data.starters.filter((r) => r.position === pos);
    return at.length ? at.reduce((lo, r) => ((r.projected ?? 0) < (lo.projected ?? 0) ? r : lo)) : null;
  };
  const weak = (pos: string, rows: Stream[]) => {
    const best = Math.max(0, ...rows.map((s) => s.proj.rotowire ?? 0));
    return rows.length > 0 && best > (setStarter(pos)?.projected ?? 0);
  };
  const streams = Object.entries(data.streaming);
  const openStreams = allStreams ? streams : streams.filter(([pos, rows]) => weak(pos, rows));
  // The toggle reveals or hides the positions that are not a weak spot
  // ("Show options"). No toggle when every position is already on show.
  const extra = streams.filter(([pos, rows]) => !weak(pos, rows)).map(([pos]) => pos);
  const streamToggle =
    extra.length > 0 ? (
      <button
        type="button"
        onClick={() => setAllStreams((v) => !v)}
        className="ff-inline ff-hit whitespace-nowrap text-xs text-indigo-400 hover:text-indigo-300"
      >
        {allStreams ? "Hide options" : "Show options"}
      </button>
    ) : undefined;

  const survival = data.survival ?? null;

  return (
    <div className="space-y-4">
      {survival && <SurvivalCard survival={survival} />}

      {moves.length === 0 ? (
        <QuietLine
          title="Switch these"
          info="Bench players who out-project a starter, or whom the experts rank above one, each paired with the starter he would displace."
        >
          Your lineup is optimal for week {data.week}.
        </QuietLine>
      ) : (
        <Card
          title="Switch these"
          info="Bench players who out-project a starter, or whom the experts rank above one, each paired with the starter he would displace."
          right={
            data.swaps.length > 0 ? (
              <span className="whitespace-nowrap text-xs tabular-nums text-gray-400">{signed(swing)} projected</span>
            ) : undefined
          }
        >
          <div className="ff-stack-wrap overflow-x-auto">
            <table className="ff-stack w-full">
              <thead>
                <tr>
                  <Th>Slot</Th>
                  <Th>Start</Th>
                  <Th>Sit</Th>
                  <Th className="text-right">Gain</Th>
                  <Th>Why</Th>
                  <Th>{""}</Th>
                </tr>
              </thead>
              <tbody>
                {moves.map((m) => (
                  <tr key={m.key} className="border-t border-gray-800/60 align-top">
                    <Td data-label="Slot" className="whitespace-nowrap text-xs font-medium text-gray-400" empty={m.slot == null}>
                      {m.slot ? slotLabel(m.slot) : "—"}
                    </Td>
                    {/* Half a switch is still a decision. A numbers row with
                        nobody coming in is a slot being filled from elsewhere
                        in the lineup; with nobody going out, it fills an empty
                        slot. A rank row always has both halves. */}
                    <Td data-label="Start">
                      {m.in ? (
                        <SwapSide r={m.in} tone={m.source === "ranks" ? "rank" : "in"} onPlayer={onPlayer} />
                      ) : (
                        <span className="text-xs text-gray-500">someone already in your lineup</span>
                      )}
                    </Td>
                    <Td data-label="Sit">
                      {m.out ? (
                        <SwapSide r={m.out} tone={m.source === "ranks" ? "rank" : "out"} onPlayer={onPlayer} />
                      ) : (
                        <span className="text-xs text-gray-500">an empty slot</span>
                      )}
                    </Td>
                    <Td data-label="Gain" className="text-right" empty={m.gain == null}>
                      {m.gain != null ? (
                        // A rank row always costs projected points — that is
                        // the disagreement — so the number is the first thing
                        // you should weigh, not a hidden "—". Under a point
                        // either way is inside the noise in any projection set.
                        <Badge
                          tone={m.gain < 0 ? "warning" : m.gain >= 1 ? "good" : "neutral"}
                          title={
                            m.gain < 0
                              ? "what taking the experts' ordering would cost against the projection"
                              : m.gain >= 1
                                ? undefined
                                : "inside the noise between projection sources"
                          }
                        >
                          {signed(m.gain)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-gray-700">—</span>
                      )}
                    </Td>
                    <Td data-label="Why" className="text-xs" block>
                      <Badge tone={m.source === "numbers" ? "info" : "neutral"}>{m.source}</Badge>
                      {/* "55 to 58" is two bare numbers; a rank only means
                          something with its list attached — WR55 over WR58
                          at the position, or 118 over 120 on the FLEX list
                          where the positional numbers do not compare. */}
                      <span className="ml-1.5 text-gray-500">
                        {m.ranks
                          ? m.ranks.basis === "position"
                            ? `experts rank him ${m.in?.position}${m.ranks.in} over ${m.out?.position}${m.ranks.out}`
                            : `experts rank him ${m.ranks.in} over ${m.ranks.out} on the ${m.ranks.basis} list`
                          : "projection-optimal for this slot"}
                      </span>
                      {/* What a site actually wrote about the player coming
                          in. Context on him, not the reason the row exists —
                          that is the rank or the projection, above. */}
                      {m.evidence?.claims?.evidence[0] && (
                        <div className="mt-0.5">
                          <ClaimQuote e={m.evidence.claims.evidence[0]} />
                        </div>
                      )}
                    </Td>
                    {/* Both halves present is the only case with anything to
                        compare source by source. Right-aligned in a
                        full-width box so it sits at the right edge of a
                        phone's stacked card too. */}
                    <Td data-label="" empty={!(m.in && m.out)}>
                      {m.in && m.out && (
                        <div className="flex w-full justify-end">
                          <DetailsButton a={m.in} b={m.out} onOpen={() => setCompare({ a: m.in as Row, b: m.out as Row, slot: m.slot })} />
                        </div>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {openStreams.length === 0 ? (
        <QuietLine
          title="Streaming"
          info="Positions where the best available player out-projects your weakest set starter there."
          right={streamToggle}
        >
          No upgrade available{streams.length > 0 ? ` at ${streams.map(([pos]) => pos).join(", ")}` : ""}.
        </QuietLine>
      ) : (
        <Card
          title="Streaming"
          info={
            allStreams
              ? "Best available at each streamable position, highest projection first, leaving out anyone projected at zero."
              : "Positions where the best available out-projects your weakest set starter, highest projection first."
          }
          right={streamToggle}
        >
          <div className="ff-stack-wrap overflow-x-auto">
            <table className="ff-stack w-full table-fixed">
              <thead>
                <tr>
                  <Th className="w-[24%]">Player</Th>
                  <Th className="hidden w-[5rem] text-right sm:table-cell">Proj</Th>
                  <Th className="hidden w-[18%] sm:table-cell">Matchup</Th>
                  <Th className="hidden w-[5rem] sm:table-cell">Rank</Th>
                  <Th>Sites say</Th>
                  <Th className="hidden w-[5.5rem] sm:table-cell">{""}</Th>
                </tr>
              </thead>
              <tbody>
                {openStreams.flatMap(([pos, rows]) => {
                  // The position and who you would be replacing head each
                  // group as its own full-width row: a plain heading on a
                  // phone rather than a card of its own. Every comparison is
                  // against that starter — the weakest one set at the position.
                  const cur = setStarter(pos);
                  const heading = (
                    <tr
                      key={`${pos}-head`}
                      className="border-t border-gray-800/60 max-sm:mb-0! max-sm:border-0! max-sm:px-0! max-sm:pb-0!"
                    >
                      <Td data-label="" colSpan={6} className="ff-row-head pb-0.5 pt-2.5 text-xs font-medium text-gray-400">
                        {pos}
                        {rows.length === 0 ? (
                          <span className="font-normal text-gray-500"> · nobody projected to play is available</span>
                        ) : (
                          cur?.projected != null && (
                            <span className="font-normal tabular-nums text-gray-500"> · set starter {cur.projected.toFixed(1)}</span>
                          )
                        )}
                      </Td>
                    </tr>
                  );
                  return [
                    heading,
                    ...rows.map((s) => {
                      const details = cur && (
                        <DetailsButton a={{ ...s, position: pos }} b={cur} onOpen={() => setCompare({ a: { ...s, position: pos }, b: cur, slot: pos })} />
                      );
                      const proj = s.proj.rotowire;
                      return (
                        <tr key={`${pos}-${s.player_id}`} className="border-t border-gray-800/30 align-top">
                          <Td data-label="" className="ff-row-head">
                            <div className="flex items-baseline gap-2">
                              <div className="min-w-0 flex-1">
                                <PlayerName id={s.player_id} name={s.name} pos={pos} team={s.team} onPlayer={onPlayer} />
                              </div>
                              {proj != null && <span className="shrink-0 text-sm tabular-nums text-gray-100 sm:hidden">{proj.toFixed(1)}</span>}
                            </div>
                            <PhoneMeta pos={pos} team={s.team} matchup={s.matchup} usage={s.usage} rank={s.rank} delta={s.delta} action={details} />
                          </Td>
                          <Td className="hidden text-right sm:table-cell">
                            <span className="whitespace-nowrap tabular-nums text-gray-100">{proj != null ? proj.toFixed(1) : "—"}</span>
                          </Td>
                          <Td className="hidden text-xs tabular-nums sm:table-cell">
                            <MatchupCell matchup={s.matchup} position={pos} team={s.team} />
                            {s.usage && showsUsage(pos) && (
                              <div className="mt-0.5">
                                <UsageCell usage={s.usage} position={pos} />
                              </div>
                            )}
                          </Td>
                          <Td className="hidden text-xs sm:table-cell">
                            <RankText pos={pos} median={s.rank?.median} best={s.rank?.best} worst={s.rank?.worst} delta={s.delta} />
                          </Td>
                          <Td data-label="" className="text-xs" block empty={s.claims == null}>
                            <SitesCell c={s.claims} />
                          </Td>
                          {/* On a phone Details rides at the end of line 2. */}
                          <Td className="hidden text-right sm:table-cell">{details}</Td>
                        </tr>
                      );
                    }),
                  ];
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card
        title="Starters"
        right={
          <span className="whitespace-nowrap text-xs tabular-nums text-gray-400">
            {data.totals.current.toFixed(1)} projected
            {data.totals.optimal !== data.totals.current && (
              <span className="text-gray-600"> · {data.totals.optimal.toFixed(1)} optimal</span>
            )}
          </span>
        }
        info={
          "Proj = Sleeper's projection under this league's scoring" +
          (data.usage_week != null ? `; usage = week ${data.usage_week} snap/target share.` : ".")
        }
      >
        <RosterTable rows={data.starters} slotOf={(r) => slotLabel(r.slot ?? r.position ?? "")} side={side} onPlayer={onPlayer} />
        {data.empty_slots.length > 0 && (
          <p className="mt-2 text-xs text-amber-300">
            Nothing set at {data.empty_slots.map(slotLabel).join(", ")} — an empty slot scores zero.
          </p>
        )}
        <Note>{data.note}</Note>
        <Note>{data.context_note}</Note>
      </Card>
      <Card title="Bench" info="Everyone rostered and not in the lineup, highest projection first.">
        <RosterTable rows={data.bench} slotOf={() => "BN"} fold side={side} onPlayer={onPlayer} />
      </Card>
      {/* Two benches with two different rules, and a league can have either,
          both or neither. Each shows only where the league has the slots. */}
      {data.reserve_slots > 0 &&
        ((data.reserve ?? []).length > 0 ? (
          <Card
            title="IR"
            right={
              <span className="whitespace-nowrap text-xs tabular-nums text-gray-400">
                {(data.reserve ?? []).length} of {data.reserve_slots} slots
              </span>
            }
          >
            <RosterTable rows={data.reserve ?? []} slotOf={() => "IR"} side={side} onPlayer={onPlayer} />
            {data.reserve_note && <Note>{data.reserve_note}</Note>}
          </Card>
        ) : (
          <QuietLine title="IR" right={<span className="text-xs tabular-nums text-gray-500">0 of {data.reserve_slots} slots</span>}>
            Nobody on IR.
          </QuietLine>
        ))}
      {data.taxi_slots > 0 &&
        ((data.taxi ?? []).length > 0 ? (
          <Card
            title="Taxi squad"
            right={
              <span className="whitespace-nowrap text-xs tabular-nums text-gray-400">
                {(data.taxi ?? []).length} of {data.taxi_slots} slots
              </span>
            }
          >
            <RosterTable rows={data.taxi ?? []} slotOf={() => "TX"} fold side={side} onPlayer={onPlayer} />
            {data.taxi_note && <Note>{data.taxi_note}</Note>}
          </Card>
        ) : (
          <QuietLine title="Taxi squad" right={<span className="text-xs tabular-nums text-gray-500">0 of {data.taxi_slots} slots</span>}>
            Taxi squad is empty.
          </QuietLine>
        ))}

      {compare && (
        <SwapDetails a={compare.a} b={compare.b} slot={compare.slot} onPlayer={onPlayer} onClose={() => setCompare(null)} />
      )}
    </div>
  );
}
