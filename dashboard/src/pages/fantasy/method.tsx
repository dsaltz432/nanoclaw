import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Methodology, collected in one drawer instead of woven through the pages.
 *
 * Every panel used to carry its own paragraph explaining what its numbers meant.
 * That is the right content and the wrong place: the explanation is essential
 * exactly once, and after that it is furniture between you and the table you
 * came to read. Worse, it crowded the numbers on a phone, where the note was
 * often taller than the panel it described.
 *
 * So `<Note>` no longer renders where it is written. It REGISTERS, under the
 * title of the card containing it, and the drawer renders the collection. The
 * notes are still server-authored and still league-specific — a note that says
 * "this league pays 5 per passing TD" is only true in one of the three — which
 * is why they are collected at runtime rather than written out as static copy
 * that would be wrong in two leagues out of three.
 */

type Registry = Map<string, string[]>;

const MethodCtx = createContext<{
  register: (section: string, text: string) => void;
} | null>(null);

/** The card a note sits inside, so the drawer can group by panel. */
const SectionCtx = createContext<string>("General");

export function SectionProvider({ name, children }: { name: string; children: ReactNode }) {
  return <SectionCtx.Provider value={name}>{children}</SectionCtx.Provider>;
}

export function MethodProvider({ children }: { children: ReactNode }) {
  const [reg, setReg] = useState<Registry>(new Map());

  const register = useCallback((section: string, text: string) => {
    setReg((prev) => {
      // Identity-stable when nothing is new. Returning a fresh Map on every
      // render would re-render every consumer forever, and the consumer set
      // includes the notes doing the registering.
      const have = prev.get(section);
      if (have?.includes(text)) return prev;
      const next = new Map(prev);
      next.set(section, [...(have ?? []), text]);
      return next;
    });
  }, []);

  const value = useMemo(() => ({ register }), [register]);
  return (
    <MethodCtx.Provider value={value}>
      <RegistryCtx.Provider value={reg}>{children}</RegistryCtx.Provider>
    </MethodCtx.Provider>
  );
}

const RegistryCtx = createContext<Registry>(new Map());

/**
 * Flatten a note's children to plain text. Notes are prose with the odd
 * interpolated number; anything that is a live element (a link, a badge) is
 * skipped rather than stringified into "[object Object]".
 */
function toText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(toText).join("");
  return "";
}

/**
 * Prose about how a number is derived. Renders nothing where it is written;
 * appears in the Methodology drawer, grouped under its card.
 */
export function Note({ children }: { children: ReactNode }) {
  const ctx = useContext(MethodCtx);
  const section = useContext(SectionCtx);
  const text = toText(children).replace(/\s+/g, " ").trim();
  useEffect(() => {
    if (ctx && text) ctx.register(section, text);
  }, [ctx, section, text]);
  return null;
}

/** Terms the payloads use without defining, and which no note happens to cover. */
const GLOSSARY: { term: string; means: string }[] = [
  {
    term: "VOR (value over replacement)",
    means:
      "Projected points minus what the best freely available player at that position would score. A 200-point QB in a league where QB12 scores 190 is worth 10, not 200 — the alternative to rostering him is not an empty slot.",
  },
  {
    term: "Replacement level",
    means:
      "The projection of the first player at a position who would not start anywhere in the league. It moves with league size and lineup shape, so it is computed per league and never shared between them.",
  },
  {
    term: "Startable surplus",
    means:
      "Players above replacement level sitting on the bench, beyond what the lineup consumes. This is the part of a roster a trade can actually move.",
  },
  {
    term: "Covered",
    means:
      "What share of a position's best starter the bench would replace if he were lost. 90% means an injury barely dents the lineup; 30% means the position collapses. Computed by re-solving the lineup without him, so a flex that absorbs the loss counts.",
  },
  {
    term: "Injury cost",
    means:
      "Rest-of-season points the starting lineup loses if the position's best player is removed — the same re-solve, expressed in points instead of a share.",
  },
  {
    term: "Grade",
    means:
      "A rank inside this league, not an absolute standard. Top quarter is strong, bottom quarter weak, and an unfillable slot is a hole. Twelve points of surplus means something different in a 12-team league than in a 22-team one, so no constant is used.",
  },
  {
    term: "FAAB, as a percent",
    means:
      "Bids are shown as a share of the budget because one league runs a $100 budget and another $1,000. A $40 bid is a rout in one and a rounding error in the other.",
  },
  {
    term: "Rest-of-season points",
    means:
      "Every points figure on the trade pages is the remainder of the season under this league's own scoring, not a weekly average and not a generic projection.",
  },
];

