import { useContext, useState, type SyntheticEvent } from "react";
import { Badge, HoverInfo, LeagueContext, NewsPeek } from "./viz";
import { ACTION_TONE, ago, claimLean, claimMix, fmtDate, signed, srcShort } from "./labels";

/**
 * Player facts every tab renders: his name (which opens the dossier), the
 * newest wire note, what the sites say, his consensus rank, and the usage /
 * matchup strips. One file so the tabs cannot drift into seven ways of
 * printing the same fact.
 *
 * Third-party strings (headline, rationale) arrive defanged and are rendered
 * as text.
 */

/**
 * Warms the server's cache for a player's dossier when the pointer rests on
 * his name, so the click usually opens it at once instead of waiting ~0.5s
 * for Python. The dwell keeps a pointer sweeping down a table from firing a
 * request per row; each player is asked for at most once per page.
 */
const DOSSIER_DWELL_MS = 150;
const dossierWarmed = new Set<string>();
let dossierTimer: number | undefined;
function warmDossier(id: string, league: string) {
  window.clearTimeout(dossierTimer);
  const key = `${league}|${id}`;
  if (dossierWarmed.has(key)) return;
  dossierTimer = window.setTimeout(() => {
    dossierWarmed.add(key);
    // The same URL PlayerDossier fetches, so the click lands on this cache entry.
    fetch(`/api/fantasy/dossier?${new URLSearchParams({ league, player: id })}`).catch(() => dossierWarmed.delete(key));
  }, DOSSIER_DWELL_MS);
}

/**
 * A player's name as a button that opens his dossier, then "POS · TEAM", his
 * Sleeper injury designation and the news badge. Plain text where no dossier handler is
 * wired (a read-only panel).
 */
export function PlayerName({
  id,
  name,
  pos,
  team,
  injury,
  onPlayer,
  news = true,
}: {
  id: string;
  name: string | null;
  pos?: string | null;
  team?: string | null;
  injury?: string | null;
  onPlayer?: (id: string) => void;
  /** The news badge; off where the row IS the news (Reading) or places it itself (Trades). */
  news?: boolean;
}) {
  const league = useContext(LeagueContext);
  const meta = [pos, team].filter(Boolean).join(" · ");
  const label = name ?? id;
  return (
    <>
      {onPlayer ? (
        <button
          type="button"
          onClick={(e) => {
            // Rows that expand on click must not also toggle.
            e.stopPropagation();
            onPlayer(id);
          }}
          onMouseEnter={() => warmDossier(id, league)}
          onMouseLeave={() => window.clearTimeout(dossierTimer)}
          onFocus={() => warmDossier(id, league)}
          // ff-inline: a name sits in prose and 11px meta lines, where the
          // touch rule's 36px min-height would make the whole line tall.
          className="ff-inline text-left text-gray-100 hover:text-indigo-300 hover:underline"
        >
          {label}
        </button>
      ) : (
        <span className="text-gray-100">{label}</span>
      )}
      {meta && <span className="ml-1.5 whitespace-nowrap text-xs text-gray-500">{meta}</span>}
      {injury && (
        <>
          {" "}
          <Badge tone="warning">{injury}</Badge>
        </>
      )}
      {news && <NewsPeek id={id} name={label} />}
    </>
  );
}

/**
 * What the sites say about him, at a glance: the lead call and, where the
 * sites genuinely split, the opposing one ("start ×5 / sit ×2"). The whole
 * mix is in the tooltip. `nSources` appends "N sites".
 */
export function ClaimsSummary({
  byAction,
  nSources,
}: {
  byAction: Record<string, number> | null | undefined;
  nSources?: number | null;
}) {
  const lean = byAction ? claimLean(byAction) : null;
  if (!byAction || !lean) return <span className="text-xs text-gray-700">quiet</span>;
  const chip = ([a, n]: [string, number]) => (
    <Badge tone={ACTION_TONE[a] ?? "neutral"}>
      {a}
      {n > 1 ? ` ×${n}` : ""}
    </Badge>
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-1" title={`all calls: ${claimMix(byAction)}`}>
      {chip(lean.lead)}
      {lean.counter && (
        <>
          <span className="text-gray-700">/</span>
          {chip(lean.counter)}
        </>
      )}
      {nSources != null && nSources > 0 && (
        <span className="text-[11px] text-gray-600">
          {nSources} site{nSources === 1 ? "" : "s"}
        </span>
      )}
    </span>
  );
}

