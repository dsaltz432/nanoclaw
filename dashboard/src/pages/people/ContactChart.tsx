import { useEffect, useMemo, useRef, useState } from "react";
import { Interaction, Person, SOURCE_LABELS, TIMED_SOURCES, fmtDay, fmtDuration } from "./shared";

/**
 * Contact over time, for one person.
 *
 * Calls are columns rising from a baseline — height is minutes, and calls on
 * the same day stack with a 2px gap. Entries with no duration (in person,
 * manual notes, a call logged without minutes) can't have a height, so they sit
 * in a lane of dots under the axis, on the same dates: they're events, not
 * magnitudes, and an in-person entry counts in full whatever its "length".
 *
 * Greys only, like the 90-day strip: light = counts, dark = recorded but
 * doesn't count. Colour on the page is reserved for how overdue someone is
 * (the row and its chip), so the chart stays grey.
 */

type Range = "90d" | "6m" | "1y" | "all";
const RANGES: { key: Range; label: string; days: number | null }[] = [
  { key: "90d", label: "90 days", days: 90 },
  { key: "6m", label: "6 months", days: 183 },
  { key: "1y", label: "1 year", days: 365 },
  { key: "all", label: "All", days: null },
];

const H_PLOT = 140; // column area
const H_AXIS = 22; // date labels
const H_LANE = 26; // in-person / note dots
const PAD_L = 58; // y-axis ticks and the lane label
const PAD_R = 8;
const PAD_T = 10;
const COL_W = 4; // thin; never fills the slot
const GAP = 2; // surface gap between stacked segments

// Tailwind grays as hex, so SVG fills match the strip exactly.
const COUNTS = "#d1d5db"; // gray-300
const NOT_COUNTS = "#4b5563"; // gray-600
const GRID = "#1f2937"; // gray-800 — one step off the gray-900 surface
const SURFACE = "#111827"; // gray-900
const INK_MUTED = "#6b7280"; // gray-500

interface Mark {
  i: Interaction;
  x: number;
  y0: number; // column segment: baseline side
  y1: number; // column segment: top
}

function dayMs(ts: string): number {
  return Date.parse(ts.slice(0, 10) + "T00:00:00Z");
}

function niceMax(minutes: number): number {
  for (const step of [5, 10, 15, 30, 60, 120, 240]) {
    if (minutes <= step * 4) return Math.max(step, Math.ceil(minutes / step) * step);
  }
  return Math.ceil(minutes / 60) * 60;
}

