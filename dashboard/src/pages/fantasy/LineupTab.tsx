import { useEffect, useState, type ReactNode } from "react";
import { Badge, Card, StatTile, Td, Th } from "./viz";
import { ACTION_TONE, projLabel, projShort, srcLabel, srcShort } from "./labels";
import { SrcLink, MatchupCell, NoteLine, RoleBadge, UsageCell, type Matchup, type Note, type Usage } from "./NoteLine";

/**
 * Lineup — start / sit this week.
 *
 * The projection-optimal lineup (the engine's number of record) against the
 * one you actually have set, with the other two projection sources and the
 * consensus rank on every row, and the sites' this-week claims beside them.
 * Every change the engine would make is shown as a paired switch — start him,
 * sit that one, at this slot, for this many points — and both halves are
 * highlighted where they sit in Starters and Bench, each naming the other.
 * Disagreements — a starter the sites say sit, a bench player they say
 * start — join the same table with who he would displace. Streaming picks at
 * QB/TE/DEF/K show the best available with what the sites say.
 */

type Rank = { median: number; best: number; worst: number; spread: number; n: number } | null;
type Claims = {
  n: number;
  n_sources: number;
  net: number;
  by_action: Record<string, number>;
  week: number;
  evidence: { action: string; horizon: string; confidence: number | null; rationale: string; source: string; title: string; url: string }[];
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
  current_starter: boolean;
  optimal_starter: boolean;
  reserve?: boolean;
  points?: number;
  usage: Usage;
  matchup: Matchup;
  note: Note;
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
  projected?: number | null;
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
  claims: { n: number; net: number; by_action: Record<string, number>; evidence: { rationale: string; source: string }[] } | null;
  usage: Usage;
  matchup: Matchup;
  note: Note;
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
  /** The projection-optimal lineup. Not rendered as a table; it is what the swaps are against. */
  optimal: Row[];
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
  cross_list: string;
  streaming: Record<string, Stream[]>;
  note: string;
  context_note: string;
  usage_week: number | null;
  usage_prev_week: number | null;
  role_change_points: number;
  note_hours: number;
  error?: string;
};


