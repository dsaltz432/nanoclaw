import { useState, useEffect, useCallback, useRef } from "react";
// Stadium map images served from /images/

// ── Types ─────────────────────────────────────────────────────────────────────

interface Team {
  slug: string;
  name: string;
  sport: string;
  color: string;
  enabled?: boolean;
}

interface CategoryPrice {
  category: string;
  lowest_price: number;
  listing_count: number;
  polled_at: string;
  best_section: string | null;
}

interface Event {
  id: number;
  team_slug: string;
  team_name: string;
  sport: string;
  title: string;
  venue: string | null;
  event_datetime: string | null;
  stubhub_url: string | null;
  status: string;
  categories: CategoryPrice[];
  overall_lowest: number | null;
  listing_count: number | null;
  polled_at: string | null;
  weather_high: number | null;
  weather_low: number | null;
  weather_precip_pct: number | null;
}

interface Snapshot {
  category: string;
  polled_at: string;
  days_until: number;
  hours_until: number;
  lowest_price: number | null;
  listing_count: number | null;
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return "Date TBD";
  const d = new Date(iso.includes("+") || iso.endsWith("Z") ? iso : iso + "Z");
  if (isNaN(d.getTime())) return "Date TBD";
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

function fmtCountdown(dt: string | null): string {
  if (!dt) return "TBD";
  const hours =
    (new Date(dt.includes("+") || dt.endsWith("Z") ? dt : dt + "Z").getTime() - Date.now()) /
    3_600_000;
  if (hours < 0) return "Past";
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
}

function fmtPrice(p: number | null): string {
  if (p == null) return "—";
  return `$${p.toFixed(0)}`;
}

function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${Math.round(h)}h`;
  if (h < 24 * 7) return `${Math.round(h / 24)}d`;
  return `${Math.round(h / 24 / 7)}w`;
}

// Category display order + colors (all venues)
const CATEGORY_COLORS: Record<string, string> = {
  // Yankees
  "Field Level": "#f59e0b",
  "Premium Main Level": "#e879f9",
  "Outfield / Corners": "#3b82f6",
  Bleachers: "#8b5cf6",
  // Liberty
  "Courtside / Floor": "#f59e0b",
  "Lower Bowl": "#e879f9",
  "Club / VIP": "#ec4899",
  "Mid-Level": "#3b82f6",
  "Upper Bowl": "#10b981",
  // Jets
  "Lower Level Sideline": "#f59e0b",
  "Lower Level End Zone": "#e879f9",
  "Mezzanine / Club": "#3b82f6",
  "General Admission": "#6b7280",
  // Red Sox
  "Field Box": "#f59e0b",
  "Loge Box": "#e879f9",
  Grandstand: "#3b82f6",
  "Green Monster": "#10b981",
  "Right Field / Pavilion": "#06b6d4",
  // Knicks / Rangers (MSG)
  "Floor / Courtside": "#f59e0b",
  "100 Level": "#3b82f6",
  "200 Level": "#10b981",
  "Club / Bridge": "#e879f9",
  // Shared
  "Upper Deck": "#10b981",
  "Standing Room": "#6b7280",
  Overall: "#ef4444",
};

const CATEGORY_ORDER = [
  // Yankees
  "Field Level",
  "Premium Main Level",
  // Liberty
  "Courtside / Floor",
  "Lower Bowl",
  "Club / VIP",
  // Jets
  "Lower Level Sideline",
  "Lower Level End Zone",
  // Red Sox
  "Field Box",
  "Loge Box",
  "Green Monster",
  "Grandstand",
  "Right Field / Pavilion",
  // Shared mid-tier
  "Outfield / Corners",
  "Mid-Level",
  "Mezzanine / Club",
  // Upper tiers
  "Upper Deck",
  "Upper Bowl",
  "Bleachers",
  "Standing Room",
  "General Admission",
];

function catColor(cat: string): string {
  return CATEGORY_COLORS[cat] ?? "#6b7280";
}

// Shorten long section names for display
function fmtSection(s: string): string {
  if (s === "Pinstripe Pass") return "PP";
  return s;
}

// Shorten event titles for display
function fmtTitle(title: string): string {
  return title
    .replace(/New York Yankees/g, "Yankees")
    .replace(/Boston Red Sox/g, "Red Sox")
    .replace(/New York Knicks/g, "Knicks")
    .replace(/New York Rangers/g, "Rangers")
    .replace(/New York Liberty/g, "Liberty")
    .replace(/New York Jets/g, "Jets");
}

// Venue descriptions per category — used in the stadium guide
const VENUE_INFO: Record<
  string,
  {
    venue: string;
    description: string;
    categories: Record<string, string>;
  }
> = {
  "new-york-yankees": {
    venue: "Yankee Stadium",
    description:
      "Horseshoe layout with home plate at the south end. Section numbers increase from the right-field side (1B) to left-field side (3B). Lower numbers = closer to the field.",
    categories: {
      "Field Level":
        "Legends/Champions suites (11-28), Field Level between the bases (109-131), and Audi Yankees Club. Closest to the action, premium pricing.",
      "Premium Main Level":
        "Main Level infield between the bases (211-228). One tier up from Field Level, still centered on the action. Great sightlines at a mid-range price.",
      "Outfield / Corners":
        "Field Level outfield (103-107, 133-136) and Main Level outfield (205-210, 229-234). Lower bowl but angled views toward the corners.",
      "Upper Deck":
        "Terrace Level (300s) and Grandstand Level (400s). Full range of views from behind home plate to outfield. High up but great for seeing the whole field.",
      Bleachers:
        "Outfield bleacher sections (202-204 in RF, 235-238 in LF). Home of the Bleacher Creatures. Backless benches, unique atmosphere, solid value.",
      "Standing Room":
        "Pinstripe Pass — general admission standing room. Cheapest way in. You can roam the concourses and find a spot.",
    },
  },
  "boston-red-sox": {
    venue: "Fenway Park",
    description:
      "Historic ballpark in Boston. Unique asymmetric layout with the Green Monster in left field. Section prefixes: F (Field Box), G (Grandstand), B (Bleachers/Box), L (Loge), M (Monster), PB (Pavilion Box), R (Roof).",
    categories: {
      "Field Box":
        "F sections (main lower bowl around the field), plus D (Dugout), H (Home Plate), and FBC (Field Box Club). Closest to the action.",
      "Loge Box":
        "L sections (36-43). Second tier, excellent sightlines. Premium mid-level seating.",
      "Grandstand":
        "G sections (1-33). Upper level with full field views. Classic Fenway experience.",
      "Green Monster":
        "M sections (7-10). Iconic left field wall seats atop the 37-foot Green Monster. Limited availability, unique perspective.",
      "Bleachers":
        "B sections (87+). Outfield seating. Lively atmosphere, good value.",
      "Right Field / Pavilion":
        "PB (Pavilion Box), R (Roof), and AP (State Street Pavilion) sections. Right field elevated seating.",
      "Standing Room":
        "Standing room only — general admission areas including Green Monster standing (SRGM) and right field deck (SRRD).",
    },
  },
  "new-york-knicks": {
    venue: "Madison Square Garden",
    description:
      "Iconic arena in Midtown Manhattan. Circular layout with the court/rink at center. Four main levels: Floor/Courtside, 100 Level (lower bowl), 200 Level (upper bowl), and Chase Bridges (suspended club seating).",
    categories: {
      "Floor / Courtside":
        "Floor-level seating around the court. Single-digit sections (1-4) with lettered rows. The most premium seats in the arena.",
      "100 Level":
        "Lower bowl sections 101-120. Closest raised tier to the court with excellent sightlines.",
      "200 Level":
        "Upper bowl sections 201-230. Full court/rink view from above.",
      "Club / Bridge":
        "Chase Bridge sections — suspended club seating above the 100 level with unique overhead perspective and premium amenities.",
    },
  },
  "new-york-rangers": {
    venue: "Madison Square Garden",
    description:
      "Iconic arena in Midtown Manhattan. Same layout as Knicks — circular with four main levels. Section numbers are the same for hockey and basketball.",
    categories: {
      "Floor / Courtside":
        "Rink-level seating closest to the ice. Single-digit sections (1-4) with lettered rows.",
      "100 Level":
        "Lower bowl sections 101-120. Great views of the ice.",
      "200 Level":
        "Upper bowl sections 201-230. Full rink view from above.",
      "Club / Bridge":
        "Chase Bridge sections — suspended club seating with unique overhead perspective.",
    },
  },
  "new-york-liberty": {
    venue: "Barclays Center",
    description:
      "Octagonal arena in Brooklyn. Court is centered with seating on all sides. Single-digit sections (1-31) are the closest tier, 100-series is mid-level, 200-series is upper bowl.",
    categories: {
      "Courtside / Floor":
        "Floor-level seating around the court. Lettered sections (F, K, R, FLR) are courtside rows. The closest seats in the arena — premium pricing.",
      "Lower Bowl":
        "Sections 1-31 — the first raised tier surrounding the court. Close to the action with excellent sightlines.",
      "Club / VIP":
        "Premium club and VIP sections with dedicated amenities, food, and drink access.",
      "Mid-Level":
        "100-series sections (102-129). Second tier up from the court. Good views at mid-range prices.",
      "Upper Bowl":
        "200-series sections (202-230). Top level of the arena. Full court view from above.",
    },
  },
  "new-york-jets": {
    venue: "MetLife Stadium",
    description:
      "Open-air stadium in East Rutherford, NJ. Oval layout with the field running north-south. Three main concourses: 100s (lower), 200s (mezzanine/club), 300s (upper deck).",
    categories: {
      "Lower Level Sideline":
        "100-level sections along both sidelines near midfield (109-111, 116-118, 133-135, 140-143). Best views of the action — closest to the field, centered on the play.",
      "Lower Level End Zone":
        "100-level sections behind the end zones and in the corners (101-108, 121-131, 144-149). Still lower bowl but angled views.",
      "Mezzanine / Club":
        "200-level sections including club seating areas. Mid-level height with good sightlines and access to club amenities.",
      "Upper Deck":
        "300-level sections (302-350). Top tier of the stadium. High up but full field visibility.",
      "General Admission":
        "Generic upper-level or standing room tickets without assigned sections.",
    },
  },
};

// ── Stadium guide (collapsible) ─────────────────────────────────────────────

interface CategoryInfo {
  category: string;
  sections: string[];
  count: number;
}

function StadiumGuide({ teamSlug }: { teamSlug: string }) {
  const [open, setOpen] = useState(false);
  const [categories, setCategories] = useState<CategoryInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    fetch(`/api/tickets/categories?team=${teamSlug}`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data) && data.length > 0 && data[0].sections) {
          // Sort by CATEGORY_ORDER
          data.sort(
            (a: CategoryInfo, b: CategoryInfo) =>
              (CATEGORY_ORDER.indexOf(a.category) ?? 99) -
              (CATEGORY_ORDER.indexOf(b.category) ?? 99)
          );
          setCategories(data);
        }
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [open, loaded, teamSlug]);

  // Reset when team changes
  useEffect(() => {
    setLoaded(false);
    setCategories([]);
    setOpen(false);
  }, [teamSlug]);

  const info = VENUE_INFO[teamSlug];
  if (!info) return null;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-800/50 transition-colors rounded-xl"
      >
        <div className="flex items-center gap-2">
          <svg
            className="w-4 h-4 text-gray-500"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="2" y="2" width="12" height="12" rx="2" />
            <path d="M2 6h12" />
            <path d="M6 6v8" />
          </svg>
          <span className="text-sm font-semibold text-gray-300">
            {info.venue} — Seating Guide
          </span>
        </div>
        <svg
          className={`w-4 h-4 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-gray-800">
          <p className="text-xs text-gray-500 mt-3 mb-4">
            {info.description}
          </p>

