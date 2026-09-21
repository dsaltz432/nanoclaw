import { Badge } from "./viz";
import { ago, srcShort } from "./labels";

/**
 * Context beside a player that Lineup, Moves and the dossier all show: the
 * newest wire note on him, a role-change flag from snap share, and the
 * usage / matchup strips. One file so the three tabs cannot drift.
 *
 * Third-party strings (headline) arrive defanged and are rendered as text.
 */

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
  role_change: "up" | "down" | null;
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
        className="text-gray-500 underline decoration-gray-700 underline-offset-2 hover:text-indigo-300 hover:decoration-indigo-400"
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
      {when && <span className="text-gray-600"> {when}</span>}
      {note.flagged && (
        <>
          {" "}
          <Badge tone="warning">reads as instruction</Badge>
        </>
      )}
    </div>
  );
}

/** Snap share moved by the threshold or more, week over week. */
export function RoleBadge({ change }: { change: "up" | "down" | null | undefined }) {
  if (!change) return null;
  return change === "up" ? <Badge tone="good">role change ↑</Badge> : <Badge tone="warning">role change ↓</Badge>;
}

const signed = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

/** "(+20)" in green, "(-8)" in red. */
export function Delta({ d }: { d: number | null | undefined }) {
  if (d == null) return null;
  return <span className={d >= 0 ? "text-green-400" : "text-red-400"}> ({signed(d)})</span>;
}

/** Raw counts for a title attribute: "65 snaps · 6 targets · 23 carries (week 1)". */
export function usageTitle(u: NonNullable<Usage>): string {
  const parts: string[] = [];
  if (u.snaps != null) parts.push(`${u.snaps} snaps`);
  if (u.targets != null) parts.push(`${u.targets} targets`);
  if (u.carries != null) parts.push(`${u.carries} carries`);
  if (!u.played) parts.push("did not play");
  return `${parts.join(" · ")} (week ${u.week})`;
}

/** "snap 58% (+20) · tgt 21% (+3)" plus the role-change badge. QBs show snap only. */
export function UsageCell({ usage, position }: { usage: Usage; position: string | null }) {
  if (!usage) return <span className="text-gray-700">—</span>;
  const qb = position === "QB";
  return (
    <span className="whitespace-nowrap text-xs tabular-nums text-gray-300" title={usageTitle(usage)}>
      {usage.snap_pct != null ? (
        <>
          <span className="text-gray-500">snap</span> {usage.snap_pct}%
          <Delta d={usage.snap_delta} />
        </>
      ) : (
        <span className="text-gray-700">no snaps</span>
      )}
      {!qb && usage.target_share != null && (
        <>
          <span className="text-gray-600"> · </span>
          <span className="text-gray-500">tgt</span> {usage.target_share}%
          <Delta d={usage.target_delta} />
        </>
      )}
      {usage.role_change && (
        <>
          {" "}
          <RoleBadge change={usage.role_change} />
        </>
      )}
    </span>
  );
}

/** "vs DET · 29.5" / "@ DET · 29.5" / BYE. A DEF shows what it faces (the opponent's implied total). */
export function MatchupCell({ matchup, position }: { matchup: Matchup; position: string | null }) {
  if (!matchup) return <span className="text-gray-700">—</span>;
  if (matchup.bye) return <Badge tone="warning">BYE</Badge>;
  const def = position === "DEF";
  const pts = def ? matchup.opp_implied_total : matchup.implied_total;
  return (
    <span className="whitespace-nowrap text-xs tabular-nums text-gray-300" title={def ? "what the defense faces" : undefined}>
      {matchup.opponent ? `${matchup.home === false ? "@" : "vs"} ${matchup.opponent}` : "—"}
      {pts != null && <span className="text-gray-500"> · {pts.toFixed(1)}</span>}
    </span>
  );
}
