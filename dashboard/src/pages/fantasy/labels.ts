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

/** Projection sources print lowercase beside a number: "roto 12 · espn 11 · ffb 13". */
export const PROJ_SHORT: Record<string, string> = {
  rotowire: "roto",
  espn: "espn",
  ffballers: "ffb",
};

export const srcShort = (s: string): string => SOURCE_SHORT[s] ?? s;
export const srcLabel = (s: string): string => SOURCE_LABEL[s] ?? s;
export const projShort = (s: string): string => PROJ_SHORT[s] ?? s;

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
