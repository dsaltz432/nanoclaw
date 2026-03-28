import { useEffect, useState, useRef } from "react";
import "leaflet/dist/leaflet.css";
import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import L from "leaflet";

// Fix Leaflet default icon paths broken by Vite bundling
delete (L.Icon.Default.prototype as unknown as Record<string, unknown>)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png",
  iconUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png",
  shadowUrl:
    "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png",
});

// ── Types ──────────────────────────────────────────────────────────────────

interface BeaconEvent {
  id: number;
  title: string;
  category: string;
  emoji?: string;
  date_start: string;
  date_end?: string;
  time?: string | null;
  location?: string;
  venue_id?: number;
  url?: string;
  description?: string;
  sources?: string | null;
}

interface Venue {
  id: string | number;
  name: string;
  city: string;
  type_badge?: string;
  address?: string;
  lat?: number | null;
  lng?: number | null;
  website?: string;
  description?: string;
  has_events?: boolean;
}

interface NewsItem {
  id: string | number;
  title: string;
  source?: string;
  url?: string;
  published_at?: string;
  category?: string;
  discarded?: boolean;
}

interface Meta {
  last_updated: string | null;
  db_exists: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────

const CATEGORIES = [
  { key: "all", label: "All", emoji: "✨" },
  { key: "music", label: "Music", emoji: "🎵" },
  { key: "market", label: "Market", emoji: "🌿" },
  { key: "outdoor", label: "Outdoor", emoji: "🥾" },
  { key: "festival", label: "Festival", emoji: "🎉" },
  { key: "community", label: "Community", emoji: "🏘" },
];

type DateRange = "weekend" | "week" | "2weeks" | "all";

const DATE_RANGES: { key: DateRange; label: string }[] = [
  { key: "weekend", label: "This Weekend" },
  { key: "week", label: "This Week" },
  { key: "2weeks", label: "Next 2 Weeks" },
  { key: "all", label: "All" },
];

const CITY_ORDER = [
  "Beacon",
  "Newburgh",
  "Cold Spring",
  "Garrison",
  "Hudson",
  "Rhinebeck",
  "Tivoli",
];

type VenueFilter = "all" | "beacon" | "food" | "brewery" | "music" | "outdoor" | "events";

const VENUE_FILTERS: { key: VenueFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "beacon", label: "Beacon" },
  { key: "events", label: "Has Events" },
  { key: "food", label: "Food" },
  { key: "brewery", label: "Brewery" },
  { key: "music", label: "Music" },
  { key: "outdoor", label: "Outdoor" },
];

function matchVenueFilter(v: Venue, filter: VenueFilter): boolean {
  if (filter === "all") return true;
  if (filter === "beacon") return v.city === "Beacon";
  if (filter === "events") return !!v.has_events;
  const t = v.type_badge ?? "";
  if (filter === "food") return /restaurant|cafe|bar(?!\/music)|kitchen/i.test(t);
  if (filter === "brewery") return /brewery|distillery|tap/i.test(t);
  if (filter === "music") return /music/i.test(t);
  if (filter === "outdoor") return /outdoor/i.test(t);
  return true;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getDateBounds(range: DateRange): { from: string; to: string } | null {
  if (range === "all") return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const fmt = (d: Date) => d.toISOString().split("T")[0];

  if (range === "weekend") {
    const day = today.getDay(); // 0=Sun,6=Sat
    const daysToSat = day === 6 ? 0 : (6 - day) % 7 || 7;
    const sat = new Date(today);
    sat.setDate(today.getDate() + daysToSat);
    const sun = new Date(sat);
    sun.setDate(sat.getDate() + 1);
    return { from: fmt(sat), to: fmt(sun) };
  }
  if (range === "week") {
    const end = new Date(today);
    end.setDate(today.getDate() + 6);
    return { from: fmt(today), to: fmt(end) };
  }
  // 2weeks
  const end = new Date(today);
  end.setDate(today.getDate() + 13);
  return { from: fmt(today), to: fmt(end) };
}

function formatEventDate(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function parseEventTime(description?: string): string | null {
  if (!description) return null;
  const m = description.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/i);
  return m ? m[1].toLowerCase().replace(/\s/, "") : null;
}

function relativeUpdated(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const CATEGORY_COLORS: Record<string, string> = {
  music: "bg-purple-500/15 text-purple-300 border-purple-500/30",
  market: "bg-green-500/15 text-green-300 border-green-500/30",
  outdoor: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  festival: "bg-pink-500/15 text-pink-300 border-pink-500/30",
  community: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  news: "bg-gray-500/15 text-gray-300 border-gray-500/30",
  opening: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  closing: "bg-red-500/15 text-red-300 border-red-500/30",
};

function CategoryBadge({ cat }: { cat: string }) {
  const cls =
    CATEGORY_COLORS[cat] || "bg-gray-500/15 text-gray-300 border-gray-500/30";
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}
    >
      {cat}
    </span>
  );
}