function tickLabel(min: number): string {
  if (min === 0) return "0";
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min}m`;
}

export default function ContactChart({
  person,
  today,
  showShort = false,
}: {
  person: Person;
  today: string;
  /** Include the calls under a minute the page hides by default. */
  showShort?: boolean;
}) {
  const [rows, setRows] = useState<Interaction[] | null>(null);
  const [range, setRange] = useState<Range>("6m");
  const [hover, setHover] = useState<{ mark: Interaction; x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);

  useEffect(() => {
    fetch(`/api/people/${person.id}/interactions?limit=2000${showShort ? "&short=1" : ""}`)
      .then((r) => r.json())
      .then((d) => setRows(d.interactions ?? []))
      .catch(() => setRows([]));
  }, [person.id, person.shown_count, showShort]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(280, entry.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
    // The wrapper only exists once data has loaded; observing on mount alone
    // would watch nothing and leave the chart at its fallback width.
  }, [rows === null]);

  const endMs = Date.parse(today + "T00:00:00Z");
  const view = useMemo(() => {
    if (!rows) return null;
    const days = RANGES.find((r) => r.key === range)!.days;
    const earliest = rows.length ? Math.min(...rows.map((r) => dayMs(r.ts))) : endMs;
    const startMs = days === null ? Math.min(earliest, endMs - 30 * 86_400_000) : endMs - (days - 1) * 86_400_000;
    const inRange = rows.filter((r) => dayMs(r.ts) >= startMs);

    const timed = inRange.filter((r) => TIMED_SOURCES.includes(r.source) && r.duration_s !== null);
    const untimed = inRange.filter((r) => !timed.includes(r));

    // Stack same-day calls: total minutes per day sets the scale.
    const byDay = new Map<number, Interaction[]>();
    for (const r of timed) {
      const d = dayMs(r.ts);
      byDay.set(d, [...(byDay.get(d) ?? []), r]);
    }
    const maxMin = Math.max(
      5,
      ...[...byDay.values()].map((list) => list.reduce((s, r) => s + r.duration_s! / 60, 0))
    );
    return { startMs, timed, untimed, byDay, yMax: niceMax(maxMin) };
  }, [rows, range, endMs]);

  const plotW = width - PAD_L - PAD_R;
  const height = PAD_T + H_PLOT + H_AXIS + H_LANE;
  const baseY = PAD_T + H_PLOT;
  const laneY = baseY + H_AXIS + H_LANE / 2;

  // One minimum for every timed source → draw it; otherwise the tooltip says.
  const minimums = TIMED_SOURCES.filter((s) => s in person.rules).map((s) => person.rules[s] ?? 0);
  const firstMin = minimums[0];
  const sharedMin =
    firstMin !== undefined && minimums.every((m) => m === firstMin) ? firstMin : null;

  if (!rows || !view) return <div className="h-48 text-sm text-gray-600">Loading…</div>;

  const { startMs, untimed, byDay, yMax } = view;
  const span = Math.max(1, endMs - startMs);
  const xOf = (ms: number) => PAD_L + ((ms - startMs) / span) * (plotW - COL_W) + COL_W / 2;
  const yOf = (min: number) => baseY - (min / yMax) * H_PLOT;

  const marks: Mark[] = [];
  for (const [d, list] of byDay) {
    let acc = 0;
    for (const r of [...list].sort((a, b) => a.ts.localeCompare(b.ts))) {
      const m = r.duration_s! / 60;
      const y0 = yOf(acc) - (acc > 0 ? GAP : 0);
      const y1 = Math.min(y0 - 1, yOf(acc + m));
      marks.push({ i: r, x: xOf(d), y0, y1 });
      acc += m;
    }
  }

  const ticks = [0, yMax / 2, yMax];
  const xTicks = xTickDates(startMs, endMs, plotW);

  const empty = view.timed.length === 0 && untimed.length === 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex shrink-0 gap-1 rounded-md bg-gray-900 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`whitespace-nowrap rounded px-2 py-0.5 text-xs ${
                range === r.key ? "bg-gray-800 text-gray-200" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <Legend minimum={sharedMin && sharedMin / 60 < yMax ? sharedMin : null} />
      </div>

      <div ref={wrapRef} className="relative w-full overflow-hidden">
        {empty && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-600">
            Nothing in this range.
          </div>
        )}
        <svg
          width={width}
          height={height}
          className="block"
          role="img"
          aria-label={`${person.name}: calls by length and in-person entries over time`}
          onPointerLeave={() => setHover(null)}
        >
          {/* grid + y ticks */}
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={width - PAD_R} y1={yOf(t)} y2={yOf(t)} stroke={GRID} />
              <text
                x={PAD_L - 6}
                y={yOf(t)}
                dy="0.32em"
                textAnchor="end"
                fontSize={10}
                fill={INK_MUTED}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {tickLabel(t)}
              </text>
            </g>
          ))}

          {/* the call minimum, when every call source shares one */}
          {sharedMin !== null && sharedMin > 0 && sharedMin / 60 < yMax && (
            <g>
              <line
                x1={PAD_L}
                x2={width - PAD_R}
                y1={yOf(sharedMin / 60)}
                y2={yOf(sharedMin / 60)}
                stroke={INK_MUTED}
                strokeOpacity={0.5}
              />
            </g>
          )}

          {/* x axis */}
          {xTicks.map((t) => (
            <g key={t.ms}>
              <line
                x1={xOf(t.ms)}
                x2={xOf(t.ms)}
                y1={baseY}
                y2={baseY + (t.major ? 5 : 3)}
                stroke={t.major ? INK_MUTED : GRID}
              />
              {t.label && (
                <text
                  x={xOf(t.ms)}
                  y={baseY + 16}
                  textAnchor="middle"
                  fontSize={10}
                  fill={INK_MUTED}
                >
                  {t.label}
                </text>
              )}
            </g>
          ))}

          {/* in-person / notes lane */}
          <line x1={PAD_L} x2={width - PAD_R} y1={laneY} y2={laneY} stroke={GRID} />
          <text x={PAD_L - 6} y={laneY} dy="0.32em" textAnchor="end" fontSize={10} fill={INK_MUTED}>
            in person
          </text>

          {/* in-person visits: a faint full-height band. They count in full but
              have no length, so they get presence, never a made-up height. */}
          {untimed
            .filter((i) => i.source === "in_person")
            .map((i) => (
              <rect
                key={`band-${i.id}`}
                x={xOf(dayMs(i.ts)) - 3}
                y={PAD_T}
                width={6}
                height={H_PLOT}
                rx={2}
                fill={i.qualifies ? COUNTS : NOT_COUNTS}
                fillOpacity={0.16}
              />
            ))}

          {/* call columns: 4px rounded top, square at the baseline */}
          {marks.map((m) => {
            const fill = m.i.qualifies ? COUNTS : NOT_COUNTS;
            const h = Math.max(1, m.y0 - m.y1);
            const r = Math.min(2, h / 2);
            const x0 = m.x - COL_W / 2;
            const d =
              `M${x0},${m.y0} V${m.y1 + r} Q${x0},${m.y1} ${x0 + r},${m.y1} ` +
              `H${x0 + COL_W - r} Q${x0 + COL_W},${m.y1} ${x0 + COL_W},${m.y1 + r} V${m.y0} Z`;
            return <path key={m.i.id} d={d} fill={fill} />;
          })}

          {/* in-person dots: filled = in person, hollow = a note / call with no length */}
          {untimed.map((i) => {
            const x = xOf(dayMs(i.ts));
            const fill = i.qualifies ? COUNTS : NOT_COUNTS;
            const solid = i.source === "in_person";
            return (
              <g key={i.id}>
                {/* 2px surface ring so overlapping dots stay distinct */}
                <circle cx={x} cy={laneY} r={6} fill={SURFACE} />
                <circle
                  cx={x}
                  cy={laneY}
                  r={solid ? 4 : 3}
                  fill={solid ? fill : SURFACE}
                  stroke={solid ? "none" : fill}
                  strokeWidth={solid ? 0 : 2}
                />
              </g>
            );
          })}

          {/* hit targets, ≥ 24px wide and focusable, drawn last so they sit on top */}
          {[...marks.map((m) => ({ i: m.i, x: m.x, y: m.y1, top: m.y1, bottom: baseY })),
            ...untimed.map((i) => ({ i, x: xOf(dayMs(i.ts)), y: laneY, top: laneY - 12, bottom: laneY + 12 }))
          ].map((t) => (
            <rect
              key={`hit-${t.i.id}`}
              x={t.x - 12}
              y={Math.min(t.top, t.bottom - 24)}
              width={24}
              height={Math.max(24, t.bottom - t.top)}
              fill="transparent"
              tabIndex={0}
              aria-label={describe(t.i)}
              onPointerEnter={() => setHover({ mark: t.i, x: t.x, y: t.y })}
              onFocus={() => setHover({ mark: t.i, x: t.x, y: t.y })}
              onBlur={() => setHover(null)}
              className="outline-none"
            />
          ))}

          {/* crosshair on the hovered / focused mark */}
          {hover && (
            <line
              x1={hover.x}
              x2={hover.x}
              y1={PAD_T}
              y2={laneY + 8}
              stroke={INK_MUTED}
              strokeOpacity={0.35}
              pointerEvents="none"
            />
          )}
        </svg>

        {hover && <Tooltip i={hover.mark} x={hover.x} y={hover.y} width={width} />}
      </div>
    </div>
  );
}

