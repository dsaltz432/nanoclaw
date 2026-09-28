import { useEffect, useState, type ReactNode } from "react";
import { Badge, Card, ErrorBox, FoldToggle, Loading, Note } from "./viz";
import { ACTION_TONE, HORIZON_LABEL, ago, cap, fmtDateTime, horizonShort, srcLabel } from "./labels";
import { PlayerName, noteTopic } from "./NoteLine";
import { Segmented, Select } from "./Select";

/**
 * Reading — one feed of what has been written: articles from the content
 * layer (with the model's one-line summary and the claims it extracted) and
 * Rotowire wire notes, newest first. Filter to your players in the selected
 * league, a site, a claim horizon or a time window. Read state is stored
 * server-side per article or note (not per league), so marking something read
 * here marks it read everywhere.
 *
 * Trending and crowd demand are deliberately not repeated here: they live on
 * Moves, and Today summarises them.
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
      claims: Claim[];
      claims_n: number;
      extraction: string;
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
  counts: { total: number; unread: number; articles: number; notes: number };
  items: Item[];
  sources: string[];
  provenance: string;
  error?: string;
};

const PAGE = 30;
/** Items fetched per request, newest first; counts cover the whole window. */
const LIMIT = 200;
const SEG_MIN = "[&_button]:min-w-[2.25rem]";
const HOURS_OPTIONS = [
  { value: "24", label: "Last day" },
  { value: "72", label: "Last 3 days" },
  { value: "168", label: "Last week" },
  { value: "336", label: "Last 2 weeks" },
];
const DEFAULT_HOURS = 72;