/**
 * Side-by-side detail for a proposed switch: every projection source and
 * every ranking source that has an opinion on the two players, with which
 * one each favours.
 *
 * The headline number hides how thin a call can be. "Purdy over Dak, +0.5"
 * reads settled; underneath, Rotowire and ESPN prefer Purdy, the Fantasy
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
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-400">{title}</h4>
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
              <td colSpan={4} className="py-1 text-gray-600">
                No source has both players.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  const Head = ({ s, tone }: { s: Side; tone: "a" | "b" }) => (
    <div className={`border-l-2 pl-2 ${tone === "a" ? "border-emerald-500/60" : "border-amber-500/60"}`}>
      <button
        onClick={() => onPlayer(s.player_id)}
        className="text-left text-sm font-medium text-gray-100 hover:text-indigo-300 hover:underline"
      >
        {s.name}
      </button>
      <div className="text-[11px] text-gray-500">
        {s.position}
        {s.team ? ` · ${s.team}` : ""}
      </div>
      <div className="mt-1 text-xs tabular-nums text-gray-300">
        {s.rank ? (
          <>
            {s.position}
            {s.rank.median} <span className="text-gray-600">({s.rank.best}–{s.rank.worst}, n={s.rank.n})</span>
          </>
        ) : (
          <span className="text-gray-700">unranked</span>
        )}
        {/* Which way the board has moved him since the last snapshot: a call
            this close is often really a question of who is trending. */}
        {s.delta != null && s.delta !== 0 && (
          <span className={s.delta > 0 ? " text-emerald-400" : " text-amber-300"}>
            {" "}
            {s.delta > 0 ? "▲" : "▼"}
            {Math.abs(s.delta)}
          </span>
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
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-gray-100">
              {a.name} <span className="text-gray-500">vs</span> {b.name}
            </h3>
            {slot && <p className="text-xs text-gray-500">at {slot}</p>}
          </div>
          <button onClick={onClose} className="shrink-0 text-xs text-gray-400 hover:text-gray-200" aria-label="Close">
            close
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


export default function LineupTab({ league, onPlayer }: { league: string; onPlayer: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [allStreams, setAllStreams] = useState(false);
  // The two players a Details popup is currently comparing, or null.
  const [compare, setCompare] = useState<{ a: Side; b: Side; slot: string | null } | null>(null);

  useEffect(() => {
    setData(null);
    fetch(`/api/fantasy/lineup?league=${encodeURIComponent(league)}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : (setErr(null), setData(d))))
      .catch((e) => setErr(String(e)));
  }, [league]);

  if (err) return <div className="p-6 text-sm text-red-400">{err}</div>;
  if (!data) return <div className="p-6 text-sm text-gray-500">Loading…</div>;

  const gainText = (g: number) => `${g >= 0 ? "+" : ""}${g.toFixed(1)}`;

  const DetailsButton = ({ a, b, slot }: { a: Side; b: Side; slot: string | null }) => (
    <button
      onClick={() => setCompare({ a, b, slot })}
      className="ff-inline rounded-md border border-gray-800 px-2 py-0.5 text-[11px] text-gray-400 hover:border-gray-700 hover:text-gray-200"
    >
      Details
    </button>
  );

  // Both halves of every switch, indexed by player, so a highlighted row in
  // Starters or Bench can name the other half instead of only flagging
  // itself. "Start Purdy" and "sit Dak" are one decision; the tables should
  // not make you rebuild the pairing by eye.
  type Marker = {
    role: "in" | "out";
    /** "projection" = he out-projects the starter; "rank" = the experts order him ahead. */
    basis: "projection" | "rank";
    slot: string | null;
    gain: number | null;
    counterpart: Row | null;
  };
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

  const Name = ({ r }: { r: Row }) => (
    <>
      <button onClick={() => onPlayer(r.player_id)} className="text-left text-gray-100 hover:text-indigo-300 hover:underline">
        {r.name}
      </button>
      <span className="ml-1.5 text-xs text-gray-500">
        {r.position}
        {r.team ? ` · ${r.team}` : ""}
      </span>
      {r.injury_status && (
        <>
          {" "}
          <Badge tone="warning">{r.injury_status}</Badge>
        </>
      )}
      {/* The newest injury / out / role / return wire note, inline, so a
          starter's status is visible without opening the dossier. */}
      <NoteLine note={r.note} />
    </>
  );

  const ProjCell = ({ r }: { r: Row }) => (
    <span className="whitespace-nowrap tabular-nums">
      <span className="text-gray-100">{r.projected?.toFixed(1) ?? "—"}</span>
      {/* The other two sources are a desktop detail; on a phone the
          league-correct number and the disagreement flag are the answer. */}
      {/* One decimal, not none. These are projected points, but rounded whole
          they sit one column from "RB113 (82–128)" and read as ranks — and
          the rounding also hid the disagreement the ± beside them flags,
          printing 4.6 and 1.3 as 5 and 1. */}
      <span className="ml-1.5 hidden text-[11px] text-gray-600 xl:inline">
        {Object.entries(r.proj)
          .filter(([s]) => s !== "rotowire")
          .map(([s, v]) => `${projShort(s)} ${v.toFixed(1)}`)
          .join(" · ")}
      </span>
      {r.proj_spread != null && r.proj_spread >= 4 && (
        <span className="ml-1 text-amber-300" title="projection sources disagree">
          ±{r.proj_spread.toFixed(1)}
        </span>
      )}
    </span>
  );

  const RankCell = ({ r }: { r: Row }) =>
    r.rank ? (
      <span className="whitespace-nowrap tabular-nums text-gray-300" title={Object.entries(r.ranks).map(([s, v]) => `${srcShort(s)} ${v}`).join(", ")}>
        {r.position}
        {r.rank.median}
        <span className="text-gray-600"> ({r.rank.best}–{r.rank.worst})</span>
      </span>
    ) : (
      <span className="text-gray-700">—</span>
    );

  const ClaimsCell = ({ c }: { c: Claims }) =>
    c ? (
      <span>
        <span className="inline-flex flex-wrap gap-1">
          {Object.entries(c.by_action)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([a, n]) => (
              <Badge key={a} tone={ACTION_TONE[a] ?? "neutral"}>
                {a}
                {n > 1 ? ` ×${n}` : ""}
              </Badge>
            ))}
        </span>
        {c.evidence[0] && (
          <div className="mt-0.5 max-w-[24rem] text-[11px] text-gray-500">
            <SrcLink e={c.evidence[0]} /> {c.evidence[0].rationale}
          </div>
        )}
      </span>
    ) : (
      <span className="text-xs text-gray-700">quiet</span>
    );

  const SetCell = ({ r }: { r: Row }) => {
    // Taxi rows are `reserve` too — they are both "parked" — but they are not
    // on IR, and badging four taxi players "IR slot" said they were hurt.
    if (r.reserve) return <Badge tone="neutral">{r.slot === "TAXI" ? "taxi" : "IR slot"}</Badge>;
    const sw = side.get(r.player_id);
    if (!sw) return <span className="text-gray-600">{r.current_starter ? "starting" : "bench"}</span>;
    return (
      <div>
        <Badge tone={sw.basis === "rank" ? "info" : sw.role === "in" ? "good" : "warning"}>
          {sw.basis === "rank"
            ? sw.role === "in"
              ? "ranked higher"
              : "ranked lower"
            : sw.role === "in"
              ? "start him"
              : "sit him"}
        </Badge>
        {sw.counterpart && (
          <div className="mt-0.5 text-gray-500">
            {sw.role === "in" ? "over " : "for "}
            {sw.counterpart.name}
            {sw.slot ? ` at ${sw.slot}` : ""}
            {sw.gain != null && <span className="text-gray-600"> · {gainText(sw.gain)}</span>}
          </div>
        )}
      </div>
    );
  };

  /** Tint both halves of a switch where they sit, so the pair is findable by eye. */
  const rowTint = (r: Row) => {
    const sw = side.get(r.player_id);
    if (!sw) return "";
    // A rank flag is the weaker of the two claims — the projections are still
    // against it — so it reads as its own colour rather than a fainter green.
    if (sw.basis === "rank") return "bg-indigo-500/10";
    return sw.role === "in" ? "bg-emerald-500/10" : "bg-amber-500/10";
  };

  /**
   * One half of a switch: who, what he projects, where the consensus has him,
   * and the wire note that might be the whole reason for the move.
   */
  const SwapSide = ({ r, tone, muted = false }: { r: Row; tone: "in" | "out" | "rank"; muted?: boolean }) => (
    <div
      className={`border-l-2 pl-2 ${
        muted
          ? "border-gray-700"
          : tone === "rank"
            ? "border-indigo-500/60"
            : tone === "in"
              ? "border-emerald-500/60"
              : "border-amber-500/60"
      }`}
    >
      <div>
        <button
          onClick={() => onPlayer(r.player_id)}
          className={`text-left hover:text-indigo-300 hover:underline ${muted ? "text-gray-400" : "text-gray-100"}`}
        >
          {r.name}
        </button>
        <span className="ml-1.5 text-xs text-gray-500">
          {r.position}
          {r.team ? ` · ${r.team}` : ""}
        </span>
        {r.injury_status && (
          <>
            {" "}
            <Badge tone="warning">{r.injury_status}</Badge>
          </>
        )}
        {/* A bench player whose snap share jumped is often the whole reason. */}
        {!muted && r.usage?.role_change && (
          <>
            {" "}
            <RoleBadge change={r.usage.role_change} />
          </>
        )}
      </div>
      <div className="text-xs tabular-nums text-gray-400">
        {r.projected?.toFixed(1) ?? "—"}
        <span className="text-gray-600"> proj</span>
        {r.rank && (
          <>
            {" · "}
            {r.position}
            {r.rank.median}
          </>
        )}
      </div>
      {/* The wire note belongs to the player the row is about. Repeating a
          three-line injury note for a displaced player who is only inferred —
          and inferred twice over, once per sites row — buried the card. */}
      {!muted && <NoteLine note={r.note} className="whitespace-normal" />}
    </div>
  );

  /**
   * A card with nothing in it is still worth saying — "your lineup is already
   * optimal" is an answer — but it does not deserve a header, a subtitle and
   * two rows of padding to say it. One slim line, same border, same order in
   * the page, so the tab opens on the things that need you.
   */
  const QuietLine = ({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) => (
    <section className="flex min-w-0 flex-col gap-x-3 gap-y-1 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 sm:flex-row sm:items-baseline sm:px-4">
      <h3 className="shrink-0 text-sm font-semibold text-gray-300">{title}</h3>
      <p className="min-w-0 text-xs text-gray-500">{children}</p>
      {right && <div className="shrink-0 sm:ml-auto">{right}</div>}
    </section>
  );

  const Table = ({ rows, slotCol }: { rows: Row[]; slotCol: boolean }) => (
    <div className="ff-stack-wrap overflow-x-auto">
      <table className="ff-stack w-full">
        <thead>
          <tr>
            {slotCol && <Th>Slot</Th>}
            <Th>Player</Th>
            <Th>Set</Th>
            <Th className="text-right">Proj</Th>
            <Th>Matchup · usage</Th>
            <Th>Rank</Th>
            <Th>Sites say (this week)</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.player_id} className={`border-t border-gray-800/60 align-top ${rowTint(r)}`}>
              {slotCol && <Td data-label="Slot" className="text-xs text-gray-500">{r.slot}</Td>}
              <Td data-label="" className="ff-row-head whitespace-nowrap">
                <Name r={r} />
              </Td>
              <Td data-label="Set" className="text-xs">
                <SetCell r={r} />
              </Td>
              <Td data-label="Proj" className="text-right">
                <ProjCell r={r} />
              </Td>
              {/* Two short facts stacked in one column: side by side they
                  pushed the starters table 170px past its card at 1259px. */}
              <Td data-label="Matchup · usage" className="whitespace-nowrap text-xs tabular-nums">
                <div>
                  <div>
                    <MatchupCell matchup={r.matchup} position={r.position} />
                  </div>
                  <div className="text-gray-400">
                    <UsageCell usage={r.usage} position={r.position} />
                  </div>
                </div>
              </Td>
              <Td data-label="Rank" className="text-xs">
                <RankCell r={r} />
              </Td>
              <Td data-label="Sites say" className="text-xs sm:min-w-[13rem]">
                <ClaimsCell c={r.claims} />
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );


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

  // A streaming panel is worth opening only where the set starter projects
  // below the best available; a set QB with nobody better on the wire is
  // noise. Kickers rarely stream, so K is treated the same way.
  /** The weakest set starter at a position — who a streaming pickup replaces. */
  const setStarter = (pos: string): Row | null => {
    const at = data.starters.filter((r) => r.position === pos);
    return at.length ? at.reduce((lo, r) => ((r.projected ?? 0) < (lo.projected ?? 0) ? r : lo)) : null;
  };
  const starterProj = (pos: string) =>
    Math.max(0, ...data.starters.filter((r) => r.position === pos).map((r) => r.projected ?? 0));
  const weak = (pos: string, rows: Stream[]) => {
    const best = Math.max(0, ...rows.map((s) => s.proj.rotowire ?? 0));
    return rows.length > 0 && best > starterProj(pos);
  };
  const streams = Object.entries(data.streaming);
  const openStreams = allStreams ? streams : streams.filter(([pos, rows]) => weak(pos, rows));

  // Guillotine: the question is not "am I optimal" but "am I above the chop
  // line". The lowest six rosters are the line as the projections see it;
  // your own row is appended when you sit comfortably above them.
  const survival = data.survival ?? null;
  const SURVIVAL_ROWS = 6;
  const survivalRows = (() => {
    if (!survival) return [];
    const low = survival.distribution.slice(0, SURVIVAL_ROWS);
    const mine = survival.distribution.find((r) => r.is_me);
    return mine && !low.some((r) => r.roster_id === mine.roster_id) ? [...low, mine] : low;
  })();
  const margin = survival?.margin_above_lowest ?? null;
  const marginTone: "critical" | "warning" | "good" = margin == null ? "good" : margin < 5 ? "critical" : margin < 15 ? "warning" : "good";
  const marginHint =
    survival?.margin_if_optimal != null && margin != null && survival.margin_if_optimal !== margin
      ? `+${survival.margin_if_optimal.toFixed(1)} if optimal`
      : undefined;

  return (
    <div className="space-y-4">
      {survival && (
        <Card
          title="Survival"
          subtitle={`week ${survival.week} · ${survival.teams_alive} teams alive · ${survival.eliminated_so_far} chopped so far`}
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatTile label="Your set lineup" value={survival.mine?.set.toFixed(1) ?? "—"} />
            <StatTile label="Lowest rival" value={survival.lowest_rival?.set.toFixed(1) ?? "—"} hint={survival.lowest_rival?.owner} />
            <StatTile label="Margin above the line" value={margin != null ? `${margin >= 0 ? "+" : ""}${margin.toFixed(1)}` : "—"} tone={marginTone} hint={marginHint} />
            <StatTile
              label="From the bottom"
              value={survival.my_rank_from_bottom != null ? `${survival.my_rank_from_bottom} of ${survival.teams_alive}` : "—"}
              hint={survival.median_set != null ? `median ${survival.median_set.toFixed(1)}` : undefined}
            />
          </div>
          {survivalRows.length > 0 && (
            <ul className="mt-3 space-y-0.5 text-xs">
              {survivalRows.map((r) => (
                <li
                  key={r.roster_id}
                  className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-2 py-1 ${r.is_me ? "bg-indigo-500/10 text-gray-100" : "text-gray-300"}`}
                >
                  <span className="min-w-0 truncate">
                    {r.owner}
                    {r.is_me && <span className="ml-1 text-indigo-400">you</span>}
                  </span>
                  <span className="tabular-nums">
                    · {r.set.toFixed(1)} <span className="text-gray-500">(optimal {r.optimal.toFixed(1)})</span>
                  </span>
                  {r.starters_without_projection > 0 && <Badge tone="warning">{r.starters_without_projection} empty</Badge>}
                </li>
              ))}
            </ul>
          )}
          {survival.last_week && (
            <p className="mt-2 text-xs text-gray-500">
              Week {survival.last_week.week}: chop line {survival.last_week.chop_line} ({survival.last_week.chopped}) · you scored{" "}
              {survival.last_week.my_points != null ? survival.last_week.my_points.toFixed(1) : "—"}, {survival.last_week.my_rank_from_bottom ?? "—"} from the bottom of{" "}
              {survival.last_week.teams}
            </p>
          )}
          <p className="mt-2 text-[11px] text-gray-600">{survival.note}</p>
        </Card>
      )}


      {moves.length === 0 ? (
        <QuietLine title="Switch these">
          Nothing to change — your lineup is the projection-optimal one for week {data.week} ({data.totals.current.toFixed(1)}{" "}
          projected), and no bench player is ranked above a starter he could replace.
        </QuietLine>
      ) : (
        <Card
          title="Switch these"
          subtitle={`Changes to your set lineup, each paired with the starter it would displace. A player is here because he out-projects a starter, or because the experts rank him above one (positional ranks at a fixed slot, the ${data.cross_list} list at a flex). Nothing here is an override.`}
          right={
            data.swaps.length > 0 ? (
              <span className="whitespace-nowrap text-xs tabular-nums text-gray-400">{gainText(swing)} projected</span>
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
                    <Td data-label="Slot" className="whitespace-nowrap text-xs font-medium text-gray-400">
                      {m.slot ?? "—"}
                    </Td>
                    {/* Half a switch is still a decision, and the missing half
                        means something different either side of the source: a
                        numbers row with nobody coming in is a slot being
                        filled from elsewhere in the lineup; a sites row with
                        nobody coming in is a slot filled from elsewhere in
                        the lineup. A rank row always has both. */}
                    <Td data-label="Start" className="whitespace-nowrap">
                      {m.in ? (
                        <SwapSide r={m.in} tone={m.source === "ranks" ? "rank" : "in"} />
                      ) : (
                        <span className="text-xs text-gray-600">someone already in your lineup</span>
                      )}
                    </Td>
                    <Td data-label="Sit" className="whitespace-nowrap">
                      {m.out ? (
                        <SwapSide r={m.out} tone={m.source === "ranks" ? "rank" : "out"} />
                      ) : (
                        <span className="text-xs text-gray-600">an empty slot</span>
                      )}
                    </Td>
                    <Td data-label="Gain" className="text-right">
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
                          {gainText(m.gain)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-gray-700">—</span>
                      )}
                    </Td>
                    <Td data-label="Why" className="text-xs sm:min-w-[16rem]">
                      <div>
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
                          <div className="mt-0.5 max-w-[24rem] text-gray-500">
                            <SrcLink e={m.evidence.claims.evidence[0]} />{" "}
                            {m.evidence.claims.evidence[0].rationale}
                          </div>
                        )}
                      </div>
                    </Td>
                    <Td data-label="" className="text-right">
                      {/* Both halves present is the only case with anything to
                          compare source by source. */}
                      {m.in && m.out && <DetailsButton a={m.in} b={m.out} slot={m.slot} />}
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
          right={streams.length > 0 ? (
            <button
              onClick={() => setAllStreams((v) => !v)}
              className="rounded-md border border-gray-800 px-2 py-1 text-xs text-gray-400 hover:border-gray-700 hover:text-gray-200"
            >
              {allStreams ? "weak spots only" : `show all ${streams.length}`}
            </button>
          ) : undefined}
        >
          Your set starter out-projects the best available at every streamable position
          {streams.length > 0 ? ` (${streams.map(([pos]) => pos).join(", ")})` : ""}.
        </QuietLine>
      ) : (
        <Card
          title="Streaming"
          subtitle={
            allStreams
              ? "Best available at the streamable positions in this league, by consensus rank, with what the sites say."
              : "Positions where the best available projects above your set starter. The rest are folded."
          }
          right={
            <button
              onClick={() => setAllStreams((v) => !v)}
              className="rounded-md border border-gray-800 px-2 py-1 text-xs text-gray-400 hover:border-gray-700 hover:text-gray-200"
            >
              {allStreams ? "weak spots only" : `show all ${streams.length}`}
            </button>
          }
        >
          <div className="ff-stack-wrap overflow-x-auto">
            <table className="ff-stack w-full">
              <thead>
                <tr>
                  <Th>Pos</Th>
                  <Th>Player</Th>
                  <Th>Rank</Th>
                  <Th className="text-right">Proj</Th>
                  <Th>Matchup</Th>
                  <Th>Sites say</Th>
                  <Th>{""}</Th>
                </tr>
              </thead>
              <tbody>
                {openStreams.flatMap(([pos, rows]) =>
                  rows.length === 0
                    ? [
                        <tr key={pos} className="border-t border-gray-800/60">
                          <Td data-label="Pos" className="text-xs font-medium text-gray-400">{pos}</Td>
                          <Td data-label="" className="text-xs text-gray-600" colSpan={6}>nobody ranked available</Td>
                        </tr>,
                      ]
                    : rows.map((s, i) => (
                        <tr key={`${pos}-${s.player_id}`} className={`align-top ${i === 0 ? "border-t border-gray-800/60" : "border-t border-gray-800/30"}`}>
                          <Td data-label="Pos" className="whitespace-nowrap text-xs font-medium text-gray-400">
                            {i === 0 ? (
                              <div>
                                {pos}
                                {starterProj(pos) > 0 && <div className="font-normal text-gray-600">set starter {starterProj(pos).toFixed(1)}</div>}
                              </div>
                            ) : (
                              // Stacked on a phone the label needs a value; on a desktop the group header carries it.
                              <span className="sm:hidden">{pos}</span>
                            )}
                          </Td>
                          <Td data-label="" className="ff-row-head whitespace-nowrap">
                            <button onClick={() => onPlayer(s.player_id)} className="text-left text-gray-100 hover:text-indigo-300 hover:underline">
                              {s.name}
                            </button>
                            <span className="ml-1.5 text-xs text-gray-500">
                              {pos}
                              {s.team ? ` · ${s.team}` : ""}
                            </span>
                            {s.note && <NoteLine note={s.note} className="whitespace-normal" />}
                          </Td>
                          <Td data-label="Rank" className="whitespace-nowrap text-xs tabular-nums text-gray-300">
                            {s.rank ? `${pos}${s.rank.median}` : "—"}
                          </Td>
                          <Td data-label="Proj" className="whitespace-nowrap text-right tabular-nums text-gray-100">
                            {s.proj.rotowire != null ? s.proj.rotowire.toFixed(1) : "—"}
                          </Td>
                          <Td data-label="Matchup" className="whitespace-nowrap text-xs tabular-nums">
                            <MatchupCell matchup={s.matchup} position={pos} />
                          </Td>
                          <Td data-label="Sites say" className="text-xs sm:min-w-[13rem]">
                            {s.claims ? (
                              <div>
                                <span className="inline-flex flex-wrap gap-1">
                                  {Object.entries(s.claims.by_action)
                                    .sort((x, y) => y[1] - x[1])
                                    .slice(0, 2)
                                    .map(([a, n]) => (
                                      <Badge key={a} tone={ACTION_TONE[a] ?? "neutral"}>
                                        {a}
                                        {n > 1 ? ` ×${n}` : ""}
                                      </Badge>
                                    ))}
                                </span>
                                {s.claims.evidence[0] && <div className="mt-0.5 max-w-[24rem] text-[11px] text-gray-500">{s.claims.evidence[0].rationale}</div>}
                              </div>
                            ) : (
                              <span className="text-gray-700">quiet</span>
                            )}
                          </Td>
                          <Td data-label="" className="text-right">
                            {/* Compared against the starter he would actually
                                replace — the weakest one at the position. */}
                            {(() => {
                              const cur = setStarter(pos);
                              return cur ? <DetailsButton a={{ ...s, position: pos }} b={cur} slot={pos} /> : null;
                            })()}
                          </Td>
                        </tr>
                      ))
                )}
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
        subtitle={
          `The lineup you have set for week ${data.week}, slot by slot — anything to change is flagged in Set and listed above. Proj is Rotowire under this league's scoring, with ESPN and the Fantasy Footballers beside it.` +
          (data.usage_week != null
            ? ` Matchup is the opponent and the Vegas implied team total; usage is snap and target share for week ${data.usage_week}` +
              (data.usage_prev_week != null ? ` (change from week ${data.usage_prev_week})` : "") +
              "."
            : "")
        }
      >
        <Table rows={data.starters} slotCol />
        {data.empty_slots.length > 0 && (
          <p className="mt-2 text-xs text-amber-300">
            Nothing set at {data.empty_slots.join(", ")} — an empty slot scores zero.
          </p>
        )}
      </Card>
      <Card title="Bench" subtitle="Everyone rostered and not in the lineup, highest projection first.">
        <Table rows={data.bench} slotCol={false} />
      </Card>
      {/* Two benches with two different rules, and a league can have either,
          both or neither. Each shows only where the league has the slots. */}
      {data.reserve_slots > 0 && (
        <Card
          title="IR"
          subtitle={data.reserve_note}
          right={
            <span className="whitespace-nowrap text-xs tabular-nums text-gray-400">
              {(data.reserve ?? []).length} of {data.reserve_slots}
            </span>
          }
        >
          {(data.reserve ?? []).length > 0 ? (
            <Table rows={data.reserve ?? []} slotCol={false} />
          ) : (
            <p className="text-xs text-gray-600">Nobody on IR.</p>
          )}
        </Card>
      )}
      {data.taxi_slots > 0 && (
        <Card
          title="Taxi squad"
          subtitle={data.taxi_note}
          right={
            <span className="whitespace-nowrap text-xs tabular-nums text-gray-400">
              {(data.taxi ?? []).length} of {data.taxi_slots}
            </span>
          }
        >
          {(data.taxi ?? []).length > 0 ? (
            <Table rows={data.taxi ?? []} slotCol={false} />
          ) : (
            <p className="text-xs text-gray-600">Taxi squad is empty.</p>
          )}
        </Card>
      )}

      {compare && (
        <SwapDetails a={compare.a} b={compare.b} slot={compare.slot} onPlayer={onPlayer} onClose={() => setCompare(null)} />
      )}
      <p className="text-[11px] text-gray-600">{data.note}</p>
      <p className="text-[11px] text-gray-600">{data.context_note}</p>
    </div>
  );
}
