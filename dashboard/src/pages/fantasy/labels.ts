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
