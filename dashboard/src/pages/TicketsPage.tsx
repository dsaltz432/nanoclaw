import { useState, useEffect, useCallback, useRef } from "react";
// Stadium map images served from /images/

// ── Types ─────────────────────────────────────────────────────────────────────

interface Team {
  slug: string;
  name: string;
  sport: string;
  color: string;
  enabled?: boolean;
  home_venue_slug?: string;
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
  venue_slug: string | null;
  event_datetime: string | null;
  stubhub_url: string | null;
  status: string;
  is_home_game: number | null;
  categories: CategoryPrice[];
  overall_lowest: number | null;
  listing_count: number | null;
  polled_at: string | null;
  weather_high: number | null;
  weather_low: number | null;
  weather_precip_pct: number | null;
}

interface Venue {
  slug: string;
  name: string;
  sport: string;
  home_team_slug?: string;
  description?: string;
}

interface Snapshot {
  category: string;
  polled_at: string;
  days_until: number;
  hours_until: number;
  lowest_price: number | null;
  listing_count: number | null;
  weather_high: number | null;
  weather_low: number | null;
  weather_precip_pct: number | null;
}


// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return "Date TBD";
  const d = new Date(iso.includes("+") || iso.endsWith("Z") ? iso : iso + "Z");
  if (isNaN(d.getTime())) return "Date TBD";
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }) + " ET";
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

// Category display order + colors (all venues, all sports).
// Colors map premium (amber/pink) → upper (emerald/teal) → standing (gray).
const CATEGORY_COLORS: Record<string, string> = {
  // Floor / Courtside tier — most premium
  "Floor / Courtside": "#f59e0b",
  "Courtside / Floor": "#f59e0b",

  // Field / Lower Sideline / Premium lower — premium
  "Field Level": "#f59e0b",
  "Field Box": "#f59e0b",
  "Lower Sideline": "#f59e0b",
  "Lower Level Sideline": "#f59e0b",
  "Lower Prime (50-yd line)": "#fbbf24",
  "Premium": "#ec4899",
  "Premium Main Level": "#e879f9",
  "Monster Seated": "#f472b6",
  "Dawg Pound": "#f97316",

  // Club / Loge / Mezzanine / Bridge
  "Club Level": "#e879f9",
  "Club / Loge": "#e879f9",
  "Club / VIP": "#ec4899",
  "Club / Bridge": "#d946ef",
  "Loge Box": "#e879f9",
  "Mezzanine / Club": "#a855f7",
  "Mezzanine": "#a855f7",
  "Mid-Level": "#a78bfa",

  // Lower bowl / 100 level / Lower End Zone
  "Lower Bowl": "#3b82f6",
  "100 Level": "#3b82f6",
  "Lower End Zone": "#60a5fa",
  "Lower Level End Zone": "#60a5fa",
  "Lower Reserved": "#93c5fd",
  "Lower Corner": "#60a5fa",
  "Lower Corner / Club": "#818cf8",

  // Outfield / Corners (MLB)
  "Field Outfield / Corners": "#06b6d4",
  "Outfield / Corners": "#06b6d4",
  "Grandstand": "#22d3ee",
  "Right Field / Pavilion": "#06b6d4",
  "Pavilion": "#06b6d4",
  "Top Deck": "#14b8a6",
  "Rooftop": "#14b8a6",
  "Western Metal Building": "#0891b2",
  "Crawford Boxes": "#0891b2",
  "Left Field Deck": "#0891b2",
  "Right Field Terrace": "#0891b2",
  "Outfield Berm": "#22d3ee",
  "Rockpile": "#0e7490",
  "Fountain View": "#0891b2",
  "Arcade": "#06b6d4",

  // Upper tiers
  "Upper Bowl": "#10b981",
  "Upper Level": "#10b981",
  "Upper Deck": "#10b981",
  "200 Level": "#10b981",
  "Upper Sideline": "#10b981",
  "Upper End Zone": "#34d399",
  "Upper Reserved": "#6ee7b7",
  "Suites": "#5eead4",

  // Bleachers / Standing Room / GA
  "Bleachers": "#8b5cf6",
  "Monster Standing": "#6366f1",
  "Standing Room": "#6b7280",
  "General Admission": "#6b7280",

  // Tournament-specific (FIFA World Cup at MetLife)
  "Premium Hospitality": "#ec4899",
  "Supporters": "#fb923c",
  "FIFA Category Seats": "#10b981",

  Overall: "#ef4444",
};

