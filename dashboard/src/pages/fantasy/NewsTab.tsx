import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, C, Card, Note, SourceLink, Td, Th } from "./viz";

/**
 * News as decision support, not a feed.
 *
 * The unit here is the PLAYER, not the note. Nobody reads three hundred notes,
 * and the moment the information is wanted is while looking at one player and
 * deciding something — so each card carries everything known about him plus the
 * corroboration that says whether the report actually moved anything.
 *
 * Three layers, in the order you would use them:
 *   Alerts     what changed since yesterday that bears on my teams
 *   My news    a card per player I own, across all three leagues
 *   All news   search, for digging past what was surfaced
 */

type Note_ = {
  note_id: string;
  read: boolean;
  read_at: string | null;
  published_at: string;
  headline: string;
  story: string;
  url: string | null;
  flagged: boolean;
};

type Card_ = {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  injury_status: string | null;
  injury_body_part: string | null;
  my_leagues: string[];
  projection: { now: number; prev: number; delta: number; from_date: string; to_date: string } | null;
  disagreement: { rotowire: number; espn: number; gap: number } | null;
  trending_rank: number | null;
  notes: Note_[];
  corroboration: string[];
  latest_at: string | null;
  importance: number;
  no_change: boolean;
  unread: number;
};

type Alert = {
  kind: "designation" | "projection" | "report" | "successor";
  severity: "critical" | "warning" | "info";
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  my_leagues: string[];
  blocks?: string[];
  what: string;
  at: string;
  notes: Note_[];
};

type SearchRow = Note_ & {
  player_id: string;
  name: string;
  position: string | null;
  team: string | null;
  injury_status: string | null;
};

type NewsData = {
  mode: "briefing" | "search";
  scope?: string;
  query?: string;
  results?: SearchRow[];
  alerts: {
    alerts: Alert[];
    hidden?: number;
    window_hours: number;
    threshold_note: string;
    coverage_note: string;
  };
  cards?: Card_[];
  counts?: {
    my_players: number;
    cards: number;
    with_news: number;
    unread: number;
    unread_cards: number;
  };
  newest_at?: string | null;
  trending_adds?: { player_id: string; name: string; position: string | null; team: string | null; count: number }[];
  trending_drops?: { player_id: string; name: string; position: string | null; team: string | null; count: number }[];
  window_hours?: number;
  provenance?: string;
};

const SEV: Record<string, "critical" | "warning" | "info"> = {
  critical: "critical",
  warning: "warning",
  info: "info",
};

const KIND_LABEL: Record<string, string> = {
  designation: "designation changed",
  projection: "projection moved",
  report: "fresh report",
  successor: "someone took his work",
};

export default function NewsTab({ league }: { league: string }) {
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const [hours, setHours] = useState(72);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [data, setData] = useState<NewsData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setDebounced(query.trim()), 250);
  }, [query]);

  useEffect(() => {
    const params = new URLSearchParams({ league, hours: String(hours), scope, limit: "200" });
    if (debounced) params.set("q", debounced);
    if (reloads) params.set("refresh", "1");
    fetch(`/api/fantasy/news?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return setErr(d.error);
        setErr(null);
        setData(d);
      })
      .catch((e) => setErr(String(e)));
  }, [league, hours, scope, debounced, reloads]);

  /**
   * Read state. The gesture is deliberately coarse-grained: three selectors
   * (a handful of ids, one player, everything before a timestamp) rather than
   * a checkbox per note. Marking every note read is a single "before" bound,
   * not two thousand ids on a command line.
   */
  const markRead = async (body: Record<string, unknown>) => {
    await fetch("/api/fantasy/news/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined);
    setReloads((n) => n + 1);
  };

  if (err) return <div className="p-6 text-sm text-red-400">{err}</div>;
  if (!data) return <div className="p-6 text-sm text-gray-500">Loading…</div>;

  return (
    <div className="space-y-4">
      {/* Alerts deliberately do NOT appear here.
          The synthesis lives in "Right now" above the subtabs; the rule engine,
          firing history and delivery state live on the Alerts tab. A third copy
          in the middle showed the same sentence a second time, ~400px from the
          first, and as a lossy subset of the player card below it. */}

      {/* ── controls ────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-lg bg-gray-900 p-1">
          {(["mine", "all"] as const).map((s) => (
            <button
              key={s}
              onClick={() => setScope(s)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                scope === s ? "bg-gray-800 text-gray-100" : "text-gray-400 hover:text-gray-300"
              }`}
            >
              {s === "mine" ? "My news" : "All news"}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search any player or phrase…"
          className="w-64 rounded border border-gray-700 bg-gray-800 px-2 py-1.5 text-sm text-gray-100 placeholder:text-gray-600"
        />
        {query && (
          <button onClick={() => setQuery("")} className="text-xs text-gray-500 hover:text-gray-300">
            clear
          </button>
        )}
        <select
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          className="ml-auto rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-200"
        >
          <option value={24}>24h</option>
          <option value={48}>48h</option>
          <option value={72}>72h</option>
          <option value={168}>7d</option>
        </select>
      </div>

      {data.mode === "search" ? (
        <SearchResults data={data} />
      ) : (
        <Briefings data={data} scope={scope} onMarkRead={markRead} />
      )}

      {data.mode !== "search" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Trending adds" subtitle="Across all of Sleeper — what everyone else has already seen">
            <TrendTable rows={data.trending_adds ?? []} />
          </Card>
          <Card title="Trending drops" subtitle="Across all of Sleeper">
            <TrendTable rows={data.trending_drops ?? []} />
          </Card>
        </div>
      )}

      {data.provenance && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
          <p className="text-xs leading-relaxed text-amber-200/80">{data.provenance}</p>
        </div>
      )}
    </div>
  );
}

