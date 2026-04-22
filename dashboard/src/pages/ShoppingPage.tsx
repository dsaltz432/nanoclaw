import { useState, useEffect, useCallback, useRef } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface SourcePrice {
  source: string;
  source_url: string | null;
  retailer_slug: string | null;
  retailer_display: string | null;
  price: number;
  in_stock: number;
  verified: number;
  snapshot_source: string | null;
  polled_at: string;
}

interface Product {
  id: number;
  name: string;
  description: string | null;
  source_url: string;
  image_url: string | null;
  category: string | null;
  status: string;
  tracking_enabled: number;
  created_at: string;
  last_checked: string | null;
  prices: SourcePrice[];
  best_price: number | null;
  best_source: string | null;
  best_source_url: string | null;
  best_retailer_display: string | null;
}

interface Snapshot {
  source: string;
  source_url: string | null;
  retailer_slug: string | null;
  retailer_display: string | null;
  price: number;
  in_stock: number;
  verified: number;
  snapshot_source: string | null;
  polled_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const SOURCE_COLORS: Record<string, string> = {
  amazon: "#FF9900",
  walmart: "#0071CE",
  target: "#CC0000",
  bestbuy: "#0046BE",
  reddit: "#FF4500",
  other: "#6b7280",
};

const SOURCE_LABELS: Record<string, string> = {
  amazon: "Amazon",
  walmart: "Walmart",
  target: "Target",
  bestbuy: "Best Buy",
  reddit: "Reddit",
  other: "Other",
};

function sourceColor(source: string): string {
  return SOURCE_COLORS[source.toLowerCase()] ?? "#6b7280";
}

function sourceLabel(source: string, retailerDisplay?: string | null): string {
  if (retailerDisplay) return retailerDisplay;
  return SOURCE_LABELS[source.toLowerCase()] ?? source;
}

function fmtPrice(p: number | null): string {
  if (p == null) return "—";
  return `$${p.toFixed(2)}`;
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function fmtChartDate(polledAt: string): string {
  const d = new Date(
    polledAt.includes("+") || polledAt.endsWith("Z")
      ? polledAt
      : polledAt + "Z"
  );
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "America/New_York",
  });
}

function fmtChartDateTime(polledAt: string): string {
  const d = new Date(
    polledAt.includes("+") || polledAt.endsWith("Z")
      ? polledAt
      : polledAt + "Z"
  );
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  });
}

// ── Price Chart (multi-source) ───────────────────────────────────────────────

const TIME_RANGES = [
  { label: "All", hours: Infinity },
  { label: "1d", hours: 24 },
  { label: "3d", hours: 72 },
  { label: "1w", hours: 168 },
  { label: "2w", hours: 336 },
  { label: "1mo", hours: 720 },
];