/**
 * One quoted claim: the linked source prefix, then the rationale, clamped to
 * two lines unless `clamp` is off. A tap on the rationale opens the rest —
 * the tooltip that shows it on a desktop does not exist under a thumb. The
 * source link stays its own target (an anchor cannot sit inside a button),
 * and the rationale is an inline span rather than a <button>, whose
 * inline-block box would sit outside the line clamp.
 */
export function ClaimQuote({ e, clamp = true }: { e: Claim; clamp?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const clamped = clamp && !expanded;
  const toggle = (ev: SyntheticEvent) => {
    // Rows that expand on click must not also toggle.
    ev.stopPropagation();
    setExpanded((v) => !v);
  };
  return (
    <div className={`text-xs text-gray-500 ${clamped ? "line-clamp-2" : ""}`} title={clamped ? e.rationale : undefined}>
      <SrcLink e={e} />{" "}
      {clamp ? (
        <span
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={toggle}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              toggle(ev);
            }
          }}
          className="ff-inline cursor-pointer hover:text-gray-400"
        >
          {e.rationale}
        </span>
      ) : (
        e.rationale
      )}
    </div>
  );
}

/**
 * Consensus rank as "WR11". The best–worst spread is in the tooltip, and the
 * move since the previous snapshot is shown only when it is at least a whole
 * place — a median wobbling by half a rank is noise, not news.
 */
export function RankText({
  pos,
  median,
  best,
  worst,
  delta,
}: {
  pos?: string | null;
  median: number | null | undefined;
  best?: number | null;
  worst?: number | null;
  delta?: number | null;
}) {
  if (median == null) return <span className="text-gray-700">—</span>;
  const d = delta != null && Math.abs(delta) >= 1 ? Math.round(delta) : null;
  const spread = best != null && worst != null ? `sites range ${pos ?? ""}${best}–${pos ?? ""}${worst}` : undefined;
  return (
    <span className="whitespace-nowrap tabular-nums text-gray-300" title={spread}>
      {pos ?? ""}
      {Number(median.toPrecision(6))}
      {d != null && (
        <span className={d > 0 ? "text-green-400" : "text-red-400"}>
          {" "}
          {d > 0 ? "▲" : "▼"}
          {Math.abs(d)}
        </span>
      )}
    </span>
  );
}

export type Note = {
  published_at: string;
  headline: string;
  topics: string[];
  url: string | null;
  flagged: boolean;
} | null;

export type Usage = {
  week: number;
  prev_week: number | null;
  snap_pct: number | null;
  snap_delta: number | null;
  snaps: number | null;
  target_share: number | null;
  target_delta: number | null;
  targets: number | null;
  carries: number | null;
  touches: number | null;
  played: boolean;
} | null;

export type Matchup = {
  opponent: string | null;
  bye: boolean;
  home: boolean | null;
  implied_total: number | null;
  opp_implied_total: number | null;
  total: number | null;
  spread: number | null;
  gameday?: string;
  gametime?: string;
} | null;

/** One extracted claim, as every tab renders it. */
export type Claim = {
  action?: string;
  horizon?: string;
  rationale: string;
  source: string;
  title?: string | null;
  url?: string | null;
  /** Week-horizon claim published before this player's last kickoff. */
  stale?: boolean;
};

/**
 * The "CBS:" that prefixes a quoted rationale, linked to the article it came
 * from. The claim already carries the URL and headline, so the prefix that
 * was already there can carry the link — no extra row, no extra pixel, and
 * the analysis stops being a dead-end attribution.
 */
