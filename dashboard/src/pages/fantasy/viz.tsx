import {
  Children,
  ComponentPropsWithoutRef,
  ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { SectionProvider } from "./method";
import { fmtDate } from "./labels";

/**
 * Chart primitives for the Fantasy tab. Plain SVG — the dashboard has no chart
 * library and does not need one for these forms.
 *
 * Palette is the validated dark set, checked against this dashboard's own card
 * surface (#111827), not against a generic dark surface:
 *   node scripts/validate_palette.js "#3987e5,#d95926,#199e70" --mode dark --surface "#111827"
 *   → all six checks PASS
 *
 * Rules that the components enforce rather than leave to the caller:
 *   - one axis, never two
 *   - a series is coloured by identity, never by rank, so filtering never
 *     repaints the survivors
 *   - twelve managers is too many series to colour: the line chart takes ONE
 *     emphasised series and draws the rest as recessive context hairlines
 *   - status colour never carries meaning alone — every Badge has a label
 */

export const C = {
  surface: "#111827",
  grid: "#1f2937",
  axis: "#374151",
  ink: "#f3f4f6",
  ink2: "#9ca3af",
  muted: "#6b7280",
  s1: "#3987e5",
  s2: "#d95926",
  s3: "#199e70",
  good: "#0ca30c",
  warning: "#fab219",
  critical: "#d03b3b",
  context: "#374151",
};

/** True on a phone-sized screen. Re-evaluated on resize/rotate. */
export function useIsNarrow() {
  const [narrow, setNarrow] = useState(
    typeof window !== "undefined" ? window.matchMedia("(max-width: 639px)").matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const on = () => setNarrow(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return narrow;
}

// Literal class names (Tailwind only emits classes it can find in the source).
const GRID_COLS = ["", "grid-cols-1", "grid-cols-[minmax(0,1fr)_auto]", "grid-cols-[minmax(0,1fr)_auto_auto]"];
const SM_GRID_COLS = ["", "sm:grid-cols-1", "sm:grid-cols-[minmax(0,1fr)_auto]", "sm:grid-cols-[minmax(0,1fr)_auto_auto]"];
const COL_SPAN = ["", "col-span-1", "col-span-2", "col-span-3"];

export function Card({
  title,
  subtitle,
  info,
  right,
  children,
  className = "",
  secondary = false,
  collapsible = false,
  defaultOpen = false,
  rightStacks = false,
}: {
  title?: string;
  /** Data about the card's contents ("17 players · market 40,544"): beside the title from sm up. */
  subtitle?: ReactNode;
  /**
   * What the card is and how it is chosen: shown on hover (a tap on a phone)
   * over the title, which gets a dotted underline. A sentence of explanation
   * under every title cost a line per card, and it is read once.
   */
  info?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  /**
   * Reference material rather than something you act on. Starts COLLAPSED on a
   * phone and open everywhere else. Each tab was six or seven screens tall
   * because it stacked a desktop dashboard vertically; folding the lookup
   * tables away puts the actionable cards back within a thumb's reach without
   * removing anything.
   */
  secondary?: boolean;
  /**
   * Reference material on every screen size: collapsed (unless `defaultOpen`)
   * behind the same show/hide link `secondary` uses on a phone. Unlike
   * `secondary`, the `right` slot stays visible while folded.
   */
  collapsible?: boolean;
  defaultOpen?: boolean;
  /**
   * The right slot holds wide controls (inputs, selects, segmented buttons):
   * on a phone it takes its own full-width row under the title and subtitle
   * instead of sharing the title row.
   */
  rightStacks?: boolean;
}) {
  const narrow = useIsNarrow();
  const [open, setOpen] = useState(collapsible && defaultOpen);
  const folds = collapsible || (secondary && narrow);
  const shown = !folds || open;
  const toggle = folds && (
    <button
      type="button"
      onClick={() => setOpen((v) => !v)}
      aria-expanded={open}
      className="ff-inline ff-hit shrink-0 text-left text-xs text-indigo-400 hover:text-indigo-300"
    >
      {open ? "Hide" : "Show"}
    </button>
  );
  // A phone-folded `secondary` card hides `right` while folded (its filters
  // act on a table you cannot see); a `collapsible` one keeps it beside the link.
  const showRight = !!right && (!folds || collapsible || open);
  const stacked = rightStacks && showRight;
  // Header columns: the title, then the right slot and the toggle where each
  // is present. On a phone a stacked right slot leaves the title row.
  const phoneCols = 1 + (showRight && !stacked ? 1 : 0) + (toggle ? 1 : 0);
  const deskCols = 1 + (showRight ? 1 : 0) + (toggle ? 1 : 0);
  return (
    <section className={`min-w-0 rounded-lg border border-gray-800 bg-gray-900 ${className}`}>
      {(title || right || folds) && (
        <header
          // A grid, so one DOM serves both layouts. On a phone the title and a
          // short right slot (a count, one link, show/hide) share the first
          // row and the subtitle runs full width beneath them; side by side
          // it would be squeezed to a column two words wide. From sm up it is
          // ONE row: title, the subtitle beside it, then the right slot.
          className={`grid ${GRID_COLS[phoneCols]} ${SM_GRID_COLS[deskCols]} items-baseline gap-x-3 border-b border-gray-800 px-3 py-2.5 sm:items-center sm:gap-x-4 sm:px-4`}
        >
          {/* `contents` on a phone, so the title and subtitle are grid items
              on rows 1 and 2; from sm up a wrapping flex line in column 1. */}
          <div className="contents sm:col-start-1 sm:row-start-1 sm:flex sm:min-w-0 sm:flex-wrap sm:items-baseline sm:gap-x-2.5">
            {title && (
              <h3 className="col-start-1 row-start-1 min-w-0 text-sm font-semibold text-gray-100">
                {info ? <HoverInfo info={info}>{title}</HoverInfo> : title}
              </h3>
            )}
            {subtitle && (
              <p
                className={`${COL_SPAN[phoneCols]} row-start-2 mt-0.5 min-w-0 text-[11px] leading-snug text-gray-500 sm:mt-0 sm:text-xs`}
              >
                {subtitle}
              </p>
            )}
          </div>
          {showRight && (
            <div
              className={`min-w-0 sm:col-start-2 sm:row-start-1 sm:mt-0 sm:justify-self-end ${
                stacked ? `${COL_SPAN[phoneCols]} row-start-3 mt-2 sm:col-span-1` : "col-start-2 row-start-1 justify-self-end"
              }`}
            >
              {right}
            </div>
          )}
          {toggle && (
            <div
              className={`row-start-1 justify-self-end ${phoneCols === 3 ? "col-start-3" : "col-start-2"} ${
                deskCols === 3 ? "sm:col-start-3" : "sm:col-start-2"
              }`}
            >
              {toggle}
            </div>
          )}
        </header>
      )}
      {/* Notes inside this card register under its title in the Methodology
          drawer, so the drawer can say WHICH panel each explanation is about
          without every call site having to name itself. */}
      {/* Kept MOUNTED when collapsed, only hidden. Unmounting would drop the
          <Note> registrations the Methodology page collects, and re-run any
          fetch the card owns every time it is opened. */}
      <div className={shown ? "p-3 sm:p-4" : "hidden"}>
        <SectionProvider name={title ?? "General"}>{children}</SectionProvider>
      </div>
    </section>
  );
}

/**
 * A card with nothing in it is still worth saying — "your lineup is already
 * optimal" is an answer — but it does not deserve a header, a subtitle and
 * two rows of padding to say it. One slim line, same border, same order in
 * the page, so the tab opens on the things that need you.
 */
export function QuietLine({
  title,
  info,
  children,
  right,
}: {
  title: string;
  /** As on Card: explanation on hover over the title. */
  info?: ReactNode;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    // On a phone the title and `right` share the first row, as on Card, and
    // the sentence runs full width under them; from sm up it is one line.
    <section
      className={`grid min-w-0 items-baseline gap-x-3 gap-y-1 rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 sm:flex sm:px-4 ${
        right ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1"
      }`}
    >
      <h3 className="col-start-1 row-start-1 shrink-0 text-sm font-semibold text-gray-300">
        {info ? <HoverInfo info={info}>{title}</HoverInfo> : title}
      </h3>
      <p className={`row-start-2 min-w-0 text-xs text-gray-500 ${right ? "col-span-2" : ""}`}>{children}</p>
      {right && <div className="col-start-2 row-start-1 shrink-0 justify-self-end sm:ml-auto">{right}</div>}
    </section>
  );
}

/**
 * The one loading state: a few pulsing bars in roughly the space the content
 * will take, so the card does not jump from one line to a screenful. The
 * label is for screen readers; the bars say "loading" to everyone else.
 */
export function Loading({ label = "Loading…", rows = 3 }: { label?: string; rows?: number }) {
  // The floor is for a card's worth of rows; a one-line placeholder stays one line.
  return (
    <div role="status" aria-live="polite" className={`space-y-2.5 py-1 ${rows >= 3 ? "min-h-[8rem]" : ""}`}>
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          aria-hidden="true"
          className="h-4 animate-pulse rounded bg-gray-800"
          style={{ width: `${92 - (i % 3) * 14}%` }}
        />
      ))}
    </div>
  );
}

