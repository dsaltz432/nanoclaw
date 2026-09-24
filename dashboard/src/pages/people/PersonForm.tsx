import {
  Person,
  SOURCE_LABELS,
  TIMED_SOURCES,
} from "./shared";

/**
 * Add / edit form for one tracked person, used by the People page.
 *
 * contacts.db is the only store, and this form is the only way a person gets
 * into it. The Telegram agent and the nightly sheet sync only ever append
 * interactions to people who already exist — neither can invent one, which is
 * what keeps a mis-parsed "saw Morgan" from quietly creating a contact.
 */

export const ALL_SOURCES = ["in_person", "phone", "whatsapp", "manual"];

export interface RuleDraft {
  enabled: boolean;
  minutes: string;
}

export interface Draft {
  id: number | null;
  name: string;
  threshold_days: string;
  notes: string;
  phones: string;
  rules: Record<string, RuleDraft>;
}

export function emptyDraft(): Draft {
  return {
    id: null,
    name: "",
    threshold_days: "14",
    notes: "",
    phones: "",
    rules: {
      in_person: { enabled: true, minutes: "" },
      phone: { enabled: true, minutes: "5" },
      whatsapp: { enabled: true, minutes: "5" },
      manual: { enabled: true, minutes: "" },
    },
  };
}

export function draftFrom(person: Person): Draft {
  const rules: Record<string, RuleDraft> = {};
  for (const source of ALL_SOURCES) {
    const min = person.rules[source];
    rules[source] = {
      enabled: source in person.rules,
      minutes: min ? String(Math.round(min / 60)) : "",
    };
  }
  return {
    id: person.id,
    name: person.name,
    threshold_days: String(person.threshold_days),
    notes: person.notes ?? "",
    phones: person.identifiers
      .filter((i) => i.kind === "phone_number")
      .map((i) => i.value)
      .join("\n"),
    rules,
  };
}

export function draftToBody(draft: Draft) {
  const lines = (text: string) =>
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

  return {
    name: draft.name,
    threshold_days: Number(draft.threshold_days),
    notes: draft.notes,
    // Phone numbers are the only identifier anything matches on now: the call
    // log and the WhatsApp backup both identify people by number. (The schema's
    // whatsapp_name kind is unused; saving here replaces identifiers wholesale.)
    identifiers: lines(draft.phones).map((value) => ({ kind: "phone_number", value })),
    rules: Object.fromEntries(
      Object.entries(draft.rules)
        .filter(([, r]) => r.enabled)
        .map(([source, r]) => [
          source,
          TIMED_SOURCES.includes(source) && r.minutes
            ? Math.round(Number(r.minutes) * 60)
            : null,
        ])
    ),
  };
}

// ── Form ──────────────────────────────────────────────────────────────────────

const inputCls =
  "rounded-md border border-gray-700 bg-gray-900 px-2 py-1.5 text-sm text-gray-200 " +
  "placeholder:text-gray-600 focus:border-gray-600 focus:outline-none";

export function PersonForm({
  draft,
  onChange,
  onSave,
  onCancel,
  saving,
  error,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const setRule = (source: string, patch: Partial<RuleDraft>) =>
    onChange({
      ...draft,
      rules: { ...draft.rules, [source]: { ...draft.rules[source]!, ...patch } },
    });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
      className="space-y-4 rounded-lg border border-gray-800 bg-gray-900 p-4"
    >
      <div className="flex flex-wrap gap-3">
        <label className="flex w-full flex-col gap-1 sm:w-auto">
          <span className="text-xs text-gray-500">Name</span>
          <input
            autoFocus
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
            placeholder="Mom"
            className={`w-full sm:w-44 ${inputCls}`}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Overdue after</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="1"
              value={draft.threshold_days}
              onChange={(e) => onChange({ ...draft, threshold_days: e.target.value })}
              className={`w-20 ${inputCls}`}
            />
            <span className="text-sm text-gray-500">days</span>
          </div>
        </label>

        <label className="flex w-full flex-col gap-1 sm:w-auto sm:min-w-56 sm:flex-1">
          <span className="text-xs text-gray-500">Notes</span>
          <input
            value={draft.notes}
            onChange={(e) => onChange({ ...draft, notes: e.target.value })}
            placeholder="optional"
            className={inputCls}
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-3">
        <label className="flex w-full flex-col gap-1 sm:w-auto">
          <span className="text-xs text-gray-500">Phone numbers — one per line</span>
          <textarea
            rows={3}
            value={draft.phones}
            onChange={(e) => onChange({ ...draft, phones: e.target.value })}
            placeholder={"+1 212 555 0143\n212-555-0177"}
            className={`w-full font-mono text-xs sm:w-56 ${inputCls}`}
          />
          <span className="max-w-56 text-xs text-gray-600">
            Any format. Matches both phone and WhatsApp calls.
          </span>
        </label>

        <div className="flex flex-col gap-1">
          <span className="text-xs text-gray-500">Counts as an interaction</span>
          <div className="space-y-1.5 rounded-md border border-gray-800 p-2">
            {ALL_SOURCES.map((source) => {
              const rule = draft.rules[source]!;
              const timed = TIMED_SOURCES.includes(source);
              return (
                <div key={source} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    id={`rule-${draft.id ?? "new"}-${source}`}
                    checked={rule.enabled}
                    onChange={(e) => setRule(source, { enabled: e.target.checked })}
                    className="h-3.5 w-3.5 accent-indigo-500"
                  />
                  <label
                    htmlFor={`rule-${draft.id ?? "new"}-${source}`}
                    className={`w-28 ${rule.enabled ? "text-gray-300" : "text-gray-600"}`}
                  >
                    {SOURCE_LABELS[source]}
                  </label>
                  {timed && (
                    <>
                      <span className="text-xs text-gray-600">at least</span>
                      <input
                        type="number"
                        min="0"
                        disabled={!rule.enabled}
                        value={rule.minutes}
                        onChange={(e) => setRule(source, { minutes: e.target.value })}
                        placeholder="0"
                        className={`w-14 ${inputCls} disabled:opacity-40`}
                      />
                      <span className="text-xs text-gray-600">min</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>
          <span className="max-w-xs text-xs text-gray-600">
            Unticked sources are still recorded — they just never reset the clock.
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded-md bg-indigo-500/10 px-3 py-1.5 text-sm text-indigo-400 hover:bg-indigo-500/20 disabled:opacity-50"
        >
          {saving ? "Saving…" : draft.id ? "Save changes" : "Add person"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm text-gray-400 hover:text-gray-200"
        >
          Cancel
        </button>
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </form>
  );
}
