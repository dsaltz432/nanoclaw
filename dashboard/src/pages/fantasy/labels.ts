/**
 * Labels shared by every Fantasy panel.
 *
 * One map per vocabulary, so a site's abbreviation, a horizon's wording or a
 * claim action's colour cannot drift between tabs. Seven files used to carry
 * their own copy of the source map and they had already diverged ("FFB" on
 * Lineup, "ffb" on Rankings and the dossier).
 */

/** Rank and claim sources, abbreviated for a table cell. */
export const SOURCE_SHORT: Record<string, string> = {
  fantasypros: "FP",
  cbs: "CBS",
  footballguys: "FBG",
  ffballers: "FFB",
  draftsharks: "DS",
  fantasylife: "FL",
  rotowire: "roto",
  espn: "espn",
};

/** Sources spelled out, for a feed header or a dossier. */
export const SOURCE_LABEL: Record<string, string> = {
  fantasypros: "FantasyPros",
  cbs: "CBS",
  footballguys: "Footballguys",
  ffballers: "Fantasy Footballers",
  draftsharks: "DraftSharks",
  fantasylife: "FantasyLife",
  rotowire: "Rotowire wire",
};

/**
 * Projection sources spelled out, for the swap-details comparison. Distinct
 * from SOURCE_LABEL, whose "Rotowire wire" names the news feed and reads
 * wrong above a column of projected points.
 */
export const PROJ_LABEL: Record<string, string> = {
  rotowire: "Rotowire",
  espn: "ESPN",
  ffballers: "Fantasy Footballers",
};

/** Projection sources print lowercase beside a number: "roto 12 · espn 11 · ffb 13". */
export const PROJ_SHORT: Record<string, string> = {
  rotowire: "roto",
  espn: "espn",
  ffballers: "ffb",
};

export const srcShort = (s: string): string => SOURCE_SHORT[s] ?? s;
export const srcLabel = (s: string): string => SOURCE_LABEL[s] ?? s;
export const projShort = (s: string): string => PROJ_SHORT[s] ?? s;
export const projLabel = (s: string): string => PROJ_LABEL[s] ?? SOURCE_LABEL[s] ?? s;

/** Ranking scopes (the consensus lists) and claim horizons, as prose. */
export const SCOPE_LABEL = {
  weekly: "this week",
  ros: "rest of season",
  dynasty: "dynasty",
} as const;
export const HORIZON_LABEL = {
  week: "this week",
  ros: "rest of season",
  dynasty: "dynasty",
} as const;
/** Horizon for a chip where the prose form would not fit. */
export const HORIZON_SHORT = {
  week: "wk",
  ros: "ROS",
  dynasty: "dyn",
} as const;

export const horizonLabel = (h: string): string => (HORIZON_LABEL as Record<string, string>)[h] ?? h;
export const horizonShort = (h: string): string => (HORIZON_SHORT as Record<string, string>)[h] ?? h;

/** Claim action -> badge tone. Status colour never carries meaning alone; the action word is always printed beside it. */
export const ACTION_TONE: Record<string, "good" | "critical" | "warning" | "info" | "neutral"> = {
  add: "good",
  buy: "good",
  start: "good",
  hold: "info",
  stash: "info",
  watch: "neutral",
  sit: "warning",
  drop: "critical",
  sell: "warning",
};

/**
 * Which call contradicts which. `hold` is opposed by both selling and
 * cutting, since the prompt defines it as "explicitly keep, do not sell or
 * drop".
 */
const OPPOSITE: Record<string, string[]> = {
  start: ["sit"],
  sit: ["start"],
  buy: ["sell"],
  sell: ["buy"],
  add: ["drop"],
  drop: ["add"],
  hold: ["sell", "drop"],
  stash: ["drop"],
};

/** A minority smaller than this is one dissenting voice, not a split. */
const SPLIT_SHARE = 0.25;

/**
 * The one call a board row should lead with, and the opposing call when the
 * sites genuinely disagree.
 *
 * Printing all nine actions averaged four badges a row and ran to seven,
 * where a third of them were a single claim and `watch` — 7% of all claim
 * volume — contributes nothing to the tally by design. The detailed mix is
 * what the Lineup, Moves and Trades tabs are each for; a ranked list needs
 * the lean and whether it is contested.
 */
export function claimLean(
  byAction: Record<string, number>
): { lead: [string, number]; counter: [string, number] | null } | null {
  const votes = Object.entries(byAction).filter(([a, n]) => a !== "watch" && n > 0);
  if (votes.length === 0) return null;
  const lead = votes.reduce((hi, x) => (x[1] > hi[1] ? x : hi));
  const opposed = (OPPOSITE[lead[0]] ?? [])
    .map((a) => [a, byAction[a] ?? 0] as [string, number])
    .filter(([, n]) => n > 0);
  const counter = opposed.length ? opposed.reduce((hi, x) => (x[1] > hi[1] ? x : hi)) : null;
  return {
    lead,
    counter: counter && counter[1] / (lead[1] + counter[1]) >= SPLIT_SHARE ? counter : null,
  };
}

/** "start ×9 · buy ×2 · hold ×2 · watch" — the full mix, for a tooltip. */
export const claimMix = (byAction: Record<string, number>): string =>
  Object.entries(byAction)
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `${a}${n > 1 ? ` ×${n}` : ""}`)
    .join(" · ");

/** Today's "since yesterday" diff: change kind -> badge tone and the word printed beside it. */
export const CHANGE_TONE: Record<string, "good" | "critical" | "warning" | "info" | "neutral"> = {
  needs_you: "critical",
  flag_new: "warning",
  flag_cleared: "good",
  rank_up: "good",
  rank_down: "warning",
  sell_new: "warning",
  buy_new: "info",
  talk_new: "info",
  talk_gone: "neutral",
};
export const CHANGE_LABEL: Record<string, string> = {
  needs_you: "needs you",
  flag_new: "flag",
  flag_cleared: "cleared",
  rank_up: "rank up",
  rank_down: "rank down",
  sell_new: "sell",
  buy_new: "buy",
  talk_new: "talk",
  talk_gone: "quiet",
};
export const changeLabel = (k: string): string => CHANGE_LABEL[k] ?? k.replace(/_/g, " ");

/** "4 min ago" for a UTC ISO timestamp; null when it does not parse. */
export function ago(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}