export function SrcLink({ e }: { e: Claim }) {
  const label = srcShort(e.source);
  // A quote from before the player's last kickoff is about a game that has
  // been played. It is still worth reading, so it is dated rather than
  // dropped — every tab that quotes a claim goes through here, so saying it
  // once says it everywhere.
  const stale = e.stale ? (
    <span className="italic text-gray-600" title="published before this player's last game">
      {" "}
      (pre-game)
    </span>
  ) : null;
  if (!e.url)
    return (
      <span className="text-gray-600">
        {label}
        {stale}:
      </span>
    );
  return (
    <>
      <a
        href={e.url}
        target="_blank"
        rel="noreferrer"
        title={e.title || `Open this ${label} article`}
        className="ff-hit text-gray-500 underline decoration-gray-700 underline-offset-2 hover:text-indigo-300 hover:decoration-indigo-400"
      >
        {label}
        <span aria-hidden="true"> ↗</span>
      </a>
      {stale}:
    </>
  );
}

/**
 * Topic -> badge tone, first match wins in this order.
 *
 * `out` and `injury` are deliberately NOT here. A badge claiming a player is
 * out is a claim about his availability, and Sleeper publishes that as a
 * field — rendered as his own badge beside his name. Deriving a second copy
 * by pattern-matching the headline duplicated an authoritative fact with a
 * guessed one, and guessed it wrong whenever the injury in the sentence
 * belonged to somebody else: "Bates should take on an elevated role ... after
 * Chig Okonkwo was ruled out due to a hamstring injury" is filed under Bates,
 * who is fine, and it put a red OUT next to him on the start/sit table.
 *
 * Checked over five days of wire notes: of 37 headlines whose text reads as
 * `out`, Sleeper's designation agreed with the correct answer 37 times, and
 * the one case the text rule got wrong Sleeper got right. It cannot replace
 * the topics wholesale — 36% of genuine injury notes are about players with
 * no designation, because they are playing ("Kittle (Achilles) practiced
 * fully and does not have an injury designation") — so `out` and `injury`
 * still classify and rank notes. They just do not get to assert a status.
 */
const TOPIC_TONE: [string, "critical" | "warning" | "info" | "good"][] = [
  ["role", "info"],
  ["return", "good"],
];

export function noteTopic(topics: string[]): { topic: string; tone: "critical" | "warning" | "info" | "good" } | null {
  for (const [t, tone] of TOPIC_TONE) {
    const hit = topics.find((x) => x.includes(t));
    if (hit) return { topic: t, tone };
  }
  return null;
}

/** The newest wire note on a player: topic badge, headline (linked when ESPN has a page), age. */
export function NoteLine({ note, className = "mt-0.5 max-w-[26rem] whitespace-normal text-[11px] font-normal text-gray-400" }: { note: Note; className?: string }) {
  if (!note) return null;
  const t = noteTopic(note.topics);
  const when = ago(note.published_at);
  return (
    <div className={className}>
      {t && <Badge tone={t.tone}>{t.topic}</Badge>}{" "}
      {note.url ? (
        <a href={note.url} target="_blank" rel="noreferrer" className="hover:text-indigo-300 hover:underline">
          {note.headline}
        </a>
      ) : (
        <span>{note.headline}</span>
      )}
      {when && (
        <>
          {" "}
          <span className="whitespace-nowrap text-gray-600">{when}</span>
        </>
      )}
      {note.flagged && (
        <>
          {" "}
          <Badge tone="warning">reads as an instruction</Badge>
        </>
      )}
    </div>
  );
}

/**
 * Counts and week-over-week moves, one per line, for the usage HoverInfo:
 * "Week 2 (change vs week 1)", "65 snaps, 88% (+13)", "6 targets, 19% (−11)",
 * "23 carries". The moves live here rather than in the cell: coloured on
 * every row they stopped meaning anything.
 */
export function usageTitle(u: NonNullable<Usage>, position?: string | null): string {
  const move = (d: number | null) => (d == null ? "" : ` (${signed(d, 0)})`);
  const parts: string[] = [];
  if (u.snaps != null || u.snap_pct != null)
    parts.push(`${u.snaps ?? "?"} snaps${u.snap_pct != null ? `, ${u.snap_pct}%${move(u.snap_delta)}` : ""}`);
  if (u.targets != null || u.target_share != null)
    parts.push(`${u.targets ?? "?"} target${u.targets === 1 ? "" : "s"}${u.target_share != null ? `, ${u.target_share}%${move(u.target_delta)}` : ""}`);
  // Carries only when he had some, except a back, for whom zero is news.
  if (u.carries != null && (u.carries > 0 || position === "RB")) parts.push(`${u.carries} carr${u.carries === 1 ? "y" : "ies"}`);
  if (!u.played) parts.push("did not play");
  return [`Week ${u.week}${u.prev_week ? ` (change vs week ${u.prev_week})` : ""}`, ...parts].join("\n");
}

