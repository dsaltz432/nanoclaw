import { useCallback, useEffect, useState, Fragment } from "react";
import {
  DayMark,
  Interaction,
  LOGGABLE_SOURCES,
  Person,
  PeopleResponse,
  SOURCE_LABELS,
  STATUS_LABEL,
  TONE_STYLE,
  toneOf,
  fmtDay,
  fmtDuration,
  todayStr,
} from "./people/shared";
import ContactChart from "./people/ContactChart";
import { Draft, PersonForm, draftFrom, draftToBody, emptyDraft } from "./people/PersonForm";

/**
 * People — one row per person, last real interaction, days since. Also the one
 * place people are added, edited and removed (the scheduled tasks that feed and
 * nudge are managed with every other task, under Admin).
 *
 * Deliberately descriptive rather than a scoreboard: no streaks, no totals to
 * beat. Colour means one thing — how overdue someone is (people/shared.ts
 * toneOf) — on the row and its status chip, and nowhere else.
 */

// ── 90-day strip ──────────────────────────────────────────────────────────────

function DayStrip({ days, start, today }: { days: DayMark[]; start: string; today: string }) {
  const marks = new Map(days.map((d) => [d.date, d]));
  const startMs = Date.parse(start + "T00:00:00Z");
  const total = Math.round((Date.parse(today + "T00:00:00Z") - startMs) / 86_400_000) + 1;

  return (
    <div className="flex gap-px" title={`Last ${total} days — oldest on the left`}>
      {Array.from({ length: total }, (_, i) => {
        const date = new Date(startMs + i * 86_400_000).toISOString().slice(0, 10);
        const mark = marks.get(date);
        const cls = !mark
          ? "bg-gray-800/50"
          : mark.qualifies
            ? "bg-gray-300"
            : "bg-gray-600/80";
        const label = mark
          ? `${date} — ${mark.sources.map((s) => SOURCE_LABELS[s] ?? s).join(", ")}` +
            (mark.qualifies ? "" : " (doesn't count)")
          : date;
        return <span key={date} title={label} className={`h-5 w-1 rounded-sm ${cls}`} />;
      })}
    </div>
  );
}

// ── Log form ──────────────────────────────────────────────────────────────────