function PriceChart({
  data,
  sources,
}: {
  data: Snapshot[];
  sources: string[];
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hov, setHov] = useState<{ idx: number; source: string } | null>(null);
  const [timeRange, setTimeRange] = useState(Infinity);

  const allTimestamps = [...new Set(data.map((d) => d.polled_at))].sort();
  if (allTimestamps.length < 2) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-gray-600">
        {allTimestamps.length === 0
          ? "No price data yet"
          : "Chart needs 2+ data points — check back after the next price check"}
      </div>
    );
  }

  const cutoff =
    timeRange === Infinity ? 0 : Date.now() - timeRange * 3_600_000;
  const filtered = data.filter((d) => {
    if (timeRange === Infinity) return true;
    const t = new Date(
      d.polled_at.includes("+") || d.polled_at.endsWith("Z")
        ? d.polled_at
        : d.polled_at + "Z"
    ).getTime();
    return t >= cutoff;
  });

  const timestamps = [...new Set(filtered.map((d) => d.polled_at))].sort();
  const showRangeFilter = allTimestamps.length > 10;

  // Build per-source time series
  const series: Record<
    string,
    { time: number; price: number; polledAt: string }[]
  > = {};
  for (const src of sources) series[src] = [];
  for (const snap of filtered) {
    if (snap.price != null && sources.includes(snap.source)) {
      if (!series[snap.source]) series[snap.source] = [];
      const t = new Date(
        snap.polled_at.includes("+") || snap.polled_at.endsWith("Z")
          ? snap.polled_at
          : snap.polled_at + "Z"
      ).getTime();
      series[snap.source].push({ time: t, price: snap.price, polledAt: snap.polled_at });
    }
  }
  for (const src of sources) series[src]?.sort((a, b) => a.time - b.time);

  const allPrices = filtered
    .filter((d) => d.price != null && sources.includes(d.source))
    .map((d) => d.price);

  if (allPrices.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-gray-600">
        No price data for selected sources in this range
      </div>
    );
  }

  const allTimes = Object.values(series).flat().map((p) => p.time);
  const minTime = Math.min(...allTimes);
  const maxTime = Math.max(...allTimes);
  const timeSpan = maxTime - minTime || 1;

  const minP = Math.min(...allPrices) * 0.95;
  const maxP = Math.max(...allPrices) * 1.05;
  const pRange = maxP - minP || 1;

  const W = 560,
    H = 200,
    padL = 50,
    padR = 12,
    padT = 12,
    padB = 36;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB;

  const toX = (t: number) => padL + ((t - minTime) / timeSpan) * chartW;
  const toY = (p: number) => padT + chartH - ((p - minP) / pRange) * chartH;

  // Y-axis ticks
  const rawStep = pRange / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const yStep = Math.ceil(rawStep / mag) * mag || 1;
  const yStart = Math.floor(minP / yStep) * yStep;
  const yTicks: number[] = [];
  for (let v = yStart; v <= maxP + yStep; v += yStep) {
    if (v >= minP && v <= maxP) yTicks.push(v);
  }
  if (yTicks.length < 2) yTicks.push(Math.round(minP), Math.round(maxP));

  // X-axis labels
  const xLabelCount = Math.min(5, timestamps.length);
  const xTicks: { time: number; label: string }[] = [];
  for (let i = 0; i < xLabelCount; i++) {
    const t = minTime + (timeSpan * i) / (xLabelCount - 1 || 1);
    let closest = timestamps[0];
    let bestDiff = Infinity;
    for (const ts of timestamps) {
      const tsTime = new Date(
        ts.includes("+") || ts.endsWith("Z") ? ts : ts + "Z"
      ).getTime();
      if (Math.abs(tsTime - t) < bestDiff) {
        bestDiff = Math.abs(tsTime - t);
        closest = ts;
      }
    }
    const label = fmtChartDate(closest);
    if (!xTicks.find((x) => x.label === label)) {
      xTicks.push({
        time: new Date(
          closest.includes("+") || closest.endsWith("Z")
            ? closest
            : closest + "Z"
        ).getTime(),
        label,
      });
    }
  }

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const rect = svgRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = ((e.clientX - rect.left) / rect.width) * W;
      const y = ((e.clientY - rect.top) / rect.height) * H;
      let bestDist = Infinity;
      let bestSrc = "";
      let bestIdx = 0;
      for (const src of sources) {
        for (let i = 0; i < (series[src]?.length ?? 0); i++) {
          const pt = series[src][i];
          const dx = Math.abs(toX(pt.time) - x);
          const dy = Math.abs(toY(pt.price) - y);
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < bestDist) {
            bestDist = dist;
            bestSrc = src;
            bestIdx = i;
          }
        }
      }
      setHov(bestDist < 40 ? { idx: bestIdx, source: bestSrc } : null);
    },
    [sources, series]
  );

  return (
    <div>
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
            <line
              x1={padL}
              y1={toY(v)}
              x2={W - padR}
              y2={toY(v)}
              stroke="#1f2937"
              strokeWidth={0.5}
            />
            <text
              x={padL - 6}
              y={toY(v) + 3.5}
              textAnchor="end"
              fontSize={10}
              fill="#6b7280"
              fontFamily="monospace"
            >
              ${v.toFixed(v >= 100 ? 0 : 2)}
            </text>
          </g>
        ))}

        {/* X-axis labels */}
        {xTicks.map((tick, i) => (
          <g key={i}>
            <line
              x1={toX(tick.time)}
              y1={padT}
              x2={toX(tick.time)}
              y2={padT + chartH}
              stroke="#1f2937"
              strokeWidth={0.5}
              strokeDasharray="4,4"
            />
            <text
              x={toX(tick.time)}
              y={H - 10}
              textAnchor="middle"
              fontSize={10}
              fill="#6b7280"
            >
              {tick.label}
            </text>
          </g>
        ))}

        {/* Lines + dots per source */}
        {sources.map((src) => {
          const pts = series[src] ?? [];
          if (pts.length === 0) return null;
          const color = sourceColor(src);
          const isHovered = hov?.source === src;
          const isDimmed = hov && !isHovered;

          return (
            <g key={src} opacity={isDimmed ? 0.2 : 1}>
              {pts.length >= 2 && (
                <polyline
                  points={pts
                    .map((p) => `${toX(p.time)},${toY(p.price)}`)
                    .join(" ")}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeLinejoin="round"
                />
              )}
              {pts.map((p, i) => (
                <circle
                  key={i}
                  cx={toX(p.time)}
                  cy={toY(p.price)}
                  r={isHovered && hov?.idx === i ? 5 : 3}
                  fill={color}
                  stroke="#111827"
                  strokeWidth={1}
                />
              ))}
            </g>
          );
        })}

        {/* Hover tooltip */}
        {hov &&
          (() => {
            const pts = series[hov.source];
            if (!pts || !pts[hov.idx]) return null;
            const pt = pts[hov.idx];
            const cx = toX(pt.time);
            const cy = toY(pt.price);
            const TW = 160,
              TH = 50;
            const ty = cy - TH - 10 < padT ? cy + 12 : cy - TH - 10;
            const tx = Math.max(padL, Math.min(cx - TW / 2, W - padR - TW));
            return (
              <>
                <line
                  x1={cx}
                  y1={padT}
                  x2={cx}
                  y2={padT + chartH}
                  stroke="#374151"
                  strokeWidth={1}
                  strokeDasharray="3,3"
                />
                <circle
                  cx={cx}
                  cy={cy}
                  r={5}
                  fill={sourceColor(hov.source)}
                  stroke="#f9fafb"
                  strokeWidth={2}
                />
                <g transform={`translate(${tx},${ty})`}>
                  <rect
                    width={TW}
                    height={TH}
                    rx={6}
                    fill="#111827"
                    stroke="#374151"
                    strokeWidth={1}
                  />
                  <text
                    x={TW / 2}
                    y={14}
                    textAnchor="middle"
                    fontSize={9}
                    fill={sourceColor(hov.source)}
                  >
                    {sourceLabel(hov.source)}
                  </text>
                  <text
                    x={TW / 2}
                    y={30}
                    textAnchor="middle"
                    fontSize={14}
                    fontWeight="700"
                    fill="#f9fafb"
                  >
                    {fmtPrice(pt.price)}
                  </text>
                  <text
                    x={TW / 2}
                    y={43}
                    textAnchor="middle"
                    fontSize={9}
                    fill="#6b7280"
                  >
                    {fmtChartDateTime(pt.polledAt)}
                  </text>
                </g>
              </>
            );
          })()}

        {/* Axes */}
        <line
          x1={padL}
          y1={padT + chartH}
          x2={W - padR}
          y2={padT + chartH}
          stroke="#374151"
          strokeWidth={1}
        />
        <line
          x1={padL}
          y1={padT}
          x2={padL}
          y2={padT + chartH}
          stroke="#374151"
          strokeWidth={1}
        />
      </svg>
    </div>
  );
}