const CATEGORY_ORDER = [
  // Floor / Courtside (most premium)
  "Floor / Courtside",
  "Courtside / Floor",
  // Premium lower / sideline
  "Field Level",
  "Field Box",
  "Premium",
  "Premium Main Level",
  "Monster Seated",
  "Dawg Pound",
  "Lower Prime (50-yd line)",
  "Lower Sideline",
  "Lower Level Sideline",
  // Club / Loge
  "Club Level",
  "Club / Loge",
  "Club / VIP",
  "Club / Bridge",
  "Loge Box",
  "Mezzanine / Club",
  "Mezzanine",
  "Mid-Level",
  // Lower bowl / 100s / Lower End Zone
  "Lower Bowl",
  "100 Level",
  "Lower End Zone",
  "Lower Level End Zone",
  "Lower Reserved",
  "Lower Corner",
  "Lower Corner / Club",
  // Outfield / ballpark specialty
  "Outfield / Corners",
  "Field Outfield / Corners",
  "Grandstand",
  "Crawford Boxes",
  "Western Metal Building",
  "Right Field / Pavilion",
  "Pavilion",
  "Left Field Deck",
  "Right Field Terrace",
  "Arcade",
  "Fountain View",
  "Rockpile",
  "Top Deck",
  "Rooftop",
  "Outfield Berm",
  // Upper tiers
  "Upper Bowl",
  "Upper Level",
  "Upper Deck",
  "200 Level",
  "Upper Sideline",
  "Upper End Zone",
  "Upper Reserved",
  "Suites",
  // Bleachers / Standing Room
  "Bleachers",
  "Monster Standing",
  "Standing Room",
  "General Admission",
  // Tournament-specific (FIFA WC at MetLife): hospitality > supporters > FIFA tiers
  "Premium Hospitality",
  "Supporters",
  "FIFA Category Seats",
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

// Venue descriptions per category — used in the stadium guide.
// Keyed by venue_slug. Only covers home venues we have detailed mappings for;
// opponent venues fall back to the generic tier labels from venues-config.json.
const VENUE_INFO: Record<
  string,
  {
    venue: string;
    description: string;
    categories: Record<string, string>;
  }
> = {
  "yankee-stadium": {
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
  "fenway-park": {
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
      "Monster Seated":
        "M sections (7-10). Iconic left field wall seats atop the 37-foot Green Monster. Limited availability, unique perspective.",
      "Bleachers":
        "B sections (87+). Outfield seating. Lively atmosphere, good value.",
      "Right Field / Pavilion":
        "PB (Pavilion Box), R (Roof), and AP (State Street Pavilion) sections. Right field elevated seating.",
      "Standing Room":
        "Standing room only — general admission areas including Green Monster standing (SRGM) and right field deck (SRRD).",
    },
  },
  "madison-square-garden": {
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
  "barclays-center": {
    venue: "Barclays Center",
    description:
      "Octagonal arena in Brooklyn. Court is centered with seating on all sides. Single-digit sections (1-31) are the closest tier, 100-series is mid-level, 200-series is upper bowl.",
    categories: {
      "Floor / Courtside":
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
  "metlife-stadium": {
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
      "FIFA Category Seats":
        "World Cup-only. FIFA's standardized price tiers (Category 1–4). Category 1 is the highest tier, Category 4 the lowest; specific sections are assigned by FIFA at fulfillment.",
      "Supporters":
        "World Cup-only. National-team supporters sections (Premium / Standard / Value tiers per nation). Located in dedicated end-zone fan blocks.",
      "Premium Hospitality":
        "World Cup-only. FIFA Pavilion, Trophy Lounge, Champions Club, Pitchside Lounge, VIP — premium hospitality experiences with food/drink/access included.",
    },
  },
};

// ── Stadium guide (collapsible) ─────────────────────────────────────────────

interface CategoryInfo {
  category: string;
  sections: string[];
  count: number;
}

function StadiumGuide({ venueSlug, venueName }: { venueSlug: string; venueName?: string }) {
  const [open, setOpen] = useState(false);
  const [categories, setCategories] = useState<CategoryInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || loaded) return;
    fetch(`/api/tickets/categories?venue=${venueSlug}`)
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
  }, [open, loaded, venueSlug]);

  // Reset when venue changes
  useEffect(() => {
    setLoaded(false);
    setCategories([]);
    setOpen(false);
  }, [venueSlug]);

  const info = VENUE_INFO[venueSlug] ?? (venueName ? {
    venue: venueName,
    description: "Generic seating tiers (Lower / Club / Upper) based on section numbering. Specific section mappings for this venue have not been curated yet.",
    categories: {},
  } : null);
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
          {venueSlug === "yankee-stadium" && (
            <div className="mb-4 rounded-lg overflow-hidden bg-white">
              <img
                src="/images/yankee-stadium-map.png"
                alt="Yankee Stadium Seating Map"
                className="w-full"
              />
            </div>
          )}
          {venueSlug === "fenway-park" && (
            <div className="mb-4 rounded-lg overflow-hidden bg-white p-2">
              <img
                src="/images/fenway-park-map.png"
                alt="Fenway Park Seating Map"
                className="w-full max-w-lg mx-auto"
              />
            </div>
          )}
          {venueSlug === "madison-square-garden" && (
            <div className="mb-4 rounded-lg overflow-hidden bg-white p-2">
              <img
                src="/images/msg-map.png"
                alt="Madison Square Garden Seating Map"
                className="w-full max-w-lg mx-auto"
              />
            </div>
          )}
          {venueSlug === "barclays-center" && (
            <div className="mb-4 rounded-lg overflow-hidden bg-white p-2">
              <img
                src="/images/barclays-center-map.png"
                alt="Barclays Center Seating Map"
                className="w-full max-w-md mx-auto"
              />
            </div>
          )}
          {venueSlug === "metlife-stadium" && (
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

// ── Scraper health panel ─────────────────────────────────────────────────────

interface ErrorBucket {
  bucket_ts: number;
  runs: number;
  events_scraped: number;
  events_failed: number;
}

const ERROR_WINDOWS = [
  { label: "3h", hours: 3 },
  { label: "1d", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "1w", hours: 168 },
  { label: "1mo", hours: 720 },
];

function ErrorsChart() {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<{ bucket_minutes: number; buckets: ErrorBucket[] } | null>(null);
  const [hov, setHov] = useState<number | null>(null);

  useEffect(() => {
    fetch(`/api/tickets/errors-timeseries?hours=${hours}`)
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData(null));
  }, [hours]);

  if (!data) return null;
  const buckets = data.buckets;

  const W = 720, H = 140, padL = 28, padR = 8, padT = 8, padB = 28;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  // Build a continuous bucket axis: fill empty buckets with zero so we don't
  // collapse gaps in time when the Pricer happened not to run.
  const bucketSec = data.bucket_minutes * 60;
  const nowSec = Math.floor(Date.now() / 1000);
  const startSec = (nowSec - hours * 3600) - ((nowSec - hours * 3600) % bucketSec);
  const endSec = nowSec - (nowSec % bucketSec);
  const numBuckets = Math.max(1, Math.floor((endSec - startSec) / bucketSec) + 1);
  const byTs = new Map(buckets.map((b) => [b.bucket_ts, b]));
  const series: ErrorBucket[] = [];
  for (let t = startSec; t <= endSec; t += bucketSec) {
    series.push(byTs.get(t) ?? { bucket_ts: t, runs: 0, events_scraped: 0, events_failed: 0 });
  }

  const maxTotal = Math.max(1, ...series.map((b) => b.events_scraped + b.events_failed));
  const yTicks = maxTotal <= 4
    ? [0, Math.ceil(maxTotal / 2), maxTotal]
    : [0, Math.ceil(maxTotal / 2), maxTotal];

  const barW = chartW / numBuckets;
  const gap = barW > 4 ? 1 : 0;
  const toY = (v: number) => padT + chartH - (v / maxTotal) * chartH;

  // X-axis labels: ~5 evenly spaced tick labels
  const tickCount = Math.min(5, series.length);
  const tickIdxs: number[] = [];
  for (let i = 0; i < tickCount; i++) {
    tickIdxs.push(Math.round(((series.length - 1) * i) / Math.max(1, tickCount - 1)));
  }
  const fmtTs = (ts: number) => {
    const d = new Date(ts * 1000);
    if (hours <= 24) {
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
    }
    if (hours <= 168) {
      return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", timeZone: "America/New_York" });
    }
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
  };

  const totalScraped = series.reduce((s, b) => s + b.events_scraped, 0);
  const totalFailed = series.reduce((s, b) => s + b.events_failed, 0);
  const totalEvents = totalScraped + totalFailed;
  const successPct = totalEvents > 0 ? Math.round((100 * totalScraped) / totalEvents) : 0;
  const totalRuns = series.reduce((s, b) => s + b.runs, 0);

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-gray-500">Event-poll outcomes over time</div>
        <div className="flex items-center gap-1">
          {ERROR_WINDOWS.map((w) => (
            <button
              key={w.label}
              onClick={(e) => { e.stopPropagation(); setHours(w.hours); }}
              className={`px-2 py-0.5 text-xs rounded transition-colors ${
                hours === w.hours ? "bg-gray-700 text-gray-200" : "text-gray-500 hover:text-gray-400"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* Legend + totals */}
      <div className="flex items-center gap-3 mb-1 text-[10px] font-mono">
        <span className="text-emerald-400">● scraped {totalScraped}</span>
        <span className="text-rose-400">● failed {totalFailed}</span>
        <span className={successPct >= 80 ? "text-emerald-400" : successPct >= 60 ? "text-amber-400" : "text-rose-400"}>
          {successPct}% success
        </span>
        <span className="text-gray-600">· {totalRuns} runs</span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {/* Y grid + labels */}
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={padL} y1={toY(v)} x2={W - padR} y2={toY(v)} stroke="#1f2937" strokeWidth={0.5} />
            <text x={padL - 4} y={toY(v) + 3} textAnchor="end" fontSize={9} fill="#6b7280" fontFamily="monospace">{v}</text>
          </g>
        ))}

        {/* Stacked bars: scraped (emerald) + failed (rose) */}
        {series.map((b, i) => {
          const x = padL + i * barW;
          const scrapedY = toY(b.events_scraped);
          const failedY = toY(b.events_scraped + b.events_failed);
          const isHov = hov === i;
          const opacity = hov == null || isHov ? 1 : 0.5;
          return (
            <g key={i}
               onMouseEnter={() => setHov(i)}
               onMouseLeave={() => setHov(null)}
               opacity={opacity}>
              <rect x={x} y={padT} width={barW} height={chartH} fill="transparent" />
              {b.events_scraped > 0 && (
                <rect x={x + gap / 2} y={scrapedY} width={Math.max(1, barW - gap)} height={padT + chartH - scrapedY} fill="#10b981" />
              )}
              {b.events_failed > 0 && (
                <rect x={x + gap / 2} y={failedY} width={Math.max(1, barW - gap)} height={scrapedY - failedY} fill="#f43f5e" />
              )}
            </g>
          );
        })}

        {/* X-axis labels */}
        {tickIdxs.map((idx, i) => {
          const x = padL + idx * barW + barW / 2;
          return (
            <text key={i} x={x} y={H - 8} textAnchor="middle" fontSize={9} fill="#6b7280">
              {fmtTs(series[idx].bucket_ts)}
            </text>
          );
        })}

        {/* Axes */}
        <line x1={padL} y1={padT + chartH} x2={W - padR} y2={padT + chartH} stroke="#374151" strokeWidth={1} />
        <line x1={padL} y1={padT} x2={padL} y2={padT + chartH} stroke="#374151" strokeWidth={1} />

        {/* Hover tooltip */}
        {hov != null && (() => {
          const b = series[hov];
          const x = padL + hov * barW + barW / 2;
          const TW = 160, TH = 60;
          const tx = Math.max(padL, Math.min(x - TW / 2, W - padR - TW));
          const total = b.events_scraped + b.events_failed;
          const pct = total > 0 ? Math.round((100 * b.events_scraped) / total) : 0;
          return (
            <g transform={`translate(${tx},${padT})`}>
              <rect width={TW} height={TH} rx={4} fill="#111827" stroke="#374151" />
              <text x={TW / 2} y={14} textAnchor="middle" fontSize={9} fill="#9ca3af">{fmtTs(b.bucket_ts)}</text>
              <text x={8} y={28} fontSize={10} fill="#10b981">● scraped {b.events_scraped}</text>
              <text x={8} y={41} fontSize={10} fill="#f43f5e">● failed {b.events_failed}</text>
              <text x={8} y={54} fontSize={10} fill="#9ca3af">{pct}% · {b.runs} run{b.runs === 1 ? "" : "s"}</text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

interface HealthData {
  last_run?: { run_at: string; status: string; duration_ms: number; summary: string | null } | null;
  recent_runs?: Array<{ run_at: string; status: string; duration_ms: number; summary: string | null }>;
  game_day?: Array<{ id: number; title: string; event_datetime: string; hours_until: number; last_polled: string | null; minutes_since_poll: number | null }>;
  stuck_events?: Array<{ id: number; title: string; team_slug: string; venue_slug: string; hours_until: number; overdue_ratio: number | null; kind: "never" | "overdue" }>;
  counts?: { active_or_pending: number; never_polled: number; events_polled_60min: number };
}

function relMin(minutes: number): string {
  if (minutes < 1) return "now";
  if (minutes < 60) return `${Math.round(minutes)}m ago`;
  const h = Math.round(minutes / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function HealthPanel() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/tickets/health")
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Status decision: red if last run >2h old or task-level failed; amber if
  // any game-day event is stale OR recent event-level success rate < 60%;
  // green otherwise. We compute success rate by parsing the same scraped/errors
  // counts the errors-timeseries endpoint uses, so badge and chart agree.
  const lastRunAgeMin = data?.last_run
    ? (Date.now() - new Date(data.last_run.run_at).getTime()) / 60000
    : null;
  const lastRunFailed = data?.last_run && data.last_run.status !== "success";
  const staleGameDay = (data?.game_day ?? []).filter(
    (g) => g.minutes_since_poll == null || g.minutes_since_poll > 60
  );

  // Parse event-level scraped/errors counts from the last ~8 run summaries.
  const parseCount = (text: string, ...patterns: RegExp[]): number => {
    for (const re of patterns) {
      const m = text.match(re);
      if (m) {
        for (let i = 1; i < m.length; i++) if (m[i] != null) return parseInt(m[i], 10);
      }
    }
    return 0;
  };
  const recentRuns = (data?.recent_runs ?? []).slice(0, 8);
  let recentScraped = 0;
  let recentFailed = 0;
  for (const r of recentRuns) {
    const txt = r.summary ?? "";
    recentScraped += parseCount(txt, /scraped:\s*(\d+)/i, /(\d+)\s+(?:events?\s+)?scraped/i);
    recentFailed += parseCount(txt, /errors:\s*(\d+)/i, /(\d+)\s+(?:WAF\s+)?errors?/i);
  }
  const recentTotal = recentScraped + recentFailed;
  const recentSuccessPct = recentTotal > 0 ? (recentScraped / recentTotal) * 100 : 100;

  const status: "ok" | "warn" | "down" =
    !data || lastRunAgeMin == null
      ? "warn"
      : lastRunAgeMin > 120 || lastRunFailed
        ? "down"
        : staleGameDay.length > 0 || recentSuccessPct < 60
          ? "warn"
          : "ok";

  const statusLabel =
    status === "ok" ? "Healthy" : status === "warn" ? "Degraded" : "Down";
  const statusColor =
    status === "ok" ? "text-emerald-400 bg-emerald-900/30"
      : status === "warn" ? "text-amber-400 bg-amber-900/30"
        : "text-rose-400 bg-rose-900/30";

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 mb-5">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-800/50 transition-colors rounded-xl"
      >
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm font-semibold text-gray-300">Scraper health</span>
          <span className={`text-xs px-2 py-0.5 rounded ${statusColor}`}>● {statusLabel}</span>
          {data?.last_run && lastRunAgeMin != null && (
            <span className="text-xs text-gray-500">
              Last run <span className="text-gray-300">{relMin(lastRunAgeMin)}</span>
            </span>
          )}
          {data?.game_day && data.game_day.length > 0 && (
            <span className="text-xs text-gray-500">
              <span className="text-gray-300">{data.game_day.length}</span> game-day event{data.game_day.length === 1 ? "" : "s"}
              {staleGameDay.length > 0 && (
                <span className="text-amber-400"> · {staleGameDay.length} stale</span>
              )}
            </span>
          )}
          {data?.stuck_events && data.stuck_events.length > 0 && (
            <span className="text-xs text-gray-500">
              <span className="text-amber-400">{data.stuck_events.length}</span> stuck
            </span>
          )}
        </div>
        <svg
          className={`w-4 h-4 text-gray-500 transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div className="px-4 pb-4 border-t border-gray-800 text-xs">
          {loading && !data && <div className="py-3 text-gray-600">Loading...</div>}
          {data && (
            <>
              {/* Game-day events (the most important data to keep fresh) */}
              {data.game_day && data.game_day.length > 0 && (
                <div className="mt-3 mb-4">
                  <div className="text-gray-500 mb-1.5">Game-day events (&lt; 24h)</div>
                  <div className="space-y-1">
                    {data.game_day.map((g) => {
                      const stale = g.minutes_since_poll == null || g.minutes_since_poll > 60;
                      return (
                        <div key={g.id} className="flex items-center gap-2">
                          <span className={stale ? "text-amber-400" : "text-emerald-400"}>●</span>
                          <span className="text-gray-300 flex-1 truncate">{g.title}</span>
                          <span className="text-gray-500 whitespace-nowrap">
                            {g.hours_until.toFixed(1)}h to game
                          </span>
                          <span className={`whitespace-nowrap ${stale ? "text-amber-400" : "text-gray-500"}`}>
                            {g.minutes_since_poll == null ? "never polled" : `polled ${relMin(g.minutes_since_poll)}`}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Stuck events — overdue by >3x tier or never polled */}
              {data.stuck_events && data.stuck_events.length > 0 && (
                <div className="mb-4">
                  <div className="text-gray-500 mb-1.5">
                    Stuck events <span className="text-gray-600">(overdue {">"}3× tier interval)</span>
                  </div>
                  <div className="space-y-1">
                    {data.stuck_events.slice(0, 8).map((e) => (
                      <div key={e.id} className="flex items-center gap-2">
                        <span className="text-amber-400">●</span>
                        <span className="text-gray-300 flex-1 truncate">{e.title}</span>
                        <span className="text-gray-600 whitespace-nowrap">{e.team_slug}</span>
                        <span className="text-gray-500 whitespace-nowrap w-16 text-right">
                          {e.hours_until < 24 ? `${e.hours_until.toFixed(0)}h` : `${(e.hours_until / 24).toFixed(0)}d`}
                        </span>
                        <span className="text-amber-400 whitespace-nowrap w-16 text-right">
                          {e.kind === "never" ? "never" : `${e.overdue_ratio?.toFixed(1)}× late`}
                        </span>
                      </div>
                    ))}
                    {data.stuck_events.length > 8 && (
                      <div className="text-gray-600 ml-4">+ {data.stuck_events.length - 8} more</div>
                    )}
                  </div>
                </div>
              )}

              {/* Compact KPIs — only the ones actionable */}
              {data.counts && (
                <div className="grid grid-cols-3 gap-3 mb-4 pb-3 border-b border-gray-800">
                  <Stat label="Active events" value={data.counts.active_or_pending} />
                  <Stat label="Polled in last hour" value={data.counts.events_polled_60min} />
                  <Stat label="Never polled" value={data.counts.never_polled}
                        tone={data.counts.never_polled > 0 ? "warn" : "ok"} />
                </div>
              )}

              {/* Errors / outcomes over time */}
              <ErrorsChart />

              {/* Recent runs timeline */}
              <div className="flex items-center justify-between mb-2">
                <div className="text-gray-500">Recent runs</div>
                <button
                  onClick={(e) => { e.stopPropagation(); load(); }}
                  className="text-gray-500 hover:text-gray-300"
                >↻ refresh</button>
              </div>
              <div className="space-y-1.5">
                {data.recent_runs?.map((r) => {
                  const ts = new Date(r.run_at).toLocaleString("en-US", {
                    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                    timeZone: "America/New_York",
                  });
                  const summary = r.summary ?? "";
                  const hasWaf = /waf/i.test(summary) && !/no waf/i.test(summary);
                  const hasError = /error/i.test(summary) && !/0 errors?/i.test(summary);
                  const tone =
                    r.status !== "success" ? "text-rose-400"
                      : hasWaf ? "text-amber-400"
                      : hasError ? "text-rose-400"
                      : "text-emerald-400";
                  return (
                    <div key={r.run_at} className="flex items-start gap-2 font-mono">
                      <span className={`flex-shrink-0 ${tone}`}>●</span>
                      <span className="text-gray-500 flex-shrink-0 w-20">{ts}</span>
                      <span className="text-gray-600 flex-shrink-0 w-12 text-right">
                        {Math.round(r.duration_ms / 1000)}s
                      </span>
                      <span className="text-gray-400 truncate">
                        {summary.replace(/\s+/g, " ").trim() || "(no summary)"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string | null | undefined; tone?: "ok" | "warn" }) {
  const valColor =
    tone === "warn" ? "text-amber-400" : tone === "ok" ? "text-emerald-400" : "text-gray-200";
  return (
    <div>
      <div className="text-gray-600">{label}</div>
      <div className={`text-base font-semibold ${valColor}`}>{value ?? "—"}</div>
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
  const catPriceMap = new Map(event.categories.map((c) => [c.category, c.lowest_price]));
  const allCats = [
    ...new Set(event.categories.map((c) => c.category)),
  ].sort((a, b) => (catPriceMap.get(b) ?? 0) - (catPriceMap.get(a) ?? 0));
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
  ].sort((a, b) => (catPriceMap.get(b) ?? 0) - (catPriceMap.get(a) ?? 0));

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
              {event.is_home_game != null && (
                <span className={event.is_home_game === 1 ? " text-emerald-400" : " text-amber-400"}>
                  {" "}· {event.is_home_game === 1 ? "Home" : "Away"}
                </span>
              )}
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
            .sort((a, b) => b.lowest_price - a.lowest_price)
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
  const [venues, setVenues] = useState<Venue[]>([]);
  const [teamFilter, setTeamFilter] = useState("all");
  const [gameTypeFilter, setGameTypeFilter] = useState<"all" | "home" | "away">("all");
  const [loading, setLoading] = useState(true);
  const [lastPoll, setLastPoll] = useState<string | null>(null);
  const [selected, setSelected] = useState<Event | null>(null);
  const [showPast, setShowPast] = useState(false);

  // team_slug -> home venue_slug. Prefer the team's own home_venue_slug
  // (covers tournament entries like World Cup whose venue isn't reverse-linked
  // via venues-config.home_team_slug); fall back to the venues registry.
  const homeVenueForTeam: Record<string, string> = {};
  for (const v of venues) {
    if (v.home_team_slug) homeVenueForTeam[v.home_team_slug] = v.slug;
  }
  for (const t of teams) {
    if (t.home_venue_slug) homeVenueForTeam[t.slug] = t.home_venue_slug;
  }
  // venue_slug -> venue name
  const venueName: Record<string, string> = {};
  for (const v of venues) venueName[v.slug] = v.name;

  const loadEvents = useCallback(() => {
    const url = showPast
      ? "/api/tickets/events?include_past=1"
      : "/api/tickets/events";
    fetch(url)
      .then((r) => r.json())
      .then((data: Event[]) => {
        setEvents(data);
        const latest = data.find((e) => e.polled_at);
        if (latest?.polled_at) setLastPoll(latest.polled_at);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [showPast]);

  useEffect(() => {
    fetch("/api/tickets/teams")
      .then((r) => r.json())
      .then(setTeams);
    fetch("/api/tickets/venues")
      .then((r) => r.json())
      .then(setVenues)
      .catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    loadEvents();
  }, [loadEvents]);

  const filtered = events
    .filter((e) => teamFilter === "all" || e.team_slug === teamFilter)
    .filter((e) => showPast ? e.status === "completed" : e.status !== "completed")
    .filter((e) => {
      if (gameTypeFilter === "all") return true;
      if (gameTypeFilter === "home") return e.is_home_game === 1;
      return e.is_home_game === 0;
    });

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
        <a
          href="/api/tickets/export/snapshots.csv"
          download
          className="rounded-md px-3 py-1.5 text-xs font-medium bg-gray-800 text-gray-300 hover:text-gray-100 transition-colors"
        >
          ↓ Export CSV
        </a>
      </div>

      <HealthPanel />

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

      {/* Controls + stadium guide */}
      {(() => {
        const team = teamFilter !== "all" ? teams.find((t) => t.slug === teamFilter) : null;
        return (
          <div className="mb-5 space-y-2">
            <div className="flex items-center gap-6 flex-wrap">
              {/* Past Games toggle — always visible */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-500">Past Games</span>
                <button
                  onClick={() => setShowPast(!showPast)}
                  className={`relative w-9 h-5 rounded-full transition-colors ${
                    showPast ? "bg-blue-600" : "bg-gray-700"
                  }`}
                >
                  <span
                    className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      showPast ? "left-[18px]" : "left-0.5"
                    }`}
                  />
                </button>
              </div>

              {/* Home/Away filter — always visible */}
              <div className="flex items-center gap-1 rounded-md bg-gray-900 p-0.5">
                {(["all", "home", "away"] as const).map((opt) => (
                  <button
                    key={opt}
                    onClick={() => setGameTypeFilter(opt)}
                    className={`px-2.5 py-1 text-xs font-medium rounded transition-colors capitalize ${
                      gameTypeFilter === opt
                        ? "bg-gray-800 text-gray-100"
                        : "text-gray-500 hover:text-gray-300"
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>

              {/* Event Discovery toggle — team-specific only */}
              {team && (
                <div className="flex items-center gap-2">
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
                      team.enabled === false ? "bg-gray-700" : "bg-green-600"
                    }`}
                    title={team.enabled === false ? "Enable event discovery" : "Disable event discovery"}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                        team.enabled === false ? "left-0.5" : "left-[18px]"
                      }`}
                    />
                  </button>
                  <span className="text-xs text-gray-600">
                    {team.enabled === false ? "Off" : "On"}
                  </span>
                </div>
              )}
            </div>
            {teamFilter !== "all" && homeVenueForTeam[teamFilter] && (
              <StadiumGuide
                venueSlug={homeVenueForTeam[teamFilter]!}
                venueName={teams.find((t) => t.slug === teamFilter)?.name}
              />
            )}
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
            const isPast = ev.status === "completed";
            return (
              <button
                key={ev.id}
                onClick={() => setSelected(ev)}
                className={`w-full rounded-xl border p-3 text-left transition-colors ${
                  isPast
                    ? "border-gray-800/50 bg-gray-900/50 opacity-60"
                    : "border-gray-800 bg-gray-900 hover:border-gray-700"
                }`}
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
                      {ev.is_home_game != null && (
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded flex-shrink-0 ${
                            ev.is_home_game === 1
                              ? "bg-emerald-900/50 text-emerald-400"
                              : "bg-amber-900/50 text-amber-400"
                          }`}
                          title={ev.is_home_game === 1 ? "Home game" : "Away game"}
                        >
                          {ev.is_home_game === 1 ? "H" : "A"}
                        </span>
                      )}
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