/** Snap and target share say little about a QB (he plays every snap), a kicker or a defense. */
export function showsUsage(position: string | null | undefined): boolean {
  return !["QB", "K", "DEF"].includes(position ?? "");
}

/**
 * "vs ARI · 28 pts", and the betting line behind it for the HoverInfo:
 *
 *   SF vs ARI · Sep 27, 16:05 ET
 *   O/U 48.5 · SF −7.5 (favored)
 *   Implied points: SF 28.0 · ARI 20.5
 *
 * The Vegas number on the row is labelled and whole: a bare "28.0" beside the
 * opponent read as nothing in particular. A defense shows what it faces, the
 * opponent's total. `team` is the player's team, for naming the sides.
 */
export function matchupText(matchup: NonNullable<Matchup>, position: string | null | undefined, team?: string | null, sep = " · ") {
  const def = position === "DEF";
  const pts = def ? matchup.opp_implied_total : matchup.implied_total;
  const opp = matchup.opponent ? `${matchup.home === false ? "@" : "vs"} ${matchup.opponent}` : "";
  const text = [opp, pts != null ? `${Math.round(pts)} pts` : ""].filter(Boolean).join(sep);
  const us = team ?? (def ? "the defense's team" : "his team");
  const them = matchup.opponent ?? "opponent";
  const lines: string[] = [];
  const when = matchup.gameday ? `${fmtDate(matchup.gameday)}${matchup.gametime ? `, ${matchup.gametime} ET` : ""}` : "";
  lines.push([`${team ? `${team} ` : ""}${opp}`.trim(), when].filter(Boolean).join(" · "));
  if (matchup.total != null) {
    // `spread` is from this team's side, positive when it is favoured; the
    // betting convention prints the favourite with a minus.
    const sp = matchup.spread ?? 0;
    const line =
      sp === 0 ? "pick'em" : sp > 0 ? `${us} −${sp} (favored)` : `${us} +${-sp} (underdog)`;
    lines.push(`O/U ${matchup.total} · ${line}`);
  }
  if (matchup.implied_total != null && matchup.opp_implied_total != null)
    lines.push(`Implied points: ${us} ${matchup.implied_total.toFixed(1)} · ${them} ${matchup.opp_implied_total.toFixed(1)}`);
  if (def && pts != null) lines.push(`${Math.round(pts)} pts is what the defense faces: ${them}'s implied total`);
  const title = lines.filter(Boolean).join("\n") || undefined;
  return { text, title };
}

/**
 * "snap 78% tgt 12%", in plain grey, with the week-over-week moves and raw
 * counts on hover. Nothing for QB, K or DEF (showsUsage), and nothing without
 * usage; the caller decides whether the empty cell says anything.
 */
export function UsageCell({ usage, position }: { usage: Usage; position: string | null }) {
  if (!usage || !showsUsage(position)) return null;
  return (
    <span className="text-xs tabular-nums text-gray-400">
      <HoverInfo info={usageTitle(usage, position)} className="whitespace-nowrap">
        {usage.snap_pct != null ? (
          <>
            <span className="text-gray-500">snap</span> {usage.snap_pct}%
          </>
        ) : (
          <span className="text-gray-700">no snaps</span>
        )}
        {usage.target_share != null && (
          <>
            <span className="ml-1.5 text-gray-500">tgt</span> {usage.target_share}%
          </>
        )}
      </HoverInfo>
    </span>
  );
}

/** "vs DET · 29 pts" / "@ DET · 29 pts" / BYE. A DEF shows what it faces (the opponent's implied total). */
export function MatchupCell({ matchup, position, team }: { matchup: Matchup; position: string | null; team?: string | null }) {
  if (!matchup) return <span className="text-gray-700">—</span>;
  if (matchup.bye) return <Badge tone="warning">BYE</Badge>;
  const { text, title } = matchupText(matchup, position, team);
  return (
    <HoverInfo info={title} className="whitespace-nowrap text-xs tabular-nums text-gray-300">
      {text}
    </HoverInfo>
  );
}