/**
 * A run of short facts separated by "·": the second line of a compact phone
 * row ("RB · SEA · proj 12.4 · WR11"), or any inline list of the same shape.
 *
 * The dot is drawn by CSS, never written into the text: every child gets a
 * fixed-width "·" before it, and the row is pulled left by that width inside
 * a box that clips sideways. Whichever child starts a line — the first, or one
 * that wrapped — has its dot in the clipped margin, so a wrapped line never
 * starts or ends on a lone "·". That only works on elements: wrap EACH child
 * in a <span> (a bare string or number child gets no separator). Falsy
 * children are dropped, so a caller can write
 * `{age != null && <span>age {age}</span>}` without leaving a gap.
 */
export function MetaLine({ children, className = "" }: { children: ReactNode; className?: string }) {
  const parts = Children.toArray(children).filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <div className={`overflow-x-clip text-[11px] font-normal text-gray-500 ${className}`}>
      <div className="-ml-4 flex flex-wrap items-baseline [&>*]:before:inline-block [&>*]:before:w-4 [&>*]:before:text-center [&>*]:before:text-gray-600 [&>*]:before:content-['·']">
        {parts}
      </div>
    </div>
  );
}

/** The one error state: a padded red box, never bare red text. */
export function ErrorBox({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div role="alert" className={`rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-300 ${className}`}>
      {children}
    </div>
  );
}