          {/* Stadium map */}
          {teamSlug === "new-york-yankees" && (
            <div className="mb-4 rounded-lg overflow-hidden bg-white">
              <img
                src="/images/yankee-stadium-map.png"
                alt="Yankee Stadium Seating Map"
                className="w-full"
              />
            </div>
          )}
          {teamSlug === "boston-red-sox" && (
            <div className="mb-4 rounded-lg overflow-hidden bg-white p-2">
              <img
                src="/images/fenway-park-map.png"
                alt="Fenway Park Seating Map"
                className="w-full max-w-lg mx-auto"
              />
            </div>
          )}
          {(teamSlug === "new-york-knicks" || teamSlug === "new-york-rangers") && (
            <div className="mb-4 rounded-lg overflow-hidden bg-white p-2">
              <img
                src="/images/msg-map.png"
                alt="Madison Square Garden Seating Map"
                className="w-full max-w-lg mx-auto"
              />
            </div>
          )}
          {teamSlug === "new-york-liberty" && (
            <div className="mb-4 rounded-lg overflow-hidden bg-white p-2">
              <img
                src="/images/barclays-center-map.png"
                alt="Barclays Center Seating Map"
                className="w-full max-w-md mx-auto"
              />
            </div>
          )}
          {teamSlug === "new-york-jets" && (
            <div className="mb-4 rounded-lg overflow-hidden bg-white">
              <img
                src="/images/metlife-stadium-map.png"
                alt="MetLife Stadium Seating Map"
                className="w-full"
              />
            </div>
          )}