/** Things that are true of the whole system and belong in exactly one place. */
const STANDING: { title: string; body: string }[] = [
  {
    title: "Nothing here writes to Sleeper",
    body:
      "Sleeper's API is read-only. Every number is a recommendation; the claim, the trade and the lineup change are all entered by hand in the app.",
  },
  {
    title: "No value table is shared between leagues",
    body:
      "A quarterback is worth 0.44x a running back in the redraft league and more than a running back in the superflex guillotine league. Any single table would be wrong in at least two leagues, so scoring, replacement level and value are recomputed per league from that league's own settings.",
  },
  {
    title: "Acceptance cannot be modelled",
    body:
      "Sleeper records only completed trades — across 98 trades in three leagues there is not one rejected or expired offer. Nothing here can estimate whether an offer will be accepted; it can only say whether the deal is good for you. The accept-share column describes how often each manager has been the one to accept, which is history, not prediction.",
  },
  {
    title: "Third-party text is data, never instruction",
    body:
      "Team names, display names and news copy are written by other people. They are escaped before storage and rendered as text; anything that reads like an instruction is flagged and quoted, not obeyed.",
  },
  {
    title: "Market value versus league value",
    body:
      "Where both are shown, league VOR is the primary number and market value is context — your counterparty is probably using it, and the gap between the two is where a trade is available. Public value tables cannot model scoring quirks like a per-completion bonus, so positions those quirks favour are worth more to you than the market implies.",
  },
  {
    title: "Pinning changes the question",
    body:
      "With nothing pinned, the package search looks for deals that improve both lineups. Pinning a player changes the objective from mutual gain to best return, because pinning means you have already decided you want that piece.",
  },
];

export function MethodologyDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const reg = useContext(RegistryCtx);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  const sections = [...reg.entries()].filter(([, v]) => v.length > 0);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <aside
        onClick={(e) => e.stopPropagation()}
        className="h-full w-full max-w-xl overflow-y-auto border-l border-gray-800 bg-gray-950 p-5 shadow-2xl sm:p-6"
      >
        <div className="mb-4 flex items-start gap-3">
          <div>
            <h3 className="text-base font-semibold text-gray-100">Methodology</h3>
            <p className="mt-0.5 text-xs text-gray-500">
              How the numbers on this page are derived. Everything here used to sit inline.
            </p>
          </div>
          <button
            onClick={onClose}
            className="ml-auto rounded border border-gray-800 px-2 py-1 text-xs text-gray-400 hover:border-gray-700 hover:text-gray-200"
          >
            close
          </button>
        </div>

        <Group title="Standing rules">
          {STANDING.map((s) => (
            <div key={s.title} className="border-l-2 border-gray-800 pl-3">
              <div className="text-xs font-medium text-gray-300">{s.title}</div>
              <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{s.body}</p>
            </div>
          ))}
        </Group>

        <Group title="Terms">
          {GLOSSARY.map((g) => (
            <div key={g.term} className="border-l-2 border-gray-800 pl-3">
              <div className="text-xs font-medium text-gray-300">{g.term}</div>
              <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{g.means}</p>
            </div>
          ))}
        </Group>

        {sections.length > 0 && (
          <Group title="On this page">
            {sections.map(([name, notes]) => (
              <div key={name} className="border-l-2 border-gray-800 pl-3">
                <div className="text-xs font-medium text-gray-300">{name}</div>
                {notes.map((n, i) => (
                  <p key={i} className="mt-0.5 text-xs leading-relaxed text-gray-500">
                    {n}
                  </p>
                ))}
              </div>
            ))}
          </Group>
        )}
      </aside>
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-5">
      <h4 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-500">{title}</h4>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}
