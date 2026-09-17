import { useCallback, useEffect, useState } from "react";
import { Badge, FoldToggle } from "./viz";
import { ACTION_TONE, HORIZON_LABEL, horizonShort, srcLabel } from "./labels";
import { Segmented, Select } from "./Select";

/**
 * Reading — one feed of what has been written: articles from the content
 * layer (with the model's one-line summary and the claims it extracted) and
 * Rotowire wire notes, newest first. Filter to your players, one player, a
 * site, or a claim horizon. Read state is shared with the old News tab.
 *
 * The trending sidebars that used to live on News are gone on purpose: that
 * signal lives on Moves and Today, and three places for one number was the
 * complaint.
 */

type Claim = { player_id: string | null; name: string; action: string | null; horizon: string | null; confidence: number | null; mine: boolean };

type Item =
  | {
      kind: "article";
      id: string;
      source: string;
      article_kind: string;
      title: string;
      url: string;
      author: string;
      published_at: string | null;
      summary: string;
      body_chars: number;
      category: string;
      claims: Claim[];
      claims_n: number;
      extraction: string;
      my_players: string[];
      read: boolean;
      flagged: boolean;
      gated: boolean;
    }
  | {
      kind: "note";
      id: string;
      source: "rotowire";
      player_id: string;
      name: string;
      position: string | null;
      team: string | null;
      injury_status: string | null;
      published_at: string;
      headline: string;
      story: string;
      topics: string[];
      url: string | null;
      mine: boolean;
      read: boolean;
      flagged: boolean;
    };

type Data = {
  hours: number;
  counts: { total: number; unread: number; articles: number; notes: number };
  items: Item[];
  sources: string[];
  provenance: string;
  error?: string;
};

