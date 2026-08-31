import { ComponentPropsWithoutRef, CSSProperties, ReactNode, useEffect, useState } from "react";
import { SectionProvider } from "./method";

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

export function Card({
  title,
  subtitle,
  right,
  children,
  className = "",
  secondary = false,
}: {
  title?: string;
  subtitle?: ReactNode;
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
}) {
  const narrow = useIsNarrow();
  const [open, setOpen] = useState(false);
  const collapsible = secondary && narrow;
  const shown = !collapsible || open;
  return (
    <section className={`min-w-0 rounded-lg border border-gray-800 bg-gray-900 ${className}`}>
      {(title || right) && (
        <header
          // Stacks on a phone. Side by side, a `shrink-0` control leaves the
          // subtitle a column two words wide and it wraps one word per line.
          className="flex flex-col items-start gap-2 border-b border-gray-800 px-3 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:px-4 sm:py-3"
        >
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold text-gray-100">{title}</h3>}
            {/* Subtitles are mostly explanation, and on a phone two lines of it
                sat between you and the table on every single card. They are not
                dropped — some carry live counts ("19 unread across 14 players")
                and cannot be told from prose programmatically — but they get
                smaller type and tighter leading below sm, which is about 40% of
                the height back without losing a word. */}
            {subtitle && (
              <p className="mt-0.5 text-[11px] leading-snug text-gray-500 sm:text-xs sm:leading-normal">
                {subtitle}
              </p>
            )}
          </div>
          {right && !collapsible && <div className="w-full shrink-0 sm:w-auto">{right}</div>}
          {collapsible && (
            <button
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="w-full shrink-0 text-left text-xs text-indigo-400 sm:w-auto"
            >
              {open ? "hide" : "show"}
            </button>
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

export function StatTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "good" | "warning" | "critical";
}) {
  const color =
    tone === "good" ? C.good : tone === "warning" ? C.warning : tone === "critical" ? C.critical : C.ink;
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900 px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold" style={{ color }}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-gray-500">{hint}</div>}
    </div>
  );
}

/** Status badge — always icon/word + label, never colour alone. */
export function Badge({
  tone = "neutral",
  children,
  title,
}: {
  tone?: "neutral" | "good" | "warning" | "critical" | "info";
  children: ReactNode;
  title?: string;
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
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${map[tone]}`}
    >
      {children}
    </span>
  );
}

/** Inline magnitude bar for a table cell. One hue, 4px rounded data-end. */
export function CellBar({
  value,
  max,
  color = C.s1,
  width = 72,
}: {
  value: number | null | undefined;
  max: number;
  color?: string;
  width?: number;
}) {
  if (value == null || !max) return <span className="text-gray-700">—</span>;
  const w = Math.max(2, Math.min(width, (Math.abs(value) / max) * width));
  return (
    <span className="inline-block align-middle" style={{ width, height: 8 }}>
      <svg width={width} height={8} role="presentation">
        <rect x={0} y={0} width={w} height={8} rx={4} fill={color} />
      </svg>
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
  height = 190,
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
  const W = 640;
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
          i % Math.ceil(n / 8) === 0 ? (
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

export function Th({
  children,
  className = "",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  /** A column header is the right home for the paragraph explaining the column. */
} & ComponentPropsWithoutRef<"th">) {
  return (
    <th
      {...rest}
      className={`px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-gray-500 ${className}`}
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
 * Every call site passing data-label was already correct; none of them reached
 * a phone, so a stacked row read "Bradley / 2 / 1 / 1 / 50%" with nothing
 * saying which number was which.
 */
export function Td({
  children,
  className = "",
  ...rest
}: { children: ReactNode; className?: string } & ComponentPropsWithoutRef<"td">) {
  return (
    <td {...rest} className={`px-2 py-1.5 text-sm text-gray-300 ${className}`}>
      {children}
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
 * A small note icon beside a player's name. Hover or click to read his most
 * recent reports without leaving the row you are working in.
 *
 * Click as well as hover, deliberately: an 11pm waiver decision happens on a
 * phone, and a hover-only affordance is invisible to a thumb.
 *
 * Renders NOTHING when there are no notes rather than a greyed-out icon — an
 * absent icon reads as "nothing to see", while a dead one invites a click that
 * does nothing. The notes are shipped with the page payload, so opening this
 * fires no request.
 */
export function NewsPeek({
  notes,
  name,
  align = "left",
}: {
  notes?: PeekNote[];
  name: string;
  align?: "left" | "right";
}) {
  const [pinned, setPinned] = useState(false);
  if (!notes || notes.length === 0) return null;
  const flagged = notes.some((n) => n.flagged);
  return (
    <span className="relative inline-block align-middle">
      <button
        onClick={(e) => {
          e.stopPropagation();
          setPinned((v) => !v);
        }}
        onBlur={() => setPinned(false)}
        aria-label={`${notes.length} recent report${notes.length === 1 ? "" : "s"} on ${name}`}
        className={`peer ml-1 rounded px-1 text-[10px] leading-none ring-1 ring-inset transition-colors ${
          flagged
            ? "text-red-400 ring-red-500/40"
            : "text-gray-500 ring-gray-700 hover:text-indigo-300 hover:ring-indigo-500/40"
        }`}
      >
        {notes.length}
      </button>
      <span
        // Visibility is decided in JS, not by CSS precedence. The first version
        // used `!block` to override `hidden` — which is Tailwind v3 syntax; v4
        // moved the important modifier to a suffix (`block!`), so the class did
        // nothing and the click-to-pin path silently never worked. Hover still
        // did, which is exactly the kind of bug that survives a desktop test and
        // fails on a phone.
        // On a phone this is a bottom sheet pinned to the VIEWPORT, not a panel
        // anchored to the badge. Anchoring cannot work there: the badge sits
        // beside a player name that may be 250px across a 390px screen, so a
        // 22rem panel hanging off it is half off-screen whichever edge it
        // aligns to, and `max-w-[80vw]` only made it narrow AND clipped. Tap is
        // the only way to open it on touch anyway — there is no hover — so a
        // sheet is also the interaction a phone expects.
        className={`z-30 rounded-lg border border-gray-700 bg-gray-950 p-2.5 text-left shadow-xl
          fixed inset-x-2 bottom-2 max-h-[60vh] overflow-y-auto
          sm:absolute sm:inset-x-auto sm:bottom-auto sm:top-full sm:mt-1 sm:max-h-none sm:w-[22rem] sm:max-w-[80vw] sm:overflow-visible ${
          pinned
            ? "block pointer-events-auto"
            : "pointer-events-none hidden sm:peer-hover:block sm:peer-focus:block"
        } ${align === "right" ? "sm:right-0" : "sm:left-0"}`}
      >
        <span className="mb-1 block text-[11px] uppercase tracking-wide text-gray-500">
          {name} — {notes.length} recent report{notes.length === 1 ? "" : "s"}
        </span>
        {notes.map((n, i) => (
          <span key={i} className="mb-1.5 block last:mb-0">
            <span className="mr-1.5 text-[11px] text-gray-600">{shortDate(n.published_at)}</span>
            <span className="text-xs leading-snug text-gray-300">{n.headline}</span>
            {n.url && <SourceLink href={n.url} />}
            {n.flagged && (
              <span className="ml-1 text-[10px] text-red-400">reads as an instruction</span>
            )}
          </span>
        ))}
      </span>
    </span>
  );
}

function shortDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}


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
      className="ml-1.5 inline-flex translate-y-[1px] text-gray-600 transition-colors hover:text-indigo-300"
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