function describe(i: Interaction): string {
  const what = SOURCE_LABELS[i.source] ?? i.source;
  const len = i.duration_s ? `, ${fmtDuration(i.duration_s)}` : "";
  return `${fmtDay(i.ts)}: ${what}${len}${i.qualifies ? "" : " (doesn't count)"}`;
}

function Tooltip({ i, x, y, width }: { i: Interaction; x: number; y: number; width: number }) {
  const left = Math.min(Math.max(x - 80, 0), width - 160);
  return (
    <div
      className="pointer-events-none absolute w-40 rounded-md border border-gray-700 bg-gray-950 px-2.5 py-1.5 text-xs shadow-lg"
      style={{ left, top: Math.max(0, y - 64) }}
    >
      <div className="font-semibold text-gray-100">
        {i.duration_s ? fmtDuration(i.duration_s) : SOURCE_LABELS[i.source] ?? i.source}
      </div>
      <div className="text-gray-400">
        {i.duration_s ? `${SOURCE_LABELS[i.source] ?? i.source} · ` : ""}
        {fmtDay(i.ts)}
        {i.direction !== "n/a" && ` · ${i.direction}`}
      </div>
      {i.note && <div className="truncate text-gray-500">{i.note}</div>}
      <div className="text-gray-500">{i.qualifies ? "counts" : "doesn't count"}</div>
    </div>
  );
}