function FilterPill({
  children,
  active,
  onClick,
  dim,
}: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  dim?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? dim
            ? "border-gray-500 bg-gray-700 text-gray-200"
            : "border-indigo-500 bg-indigo-500/15 text-indigo-300"
          : "border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400"
      }`}
    >
      {children}
    </button>
  );
}

// ── Sub-tabs ───────────────────────────────────────────────────────────────

function EventsTab() {
  const [events, setEvents] = useState<BeaconEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [category, setCategory] = useState("all");
  const [dateRange, setDateRange] = useState<DateRange>("week");

  useEffect(() => {
    setLoading(true);
    const bounds = getDateBounds(dateRange);
    const params = new URLSearchParams();
    if (category !== "all") params.set("category", category);
    if (bounds) {
      params.set("date_from", bounds.from);
      params.set("date_to", bounds.to);
    }
    fetch(`/api/beacon-intel/events?${params}`)
      .then((r) => r.json())
      .then(setEvents)
      .catch(() => setEvents([]))
      .finally(() => setLoading(false));
  }, [category, dateRange]);

  return (
    <div>
      {/* Date range toggle */}
      <div className="mb-4 flex flex-wrap gap-1 rounded-lg bg-gray-900 p-1 w-full sm:w-fit">
        {DATE_RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => setDateRange(r.key)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              dateRange === r.key
                ? "bg-gray-800 text-gray-100"
                : "text-gray-400 hover:text-gray-300"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      {/* Category filter pills */}
      <div className="mb-6 flex flex-wrap gap-2">
        {CATEGORIES.map((c) => (
          <button
            key={c.key}
            onClick={() => setCategory(c.key)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              category === c.key
                ? "border-indigo-500 bg-indigo-500/15 text-indigo-300"
                : "border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-300"
            }`}
          >
            <span>{c.emoji}</span>
            {c.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-sm text-gray-500">Loading events...</div>
      ) : events.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-12 text-center">
          <p className="text-2xl mb-2">📅</p>
          <p className="text-sm text-gray-500">No events found for this filter.</p>
          <p className="mt-1 text-xs text-gray-600">
            Events will appear here once the beacon-intel database is populated.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {events.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventCard({ event }: { event: BeaconEvent }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4 flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <span className="text-xl leading-none">{event.emoji || "📅"}</span>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-gray-100 leading-snug">{event.title}</p>
          <div className="mt-1 flex flex-wrap gap-1.5 items-center">
            <CategoryBadge cat={event.category} />
          </div>
        </div>
      </div>
      <div className="space-y-1 text-xs text-gray-400">
        <div className="flex items-center gap-1.5">
          <svg
            className="h-3 w-3 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 9v7.5"
            />
          </svg>
          {formatEventDate(event.date_start)}
          {event.date_end &&
            event.date_end !== event.date_start &&
            ` – ${formatEventDate(event.date_end)}`}
          {(event.time || parseEventTime(event.description)) && (
            <span className="text-gray-500">· {event.time || parseEventTime(event.description)}</span>
          )}
        </div>
        {event.location && (
          <div className="flex items-center gap-1.5">
            <svg
              className="h-3 w-3 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15 10.5a3 3 0 11-6 0 3 3 0 016 0z"
              />
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1115 0z"
              />
            </svg>
            <span className="truncate">{event.location}</span>
          </div>
        )}
      </div>
      <div className="mt-auto flex items-center justify-between pt-1">
        {event.url ? (
          <a
            href={event.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            View details →
          </a>
        ) : <span />}
        {event.sources && (
          <span className="text-xs text-gray-600" title={event.sources}>
            via {event.sources.split(", ")[0]}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Venues Tab ─────────────────────────────────────────────────────────────

function VenuesTab() {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [loading, setLoading] = useState(true);
  const [showMap, setShowMap] = useState(false);
  const [filter, setFilter] = useState<VenueFilter>("all");
  const mapRef = useRef<boolean>(false);

  useEffect(() => {
    fetch("/api/beacon-intel/venues")
      .then((r) => r.json())
      .then(setVenues)
      .catch(() => setVenues([]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = venues.filter((v) => matchVenueFilter(v, filter));

  // Group by city
  const byCity = filtered.reduce<Record<string, Venue[]>>((acc, v) => {
    const city = v.city || "Other";
    if (!acc[city]) acc[city] = [];
    acc[city].push(v);
    return acc;
  }, {});

  const cities = [
    ...CITY_ORDER.filter((c) => byCity[c]),
    ...Object.keys(byCity)
      .filter((c) => !CITY_ORDER.includes(c))
      .sort(),
  ];

  const mappable = filtered.filter((v) => v.lat != null && v.lng != null);
  const allVenuesHaveCoords = venues.every((v) => v.lat != null || v.lng === undefined);
  const center: [number, number] = [41.5037, -73.971]; // Beacon, NY

  if (loading) {
    return <div className="text-sm text-gray-500">Loading venues...</div>;
  }

  return (
    <div>
      {/* Filter pills + map toggle */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5">
          {VENUE_FILTERS.map((f) => (
            <FilterPill
              key={f.key}
              active={filter === f.key}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </FilterPill>
          ))}
        </div>
        <button
          onClick={() => {
            setShowMap(!showMap);
            mapRef.current = true;
          }}
          className={`shrink-0 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            showMap
              ? "border-indigo-500 bg-indigo-500/10 text-indigo-300"
              : "border-gray-700 text-gray-400 hover:border-gray-600 hover:text-gray-300"
          }`}
        >
          <svg
            className="h-3.5 w-3.5"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 6.75V15m6-6v8.25m.503 3.498l4.875-2.437c.381-.19.622-.58.622-1.006V4.82c0-.836-.88-1.38-1.628-1.006l-3.869 1.934c-.317.159-.69.159-1.006 0L9.503 3.252a1.125 1.125 0 00-1.006 0L3.622 5.689C3.24 5.88 3 6.27 3 6.695V19.18c0 .836.88 1.38 1.628 1.006l3.869-1.934c-.317-.159.69-.159 1.006 0l4.994 2.497c.317.158.69.158 1.006 0z"
            />
          </svg>
          {showMap ? "Hide Map" : "Show Map"}
        </button>
      </div>

      {/* Leaflet Map */}
      {showMap && (
        <div className="mb-6 overflow-hidden rounded-xl border border-gray-800">
          {mappable.length === 0 ? (
            <div className="flex h-[340px] items-center justify-center bg-gray-900 text-sm text-gray-500">
              {allVenuesHaveCoords
                ? "No venues with map coordinates in this filter."
                : "Geocoding venue locations… refresh in a moment to see pins."}
            </div>
          ) : (
            <MapContainer
              center={center}
              zoom={11}
              style={{ height: "340px", width: "100%" }}
              className="z-0"
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {mappable.map((v) => (
                <Marker key={String(v.id)} position={[v.lat!, v.lng!]}>
                  <Popup>
                    <div className="text-sm">
                      <strong>{v.name}</strong>
                      {v.city && <div className="text-gray-500">{v.city}</div>}
                      {v.type_badge && <div>{v.type_badge}</div>}
                      {v.has_events && (
                        <div className="text-green-600 text-xs mt-1">📅 Has upcoming events</div>
                      )}
                      {v.website && (
                        <a
                          href={v.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600"
                        >
                          Website →
                        </a>
                      )}
                    </div>
                  </Popup>
                </Marker>
              ))}
            </MapContainer>
          )}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-12 text-center">
          <p className="text-2xl mb-2">🏘</p>
          <p className="text-sm text-gray-500">No venues match your filters.</p>
        </div>
      ) : filter === "beacon" ? (
        // Flat grid when a single city is selected (no grouping header needed)
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((v) => (
            <VenueCard key={v.id} venue={v} />
          ))}
        </div>
      ) : (
        // Grouped by city
        <div className="space-y-8">
          {cities.map((city) => (
            <div key={city}>
              <h3 className="mb-3 text-sm font-semibold text-gray-300 flex items-center gap-2">
                <span>📍</span>
                {city}
                <span className="text-xs font-normal text-gray-500">
                  ({byCity[city].length})
                </span>
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {byCity[city].map((v) => (
                  <VenueCard key={v.id} venue={v} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function VenueCard({ venue }: { venue: Venue }) {
  return (
    <div className={`rounded-xl border bg-gray-900 p-4 flex flex-col gap-2 ${venue.has_events ? "border-green-800/50" : "border-gray-800"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {venue.has_events && (
            <span className="shrink-0 h-2 w-2 rounded-full bg-green-500" title="Has upcoming events" />
          )}
          <p className="font-medium text-gray-100 leading-snug">{venue.name}</p>
        </div>
        {venue.type_badge && (
          <span className="shrink-0 rounded-full border border-gray-700 bg-gray-800 px-2 py-0.5 text-xs text-gray-400">
            {venue.type_badge}
          </span>
        )}
      </div>
      {venue.description && (
        <p className="text-xs text-gray-400 line-clamp-2">{venue.description}</p>
      )}
      {venue.address && (
        <p className="text-xs text-gray-500">{venue.address}</p>
      )}
      {venue.website && (
        <a
          href={venue.website}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-auto pt-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
        >
          Website →
        </a>
      )}
    </div>
  );
}

// ── News Tab ───────────────────────────────────────────────────────────────

function NewsTab() {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDiscarded, setShowDiscarded] = useState(false);

  useEffect(() => {
    setLoading(true);
    const params = showDiscarded ? "?discarded=1" : "";
    fetch(`/api/beacon-intel/news${params}`)
      .then((r) => r.json())
      .then(setNews)
      .catch(() => setNews([]))
      .finally(() => setLoading(false));
  }, [showDiscarded]);

  return (
    <div>
      {/* Toolbar */}
      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs text-gray-500">
          {showDiscarded ? "Filtered-out items — review and ignore or promote" : "Relevant news and business updates"}
        </p>
        <button
          onClick={() => setShowDiscarded(!showDiscarded)}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            showDiscarded
              ? "border-amber-500/50 bg-amber-500/10 text-amber-300"
              : "border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-400"
          }`}
        >
          <span>{showDiscarded ? "⚠️" : "🗑"}</span>
          {showDiscarded ? "Showing Discarded" : "Review Discarded"}
        </button>
      </div>

      {loading ? (
        <div className="text-sm text-gray-500">Loading...</div>
      ) : news.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-12 text-center">
          <p className="text-2xl mb-2">{showDiscarded ? "✅" : "📰"}</p>
          <p className="text-sm text-gray-500">
            {showDiscarded ? "Nothing in the discard pile." : "No news yet."}
          </p>
          {!showDiscarded && (
            <p className="mt-1 text-xs text-gray-600">
              Local news and restaurant updates will appear here.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {news.map((item) => (
            <NewsCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
}

function NewsCard({ item }: { item: NewsItem }) {
  return (
    <div className="flex items-start gap-4 rounded-xl border border-gray-800 bg-gray-900 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          {item.category && <CategoryBadge cat={item.category} />}
          {item.source && (
            <span className="text-xs text-gray-500">{item.source}</span>
          )}
          {item.published_at && (
            <span className="text-xs text-gray-600">
              {new Date(item.published_at).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
              })}
            </span>
          )}
        </div>
        {item.url ? (
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-gray-200 hover:text-indigo-300 transition-colors"
          >
            {item.title}
          </a>
        ) : (
          <p className="text-sm text-gray-200">{item.title}</p>
        )}
      </div>
      {item.url && (
        <a
          href={item.url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-gray-600 hover:text-gray-400 transition-colors"
        >
          <svg
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
            />
          </svg>
        </a>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

type SubTab = "events" | "venues" | "news";

const SUB_TABS: { key: SubTab; label: string; emoji: string }[] = [
  { key: "events", label: "Events", emoji: "📅" },
  { key: "venues", label: "Venues", emoji: "🏘" },
  { key: "news", label: "News & Intel", emoji: "📰" },
];

export default function BeaconIntelPage() {
  const [activeTab, setActiveTab] = useState<SubTab>("events");
  const [meta, setMeta] = useState<Meta>({ last_updated: null, db_exists: false });

  useEffect(() => {
    fetch("/api/beacon-intel/meta")
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => {});
  }, []);

  return (
    <div className="p-4 sm:p-8">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Beacon Intel</h2>
          <p className="mt-0.5 text-sm text-gray-500">
            Hudson Valley events, venues, and local news
          </p>
        </div>
        <div className="text-right">
          {meta.last_updated ? (
            <div className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-xs">
              <span className="text-gray-500">Last updated </span>
              <span className="text-gray-300">{relativeUpdated(meta.last_updated)}</span>
            </div>
          ) : (
            <div className="rounded-lg border border-gray-800 bg-gray-900 px-3 py-1.5 text-xs text-gray-600">
              {meta.db_exists ? "No update timestamp" : "DB not yet created"}
            </div>
          )}
        </div>
      </div>

      {/* Sub-tab bar */}
      <div className="mb-6 flex gap-1 rounded-lg bg-gray-900 p-1 w-full sm:w-fit">
        {SUB_TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab.key
                ? "bg-gray-800 text-gray-100"
                : "text-gray-400 hover:text-gray-300"
            }`}
          >
            <span>{tab.emoji}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      {activeTab === "events" && <EventsTab />}
      {activeTab === "venues" && <VenuesTab />}
      {activeTab === "news" && <NewsTab />}
    </div>
  );
}
