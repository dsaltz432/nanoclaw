import { Badge } from "./viz";
import { ago } from "./labels";

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

/** Topic -> badge tone, first match wins in this order. */
const TOPIC_TONE: [string, "critical" | "warning" | "info" | "good"][] = [
  ["out", "critical"],
  ["injury", "warning"],
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