export default function ReadingTab({ league, onPlayer }: { league: string; onPlayer: (id: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped to force a refetch after a failed mark-read write.
  const [nonce, setNonce] = useState(0);
  const [scope, setScope] = useState<"all" | "mine">("mine");
  // Two independent toggles, both on by default; the API still takes one kind.
  const [showArticles, setShowArticles] = useState(true);
  const [showNotes, setShowNotes] = useState(true);
  const kind = showArticles && showNotes ? "all" : showArticles ? "articles" : "notes";
  const [source, setSource] = useState("");
  const [horizon, setHorizon] = useState("");
  const [hours, setHours] = useState(DEFAULT_HOURS);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [shown, setShown] = useState(PAGE);
  // Phones only: the secondary filters fold behind one "Filters" link.
  const [filtersOpen, setFiltersOpen] = useState(false);

  useEffect(() => {
    const q = new URLSearchParams({ league, scope, kind, hours: String(hours), limit: String(LIMIT) });
    if (source) q.set("source", source);
    if (horizon) q.set("horizon", horizon);
    // On a filter change the previous list stays on screen, dimmed, until
    // this one lands; a response that arrives after a newer request was made
    // is dropped. A league change remounts the tab (FantasyPage keys it).
    let live = true;
    setBusy(true);
    fetch(`/api/fantasy/reading?${q.toString()}`)
      .then((r) => r.json())
      .then((d: Data) => {
        if (!live) return;
        if (d.error) {
          setErr(d.error);
          return;
        }
        setErr(null);
        setData(d);
        setShown(PAGE);
      })
      .catch((e) => live && setErr(String(e)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [league, scope, kind, source, horizon, hours, nonce]);

  const markRead = (ids: string[]) => {
    if (!ids.length) return;
    setData((d) => d && { ...d, items: d.items.map((i) => (ids.includes(i.id) ? { ...i, read: true } : i)), counts: { ...d.counts, unread: Math.max(0, d.counts.unread - ids.length) } });
    fetch("/api/fantasy/reading/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) })
      .then((r) => {
        if (!r.ok) setNonce((n) => n + 1);
      })
      .catch(() => setNonce((n) => n + 1));
  };

  // A gated or too-short article with no summary and no claims is an Admin
  // row ("did the fetch work"), not reading. It stays on Admin.
  const items = (data?.items ?? []).filter(
    (i) => (!unreadOnly || !i.read) && !(i.kind === "article" && !i.summary && i.claims_n === 0 && i.extraction !== "pending"),
  );
  const page = items.slice(0, shown);
  const unread = items.filter((i) => !i.read).map((i) => i.id);
  const windowLabel = HOURS_OPTIONS.find((o) => o.value === String(hours))?.label ?? `last ${hours} h`;

  // Non-default filters, echoed as chips beside the folded "Filters" link.
  const chips = [
    source && srcLabel(source),
    horizon && (HORIZON_LABEL as Record<string, string>)[horizon],
    hours !== DEFAULT_HOURS && windowLabel,
    unreadOnly && "unread only",
  ].filter(Boolean) as string[];

  const truncated = !!data && data.items.length < data.counts.total;
  const subtitle = data && (
    <>
      {truncated
        ? `showing ${data.items.length} of ${num(data.counts.total)} · ${num(data.counts.unread)} unread`
        : `${num(data.counts.unread)} unread of ${num(data.counts.total)}`}{" "}
      · {num(data.counts.articles)} articles · {num(data.counts.notes)} notes
    </>
  );
  // Marking read only reaches the items loaded here, so when older ones were
  // not fetched the button says how many it covers instead of "all".
  const markAll = unread.length > 0 && (
    <button
      type="button"
      onClick={() => markRead(unread)}
      title={truncated ? `Marks the ${unread.length} unread items loaded here; older ones stay unread.` : undefined}
      className="ff-inline ff-hit whitespace-nowrap text-xs text-indigo-400 hover:text-indigo-300"
    >
      {truncated ? `Mark ${unread.length} read` : "Mark all read"}
    </button>
  );

  return (
    <Card title="Reading" subtitle={subtitle} right={markAll}>
      {data?.provenance && <Note>{data.provenance}</Note>}
      {/* Two rows on a phone (the second behind "Filters"); from sm up both
          rows dissolve (display: contents) into one wrapping toolbar row. */}
      <div className="mb-3 space-y-2 sm:flex sm:flex-wrap sm:items-center sm:gap-2 sm:space-y-0">
        <div className="flex flex-wrap items-center gap-2 sm:contents">
          <Segmented
            aria-label="Scope"
            value={scope}
            onChange={(v) => setScope(v as "all" | "mine")}
            className={SEG_MIN}
            options={[
              { value: "mine", label: "My players" },
              { value: "all", label: "Everything" },
            ]}
          />
          <div
            role="group"
            aria-label="Kind"
            className="inline-flex items-center gap-0.5 rounded-md border border-gray-800 bg-gray-900 p-0.5"
          >
            <KindToggle label="Articles" on={showArticles} other={showNotes} set={setShowArticles} />
            <KindToggle label="Wire" on={showNotes} other={showArticles} set={setShowNotes} />
          </div>
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            className="ff-inline ff-hit text-xs text-indigo-400 hover:text-indigo-300 sm:hidden"
          >
            {filtersOpen ? "Hide filters" : "Filters"}
          </button>
          {!filtersOpen &&
            chips.map((c) => (
              <span key={c} className="rounded bg-gray-800 px-1.5 py-0.5 text-[11px] text-gray-300 sm:hidden">
                {c}
              </span>
            ))}
        </div>
        <div className={`${filtersOpen ? "flex" : "hidden"} flex-wrap items-center gap-2 sm:contents`}>
          <Select
            aria-label="Site"
            label="Site"
            value={source}
            onChange={setSource}
            options={[{ value: "", label: "Any" }, ...(data?.sources ?? []).map((s) => ({ value: s, label: srcLabel(s) }))]}
          />
          <Select
            aria-label="Claim horizon"
            label="Horizon"
            value={horizon}
            onChange={setHorizon}
            options={[
              { value: "", label: "Any" },
              { value: "week", label: cap(HORIZON_LABEL.week), hint: "at least one claim on this horizon" },
              { value: "ros", label: cap(HORIZON_LABEL.ros), hint: "at least one claim on this horizon" },
              { value: "dynasty", label: cap(HORIZON_LABEL.dynasty), hint: "at least one claim on this horizon" },
            ]}
          />
          <Select aria-label="Window" label="Window" value={String(hours)} onChange={(v) => setHours(Number(v))} options={HOURS_OPTIONS} />
          <label className="flex items-center gap-1 text-xs text-gray-400">
            <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Unread only
          </label>
        </div>
      </div>

      {err && <ErrorBox className="mb-3">{err}</ErrorBox>}

      {!data ? (
        !err && <Loading label="Loading reading…" rows={5} />
      ) : (
        <div className={`space-y-3 transition-opacity ${busy ? "opacity-60" : ""}`} aria-busy={busy}>
          {items.length === 0 ? (
            <p className="text-xs text-gray-500">Nothing in the {windowLabel.toLowerCase()} for this filter.</p>
          ) : (
            <ul className="space-y-2">
              {page.map((it) => (
                <li
                  key={it.id}
                  className={`min-w-0 rounded-lg border px-3 py-2.5 ${it.read ? "border-gray-800/50 bg-gray-950" : "border-gray-800 bg-gray-900"}`}
                >
                  {it.kind === "article" ? (
                    <Article it={it} onRead={() => markRead([it.id])} onPlayer={onPlayer} />
                  ) : (
                    <WireNote it={it} open={!!open[it.id]} onToggle={() => setOpen((o) => ({ ...o, [it.id]: !o[it.id] }))} onRead={() => markRead([it.id])} onPlayer={onPlayer} showMine={scope === "all"} />
                  )}
                </li>
              ))}
            </ul>
          )}
          <FoldToggle total={items.length} shown={page.length} onToggle={() => setShown((c) => c + PAGE)} mode="more" />
        </div>
      )}
    </Card>
  );
}

const num = (v: number) => v.toLocaleString();

/**
 * The first line of every item: its meta (site, time, badges) wraps under
 * itself on the left while "mark read" holds the top-right corner.
 */
function ItemHead({ children, read, onRead }: { children: ReactNode; read: boolean; onRead: () => void }) {
  return (
    <div className="flex items-start gap-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-1">{children}</div>
      {!read && <MarkRead onClick={onRead} />}
    </div>
  );
}

/**
 * One half of the articles / wire pair. Both start on; switching one off
 * shows only the other, and the last one on stays on so the feed is never
 * empty by accident. Styled like a Segmented option.
 */
function KindToggle({ label, on, other, set }: { label: string; on: boolean; other: boolean; set: (v: boolean) => void }) {
  const locked = on && !other;
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={() => !locked && set(!on)}
      title={locked ? "At least one kind stays on" : undefined}
      className={`min-w-[2.25rem] whitespace-nowrap rounded px-2.5 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60 ${
        on ? "bg-gray-800 text-gray-100 ring-1 ring-inset ring-gray-700" : "text-gray-500 hover:text-gray-300"
      } ${locked ? "cursor-default" : ""}`}
    >
      {label}
    </button>
  );
}

type ArticleItem = Extract<Item, { kind: "article" }>;

function Article({ it, onRead, onPlayer }: { it: ArticleItem; onRead: () => void; onPlayer: (id: string) => void }) {
  return (
    <>
      <ItemHead read={it.read} onRead={onRead}>
        <span className="text-[11px] uppercase tracking-wide text-gray-500">{srcLabel(it.source)}</span>
        {it.article_kind === "player_news" && <span className="text-[10px] uppercase tracking-wide text-gray-600">news</span>}
        <When iso={it.published_at} />
        {it.author && <span className="text-[11px] text-gray-600">{it.author}</span>}
        {it.gated && <Badge tone="neutral">gated</Badge>}
        {it.flagged && <Badge tone="warning">reads as an instruction</Badge>}
      </ItemHead>
      <a
        href={it.url}
        target="_blank"
        rel="noreferrer"
        className={`break-words text-sm font-medium hover:text-indigo-300 hover:underline ${it.read ? "text-gray-400" : "text-gray-100"}`}
      >
        {it.title}
      </a>
      {it.summary ? (
        <p className="mt-0.5 text-sm text-gray-400">{it.summary}</p>
      ) : it.extraction === "pending" ? (
        <p className="mt-0.5 text-xs text-gray-500">summary pending</p>
      ) : null}
      {it.claims.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {it.claims
            .filter((c) => c.action)
            .map((c, i) => {
              const cls = `inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] ${
                c.mine ? "border-indigo-500/40 bg-indigo-500/10 text-indigo-200" : "border-gray-800 text-gray-400"
              }`;
              const body = (
                <>
                  <Badge tone={ACTION_TONE[c.action ?? ""] ?? "neutral"}>{c.action}</Badge>
                  {c.name}
                  {c.horizon && c.horizon !== "week" && <span className="text-gray-600">{horizonShort(c.horizon)}</span>}
                </>
              );
              // A claim the extractor could not match to a player has no
              // dossier to open.
              return c.player_id ? (
                <button
                  key={i}
                  type="button"
                  onClick={() => onPlayer(c.player_id as string)}
                  className={`${cls} hover:border-gray-700`}
                  title={c.mine ? "on your roster" : undefined}
                >
                  {body}
                </button>
              ) : (
                <span key={i} className={cls}>
                  {body}
                </span>
              );
            })}
          {it.claims_n > it.claims.length && <span className="self-center text-[11px] text-gray-600">+{it.claims_n - it.claims.length} more</span>}
        </div>
      )}
    </>
  );
}

type WireItem = Extract<Item, { kind: "note" }>;

/**
 * One Rotowire note. The topic badge is only role/return (noteTopic): whether
 * he is out is Sleeper's designation, printed by PlayerName beside his name.
 */
function WireNote({
  it,
  open,
  onToggle,
  onRead,
  onPlayer,
  showMine,
}: {
  it: WireItem;
  open: boolean;
  onToggle: () => void;
  onRead: () => void;
  onPlayer: (id: string) => void;
  /** Under "my players" every note is yours, so the badge would be on every row. */
  showMine: boolean;
}) {
  const topic = noteTopic(it.topics);
  return (
    <>
      <ItemHead read={it.read} onRead={onRead}>
        <span className="text-[11px] uppercase tracking-wide text-gray-500">wire</span>
        <When iso={it.published_at} />
        <span className="text-sm font-medium">
          <PlayerName id={it.player_id} name={it.name} pos={it.position} team={it.team} injury={it.injury_status} onPlayer={onPlayer} news={false} />
        </span>
        {showMine && it.mine && <Badge tone="info">mine</Badge>}
        {topic && <Badge tone={topic.tone}>{topic.topic}</Badge>}
        {it.flagged && <Badge tone="warning">reads as an instruction</Badge>}
      </ItemHead>
      <p className={`mt-0.5 text-sm ${it.read ? "text-gray-500" : "text-gray-300"}`}>{it.headline}</p>
      {open && <p className="mt-1 text-xs text-gray-400">{it.story}</p>}
      {(it.story || it.url) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1">
          {it.story && (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              className="ff-inline ff-hit text-xs text-indigo-400 hover:text-indigo-300"
            >
              {open ? "Hide analysis" : "Analysis"}
            </button>
          )}
          {it.url && (
            <a
              href={it.url}
              target="_blank"
              rel="noreferrer"
              className="ff-hit inline-block py-0.5 text-[11px] text-gray-500 hover:text-indigo-300"
            >
              ESPN player news
            </a>
          )}
        </div>
      )}
    </>
  );
}

/** "3 h ago", with the exact local time on hover. */
function When({ iso }: { iso: string | null }) {
  const rel = ago(iso);
  if (!rel || !iso) return null;
  return (
    <time dateTime={iso} title={fmtDateTime(iso)} className="whitespace-nowrap text-[11px] text-gray-600">
      {rel}
    </time>
  );
}

function MarkRead({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="ff-inline ff-hit min-w-[2.5rem] shrink-0 whitespace-nowrap text-[11px] text-gray-500 hover:text-gray-300"
    >
      Mark read
    </button>
  );
}