/** Status badge — always icon/word + label, never colour alone. */
export function Badge({
  tone = "neutral",
  children,
  title,
  className = "",
}: {
  tone?: "neutral" | "good" | "warning" | "critical" | "info";
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  const map: Record<string, string> = {
    neutral: "bg-gray-800 text-gray-300 ring-gray-700",
    good: "bg-green-500/10 text-green-400 ring-green-500/30",
    warning: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
    critical: "bg-red-500/10 text-red-400 ring-red-500/30",
    info: "bg-indigo-500/10 text-indigo-300 ring-indigo-500/30",
  };
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${map[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** Horizontal bars, one series. Emphasised row gets the accent hue. */
export function HBars({
  rows,
  max,
  format = (v: number) => String(v),
  height = 18,
  labelWidth = 170,
}: {
  rows: { label: string; value: number; emphasis?: boolean; note?: string }[];
  max?: number;
  format?: (v: number) => string;
  height?: number;
  labelWidth?: number;
}) {
  const m = max ?? Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-[3px]">
      {rows.map((r, i) => (
        <div key={`${r.label}-${i}`} className="flex items-center gap-2" title={r.note}>
          <div
            className="shrink-0 truncate text-xs"
            style={{ width: labelWidth, color: r.emphasis ? C.ink : C.ink2 }}
          >
            {r.label}
          </div>
          <div className="relative min-w-0 flex-1" style={{ height }}>
            <svg width="100%" height={height} role="presentation">
              <rect x={0} y={height / 2 - 4} width="100%" height={8} rx={4} fill={C.grid} />
              <rect
                x={0}
                y={height / 2 - 4}
                width={`${Math.max(1, (r.value / m) * 100)}%`}
                height={8}
                rx={4}
                fill={r.emphasis ? C.s1 : C.context}
              />
            </svg>
          </div>
          <div
            className="w-16 shrink-0 text-right text-xs tabular-nums"
            style={{ color: r.emphasis ? C.ink : C.ink2 }}
          >
            {format(r.value)}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Multi-line chart with ONE emphasised series.
 *
 * Twelve managers cannot be told apart by twelve hues, and cycling a palette to
 * reach twelve is the classic way to make a chart that looks informative and
 * is not. The emphasised series is named in the caption and drawn in the accent
 * hue; every other series is a recessive hairline that provides the envelope.
 */
export function LineChart({
  series,
  xLabels,
  height: tall = 190,
  yMax,
  yFormat = (v: number) => String(v),
  emphasisLabel,
}: {
  series: { label: string; points: number[]; emphasis?: boolean }[];
  xLabels: (string | number)[];
  height?: number;
  yMax?: number;
  yFormat?: (v: number) => string;
  emphasisLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // The SVG scales to its box, so on a phone a 640-wide viewBox shrank the
  // 9-unit labels to ~5px. A narrower logical canvas keeps them ~10px on a
  // 342px card; the x ticks thin out to match.
  const narrow = useIsNarrow();
  const W = narrow ? 360 : 640;
  const height = narrow ? 200 : tall;
  const padL = 34;
  const padR = 12;
  const padT = 8;
  const padB = 20;
  const innerW = W - padL - padR;
  const innerH = height - padT - padB;
  const n = xLabels.length;
  const max = yMax ?? Math.max(1, ...series.flatMap((s) => s.points));
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * innerW);
  const y = (v: number) => padT + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);

  const emphasised = series.filter((s) => s.emphasis);
  const context = series.filter((s) => !s.emphasis);

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="w-full"
        style={{ maxHeight: height }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 3} textAnchor="end" fontSize={9} fill={C.muted}>
              {yFormat(t)}
            </text>
          </g>
        ))}
        {xLabels.map((l, i) =>
          i % Math.ceil(n / (narrow ? 6 : 8)) === 0 ? (
            <text key={i} x={x(i)} y={height - 6} textAnchor="middle" fontSize={9} fill={C.muted}>
              {l}
            </text>
          ) : null
        )}

        {context.map((s, si) => (
          <polyline
            key={`c${si}`}
            fill="none"
            stroke={C.context}
            strokeWidth={1}
            points={s.points.map((p, i) => `${x(i)},${y(p)}`).join(" ")}
          />
        ))}
        {emphasised.map((s, si) => (
          <polyline
            key={`e${si}`}
            fill="none"
            stroke={C.s1}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            points={s.points.map((p, i) => `${x(i)},${y(p)}`).join(" ")}
          />
        ))}

        {hover != null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + innerH} stroke={C.axis} strokeWidth={1} />
            {emphasised.map((s, si) => (
              <circle
                key={`h${si}`}
                cx={x(hover)}
                cy={y(s.points[hover] ?? 0)}
                r={4}
                fill={C.s1}
                stroke={C.surface}
                strokeWidth={2}
              />
            ))}
          </>
        )}

        {xLabels.map((_, i) => (
          <rect
            key={`hit${i}`}
            x={x(i) - innerW / (2 * Math.max(1, n - 1))}
            y={padT}
            width={innerW / Math.max(1, n - 1)}
            height={innerH}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
          />
        ))}
      </svg>
      <div className="mt-1 flex items-center justify-between text-[11px] text-gray-500">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded" style={{ background: C.s1 }} />
            {emphasisLabel ?? emphasised[0]?.label ?? "you"}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-px w-4" style={{ background: C.context }} />
            other managers
          </span>
        </span>
        {hover != null && (
          <span className="tabular-nums text-gray-400">
            wk {xLabels[hover]}
            {emphasised[0] ? ` · ${yFormat(emphasised[0].points[hover] ?? 0)}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Range marker: median → p75 → p90 for one price tier.
 * A range, not a bar from zero — the quantity is "where winning bids landed",
 * and a bar from zero would imply a total.
 */
export function RangeRow({
  median,
  p75,
  p90,
  max,
  width = 160,
}: {
  median: number;
  p75: number;
  p90: number;
  max: number;
  width?: number;
}) {
  // Inset by the dot radius at both ends, otherwise the p90 marker is sliced in
  // half against the cell edge and reads as an arrowhead.
  const R = 4;
  const span = width - R * 2;
  const sx = (v: number) => R + Math.max(0, Math.min(span, (v / Math.max(1, max)) * span));
  return (
    <svg width={width} height={14} role="presentation">
      <line x1={sx(median)} x2={sx(p90)} y1={7} y2={7} stroke={C.axis} strokeWidth={2} strokeLinecap="round" />
      <circle cx={sx(median)} cy={7} r={4} fill={C.s3} />
      <circle cx={sx(p75)} cy={7} r={4} fill={C.s1} stroke={C.surface} strokeWidth={2} />
      <circle cx={sx(p90)} cy={7} r={3} fill={C.muted} />
    </svg>
  );
}

/** Diverging balance bar — who the trade favours. Blue ↔ red, gray midpoint. */
export function Balance({ delta, scale }: { delta: number; scale: number }) {
  const W = 240;
  const half = W / 2;
  const w = Math.min(half, (Math.abs(delta) / Math.max(1, scale)) * half);
  const positive = delta >= 0;
  return (
    <svg width={W} height={16} role="presentation">
      <rect x={0} y={5} width={W} height={6} rx={3} fill={C.grid} />
      {w > 1 && (
        <rect
          x={positive ? half : half - w}
          y={4}
          width={w}
          height={8}
          rx={4}
          fill={positive ? C.s1 : C.critical}
        />
      )}
      <line x1={half} x2={half} y1={1} y2={15} stroke={C.axis} strokeWidth={2} />
    </svg>
  );
}

export { Note } from "./method";

type Align = "left" | "center" | "right";
const ALIGN_RE = /(^|\s)text-(left|center|right)(\s|$)/;
const ALIGN_CLASS: Record<Align, string> = { left: "text-left", center: "text-center", right: "text-right" };

/**
 * Alignment for a header or cell. An explicit `align` wins; otherwise a
 * `text-right`/`text-center` in className is honoured, and only a header with
 * neither falls back to text-left. Emitting text-left beside a caller's
 * text-right left the winner to stylesheet order, which was not the caller's.
 */
function alignClass(className: string, align: Align | undefined, fallback: Align | null): string {
  if (align) return ALIGN_CLASS[align];
  if (ALIGN_RE.test(className) || !fallback) return "";
  return ALIGN_CLASS[fallback];
}

/**
 * The one sub-heading inside a card (a section of a card, not a card title):
 * small caps in muted grey, the same voice as a table's column headers. The
 * Methodology page spells the same classes out, since method.tsx cannot
 * import from here without a cycle.
 */
export function SubHead({ children, className = "", id }: { children: ReactNode; className?: string; id?: string }) {
  return (
    <h4 id={id} className={`text-[11px] font-medium uppercase tracking-wide text-gray-500 ${className}`}>
      {children}
    </h4>
  );
}

export function Th({
  children,
  className = "",
  align,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  align?: Align;
  /** A column header is the right home for the paragraph explaining the column. */
} & Omit<ComponentPropsWithoutRef<"th">, "align">) {
  return (
    <th
      {...rest}
      className={`px-2 py-1.5 ${alignClass(className, align, "left")} text-[11px] font-medium uppercase tracking-wide text-gray-500 ${className}`}
    >
      {children}
    </th>
  );
}

/**
 * Cells forward any extra prop to the element -- `data-label` above all. They
 * used to destructure only children/className/style/title and silently drop
 * the rest, so the mobile stacked-card layout rendered
 * `content: attr(data-label)` against an attribute that never reached the DOM.
 *
 * A labelled cell wraps its value in `.ff-val`. On a desktop that wrapper is
 * `display: contents` and changes nothing; in a phone's stacked card it is the
 * one flex item beside the label, so a multi-part value ("12.4 · roto 11")
 * groups on the right instead of being spread across the row by
 * space-between. The row head (`data-label=""`) is left unwrapped.
 */
export function Td({
  children,
  className = "",
  align,
  block = false,
  empty = false,
  ...rest
}: {
  children?: ReactNode;
  className?: string;
  align?: Align;
  /** Prose (Sites say, Why): on a phone the label sits above and the text runs full width. */
  block?: boolean;
  /** The value is null or "—": hidden in a phone's stacked card, kept on desktop so columns line up. */
  empty?: boolean;
} & Omit<ComponentPropsWithoutRef<"td">, "align">) {
  const label = (rest as { "data-label"?: string })["data-label"];
  const cls = [
    "px-2 py-1.5 text-sm text-gray-300",
    alignClass(className, align, null),
    block ? "ff-cell-block" : "",
    empty ? "ff-empty" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <td {...rest} className={cls}>
      {label ? <div className="ff-val min-w-0">{children}</div> : children}
    </td>
  );
}

export type PeekNote = {
  published_at: string;
  headline: string;
  url: string | null;
  flagged?: boolean;
};

/**
 * The page-wide news index (ff/api.py news_index): per player [notes listed,
 * shade 0-2, any flagged], and the notes themselves, newest first.
 */
export type NewsIndex = {
  players: Record<string, [number, number, number]>;
  notes: Record<string, PeekNote[]>;
};

const NewsIndexContext = createContext<NewsIndex | null>(null);

/** The league being viewed, for anything a player name opens (his dossier is per league). */
export const LeagueContext = createContext<string>("");
/** FantasyPage fetches the index once and provides it to every tab. */
export const NewsIndexProvider = NewsIndexContext.Provider;

/**
 * A floating panel anchored to a trigger: the news badge and HoverInfo share
 * it. Hover (or focus) shows it; a click pins it until an outside press or
 * Escape. Hover spans the trigger AND the panel, so the pointer can travel
 * into the panel to reach a link: leaving either starts a short timer that
 * entering either cancels. On a phone there is no hover, so a tap pins it and
 * it opens as a bottom sheet pinned to the viewport: a panel hanging off a
 * trigger 250px across a 390px screen is half off-screen whichever edge it
 * aligns to.
 *
 * The panel is portalled to <body> and positioned `fixed`. Rendered in place
 * it sat inside tables: it inherited their nowrap (one line of text running
 * past the panel) and later rows painted over it. It opens below the
 * trigger, or above when short of room.
 */
function usePopover({
  align = "left",
  width = 352,
  interactive = true,
}: {
  align?: "left" | "right";
  width?: number;
  /**
   * The pointer can move into a hovered panel (to reach a link) and it stays
   * open. Off, a hovered panel lets the pointer through: plain detail that
   * opens over the next line must not block hovering that line.
   */
  interactive?: boolean;
} = {}) {
  const narrow = useIsNarrow();
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = pinned || (!narrow && (hovered || focused));
  const panelWidth = useCallback(() => Math.min(width, window.innerWidth - 16), [width]);

  const leaveTimer = useRef<number | undefined>(undefined);
  const enter = () => {
    window.clearTimeout(leaveTimer.current);
    setHovered(true);
  };
  const leave = () => {
    window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => setHovered(false), POPOVER_LEAVE_MS);
  };
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  const place = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const w = panelWidth();
    const h = panelRef.current?.offsetHeight ?? 160;
    const flip = window.innerHeight - r.bottom - POPOVER_GAP < h && r.top - POPOVER_GAP > window.innerHeight - r.bottom;
    const want = align === "right" ? r.right - w : r.left;
    setPos({
      top: flip ? r.top - POPOVER_GAP - h : r.bottom + POPOVER_GAP,
      left: Math.min(Math.max(8, want), window.innerWidth - w - 8),
      width: w,
    });
  }, [align, panelWidth]);

  useLayoutEffect(() => {
    if (!open || narrow) return;
    place();
    return () => setPos(null);
  }, [open, narrow, place]);

  // Follow the trigger while open; a pinned panel closes on an outside press
  // or Escape. Not on blur: the press on a link inside the panel blurs the
  // trigger first, which used to close the panel before the link was hit.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setPinned(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(false);
    };
    const onMove = () => !narrow && place();
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open, narrow, place]);

  const toggle = () => setPinned((v) => !v);
  const triggerProps = {
    ref: (el: HTMLElement | null) => {
      triggerRef.current = el;
    },
    onClick: (e: { stopPropagation: () => void }) => {
      // Rows that expand on click must not also toggle.
      e.stopPropagation();
      toggle();
    },
    onMouseEnter: enter,
    onMouseLeave: leave,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    "aria-expanded": open,
  };

  const panel = (children: ReactNode) =>
    open &&
    createPortal(
      <div
        ref={panelRef}
        onMouseEnter={narrow || !interactive ? undefined : enter}
        onMouseLeave={narrow || !interactive ? undefined : leave}
        className={`fixed z-30 whitespace-normal rounded-lg border border-gray-700 bg-gray-950 p-2.5 text-left font-normal shadow-xl ${
          narrow ? "inset-x-2 bottom-2 max-h-[60dvh] overflow-y-auto ff-sheet" : "max-h-[70vh] overflow-y-auto"
        } ${!interactive && !pinned && !narrow ? "pointer-events-none" : ""}`}
        // Unplaced, it is laid out hidden at its real width, so the height
        // `place` measures (to decide whether to flip) is the height it gets.
        style={
          narrow
            ? undefined
            : pos
              ? { top: pos.top, left: pos.left, width: pos.width }
              : { top: 0, left: 0, width: panelWidth(), visibility: "hidden" }
        }
      >
        {children}
      </div>,
      document.body,
    );

  return { open, narrow, place, toggle, triggerProps, panel };
}

/** Space between a trigger and its floating panel. */
const POPOVER_GAP = 4;
/** Grace period after the pointer leaves the trigger or panel before it closes. */
const POPOVER_LEAVE_MS = 200;

/**
 * Detail that shows only on hover (or a tap on a phone): the trigger text gets
 * a dotted underline so it reads as something to point at. `info` is a node,
 * or a string whose lines ("\n") become lines of the panel.
 */
export function HoverInfo({ info, children, className = "" }: { info: ReactNode; children: ReactNode; className?: string }) {
  const p = usePopover({ width: 300, interactive: false });
  if (!info) return <span className={className}>{children}</span>;
  return (
    <>
      <span
        {...p.triggerProps}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            p.toggle();
          }
        }}
        className={`cursor-help underline decoration-gray-600 decoration-dotted underline-offset-2 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500/60 ${className}`}
      >
        {children}
      </span>
      {p.panel(
        <div className="space-y-0.5 text-xs leading-snug text-gray-300">
          {typeof info === "string" ? info.split("\n").map((l, i) => <div key={i}>{l}</div>) : info}
        </div>,
      )}
    </>
  );
}

/**
 * The news badge beside a player's name, on every tab: how many recent notes
 * there are, shaded by whether any of them matters. Hover or click for the
 * notes themselves, newest first.
 *
 * Click as well as hover, deliberately: an 11pm waiver decision happens on a
 * phone, and a hover-only affordance is invisible to a thumb.
 *
 * Renders NOTHING when a player has no notes rather than a greyed-out badge:
 * an absent badge reads as "nothing to see", a dead one invites a click that
 * does nothing. The count, shade and headlines all come from one page-wide
 * index loaded with the page, so a hover shows the notes at once and no tab's
 * payload carries them.
 */
export function NewsPeek({
  id,
  name,
  align = "left",
}: {
  id: string;
  name: string;
  align?: "left" | "right";
}) {
  const index = useContext(NewsIndexContext);
  const entry = index?.players[id];
  const notes = index?.notes[id] ?? [];
  const p = usePopover({ align });

  if (!entry || entry[0] === 0) return null;
  const [count, shade, flagged] = entry;
  return (
    <>
      <button
        {...p.triggerProps}
        type="button"
        aria-label={`${count} recent report${count === 1 ? "" : "s"} on ${name}${SHADE_LABEL[shade] ? ` (${SHADE_LABEL[shade]})` : ""}`}
        className={`ff-inline ff-hit ml-1 inline-block rounded px-1 align-middle text-[10px] leading-none ring-1 ring-inset transition-colors ${
          flagged ? "text-red-400 ring-red-500/40" : (SHADE_CLS[shade] ?? SHADE_CLS[0])
        }`}
      >
        {count}
      </button>
      {p.panel(
        <>
          <span className="mb-1 block text-[11px] uppercase tracking-wide text-gray-500">
            {name} — {count} recent report{count === 1 ? "" : "s"}
          </span>
          {SHADE_LABEL[shade] && <span className="mb-1.5 block text-[11px] text-indigo-300">{SHADE_LABEL[shade]}</span>}
          {notes.map((n, i) => (
            <span key={i} className="mb-1.5 block last:mb-0">
              <span className="mr-1.5 text-[11px] text-gray-600">{fmtDate(n.published_at)}</span>
              <span className="text-xs leading-snug text-gray-300">{n.headline}</span>
              {n.url && <SourceLink href={n.url} />}
              {n.flagged && <span className="ml-1 text-[10px] text-red-400">reads as an instruction</span>}
            </span>
          ))}
        </>,
      )}
    </>
  );
}

/**
 * One hue, three strengths. 2: an injury / out / role / return note in the
 * last 24h; 1: in the last 72h; 0: only older or routine notes (box scores).
 */
// Fill vs outline vs dim, not just opacity steps: two translucent fills were
// indistinguishable at badge size on a phone.
const SHADE_CLS = [
  "text-indigo-400/60 ring-indigo-400/20 hover:text-indigo-300 hover:ring-indigo-400/50",
  "text-indigo-200 ring-indigo-400/80 hover:bg-indigo-500/20",
  "bg-indigo-500 text-white ring-indigo-400 hover:bg-indigo-400",
];
const SHADE_LABEL = ["", "Injury or role news in the last 3 days", "Injury or role news in the last 24 hours"];

/**
 * A link to the source, as an icon beside the text rather than the text itself.
 *
 * Wire notes have no standalone article page — the URL is the player's news
 * page on ESPN — so turning the headline into a link promised an article and
 * delivered a player index. It also made three lines of prose one large click
 * target, which is hostile to anyone trying to select a sentence.
 */
export function SourceLink({ href, label = "ESPN player news" }: { href: string; label?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title={`Open ${label}`}
      aria-label={`Open ${label}`}
      onClick={(e) => e.stopPropagation()}
      className="ff-hit ml-1.5 inline-flex translate-y-[1px] text-gray-600 transition-colors hover:text-indigo-300"
    >
      <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        <path
          d="M5.5 2H2.5A.5.5 0 0 0 2 2.5v9a.5.5 0 0 0 .5.5h9a.5.5 0 0 0 .5-.5v-3"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
        <path d="M8.5 1.75H12.25V5.5M12 2L6.75 7.25" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  );
}

/**
 * The one fold control every long list shares: "Show N more" / "Show all N" /
 * "Show fewer". Renders nothing when there is nothing hidden and nothing to
 * collapse, so call sites can drop it in unconditionally. `ff-inline` keeps
 * the coarse-pointer min-height from turning it into a 36px block; the
 * `py-2 -mb-2` pair (the top padding is the old mt-2 gap) and `ff-hit` give
 * a thumb ~32px without moving the text.
 */
export function FoldToggle({
  total,
  shown,
  expanded = false,
  onToggle,
  mode = "more",
  className = "",
}: {
  total: number;
  shown: number;
  /** When given, the control also offers "show fewer" once open. */
  expanded?: boolean;
  onToggle: () => void;
  /** "all" reads "Show all 120"; "more" reads "Show 30 more". */
  mode?: "all" | "more";
  className?: string;
}) {
  const hidden = Math.max(0, total - shown);
  if (hidden === 0 && !expanded) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`ff-inline ff-hit -mb-2 py-2 text-xs text-indigo-400 hover:text-indigo-300 ${className}`}
    >
      {expanded && hidden === 0 ? "Show fewer" : mode === "all" ? `Show all ${total}` : `Show ${hidden} more`}
    </button>
  );
}
