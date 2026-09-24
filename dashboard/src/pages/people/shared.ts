/**
 * Types, labels and formatters for the People page and its add/edit form, so
 * the two can never disagree about what a source is called or what "overdue"
 * looks like.
 */

export type Status = "ok" | "due_soon" | "overdue" | "muted";

export interface DayMark {
  date: string;
  sources: string[];
  qualifies: boolean;
}

export interface Identifier {
  kind: "phone_number" | "whatsapp_name";
  value: string;
}

export interface Person {
  id: number;
  name: string;
  threshold_days: number;
  notes: string | null;
  last_ts: string | null;
  last_source: string | null;
  last_duration_s: number | null;
  days_since: number | null;
  muted_until: string | null;
  status: Status;
  rules: Record<string, number | null>;
  identifiers: Identifier[];
  /** Everything stored for this person — what removing them deletes. */
  interaction_count: number;
  /** What the page shows: calls under a minute that don't count are left off. */
  shown_count: number;
  days: DayMark[];
}

export interface Interaction {
  id: number;
  ts: string;
  source: string;
  direction: string;
  duration_s: number | null;
  note: string | null;
  origin: string;
  qualifies: boolean;
}

export interface PeopleResponse {
  people: Person[];
  strip_days: number;
  strip_start: string;
  today: string;
}

export const SOURCE_LABELS: Record<string, string> = {
  phone: "call",
  whatsapp: "WhatsApp call",
  in_person: "in person",
  manual: "manual note",
};

export type Tone = "green" | "yellow" | "red" | "none";

/**
 * How a person's row (and chip) is coloured:
 *   green  — within the threshold (ok, or due soon)
 *   yellow — overdue by up to 2 weeks
 *   red    — overdue by more than 2 weeks, or never in touch at all
 *   none   — muted
 * The chip keeps its word label, so colour is never the only signal.
 */
export const RED_AFTER_DAYS_OVERDUE = 14;

export function toneOf(p: Pick<Person, "status" | "days_since" | "threshold_days">): Tone {
  if (p.status === "muted") return "none";
  if (p.status === "ok" || p.status === "due_soon") return "green";
  if (p.days_since === null) return "red";
  return p.days_since - p.threshold_days > RED_AFTER_DAYS_OVERDUE ? "red" : "yellow";
}

export const TONE_STYLE: Record<Tone, { row: string; chip: string; dot: string; bar: string }> = {
  green: {
    row: "bg-green-500/[0.06] hover:bg-green-500/10",
    chip: "bg-green-500/10 text-green-400",
    dot: "bg-green-400",
    bar: "bg-green-500/60",
  },
  yellow: {
    row: "bg-yellow-500/[0.07] hover:bg-yellow-500/[0.12]",
    chip: "bg-yellow-500/10 text-yellow-400",
    dot: "bg-yellow-400",
    bar: "bg-yellow-500/70",
  },
  red: {
    row: "bg-red-500/[0.08] hover:bg-red-500/[0.13]",
    chip: "bg-red-500/10 text-red-400",
    dot: "bg-red-400",
    bar: "bg-red-500/70",
  },
  none: {
    row: "hover:bg-gray-800/40",
    chip: "bg-gray-500/10 text-gray-400",
    dot: "bg-gray-400",
    bar: "bg-transparent",
  },
};

export const STATUS_LABEL: Record<Status, string> = {
  ok: "ok",
  due_soon: "due soon",
  overdue: "overdue",
  muted: "muted",
};

/** Sources you can log by hand — every source there is. */
export const LOGGABLE_SOURCES = ["in_person", "phone", "whatsapp", "manual"];

/** Sources that can carry a minimum duration. The others are yes/no events. */
export const TIMED_SOURCES = ["phone", "whatsapp"];

export function fmtDay(ts: string): string {
  return new Date(ts.slice(0, 19)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: ts.slice(0, 4) === String(new Date().getFullYear()) ? undefined : "numeric",
  });
}

export function fmtDuration(seconds: number | null): string {
  if (!seconds) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

export function todayStr(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

/** "counts: in person · call ≥ 5 min" */
export function describeRules(rules: Record<string, number | null>): string {
  const entries = Object.entries(rules);
  if (entries.length === 0) return "nothing";
  return entries
    .map(([source, min]) =>
      min ? `${SOURCE_LABELS[source] ?? source} ≥ ${fmtDuration(min)}` : SOURCE_LABELS[source] ?? source
    )
    .join(" · ");
}