          {/* Category color key */}
          <div className="flex flex-wrap gap-3 mb-4 pb-3 border-b border-gray-800">
            {CATEGORY_ORDER.map((cat) => (
              <div key={cat} className="flex items-center gap-1.5">
                <span
                  className="w-3 h-3 rounded-sm"
                  style={{ backgroundColor: catColor(cat) }}
                />
                <span className="text-xs text-gray-400">{cat}</span>
              </div>
            ))}
          </div>

          <div className="space-y-3">
            {categories.map((cat) => {
              const desc = info.categories[cat.category];
              return (
                <div key={cat.category}>
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: catColor(cat.category) }}
                    />
                    <span className="text-sm font-medium text-gray-200">
                      {cat.category}
                    </span>
                    <span className="text-xs text-gray-600">
                      ({cat.count} sections)
                    </span>
                  </div>
                  {desc && (
                    <p className="text-xs text-gray-500 ml-5 mb-1.5">
                      {desc}
                    </p>
                  )}
                  <p className="text-xs text-gray-600 ml-5 font-mono leading-relaxed">
                    {cat.sections.sort((a, b) => {
                      const na = parseInt(a), nb = parseInt(b);
                      if (!isNaN(na) && !isNaN(nb)) return na - nb;
                      return a.localeCompare(b);
                    }).join(", ")}
                  </p>
                </div>
              );
            })}
          </div>

          {!loaded && (
            <div className="text-xs text-gray-600 py-2">Loading...</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Price history chart (multi-category) ─────────────────────────────────────

// Time range options for filtering
const TIME_RANGES = [
  { label: "All", hours: Infinity },
  { label: "1d", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "1w", hours: 168 },
  { label: "2w", hours: 336 },
  { label: "1mo", hours: 720 },
];

function fmtChartDate(polledAt: string): string {
  const d = new Date(polledAt.includes("+") || polledAt.endsWith("Z") ? polledAt : polledAt + "Z");
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

function PriceChart({
  data,
  categories,
}: {
  data: Snapshot[];
  categories: string[];
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hov, setHov] = useState<{
    pollIdx: number;
    cat: string;
  } | null>(null);
  const [timeRange, setTimeRange] = useState(Infinity);

  // Group data by polled_at timestamp
  const allTimestamps = [...new Set(data.map((d) => d.polled_at))].sort();
  if (allTimestamps.length < 2) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-gray-600">
        {allTimestamps.length === 0
          ? "No price data yet"
          : "Price chart needs 2+ scrapes to show trends — check back after the next pricer run"}
      </div>
    );
  }

  // Filter data by time range (based on polled_at, not hours_until)
  const cutoff = timeRange === Infinity
    ? 0
    : Date.now() - timeRange * 3_600_000;
  const filtered = data.filter((d) => {
    if (timeRange === Infinity) return true;
    const t = new Date(d.polled_at.includes("+") || d.polled_at.endsWith("Z") ? d.polled_at : d.polled_at + "Z").getTime();
    return t >= cutoff;
  });

  const timestamps = [...new Set(filtered.map((d) => d.polled_at))].sort();
  const showRangeFilter = allTimestamps.length > 10;

  // Build per-category time series — use polled_at as X axis (chronological)
  const series: Record<string, { time: number; price: number; polledAt: string; hoursUntil: number }[]> = {};
  for (const cat of categories) {
    series[cat] = [];
  }
  for (const snap of filtered) {
    if (snap.lowest_price != null && categories.includes(snap.category)) {
      if (!series[snap.category]) series[snap.category] = [];
      const t = new Date(snap.polled_at.includes("+") || snap.polled_at.endsWith("Z") ? snap.polled_at : snap.polled_at + "Z").getTime();
      series[snap.category].push({
        time: t,
        price: snap.lowest_price,
        polledAt: snap.polled_at,
        hoursUntil: snap.hours_until,
      });
    }
  }
  // Sort each series by time
  for (const cat of categories) {
    series[cat]?.sort((a, b) => a.time - b.time);
  }

  const allPrices = filtered
    .filter((d) => d.lowest_price != null && categories.includes(d.category))
    .map((d) => d.lowest_price as number);

  if (allPrices.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-gray-600">
        No price data for selected categories in this range
      </div>
    );
  }

  // Get time bounds
  const allTimes = Object.values(series).flat().map((p) => p.time);
  const minTime = Math.min(...allTimes);
  const maxTime = Math.max(...allTimes);
  const timeSpan = maxTime - minTime || 1;

  const minP = Math.min(...allPrices) * 0.95;
  const maxP = Math.max(...allPrices) * 1.05;
  const pRange = maxP - minP || 1;

  const W = 560, H = 200, padL = 44, padR = 12, padT = 12, padB = 36;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const toX = (t: number) => padL + ((t - minTime) / timeSpan) * chartW;
  const toY = (p: number) => padT + chartH - ((p - minP) / pRange) * chartH;

  // Y-axis: 4-5 nice ticks
  const yStep = Math.ceil(pRange / 4 / 5) * 5 || 5;
  const yStart = Math.floor(minP / yStep) * yStep;
  const yTicks: number[] = [];
  for (let v = yStart; v <= maxP + yStep; v += yStep) {
    if (v >= minP && v <= maxP) yTicks.push(v);
  }
  if (yTicks.length < 2) yTicks.push(Math.round(minP), Math.round(maxP));

  // X-axis: date labels (evenly spaced, deduplicated)
  const xLabelCount = Math.min(5, timestamps.length);
  const xTicks: { time: number; label: string }[] = [];
  for (let i = 0; i < xLabelCount; i++) {
    const t = minTime + (timeSpan * i) / (xLabelCount - 1 || 1);
    // Find nearest timestamp
    let closest = timestamps[0];
    let bestDiff = Infinity;
    for (const ts of timestamps) {
      const tsTime = new Date(ts.includes("+") || ts.endsWith("Z") ? ts : ts + "Z").getTime();
      if (Math.abs(tsTime - t) < bestDiff) {
        bestDiff = Math.abs(tsTime - t);
        closest = ts;
      }
    }
    const label = fmtChartDate(closest);
    if (!xTicks.find((x) => x.label === label)) {
      xTicks.push({ time: new Date(closest.includes("+") || closest.endsWith("Z") ? closest : closest + "Z").getTime(), label });
    }
  }

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = ((e.clientX - rect.left) / rect.width) * W;
      const y = ((e.clientY - rect.top) / rect.height) * H;
      let bestDist = Infinity;
      let bestCat = "";
      let bestIdx = 0;
      for (const cat of categories) {
        for (let i = 0; i < (series[cat]?.length ?? 0); i++) {
          const pt = series[cat][i];
          const dx = Math.abs(toX(pt.time) - x);
          const dy = Math.abs(toY(pt.price) - y);
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < bestDist) {
            bestDist = dist;
            bestCat = cat;
            bestIdx = i;
          }
        }
      }
      setHov(bestDist < 40 ? { pollIdx: bestIdx, cat: bestCat } : null);
    },
    [categories, series]
  );

  return (
    <div>
      {/* Time range filter */}
      {showRangeFilter && (
        <div className="flex gap-1 mb-2">
          {TIME_RANGES.map((r) => (
            <button
              key={r.label}
              onClick={() => setTimeRange(r.hours)}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${
                timeRange === r.hours
                  ? "bg-gray-700 text-gray-200"
                  : "text-gray-500 hover:text-gray-400"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHov(null)}
      >
        {/* Grid lines + Y labels */}
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={padL} y1={toY(v)} x2={W - padR} y2={toY(v)} stroke="#1f2937" strokeWidth={0.5} />
            <text x={padL - 6} y={toY(v) + 3.5} textAnchor="end" fontSize={10} fill="#6b7280" fontFamily="monospace">
              ${v}
            </text>
          </g>
        ))}

        {/* X-axis labels */}
        {xTicks.map((tick, i) => (
          <g key={i}>
            <line x1={toX(tick.time)} y1={padT} x2={toX(tick.time)} y2={padT + chartH} stroke="#1f2937" strokeWidth={0.5} strokeDasharray="4,4" />
            <text x={toX(tick.time)} y={H - 10} textAnchor="middle" fontSize={10} fill="#6b7280">
              {tick.label}
            </text>
          </g>
        ))}

        {/* X-axis label */}
        <text x={W / 2} y={H - 1} textAnchor="middle" fontSize={8} fill="#4b5563">
          Date scraped
        </text>

        {/* Lines + dots per category */}
        {categories.map((cat) => {
          const pts = series[cat] ?? [];
          if (pts.length === 0) return null;
          const color = catColor(cat);
          const isHovered = hov?.cat === cat;
          const isDimmed = hov && !isHovered;

          return (
            <g key={cat} opacity={isDimmed ? 0.2 : 1}>
              {/* Line */}
              {pts.length >= 2 && (
                <polyline
                  points={pts.map((p) => `${toX(p.time)},${toY(p.price)}`).join(" ")}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
              )}
              {/* Data points */}
              {pts.map((p, i) => (
                <circle
                  key={i}
                  cx={toX(p.time)}
                  cy={toY(p.price)}
                  r={isHovered && hov?.pollIdx === i ? 5 : 3}
                  fill={color}
                  stroke="#111827"
                  strokeWidth={1}
                />
              ))}
            </g>
          );
        })}

        {/* Hover tooltip */}
        {hov && (() => {
          const pts = series[hov.cat];
          if (!pts || !pts[hov.pollIdx]) return null;
          const pt = pts[hov.pollIdx];
          const cx = toX(pt.time);
          const cy = toY(pt.price);
          const dateLabel = fmtChartDate(pt.polledAt);
          const hoursLabel = pt.hoursUntil < 1
            ? "Game time"
            : `${fmtHours(pt.hoursUntil)} before game`;
          const TW = 180, TH = 58;
          const ty = cy - TH - 10 < padT ? cy + 12 : cy - TH - 10;
          const tx = Math.max(padL, Math.min(cx - TW / 2, W - padR - TW));
          return (
            <>
              <line x1={cx} y1={padT} x2={cx} y2={padT + chartH} stroke="#374151" strokeWidth={1} strokeDasharray="3,3" />
              <circle cx={cx} cy={cy} r={5} fill={catColor(hov.cat)} stroke="#f9fafb" strokeWidth={2} />
              <g transform={`translate(${tx},${ty})`}>
                <rect width={TW} height={TH} rx={6} fill="#111827" stroke="#374151" strokeWidth={1} />
                <text x={TW / 2} y={14} textAnchor="middle" fontSize={9} fill="#9ca3af">
                  {hov.cat}
                </text>
                <text x={TW / 2} y={30} textAnchor="middle" fontSize={14} fontWeight="700" fill="#f9fafb">
                  ${pt.price.toFixed(0)} per ticket
                </text>
                <text x={TW / 2} y={46} textAnchor="middle" fontSize={9} fill="#6b7280">
                  {dateLabel} · {hoursLabel}
                </text>
              </g>
            </>
          );
        })()}

        {/* Axes */}
        <line x1={padL} y1={padT + chartH} x2={W - padR} y2={padT + chartH} stroke="#374151" strokeWidth={1} />
        <line x1={padL} y1={padT} x2={padL} y2={padT + chartH} stroke="#374151" strokeWidth={1} />
      </svg>
    </div>
  );
}

// ── Category legend ──────────────────────────────────────────────────────────

function CategoryLegend({
  categories,
  selected,
  onToggle,
}: {
  categories: string[];
  selected: Set<string>;
  onToggle: (cat: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {categories.map((cat) => {
        const active = selected.has(cat);
        return (
          <button
            key={cat}
            onClick={() => onToggle(cat)}
            className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-md transition-colors ${
              active
                ? "bg-gray-800 text-gray-200"
                : "bg-gray-900 text-gray-600"
            }`}
          >
            <span
              className="w-2.5 h-2.5 rounded-full inline-block"
              style={{
                backgroundColor: catColor(cat),
                opacity: active ? 1 : 0.3,
              }}
            />
            {cat}
          </button>
        );
      })}
    </div>
  );
}

// ── Event detail modal ───────────────────────────────────────────────────────

function EventDetail({
  event,
  onClose,
}: {
  event: Event;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const allCats = [
    ...new Set(event.categories.map((c) => c.category)),
  ].sort(
    (a, b) =>
      (CATEGORY_ORDER.indexOf(a) ?? 99) - (CATEGORY_ORDER.indexOf(b) ?? 99)
  );
  const [selectedCats, setSelectedCats] = useState<Set<string>>(
    new Set(allCats)
  );

  useEffect(() => {
    fetch(`/api/tickets/events/${event.id}/history`)
      .then((r) => r.json())
      .then(setHistory)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [event.id]);

  const toggleCat = (cat: string) => {
    setSelectedCats((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) {
        if (next.size > 1) next.delete(cat);
      } else {
        next.add(cat);
      }
      return next;
    });
  };

  // Available categories from history data
  const histCats = [
    ...new Set(history.map((h) => h.category)),
  ].sort(
    (a, b) =>
      (CATEGORY_ORDER.indexOf(a) ?? 99) - (CATEGORY_ORDER.indexOf(b) ?? 99)
  );

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-2xl rounded-2xl bg-gray-900 border border-gray-800 p-5 max-h-[90vh] overflow-y-auto">
        <div className="mb-4">
          <div className="flex items-start justify-between">
            <h3 className="font-semibold text-gray-100 pr-2">{fmtTitle(event.title)}</h3>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-300 text-xl leading-none flex-shrink-0"
            >
              ×
            </button>
          </div>
          <div className="flex items-center gap-3 mt-1 flex-wrap">
            <p className="text-sm text-gray-500">
              {fmtDate(event.event_datetime)}
              {event.venue && <span> · {event.venue}</span>}
            </p>
            {event.stubhub_url && (
              <a
                href={event.stubhub_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-2.5 py-1 rounded-lg bg-blue-900/40 text-blue-400 hover:bg-blue-900/60 transition-colors whitespace-nowrap"
              >
                StubHub ↗
              </a>
            )}
          </div>
        </div>

        {/* Category prices grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-5">
          {event.categories
            .sort(
              (a, b) =>
                (CATEGORY_ORDER.indexOf(a.category) ?? 99) -
                (CATEGORY_ORDER.indexOf(b.category) ?? 99)
            )
            .map((c) => {
              return (
                <div
                  key={c.category}
                  className="rounded-lg bg-gray-800 p-3"
                >
                  <div className="flex items-center gap-1.5 mb-1">
                    <span
                      className="w-2 h-2 rounded-full"
                      style={{ backgroundColor: catColor(c.category) }}
                    />
                    <span className="text-xs text-gray-500">
                      {c.category}
                    </span>
                  </div>
                  <div className="text-lg font-bold text-gray-100">
                    {fmtPrice(c.lowest_price)}
                  </div>
                  <div className="text-xs text-gray-600">
                    {c.best_section
                      ? `Section ${fmtSection(c.best_section)}`
                      : "per ticket"}
                  </div>
                </div>
              );
            })}
          {event.listing_count != null && (
            <div className="rounded-lg bg-gray-800 p-3">
              <div className="text-xs text-gray-500 mb-1">
                Total listings
              </div>
              <div className="text-lg font-bold text-gray-100">
                {event.listing_count.toLocaleString()}
              </div>
            </div>
          )}
        </div>
        <p className="text-xs text-gray-600 mb-4">
          Prices are per ticket (qty 2) before StubHub fees (~25-30%)
        </p>

        {/* Price chart */}
        <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
          Price History
        </h4>
        {loading ? (
          <div className="h-32 flex items-center justify-center text-sm text-gray-600">
            Loading...
          </div>
        ) : (
          <>
            <CategoryLegend
              categories={histCats}
              selected={selectedCats}
              onToggle={toggleCat}
            />
            <PriceChart
              data={history}
              categories={[...selectedCats]}
            />
          </>
        )}

        <p className="mt-3 text-xs text-gray-600">
          {new Set(history.map((h: any) => h.polled_at)).size} data point
          {new Set(history.map((h: any) => h.polled_at)).size !== 1 ? "s" : ""}{" "}
          collected
        </p>
      </div>
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function TicketsPage() {
  const [events, setEvents] = useState<Event[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamFilter, setTeamFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [lastPoll, setLastPoll] = useState<string | null>(null);
  const [selected, setSelected] = useState<Event | null>(null);

  const loadEvents = useCallback(() => {
    fetch("/api/tickets/events")
      .then((r) => r.json())
      .then((data: Event[]) => {
        setEvents(data);
        const latest = data.find((e) => e.polled_at);
        if (latest?.polled_at) setLastPoll(latest.polled_at);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetch("/api/tickets/teams")
      .then((r) => r.json())
      .then(setTeams);
    loadEvents();
  }, [loadEvents]);

  const filtered =
    teamFilter === "all"
      ? events
      : events.filter((e) => e.team_slug === teamFilter);

  const teamColor = (slug: string) =>
    teams.find((t) => t.slug === slug)?.color ?? "#6b7280";

  function relTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const m = Math.floor(diff / 60000);
    if (m < 60) return `${m}m ago`;
    return `${Math.floor(m / 60)}h ago`;
  }

  return (
    <div className="p-4 sm:p-8 max-w-4xl">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">
            Tickets
          </h2>
          {lastPoll && (
            <p className="text-sm text-gray-500">
              Updated {relTime(lastPoll)}
            </p>
          )}
        </div>
      </div>

      {/* Team filter */}
      <div className="mb-3 flex items-center gap-1 rounded-lg bg-gray-900 p-1 overflow-x-auto no-scrollbar">
        <button
          onClick={() => setTeamFilter("all")}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap flex-shrink-0 ${
            teamFilter === "all"
              ? "bg-gray-800 text-gray-100"
              : "text-gray-400 hover:text-gray-300"
          }`}
        >
          All
        </button>
        {teams.map((t) => (
          <button
            key={t.slug}
            onClick={() => setTeamFilter(t.slug)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap flex-shrink-0 ${
              teamFilter === t.slug
                ? "bg-gray-800 text-gray-100"
                : "text-gray-400 hover:text-gray-300"
            }`}
          >
            {t.name}
          </button>
        ))}
      </div>

      {/* Enable/disable + stadium guide (team-specific) */}
      {teamFilter !== "all" && (() => {
        const team = teams.find((t) => t.slug === teamFilter);
        return (
          <div className="mb-5 space-y-2">
            <div className="flex items-center gap-3">
              <span className="text-xs text-gray-500">Event Discovery</span>
              <button
                onClick={() => {
                  fetch(`/api/tickets/teams/${teamFilter}/toggle`, {
                    method: "PATCH",
                  })
                    .then((r) => r.json())
                    .then(() => {
                      fetch("/api/tickets/teams")
                        .then((r) => r.json())
                        .then(setTeams);
                    });
                }}
                className={`relative w-9 h-5 rounded-full transition-colors ${
                  team?.enabled === false ? "bg-gray-700" : "bg-green-600"
                }`}
                title={team?.enabled === false ? "Enable event discovery" : "Disable event discovery"}
              >
                <span
                  className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                    team?.enabled === false ? "left-0.5" : "left-[18px]"
                  }`}
                />
              </button>
              <span className="text-xs text-gray-600">
                {team?.enabled === false ? "Off" : "On"}
              </span>
            </div>
            <StadiumGuide teamSlug={teamFilter} />
          </div>
        );
      })()}

      {/* Events grid */}
      {loading ? (
        <div className="text-sm text-gray-600 py-8 text-center">
          Loading...
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-gray-600 py-8 text-center">
          No upcoming events found
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((ev) => {
            const color = teamColor(ev.team_slug);
            const sortedCats = ev.categories.sort(
              (a, b) =>
                (CATEGORY_ORDER.indexOf(a.category) ?? 99) -
                (CATEGORY_ORDER.indexOf(b.category) ?? 99)
            );
            return (
              <button
                key={ev.id}
                onClick={() => setSelected(ev)}
                className="w-full rounded-xl border border-gray-800 bg-gray-900 p-3 text-left hover:border-gray-700 transition-colors"
              >
                <div className="flex items-start gap-4">
                  {/* Left: event info */}
                  <div className="flex-shrink-0 min-w-0" style={{ width: "150px" }}>
                    <div className="flex items-center gap-2 mb-1">
                      <span
                        className="text-xs font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
                        style={{
                          background: color + "22",
                          color,
                        }}
                      >
                        {ev.team_name}
                      </span>
                      <span className="text-xs text-gray-500 flex-shrink-0">
                        {fmtCountdown(ev.event_datetime)}
                      </span>
                      {ev.stubhub_url && (
                        <a
                          href={ev.stubhub_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-gray-600 hover:text-blue-400 transition-colors flex-shrink-0"
                          onClick={(e) => e.stopPropagation()}
                          title="View on StubHub"
                        >
                          <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M6 3H3v10h10v-3" />
                            <path d="M9 2h5v5" />
                            <path d="M14 2L7 9" />
                          </svg>
                        </a>
                      )}
                    </div>
                    <p className="text-sm font-medium text-gray-200 line-clamp-1">
                      {fmtTitle(ev.title)}
                    </p>
                    <p className="text-xs text-gray-500 whitespace-nowrap">
                      {fmtDate(ev.event_datetime)}
                    </p>
                    {ev.weather_high != null && (
                      <p className="text-xs text-gray-500">
                        {Math.round(ev.weather_high)}°/{Math.round(ev.weather_low!)}°F
                        {ev.weather_precip_pct != null && ev.weather_precip_pct > 0 && (
                          <span className={ev.weather_precip_pct >= 50 ? "text-blue-400" : "text-gray-600"}>
                            {" "}{ev.weather_precip_pct}% rain
                          </span>
                        )}
                      </p>
                    )}
                    {ev.listing_count != null && (
                      <p className="text-xs text-gray-600">
                        {ev.listing_count.toLocaleString()} listings
                      </p>
                    )}
                  </div>

                  {/* Right: category prices stacked vertically */}
                  {sortedCats.length > 0 ? (
                    <div className="min-w-0 space-y-0.5 flex-1">
                      {sortedCats.map((c) => (
                        <div
                          key={c.category}
                          className="flex items-center gap-2"
                        >
                          <span
                            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                            style={{
                              backgroundColor: catColor(c.category),
                            }}
                          />
                          <span className="text-xs text-gray-500 flex-1 min-w-0 truncate">
                            {c.category}
                          </span>
                          <span className="text-xs font-medium text-gray-300 whitespace-nowrap">
                            {fmtPrice(c.lowest_price)}
                          </span>
                          {c.best_section && (
                            <span className="text-xs text-gray-600 whitespace-nowrap w-8 text-right">
                              {fmtSection(c.best_section)}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-600 flex-1">
                      No price data yet
                    </div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}


      {/* Detail modal */}
      {selected && (
        <EventDetail
          event={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