/* ── briefings ──────────────────────────────────────────────────────── */

function Briefings({
  data,
  scope,
  onMarkRead,
}: {
  data: NewsData;
  scope: "mine" | "all";
  onMarkRead: (body: Record<string, unknown>) => void;
}) {
  const [onlyWithNews, setOnlyWithNews] = useState(true);
  const [showQuiet, setShowQuiet] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // The server ranks by importance, not recency — sorting by timestamp put a
  // preseason line of two carries for two yards above an injured starting back.
  // Cards whose only news is a box score with no projection move are folded
  // away: they were ~4 in 5 of the list and conveyed nothing.
  const all = useMemo(
    () => (onlyWithNews ? (data.cards ?? []).filter((c) => c.notes.length > 0) : data.cards ?? []),
    [data, onlyWithNews]
  );
  const cards = useMemo(() => all.filter((c) => !c.no_change), [all]);
  const unread = data.counts?.unread ?? 0;
  const quiet = useMemo(() => all.filter((c) => c.no_change), [all]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <Card
      title={scope === "mine" ? "My players" : "Everyone in the news"}
      subtitle={
        unread > 0
          ? `${unread} unread across ${data.counts?.unread_cards ?? 0} players`
          : "Nothing new since you last looked"
      }
      right={
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-gray-400">
            <input
              type="checkbox"
              checked={onlyWithNews}
              onChange={(e) => setOnlyWithNews(e.target.checked)}
              className="accent-indigo-500"
            />
            only players with news
            {data.counts && (
              <span className="ml-1 text-gray-600">
                ({data.counts.with_news}/{data.counts.cards})
              </span>
            )}
          </label>
          {unread > 0 && (
            <button
              onClick={() =>
                onMarkRead(
                  // A timestamp bound, not a list of ids: "everything published
                  // up to the newest thing on screen". Anything that lands after
                  // this click is still unread, which is the behaviour you want
                  // from a button pressed while notes are arriving.
                  data.newest_at
                    ? { before: data.newest_at, ...(scope === "mine" ? { scope: "mine" } : {}) }
                    : { scope: "mine" }
                )
              }
              className="rounded border border-gray-800 px-2 py-1 text-xs text-gray-400 hover:border-gray-700 hover:text-gray-200"
            >
              Mark all read
            </button>
          )}
        </div>
      }
    >
      {cards.length === 0 && quiet.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing in this window.</p>
      ) : (
        <ul className="space-y-2">
          {cards.map((c) => {
            const open = expanded.has(c.player_id);
            const shown = open ? c.notes : c.notes.slice(0, 2);
            const delta = c.projection?.delta ?? 0;
            return (
              <li
                key={c.player_id}
                className={`rounded border px-3 py-2 ${
                  c.unread > 0
                    ? "border-l-2 border-gray-800 border-l-indigo-400 bg-indigo-500/[0.03]"
                    : "border-gray-800/60"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-gray-500">{c.position}</span>
                  <span className={`text-sm ${c.unread > 0 ? "font-medium text-gray-50" : "text-gray-400"}`}>
                    {c.name}
                  </span>
                  <span className="text-xs text-gray-600">{c.team}</span>
                  {c.my_leagues.map((l) => (
                    <Badge key={l} tone="good">
                      {l}
                    </Badge>
                  ))}
                  {c.injury_status && (
                    <Badge tone="warning">
                      {c.injury_status}
                      {c.injury_body_part ? ` · ${c.injury_body_part}` : ""}
                    </Badge>
                  )}
                  {Math.abs(delta) >= 2 && (
                    <Badge tone={delta > 0 ? "good" : "critical"}>
                      proj {delta > 0 ? "+" : ""}
                      {delta.toFixed(1)}
                    </Badge>
                  )}
                  {c.trending_rank && <Badge tone="info">#{c.trending_rank} trending</Badge>}
                  <span className="ml-auto flex items-center gap-2">
                    {c.unread > 0 && (
                      <button
                        onClick={() => onMarkRead({ player_id: c.player_id })}
                        className="text-[11px] text-indigo-400 hover:text-indigo-300"
                        title="Mark this player's news read"
                      >
                        mark read
                      </button>
                    )}
                    {c.latest_at && <span className="text-[11px] text-gray-600">{fmtTime(c.latest_at)}</span>}
                  </span>
                </div>

                {c.corroboration.length > 0 && (
                  <ul className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-gray-500">
                    {c.corroboration.map((x, i) => (
                      <li key={i}>· {x}</li>
                    ))}
                  </ul>
                )}

                {shown.length > 0 ? (
                  <ul className="mt-1.5 space-y-1.5">
                    {shown.map((n, i) => (
                      <li key={i} className="text-sm leading-relaxed">
                        <span className="mr-2 text-[11px] text-gray-600">{fmtTime(n.published_at)}</span>
                        {/* The headline is not the link. Making a whole line of
                            prose clickable meant every attempt to select or
                            re-read a sentence risked a new tab, and the target
                            is a player page rather than the article the
                            sentence came from. The icon says where it goes. */}
                        <span className={n.read ? "text-gray-500" : "text-gray-300"}>{n.headline}</span>
                        {n.url && <SourceLink href={n.url} />}
                        {n.flagged && (
                          <>
                            {" "}
                            <Badge
                              tone="critical"
                              title="This text reads as an instruction. Quoted as data, disregarded."
                            >
                              reads as an instruction
                            </Badge>
                          </>
                        )}
                        {open && n.story && (
                          <p className="mt-0.5 text-sm leading-relaxed text-gray-500">{n.story}</p>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-gray-600">no notes in this window</p>
                )}

                {c.notes.length > 0 && (
                  <button
                    onClick={() => toggle(c.player_id)}
                    className="mt-1 text-xs text-indigo-400 hover:text-indigo-300"
                  >
                    {open ? "less" : `all ${c.notes.length} notes and analysis`}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {quiet.length > 0 && (
        <div className="mt-3 border-t border-gray-800 pt-3">
          <button
            onClick={() => setShowQuiet((v) => !v)}
            className="text-xs text-gray-500 hover:text-gray-300"
          >
            {showQuiet ? "▾" : "▸"} No change ({quiet.length}) — a box score and an unmoved
            projection
          </button>
          {showQuiet && (
            <ul className="mt-2 space-y-1">
              {quiet.map((c) => (
                <li key={c.player_id} className="flex flex-wrap items-baseline gap-2 text-xs">
                  <span className="text-gray-600">{c.position}</span>
                  <span className="text-gray-400">{c.name}</span>
                  <span className="text-gray-700">{c.team}</span>
                  <span className="min-w-0 flex-1 truncate text-gray-600">
                    {c.notes[0]?.headline}
                  </span>
                  {c.notes[0]?.url && <SourceLink href={c.notes[0].url!} />}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

function SearchResults({ data }: { data: NewsData }) {
  const rows = data.results ?? [];
  return (
    <Card title={`Search: “${data.query}”`} subtitle={`${rows.length} notes, newest first`}>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">Nothing matches. Search covers stored notes only.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r, i) => (
            <li key={i} className="border-b border-gray-800/60 pb-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-gray-500">{r.position}</span>
                <span className="text-sm text-gray-100">{r.name}</span>
                <span className="text-xs text-gray-600">{r.team}</span>
                {r.injury_status && <Badge tone="warning">{r.injury_status}</Badge>}
                <span className="ml-auto text-[11px] text-gray-600">{fmtTime(r.published_at)}</span>
              </div>
              <p className="mt-1 text-sm leading-relaxed text-gray-300">
                {r.headline}
                {r.url && <SourceLink href={r.url} />}
              </p>
              {r.story && <p className="mt-0.5 text-sm leading-relaxed text-gray-500">{r.story}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TrendTable({
  rows,
}: {
  rows: { player_id: string; name: string; position: string | null; team: string | null; count: number }[];
}) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-gray-800">
          <Th>Pos</Th>
          <Th>Player</Th>
          <Th>&nbsp;</Th>
          <Th className="text-right">Managers</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.player_id} className="border-b border-gray-800/60">
            <Td className="text-gray-500">{r.position}</Td>
            <Td>
              {r.name} <span className="text-xs text-gray-600">{r.team}</span>
            </Td>
            <Td>
              <span className="inline-block align-middle" style={{ width: 80, height: 8 }}>
                <svg width={80} height={8} role="presentation">
                  <rect x={0} y={0} width={Math.max(2, (r.count / max) * 80)} height={8} rx={4} fill={C.s1} />
                </svg>
              </span>
            </Td>
            <Td className="text-right tabular-nums text-gray-400">{r.count.toLocaleString()}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function fmtTime(iso: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