function LogForm({ person, onDone }: { person: Person; onDone: () => void }) {
  const [source, setSource] = useState("in_person");
  const [date, setDate] = useState(todayStr());
  const [note, setNote] = useState("");
  const [minutes, setMinutes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCall = source === "phone" || source === "whatsapp";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const resp = await fetch(`/api/people/${person.id}/interactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source,
          date,
          note: note || null,
          duration_s: isCall && minutes ? Math.round(Number(minutes) * 60) : null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || "Could not save");
      setNote("");
      setMinutes("");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">Source</span>
        <select
          value={source}
          onChange={(e) => setSource(e.target.value)}
          className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
        >
          {LOGGABLE_SOURCES.map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-gray-500">Date</span>
        <input
          type="date"
          value={date}
          max={todayStr()}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
        />
      </label>

      {isCall && (
        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Minutes</span>
          <input
            type="number"
            min="0"
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            placeholder="20"
            className="w-20 rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
          />
        </label>
      )}

      <label className="flex min-w-48 flex-1 flex-col gap-1">
        <span className="text-xs text-gray-500">Note</span>
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="optional"
          className="rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200"
        />
      </label>

      <button
        type="submit"
        disabled={saving}
        className="rounded-md bg-indigo-500/10 px-3 py-1.5 text-sm text-indigo-400 hover:bg-indigo-500/20 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Log interaction"}
      </button>

      {error && <span className="text-xs text-red-400">{error}</span>}
    </form>
  );
}

// ── Expanded row ──────────────────────────────────────────────────────────────

function PersonDetail({
  person,
  today,
  onChanged,
  onEdit,
}: {
  person: Person;
  today: string;
  onChanged: () => void;
  onEdit: () => void;
}) {
  const [interactions, setInteractions] = useState<Interaction[] | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  // Calls under a minute are hidden unless asked for; this covers the chart
  // and the history below it, for this person only.
  const [showShort, setShowShort] = useState(false);
  const hiddenShort = person.interaction_count - person.shown_count;

  const load = useCallback(() => {
    const get = (q: string) =>
      fetch(`/api/people/${person.id}/interactions?${q}`)
        .then((r) => r.json())
        .then((d) => (d.interactions ?? []) as Interaction[]);
    (async () => {
      // The list is the last 20 entries. Showing calls under a minute must only
      // *add* them — so keep the same time span as the normal list and include
      // every entry in it, rather than taking the last 20 of everything (which
      // would let a run of short calls push the longer ones off the list).
      const normal = await get("limit=20");
      if (!showShort) return normal;
      const all = await get("limit=5000&short=1");
      const oldest = normal.length === 20 ? normal[normal.length - 1]!.ts : "";
      return all.filter((i) => i.ts >= oldest);
    })()
      .then(setInteractions)
      .catch(() => setInteractions([]));
  }, [person.id, showShort]);

  useEffect(load, [load]);

  async function removeInteraction(id: number) {
    await fetch(`/api/people/${person.id}/interactions/${id}`, { method: "DELETE" });
    load();
    onChanged();
  }

  async function removePerson() {
    await fetch(`/api/people/${person.id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    // w-0 + min-w-full: fill the row but never widen the table. Without it the
    // chart's width feeds back into the column widths and, on a phone, pushes
    // Days / Status off-screen.
    <div className="w-0 min-w-full space-y-4 border-t border-gray-800 bg-gray-900/40 px-3 py-4 sm:px-4">
      <div className="flex justify-end">
        {confirmRemove ? (
          <span className="flex items-center gap-2 text-xs">
            <span className="text-gray-400">
              Remove {person.name} and {person.interaction_count}{" "}
              {person.interaction_count === 1 ? "entry" : "entries"}?
            </span>
            <button
              onClick={removePerson}
              className="rounded bg-red-500/10 px-2 py-1 text-red-400 hover:bg-red-500/20"
            >
              Remove
            </button>
            <button
              onClick={() => setConfirmRemove(false)}
              className="px-1 text-gray-500 hover:text-gray-300"
            >
              Cancel
            </button>
          </span>
        ) : (
          <span className="flex items-center gap-3 text-xs">
            <button onClick={onEdit} className="text-gray-500 hover:text-gray-200">
              Edit
            </button>
            <button
              onClick={() => setConfirmRemove(true)}
              className="text-gray-500 hover:text-red-400"
            >
              Remove
            </button>
          </span>
        )}
      </div>

      <ContactChart person={person} today={today} showShort={showShort} />

      <LogForm
        person={person}
        onDone={() => {
          load();
          onChanged();
        }}
      />

      <div>
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-xs uppercase tracking-wide text-gray-600">
            {showShort && interactions
              ? `${interactions.length} entries, including calls under a minute`
              : `Last ${Math.min(20, person.shown_count)} of ${person.shown_count}`}
          </span>
          {hiddenShort > 0 && (
            <button
              type="button"
              onClick={() => setShowShort((v) => !v)}
              aria-pressed={showShort}
              className="rounded px-2 py-0.5 text-xs text-gray-500 hover:bg-gray-800 hover:text-gray-300"
            >
              {showShort
                ? "Hide calls under a minute"
                : `Show ${hiddenShort} ${hiddenShort === 1 ? "call" : "calls"} under a minute`}
            </button>
          )}
        </div>
        {interactions === null ? (
          <div className="text-sm text-gray-600">Loading…</div>
        ) : interactions.length === 0 ? (
          <div className="text-sm text-gray-600">Nothing recorded yet.</div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {interactions.map((i) => (
                <tr key={i.id} className="border-t border-gray-800/60">
                  <td className="py-1.5 pr-3 whitespace-nowrap text-gray-400">{fmtDay(i.ts)}</td>
                  <td className="py-1.5 pr-3 text-gray-300 sm:whitespace-nowrap">
                    <span className="whitespace-nowrap">
                      {SOURCE_LABELS[i.source] ?? i.source}
                      {i.direction !== "n/a" && (
                        <span className="text-gray-600"> {i.direction === "in" ? "in" : "out"}</span>
                      )}
                    </span>
                    {/* Phones: note and "doesn't count" move under the source. */}
                    {(i.note || !i.qualifies) && (
                      <div className="text-xs text-gray-500 sm:hidden">
                        {i.note}
                        {i.note && !i.qualifies && " · "}
                        {!i.qualifies && <span className="text-gray-600">doesn't count</span>}
                      </div>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 whitespace-nowrap text-gray-400">
                    {fmtDuration(i.duration_s)}
                  </td>
                  <td className="hidden py-1.5 pr-3 text-gray-500 sm:table-cell">{i.note}</td>
                  <td className="hidden py-1.5 pr-3 text-right whitespace-nowrap text-xs text-gray-600 sm:table-cell">
                    {i.origin}
                    {!i.qualifies && <span className="ml-2">doesn't count</span>}
                  </td>
                  <td className="py-1.5 text-right">
                    <button
                      onClick={() => removeInteraction(i.id)}
                      title="Remove this entry"
                      aria-label="Remove this entry"
                      className="px-2 py-1 text-gray-600 hover:text-red-400 sm:px-1 sm:py-0 sm:text-gray-700"
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ── Rescan notice ─────────────────────────────────────────────────────────────

type Backfill = { added: Record<string, number> } | { error: string } | null | undefined;

/** One line about what the saved call history turned up; null when nothing ran. */
function describeBackfill(name: string, backfill: Backfill): string | null {
  if (!backfill) return null;
  if ("error" in backfill) return `Saved ${name}, but checking past calls failed: ${backfill.error}`;
  const entries = Object.entries(backfill.added);
  if (entries.length === 0) return `Saved ${name}. No past calls with them in the saved call history.`;
  const parts = entries.map(([who, n]) => `${n} past ${n === 1 ? "call" : "calls"} for ${who}`);
  return `Saved ${name}. Added ${parts.join(", ")} from the saved call history.`;
}

// ── Reorder arrows ───────────────────────────────────────────────────────────────

function ArrowIcon({ up = false }: { up?: boolean }) {
  return (
    <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
      <path
        d={up ? "M1 5 L5 1 L9 5" : "M1 1 L5 5 L9 1"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function PeoplePage() {
  const [data, setData] = useState<PeopleResponse | null>(null);
  const [error, setError] = useState<{ error: string; detail?: string } | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  // What the saved-exports rescan found after an add / identifier change.
  const [notice, setNotice] = useState<string | null>(null);
  // After an up/down click the page shows the new order at once; the server's
  // order replaces it when the reload after saving lands.
  const [order, setOrder] = useState<number[] | null>(null);

  const load = useCallback(() => {
    fetch("/api/people")
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw body;
        return body;
      })
      .then((d: PeopleResponse) => {
        setData(d);
        setOrder(null);
        setError(null);
      })
      .catch((e) => setError(e?.error ? e : { error: "Could not load people" }));
  }, []);

  useEffect(load, [load]);

  function startDraft(d: Draft) {
    setDraft(d);
    setFormError(null);
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    setFormError(null);
    try {
      const resp = await fetch(draft.id ? `/api/people/${draft.id}` : "/api/people", {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draftToBody(draft)),
      });
      const body = await resp.json();
      if (!resp.ok) throw new Error(body.error || "Could not save");
      setNotice(describeBackfill(body.name, body.backfill));
      setDraft(null);
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveOrder(ids: number[]) {
    try {
      const resp = await fetch("/api/people/order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!resp.ok) throw new Error((await resp.json()).error || "Could not save the order");
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      load();
    }
  }

  /** Move one person up (-1) or down (+1) one place, and save. */
  function shift(id: number, delta: number) {
    const ids = (order ?? data!.people.map((x) => x.id)).slice();
    const from = ids.indexOf(id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    setOrder(ids);
    saveOrder(ids);
  }

  if (error) {
    return (
      <div className="p-6">
        <h1 className="text-lg font-semibold text-gray-100">People</h1>
        <div className="mt-4 rounded-lg border border-gray-800 bg-gray-900 p-4">
          <div className="text-sm text-gray-300">{error.error}</div>
          {error.detail && <div className="mt-2 text-sm text-gray-500">{error.detail}</div>}
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="p-6 text-sm text-gray-600">Loading…</div>;
  }

  const rows = order
    ? order.map((id) => data.people.find((p) => p.id === id)).filter((p): p is Person => !!p)
    : data.people;

  return (
    <div className="p-4 md:p-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold text-gray-100">People</h1>
          <span className="hidden text-xs text-gray-600 sm:inline">
            Last qualifying interaction · {data.strip_days}-day strip
          </span>
        </div>
        {!draft && (
          <button
            onClick={() => startDraft(emptyDraft())}
            className="shrink-0 rounded-md bg-indigo-500/10 px-3 py-1.5 text-sm text-indigo-400 hover:bg-indigo-500/20"
          >
            Add person
          </button>
        )}
      </div>

      {notice && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-gray-800 bg-gray-900 px-4 py-2.5 text-sm text-gray-400">
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            className="px-1 text-gray-600 hover:text-gray-300"
          >
            ×
          </button>
        </div>
      )}

      {draft && (
        <div className="mb-4">
          <PersonForm
            draft={draft}
            onChange={setDraft}
            onSave={save}
            onCancel={() => setDraft(null)}
            saving={saving}
            error={formError}
          />
        </div>
      )}

      {data.people.length === 0 ? (
        <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 text-sm text-gray-500">
          Nobody tracked yet. Add the first person above.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-gray-800 bg-gray-900">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-left text-xs uppercase tracking-wide text-gray-600">
                <th className="w-8 pl-2 pr-0" aria-label="Order" />
                <th className="py-2.5 pl-2 pr-2 font-medium sm:pr-4">Name</th>
                <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Last</th>
                <th className="px-2 py-2.5 font-medium text-right sm:px-4">Days</th>
                <th className="hidden px-4 py-2.5 font-medium text-right sm:table-cell">Every</th>
                <th className="px-2 py-2.5 font-medium sm:px-4">Status</th>
                <th className="hidden px-4 py-2.5 font-medium lg:table-cell">
                  {data.strip_days} days
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, idx) => {
                const tone = TONE_STYLE[toneOf(p)];
                const open = expanded === p.id;
                return (
                  <Fragment key={p.id}>
                    <tr
                      onClick={() => setExpanded(open ? null : p.id)}
                      className={`cursor-pointer border-t border-gray-800/60 ${tone.row}`}
                    >
                      <td className="relative w-8 py-1 pl-2 pr-0">
                        <span
                          aria-hidden="true"
                          className={`absolute inset-y-0 left-0 w-[3px] ${tone.bar}`}
                        />
                        <div className="flex flex-col" onClick={(e) => e.stopPropagation()}>
                          <button
                            type="button"
                            aria-label={`Move ${p.name} up`}
                            title="Move up"
                            disabled={idx === 0}
                            onClick={() => shift(p.id, -1)}
                            className="flex h-6 w-8 items-center justify-center rounded text-gray-600 sm:h-4 sm:w-6 hover:bg-gray-800 hover:text-gray-200 disabled:pointer-events-none disabled:opacity-20"
                          >
                            <ArrowIcon up />
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${p.name} down`}
                            title="Move down"
                            disabled={idx === rows.length - 1}
                            onClick={() => shift(p.id, 1)}
                            className="flex h-6 w-8 items-center justify-center rounded text-gray-600 sm:h-4 sm:w-6 hover:bg-gray-800 hover:text-gray-200 disabled:pointer-events-none disabled:opacity-20"
                          >
                            <ArrowIcon />
                          </button>
                        </div>
                      </td>
                      <td className="py-2.5 pl-2 pr-2 text-gray-200 sm:whitespace-nowrap sm:pr-4">
                        <span className="mr-2 inline-block w-2 text-gray-600">
                          {open ? "▾" : "▸"}
                        </span>
                        {p.name}
                        {/* Phones: the Last column is hidden, so show it here. */}
                        <div className="ml-4 mt-0.5 text-xs text-gray-500 sm:hidden">
                          {p.last_ts
                            ? `${fmtDay(p.last_ts)} · ${SOURCE_LABELS[p.last_source!] ?? p.last_source}`
                            : "never"}
                        </div>
                      </td>
                      <td className="hidden px-4 py-2.5 whitespace-nowrap text-gray-400 sm:table-cell">
                        {p.last_ts ? (
                          <>
                            {fmtDay(p.last_ts)}
                            <span className="text-gray-600">
                              {" "}
                              {SOURCE_LABELS[p.last_source!] ?? p.last_source}
                            </span>
                          </>
                        ) : (
                          <span className="text-gray-600">never</span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-right tabular-nums text-gray-300 sm:px-4">
                        {p.days_since ?? "—"}
                      </td>
                      <td className="hidden px-4 py-2.5 text-right tabular-nums text-gray-600 sm:table-cell">
                        {p.threshold_days}
                      </td>
                      <td className="px-2 py-2.5 sm:px-4">
                        <span
                          className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ${tone.chip}`}
                          title={
                            p.muted_until ? `muted until ${fmtDay(p.muted_until)}` : undefined
                          }
                        >
                          <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                          {STATUS_LABEL[p.status]}
                        </span>
                      </td>
                      <td className="hidden px-4 py-2.5 lg:table-cell">
                        <DayStrip days={p.days} start={data.strip_start} today={data.today} />
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={7} className="p-0">
                          <PersonDetail
                            person={p}
                            today={data.today}
                            onChanged={load}
                            onEdit={() => {
                              startDraft(draftFrom(p));
                              window.scrollTo({ top: 0, behavior: "smooth" });
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