function Legend({ minimum }: { minimum: number | null }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-gray-500">
      {minimum !== null && (
        <span className="flex items-center gap-1.5">
          <span className="h-px w-3" style={{ background: INK_MUTED }} />
          counts from {fmtDuration(minimum)}
        </span>
      )}
      <span className="flex items-center gap-1.5">
        <span className="h-3 w-1 rounded-t-sm" style={{ background: COUNTS }} />
        call · counts
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-3 w-1 rounded-t-sm" style={{ background: NOT_COUNTS }} />
        doesn't count
      </span>
      <span className="flex items-center gap-1.5">
        <span className="relative flex h-3 w-2 justify-center">
          <span className="absolute inset-0 rounded-sm" style={{ background: COUNTS, opacity: 0.16 }} />
          <span className="mt-auto h-2 w-2 rounded-full" style={{ background: COUNTS }} />
        </span>
        in person
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full border-2" style={{ borderColor: COUNTS }} />
        note
      </span>
    </div>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Up to a year: a tick on the 1st and 15th of every month, labelled "Apr 1",
 * "Apr 15" when there's room, otherwise the 1st only ("Apr") with the 15th as a
 * minor tick. Longer ranges: the 1st of each month, labelled as often as fits.
 */
export function xTickDates(
  startMs: number,
  endMs: number,
  plotW: number
): { ms: number; label: string | null; major: boolean }[] {
  const start = new Date(startMs);
  const days = (endMs - startMs) / 86_400_000;
  const out: { ms: number; label: string | null; major: boolean }[] = [];
  const firstYear = start.getUTCFullYear();
  const lastYear = new Date(endMs).getUTCFullYear();

  if (days <= 370) {
    const candidates: { ms: number; day: number; month: number; year: number }[] = [];
    for (let y = firstYear, m = start.getUTCMonth(); ; m++) {
      if (m > 11) { m = 0; y++; }
      for (const day of [1, 15]) {
        const ms = Date.UTC(y, m, day);
        if (ms > endMs) return finish();
        if (ms >= startMs) candidates.push({ ms, day, month: m, year: y });
      }
    }
    function finish() {
      const roomy = plotW / Math.max(1, candidates.length) >= 52;
      for (const c of candidates) {
        const yearTag = firstYear !== lastYear && c.month === 0 && c.day === 1 ? ` ${c.year}` : "";
        const label = roomy
          ? `${MONTHS[c.month]} ${c.day}${yearTag}`
          : c.day === 1
            ? `${MONTHS[c.month]}${yearTag}`
            : null;
        out.push({ ms: c.ms, label, major: c.day === 1 });
      }
      return out;
    }
  }

  const months: { ms: number; month: number; year: number }[] = [];
  for (let y = firstYear, m = start.getUTCMonth() + 1; ; m++) {
    if (m > 11) { m = 0; y++; }
    const ms = Date.UTC(y, m, 1);
    if (ms > endMs) break;
    months.push({ ms, month: m, year: y });
  }
  const every = [1, 2, 3, 6, 12].find((k) => (plotW / Math.max(1, months.length)) * k >= 64) ?? 12;
  for (const m of months) {
    const show = m.month % every === 0;
    out.push({
      ms: m.ms,
      label: show ? `${MONTHS[m.month]} ’${String(m.year).slice(2)}` : null,
      major: show,
    });
  }
  return out;
}