export default function ReadingTab({ league, onPlayer }: { league: string; onPlayer: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scope, setScope] = useState<"all" | "mine">("mine");
  const [kind, setKind] = useState<"all" | "articles" | "notes">("all");
  const [source, setSource] = useState("");
  const [horizon, setHorizon] = useState("");
  const [hours, setHours] = useState(72);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const PAGE = 30;
  const [shown, setShown] = useState(PAGE);

  const load = useCallback(() => {
    const q = new URLSearchParams({ league, scope, kind, hours: String(hours), limit: "200" });
    if (source) q.set("source", source);
    if (horizon) q.set("horizon", horizon);
    fetch(`/api/fantasy/reading?${q.toString()}`)
      .then((r) => r.json())
      .then((d) => (d.error ? setErr(d.error) : (setErr(null), setData(d))))
      .catch((e) => setErr(String(e)));
  }, [league, scope, kind, source, horizon, hours]);

  useEffect(() => {
    setData(null);
    setShown(PAGE);
    load();
  }, [load]);

  const markRead = (ids: string[]) => {
    if (!ids.length) return;
    setData((d) => d && { ...d, items: d.items.map((i) => (ids.includes(i.id) ? { ...i, read: true } : i)), counts: { ...d.counts, unread: Math.max(0, d.counts.unread - ids.length) } });
    fetch("/api/fantasy/reading/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) })
      .then((r) => {
        if (!r.ok) load();
      })
      .catch(() => load());
  };

  if (err) return <div className="p-6 text-sm text-red-400">{err}</div>;

  // A gated or too-short article with no summary and no claims is an Admin
  // row ("did the fetch work"), not reading. It stays on Admin.
  const items = (data?.items ?? []).filter(
    (i) => (!unreadOnly || !i.read) && !(i.kind === "article" && !i.summary && i.claims_n === 0 && i.extraction !== "pending"),
  );
  const page = items.slice(0, shown);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          aria-label="Scope"
          value={scope}
          onChange={(v) => setScope(v as "all" | "mine")}
          options={[
            { value: "mine", label: "about my players" },
            { value: "all", label: "everything" },
          ]}
        />
        <Segmented
          aria-label="Kind"
          value={kind}
          onChange={(v) => setKind(v as typeof kind)}
          options={[
            { value: "all", label: "articles + wire" },
            { value: "articles", label: "articles only" },
            { value: "notes", label: "wire notes only" },
          ]}
        />
        <Select
          aria-label="Site"
          value={source}
          onChange={setSource}
          options={[
            { value: "", label: "any site" },
            ...(data?.sources ?? []).map((s) => ({ value: s, label: srcLabel(s) })),
          ]}
        />
        <Select
          aria-label="Claim horizon"
          value={horizon}
          onChange={setHorizon}
          options={[
            { value: "", label: "any horizon" },
            { value: "week", label: HORIZON_LABEL.week, hint: "at least one claim on this horizon" },
            { value: "ros", label: HORIZON_LABEL.ros, hint: "at least one claim on this horizon" },
            { value: "dynasty", label: HORIZON_LABEL.dynasty, hint: "at least one claim on this horizon" },
          ]}
        />
        <Select
          aria-label="Window"
          value={String(hours)}
          onChange={(v) => setHours(Number(v))}
          options={[
            { value: "24", label: "last day" },
            { value: "72", label: "last 3 days" },
            { value: "168", label: "last week" },
            { value: "336", label: "last 2 weeks" },
          ]}
        />
        <label className="flex items-center gap-1 text-xs text-gray-400">
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> unread only
        </label>
        {data && (
          <span className="ml-auto flex items-center gap-2 text-[11px] text-gray-600">
            {data.counts.unread} unread of {data.counts.total} · {data.counts.articles} articles · {data.counts.notes} notes
            <button
              onClick={() => markRead(items.filter((i) => !i.read).map((i) => i.id))}
              className="rounded-md border border-gray-800 px-2 py-1 text-gray-400 hover:border-gray-700 hover:text-gray-200"
            >
              mark all read
            </button>
          </span>
        )}
      </div>

      {!data ? (
        <div className="p-6 text-sm text-gray-500">Loading…</div>
      ) : items.length === 0 ? (
        <p className="p-6 text-sm text-gray-600">Nothing here for this filter.</p>
      ) : (
        <ul className="space-y-2">
          {page.map((it) => (
            <li
              key={it.id}
              className={`rounded-lg border px-3 py-2.5 ${it.read ? "border-gray-800/50 bg-gray-950" : "border-gray-800 bg-gray-900"}`}
            >
              {it.kind === "article" ? (
                <>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-[11px] uppercase tracking-wide text-gray-500">{srcLabel(it.source)}</span>
                    {it.article_kind === "player_news" && <span className="text-[10px] uppercase tracking-wide text-gray-600">news</span>}
                    <span className="text-[11px] text-gray-600">{fmt(it.published_at)}</span>
                    {it.author && <span className="text-[11px] text-gray-600">{it.author}</span>}
                    {it.gated && <Badge tone="neutral">gated</Badge>}
                    {it.flagged && <Badge tone="warning">reads as instruction</Badge>}
                    {!it.read && (
                      <button onClick={() => markRead([it.id])} className="ml-auto text-[11px] text-gray-500 hover:text-gray-300">
                        mark read
                      </button>
                    )}
                  </div>
                  <a href={it.url} target="_blank" rel="noreferrer" className={`text-sm font-medium hover:text-indigo-300 hover:underline ${it.read ? "text-gray-400" : "text-gray-100"}`}>
                    {it.title}
                  </a>
                  {it.summary ? (
                    <p className="mt-0.5 text-sm text-gray-400">{it.summary}</p>
                  ) : it.extraction === "pending" ? (
                    <p className="mt-0.5 text-xs text-gray-600">summary pending — the extractor runs every 15 minutes</p>
                  ) : null}
                  {it.claims.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {it.claims.filter((c) => c.action).map((c, i) => (
                        <button
                          key={i}
                          onClick={() => c.player_id && onPlayer(c.player_id)}
                          className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${
                            c.mine ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-200" : "border-gray-800 text-gray-400 hover:border-gray-700"
                          }`}
                          title={c.mine ? "on your roster" : ""}
                        >
                          <Badge tone={ACTION_TONE[c.action ?? ""] ?? "neutral"}>{c.action}</Badge>
                          {c.name}
                          {c.horizon && c.horizon !== "week" && <span className="text-gray-600">{horizonShort(c.horizon)}</span>}
                        </button>
                      ))}
                      {it.claims_n > it.claims.length && <span className="text-[11px] text-gray-600">+{it.claims_n - it.claims.length} more</span>}
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-[11px] uppercase tracking-wide text-gray-500">wire</span>
                    <span className="text-[11px] text-gray-600">{fmt(it.published_at)}</span>
                    <button onClick={() => onPlayer(it.player_id)} className="text-sm font-medium text-gray-100 hover:text-indigo-300 hover:underline">
                      {it.name}
                    </button>
                    <span className="text-xs text-gray-500">
                      {it.position}
                      {it.team ? ` · ${it.team}` : ""}
                    </span>
                    {it.mine && <Badge tone="info">mine</Badge>}
                    {it.injury_status && <Badge tone="warning">{it.injury_status}</Badge>}
                    {it.topics.map((t) => (
                      <Badge key={t} tone={t === "out" || t === "injury" ? "critical" : t === "role" ? "warning" : "neutral"}>
                        {t}
                      </Badge>
                    ))}
                    {it.flagged && <Badge tone="warning">reads as instruction</Badge>}
                    {!it.read && (
                      <button onClick={() => markRead([it.id])} className="ml-auto text-[11px] text-gray-500 hover:text-gray-300">
                        mark read
                      </button>
                    )}
                  </div>
                  <p className={`mt-0.5 text-sm ${it.read ? "text-gray-500" : "text-gray-300"}`}>{it.headline}</p>
                  {it.story && (
                    <button onClick={() => setOpen((o) => ({ ...o, [it.id]: !o[it.id] }))} className="mt-0.5 text-[11px] text-gray-600 hover:text-gray-400">
                      {open[it.id] ? "hide analysis" : "analysis"}
                    </button>
                  )}
                  {open[it.id] && <p className="mt-1 text-xs text-gray-400">{it.story}</p>}
                  {it.url && (
                    <a href={it.url} target="_blank" rel="noreferrer" className="ml-2 text-[11px] text-gray-600 hover:text-indigo-300">
                      ESPN player news
                    </a>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {data && <FoldToggle total={items.length} shown={page.length} onToggle={() => setShown((n) => n + PAGE)} mode="more" />}
      {data && <p className="text-[11px] text-gray-600">{data.provenance}</p>}
    </div>
  );
}

function fmt(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  return same
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