// ── Source Legend ──────────────────────────────────────────────────────────────

function SourceLegend({
  sources,
  selected,
  onToggle,
}: {
  sources: string[];
  selected: Set<string>;
  onToggle: (src: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 mb-3">
      {sources.map((src) => {
        const active = selected.has(src);
        return (
          <button
            key={src}
            onClick={() => onToggle(src)}
            className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-md transition-colors ${
              active
                ? "bg-gray-800 text-gray-200"
                : "bg-gray-900 text-gray-600"
            }`}
          >
            <span
              className="w-2.5 h-2.5 rounded-full inline-block"
              style={{
                backgroundColor: sourceColor(src),
                opacity: active ? 1 : 0.3,
              }}
            />
            {sourceLabel(src)}
          </button>
        );
      })}
    </div>
  );
}

// ─�� Product Detail Modal ────────────────────────────────────────────────────

function ProductDetail({
  product,
  onClose,
}: {
  product: Product;
  onClose: () => void;
}) {
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);

  const allSources = [
    ...new Set(product.prices.map((p) => p.source)),
  ].sort();
  const [selectedSources, setSelectedSources] = useState<Set<string>>(
    new Set(allSources)
  );

  useEffect(() => {
    fetch(`/api/shopping/products/${product.id}/history`)
      .then((r) => r.json())
      .then(setHistory)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [product.id]);

  const toggleSource = (src: string) => {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(src)) {
        if (next.size > 1) next.delete(src);
      } else {
        next.add(src);
      }
      return next;
    });
  };

  const histSources = [...new Set(history.map((h) => h.source))].sort();

  // Update selected sources when history loads
  useEffect(() => {
    if (histSources.length > 0 && selectedSources.size === 0) {
      setSelectedSources(new Set(histSources));
    }
  }, [histSources.length]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl rounded-2xl bg-gray-900 border border-gray-800 p-5 max-h-[90vh] overflow-y-auto">
        <div className="mb-4">
          <div className="flex items-start justify-between">
            <div className="flex items-start gap-3 pr-2">
              {product.image_url && (
                <img
                  src={product.image_url}
                  alt={product.name}
                  className="w-12 h-12 rounded-lg object-cover flex-shrink-0"
                />
              )}
              <div>
                <h3 className="font-semibold text-gray-100">{product.name}</h3>
                {product.description && (
                  <p className="text-sm text-gray-500 mt-0.5 line-clamp-2">
                    {product.description}
                  </p>
                )}
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-300 text-xl leading-none flex-shrink-0"
            >
              x
            </button>
          </div>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            <a
              href={product.source_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs px-2.5 py-1 rounded-lg bg-blue-900/40 text-blue-400 hover:bg-blue-900/60 transition-colors"
            >
              Original Link
            </a>
            {product.category && (
              <span className="text-xs text-gray-600">{product.category}</span>
            )}
          </div>
        </div>

        {/* Source comparison table */}
        <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
          Price Comparison
        </h4>
        {product.prices.length > 0 ? (
          <div className="mb-5 space-y-1">
            {[...product.prices]
              .sort((a, b) => a.price - b.price)
              .map((p, i) => (
                <div
                  key={`${p.source}-${i}`}
                  className={`flex items-center gap-3 rounded-lg p-2.5 ${
                    i === 0 && p.in_stock && p.verified
                      ? "bg-green-900/15 border border-green-800/30"
                      : !p.verified
                        ? "bg-gray-800/50 border border-dashed border-gray-700/50"
                        : "bg-gray-800"
                  }`}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{
                      backgroundColor: sourceColor(p.source),
                      opacity: p.verified ? 1 : 0.5,
                    }}
                  />
                  <span className={`text-sm flex-1 ${p.verified ? "text-gray-300" : "text-gray-500"}`}>
                    {sourceLabel(p.source, p.retailer_display)}
                  </span>
                  {!p.verified && (
                    <span className="text-xs text-yellow-500/70">unverified</span>
                  )}
                  {!p.in_stock && (
                    <span className="text-xs text-red-400">Out of stock</span>
                  )}
                  <span
                    className={`text-sm font-semibold ${
                      !p.verified
                        ? "text-gray-500 italic"
                        : i === 0 && p.in_stock
                          ? "text-green-400"
                          : "text-gray-200"
                    }`}
                  >
                    {!p.verified && "~"}{fmtPrice(p.price)}
                  </span>
                  {p.source_url ? (
                    <a
                      href={p.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-gray-600 hover:text-blue-400 transition-colors"
                    >
                      <svg
                        className="w-3.5 h-3.5"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M6 3H3v10h10v-3" />
                        <path d="M9 2h5v5" />
                        <path d="M14 2L7 9" />
                      </svg>
                    </a>
                  ) : (
                    <span className="text-xs text-gray-700">no link</span>
                  )}
                </div>
              ))}
          </div>
        ) : (
          <p className="text-sm text-gray-600 mb-5">
            No prices collected yet. Enable tracking to start.
          </p>
        )}

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
            {histSources.length > 1 && (
              <SourceLegend
                sources={histSources}
                selected={selectedSources}
                onToggle={toggleSource}
              />
            )}
            <PriceChart data={history} sources={[...selectedSources]} />
          </>
        )}

        <p className="mt-3 text-xs text-gray-600">
          {new Set(history.map((h) => h.polled_at)).size} data point
          {new Set(history.map((h) => h.polled_at)).size !== 1 ? "s" : ""}{" "}
          collected
        </p>
      </div>
    </div>
  );
}

// ── Add Product Form ────────────────────────────────────────────────────────

function AddProductForm({
  onAdded,
}: {
  onAdded: (product: Product) => void;
}) {
  const [url, setUrl] = useState("");
  const [parsing, setParsing] = useState(false);
  const [meta, setMeta] = useState<{
    title?: string;
    description?: string;
    image?: string;
  } | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [saving, setSaving] = useState(false);

  const handleParseUrl = async () => {
    if (!url.trim()) return;
    setParsing(true);
    setMeta(null);
    try {
      const resp = await fetch("/api/shopping/products/parse-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = await resp.json();
      setMeta(data);
      setName(data.title || "");
      setDescription(data.description || "");
    } catch {
      setMeta({});
      setName("");
      setDescription("");
    } finally {
      setParsing(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const resp = await fetch("/api/shopping/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          source_url: url.trim(),
          image_url: meta?.image || null,
          category: category.trim() || null,
        }),
      });
      const product = await resp.json();
      onAdded(product);
      // Reset form
      setUrl("");
      setMeta(null);
      setName("");
      setDescription("");
      setCategory("");
    } catch {
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setMeta(null);
    setName("");
    setDescription("");
    setCategory("");
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-4">
      {/* URL input */}
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !meta) handleParseUrl();
          }}
          placeholder="Paste a product URL..."
          className="flex-1 rounded-lg bg-gray-800 border border-gray-700 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-600"
        />
        {!meta && (
          <button
            onClick={handleParseUrl}
            disabled={!url.trim() || parsing}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {parsing ? "Parsing..." : "Add"}
          </button>
        )}
      </div>

      {/* Confirmation form */}
      {meta && (
        <div className="mt-3 space-y-3 border-t border-gray-800 pt-3">
          <p className="text-xs text-gray-500">
            Confirm product details before adding:
          </p>
          <div className="flex gap-3">
            {meta.image && (
              <img
                src={meta.image}
                alt="Product"
                className="w-16 h-16 rounded-lg object-cover flex-shrink-0"
              />
            )}
            <div className="flex-1 space-y-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Product name"
                className="w-full rounded-lg bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-600"
              />
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description (optional)"
                className="w-full rounded-lg bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-600"
              />
              <input
                type="text"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                placeholder="Category (optional, e.g. electronics, home)"
                className="w-full rounded-lg bg-gray-800 border border-gray-700 px-3 py-1.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-gray-600"
              />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={handleCancel}
              className="rounded-lg px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!name.trim() || saving}
              className="rounded-lg bg-green-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-green-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? "Saving..." : "Confirm"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function ShoppingPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Product | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const loadProducts = useCallback(() => {
    fetch("/api/shopping/products")
      .then((r) => r.json())
      .then((data: Product[]) => {
        setProducts(data);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  const handleToggleTracking = async (product: Product) => {
    const newVal = product.tracking_enabled ? 0 : 1;
    await fetch(`/api/shopping/products/${product.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tracking_enabled: newVal }),
    });
    setProducts((prev) =>
      prev.map((p) =>
        p.id === product.id ? { ...p, tracking_enabled: newVal } : p
      )
    );
  };

  const handleRemove = async (product: Product) => {
    await fetch(`/api/shopping/products/${product.id}`, {
      method: "DELETE",
    });
    setProducts((prev) => prev.filter((p) => p.id !== product.id));
  };

  const handleProductAdded = (product: Product) => {
    setProducts((prev) => [product, ...prev]);
    setShowAdd(false);
  };

  return (
    <div className="p-4 sm:p-8 max-w-4xl">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">Shopping</h2>
          <p className="text-sm text-gray-500">
            {products.length} product{products.length !== 1 ? "s" : ""} tracked
          </p>
        </div>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
            showAdd
              ? "bg-gray-800 text-gray-300"
              : "bg-indigo-600 text-white hover:bg-indigo-500"
          }`}
        >
          {showAdd ? "Cancel" : "+ Add Product"}
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="mb-5">
          <AddProductForm onAdded={handleProductAdded} />
        </div>
      )}

      {/* Products list */}
      {loading ? (
        <div className="text-sm text-gray-600 py-8 text-center">
          Loading...
        </div>
      ) : products.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 text-sm">No products tracked yet</p>
          <p className="text-gray-600 text-xs mt-1">
            Add a product URL to get started
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {products.map((product) => (
            <div
              key={product.id}
              className="rounded-xl border border-gray-800 bg-gray-900 hover:border-gray-700 transition-colors"
            >
              <button
                onClick={() => setSelected(product)}
                className="w-full p-3 sm:p-4 text-left"
              >
                <div className="flex items-start gap-3 sm:gap-4">
                  {/* Image */}
                  {product.image_url && (
                    <img
                      src={product.image_url}
                      alt={product.name}
                      className="w-12 h-12 sm:w-14 sm:h-14 rounded-lg object-cover flex-shrink-0"
                    />
                  )}

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="text-sm font-medium text-gray-200 line-clamp-1">
                          {product.name}
                        </h3>
                        {product.description && (
                          <p className="text-xs text-gray-500 line-clamp-1 mt-0.5">
                            {product.description}
                          </p>
                        )}
                      </div>

                      {/* Best price badge */}
                      {product.best_price != null && (
                        <div className="flex-shrink-0 text-right">
                          <span className="text-sm font-bold text-green-400">
                            {fmtPrice(product.best_price)}
                          </span>
                          {product.best_source && (
                            <p className="text-xs text-gray-500">
                              at{" "}
                              <span
                                style={{
                                  color: sourceColor(product.best_source),
                                }}
                              >
                                {sourceLabel(product.best_source, product.best_retailer_display)}
                              </span>
                            </p>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Source prices table (top 5) */}
                    {product.prices.length > 0 && (
                      <div className="mt-2 space-y-0.5">
                        {[...product.prices]
                          .sort((a, b) => a.price - b.price)
                          .slice(0, 5)
                          .map((p, i) => (
                            <div
                              key={`${p.source}-${i}`}
                              className={`flex items-center gap-2 rounded-md px-2 py-1 ${
                                i === 0 && p.in_stock
                                  ? "bg-green-900/10"
                                  : "bg-gray-800/50"
                              }`}
                            >
                              <span
                                className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                                style={{
                                  backgroundColor: sourceColor(p.source),
                                }}
                              />
                              <span className="text-xs text-gray-400 w-20 flex-shrink-0 truncate">
                                {sourceLabel(p.source, p.retailer_display)}
                              </span>
                              <span
                                className={`text-xs font-medium flex-shrink-0 ${
                                  !p.in_stock
                                    ? "text-gray-600 line-through"
                                    : i === 0 && p.in_stock && p.verified
                                      ? "text-green-400"
                                      : p.verified
                                        ? "text-gray-300"
                                        : "text-gray-500 italic"
                                }`}
                              >
                                {!p.verified && "~"}{fmtPrice(p.price)}
                              </span>
                              {!p.verified && (
                                <span className="text-xs text-yellow-500/70">unverified</span>
                              )}
                              {!p.in_stock && (
                                <span className="text-xs text-red-400/70">OOS</span>
                              )}
                              {p.source_url && (
                                <a
                                  href={p.source_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="ml-auto text-gray-600 hover:text-blue-400 transition-colors flex-shrink-0"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <svg
                                    className="w-3 h-3"
                                    viewBox="0 0 16 16"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="1.5"
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                  >
                                    <path d="M6 3H3v10h10v-3" />
                                    <path d="M9 2h5v5" />
                                    <path d="M14 2L7 9" />
                                  </svg>
                                </a>
                              )}
                            </div>
                          ))}
                        {product.prices.length > 5 && (
                          <p className="text-xs text-gray-600 pl-2">
                            +{product.prices.length - 5} more source{product.prices.length - 5 !== 1 ? "s" : ""}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Meta line */}
                    <div className="flex items-center gap-3 mt-1.5">
                      {product.category && (
                        <span className="text-xs text-gray-600">
                          {product.category}
                        </span>
                      )}
                      {product.last_checked && (
                        <span className="text-xs text-gray-600">
                          Checked {relTime(product.last_checked)}
                        </span>
                      )}
                      {product.prices.length === 0 &&
                        product.tracking_enabled === 1 && (
                          <span className="text-xs text-gray-600">
                            Waiting for first price check...
                          </span>
                        )}
                    </div>
                  </div>
                </div>
              </button>

              {/* Actions bar */}
              <div className="flex items-center justify-between px-3 sm:px-4 pb-3 pt-0">
                {/* Tracking toggle */}
                <div
                  className="flex items-center gap-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span className="text-xs text-gray-500">Price Tracking</span>
                  <button
                    onClick={() => handleToggleTracking(product)}
                    className={`relative w-9 h-5 rounded-full transition-colors ${
                      product.tracking_enabled
                        ? "bg-green-600"
                        : "bg-gray-700"
                    }`}
                  >
                    <span
                      className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                        product.tracking_enabled
                          ? "left-[18px]"
                          : "left-0.5"
                      }`}
                    />
                  </button>
                  {product.tracking_enabled ? (
                    <span className="text-xs text-green-500">On</span>
                  ) : (
                    <span className="text-xs text-gray-600">Off</span>
                  )}
                </div>

                {/* Remove */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(`Remove "${product.name}" from your shopping list?`)) {
                      handleRemove(product);
                    }
                  }}
                  className="text-xs text-gray-600 hover:text-red-400 transition-colors px-2 py-1"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail modal */}
      {selected && (
        <ProductDetail
          product={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
