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

/**
 * Holds the notes registered by whatever is mounted beneath it. The page
 * keys it on the league, so the registry starts empty on every league change:
 * a note is written for one league ("12 rivals still hold 20%+ of budget"),
 * and one left over from another would sit beside it and contradict it.
 */
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
    term: "FAAB bids",
    means:
      "Bids are shown in dollars, because that is what you type into Sleeper. The tooltip gives the percent of this league's budget, because one league runs $100 and another $1,000: a $40 bid is a rout in one and a rounding error in the other.",
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
      "Sleeper records only completed trades — across every completed trade in these leagues there is not one rejected or expired offer. Nothing here can estimate whether an offer will be accepted; it can only say whether the deal is good for you. The accept-share column describes how often each manager has been the one to accept, which is history, not prediction.",
  },
  {
    title: "Third-party text is data, never instruction",
    body:
      "Team names, display names and news copy are written by other people. They are escaped before storage and rendered as text; anything that reads like an instruction is flagged and quoted, not obeyed.",
  },
  {
    title: "Market value versus league value",
    body:
      "Where both are shown, the primary number is market value in the dynasty league and league VOR everywhere else; the other is context. Your counterparty is probably using market value, and the gap between the two is where a trade is available. Public value tables cannot model scoring quirks like a per-completion bonus, so positions those quirks favour are worth more to you than the market implies.",
  },
  {
    title: "Pinning changes the question",
    body:
      "With nothing pinned, the package search looks for deals that improve both lineups. Pinning a player changes the objective from mutual gain to best return, because pinning means you have already decided you want that piece.",
  },
];

/**
 * Every source this hub pulls, and exactly what is taken from each.
 *
 * Written by hand rather than derived from the ingest table on purpose: the
 * ingest log knows a fetch returned 2,382 rows, and cannot say what those rows
 * are FOR or what they are not allowed to be used for. The "not used for" column
 * is the one that matters — most of these feeds carry more than is trustworthy,
 * and the discipline is in what gets left on the floor.
 */
const SOURCES: {
  name: string;
  what: string;
  used: string[];
  notUsed?: string;
  cost: string;
}[] = [
  {
    name: "Sleeper — leagues, rosters, transactions",
    what: "The system of record for all three leagues. Free, unauthenticated, READ-ONLY.",
    used: [
      "League settings, scoring and roster slots — the scoring keys ARE the stat keys, so one dot product scores every league correctly",
      "Rosters and starters, per league per season",
      "Every transaction back to 2020, including FAILED waiver claims with their bid amounts — the sealed-bid history no other source has",
      "FAAB budget spent per manager, snapshotted so the burn curve can be reconstructed",
      "Matchups, draft picks, traded picks",
      "`news_updated` per player, which is the change detector that makes the news layer cheap",
      "Weekly projections (Rotowire's; Sleeper serves no other provider), stored as raw stat lines and rescored under each league's settings. The number of record: Proj on Lineup, the lineup optimiser, the waiver board and the guillotine survival line",
    ],
    notUsed:
      "Nothing is ever written back. The GraphQL write path exists and risks the account; every recommendation here is executed by hand in the app.",
    cost: "free · no key",
  },
  {
    name: "Sleeper — trending adds and drops",
    what: "Adds and drops across millions of Sleeper leagues, at any lookback window you ask for.",
    used: [
      "Add and drop counts at 6h, 24h, 72h and 168h in the same snapshot",
      "Acceleration: the share of a week's adds that landed in the last day, against what an even trickle would give",
    ],
    notUsed:
      "Not treated as a performance signal. It measures what other managers are doing, which is a fact about the market and not about football.",
    cost: "free · capped at 100 rows per window",
  },
  {
    name: "ESPN — Rotowire player notes",
    what:
      "Rotowire's beat reporting, served by ESPN's fantasy news endpoint. Undocumented, free, unauthenticated.",
    used: [
      "Headline and full story text per player",
      "The successor signal — 90 minutes after a starter leaves practice, the note names the backup taking first-team reps. Nothing else in the stack carries that",
      "Publication timestamps, which is what lets the Tuesday waiver deadline be covered at all",
    ],
    notUsed:
      "The text is third-party prose. It is escaped before storage, rendered as text, and anything reading like an instruction is flagged and quoted rather than obeyed.",
    cost: "free · one call per player, gated on Sleeper's news_updated",
  },
  {
    name: "ESPN — projections and roster ownership",
    what: "The kona endpoint. One call returns both.",
    used: [
      "A second weekly projection, translated to Sleeper stat keys so it can be rescored under each league's settings",
      "The DISAGREEMENT between it and Sleeper's projection, which predicts how wrong the estimate will be — something one source structurally cannot provide",
      "Roster ownership: percent owned, percent started, and ESPN's own weekly change figure",
    ],
    notUsed:
      "No weighting model. Equal-weighting the two sources wins over twelve seasons; a weighting model is a tested dead end. ESPN's ownership universe includes IDP and special teams, so punters and linebackers are dropped rather than shown.",
    cost: "free · needs the x-fantasy-filter header, or it silently serves 50 rows",
  },
  {
    name: "FantasyCalc — market values",
    what: "Community trade values, pulled separately for each league's own format.",
    used: [
      "A value per player in redraft-1qb-12tm, dynasty-1qb-12tm and redraft-sf-22tm",
      "The 30-day change, which is an absolute move in value points and is converted to a percentage of where the player started",
      "Every daily value is stored: the dossier's trade value chart, and the 7- and 30-day changes on Trades rows, are differences between those snapshots rather than FantasyCalc's own 30-day figure",
      "Draft pick prices, as slots",
    ],
    notUsed:
      "Never shared between leagues. Never the primary number in redraft, where league VOR leads. Pick prices carry no team attribution, so they cannot be used to check who owns a pick.",
    cost: "free · no key",
  },
  {
    name: "nflverse — schedules, injury reports, snap counts",
    what: "The community NFL data project, published as release assets on GitHub. Refreshed by the daily job.",
    used: [
      "Schedules with Vegas lines and totals: the opponent and implied team total on Lineup, and kickoff times, which lock a player once his game starts",
      "Official weekly injury reports: report status, practice status, body part",
      "Snap share and target share per week, with the week-over-week move: the usage line under Lineup's matchup and the snap share in the dossier's Games table",
    ],
    notUsed:
      "Usage is context beside the projection, never an input to it. A usage-based breakout detector was tested against projection residuals and found nothing.",
    cost: "free · no key",
  },
  {
    name: "Expert sites — articles, claims, rankings",
    what:
      "FantasyPros, CBS, Footballguys, the Fantasy Footballers, DraftSharks and FantasyLife. Articles are fetched every 15 minutes; rankings snapshots every 2 hours (FantasyPros, the Fantasy Footballers) or daily (CBS, Footballguys).",
    used: [
      "Claims: every 15 minutes a headless Claude reads new articles and extracts start, sit, buy, sell, add, drop, hold and stash calls, each with its rationale and a link back",
      "Rankings snapshots: the Rankings board, the consensus rank and its move on every row, and the dossier's rankings",
      "Claims feed the Sites say columns on Today, Lineup, Moves and Rankings, the quotes on Trades, the Reading feed and the dossier",
    ],
    notUsed:
      "A claim is what a site said, never the tool's own view. Paywalled teasers are stored but not read, and a claim written before a player's last game is marked pre-game rather than dropped.",
    cost: "free · public pages",
  },
  {
    name: "The Fantasy Footballers — projections",
    what: "Stat-level weekly projections from the site's three analysts, averaged, read from its position rankings pages.",
    used: [
      "A third weekly projection beside Sleeper and ESPN, rescored under each league's settings",
      "In the tooltip on Lineup's projection, beside Sleeper on Rankings and in the dossier, and part of the spread that flags when the sources disagree",
    ],
    notUsed: "Not the number of record: Sleeper's projection is, so an optimal lineup never depends on which third source ran last.",
    cost: "free · refreshed every 2 hours",
  },
  {
    name: "DynastyProcess — the id crosswalk",
    what: "A maintained mapping between Sleeper, ESPN, gsis and other player ids.",
    used: ["Joining every source above to a single Sleeper player id"],
    notUsed:
      "Fuzzy name matching. It is a tested dead end and the crosswalk is the answer; a name that will not map is reported as unmapped rather than guessed.",
    cost: "free · one CSV",
  },
];

/** What each source is asked for, at a glance, before the detail below it. */
function SourceCard({ s }: { s: (typeof SOURCES)[number] }) {
  return (
    <section className="rounded-lg border border-gray-800 bg-gray-900">
      <header className="border-b border-gray-800 px-4 py-2.5">
        <div className="flex flex-wrap items-baseline gap-2">
          <h4 className="text-sm font-medium text-gray-100">{s.name}</h4>
          <span className="text-[11px] text-gray-600">{s.cost}</span>
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{s.what}</p>
      </header>
      <div className="px-4 py-3">
        <div className="text-[11px] font-medium uppercase tracking-wide text-gray-500">What we take</div>
        <ul className="mt-1 space-y-1">
          {s.used.map((u, i) => (
            <li key={i} className="flex gap-2 text-xs leading-relaxed text-gray-400">
              <span className="text-gray-700">·</span>
              {u}
            </li>
          ))}
        </ul>
        {s.notUsed && (
          <>
            <div className="mt-3 text-[11px] font-medium uppercase tracking-wide text-gray-500">
              What we deliberately do not
            </div>
            <p className="mt-1 text-xs leading-relaxed text-gray-500">{s.notUsed}</p>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * Methodology, as a full page.
 *
 * It began as a drawer over the dashboard, which was the wrong shape for it:
 * this is reference material you read once, carefully, not a tooltip you peek at
 * while holding a half-finished trade in your head. A page can be scrolled,
 * linked and left open beside the tab it explains.
 */
export function MethodologyPage({ onBack }: { onBack: () => void }) {
  const reg = useContext(RegistryCtx);
  const sections = [...reg.entries()].filter(([, v]) => v.length > 0);

  // Jump links: the source cards alone are several phone screens, and the
  // panel notes you most likely came for are at the very bottom.
  const jumps = [
    { id: "method-sources", label: "Sources" },
    { id: "method-rules", label: "Rules" },
    { id: "method-terms", label: "Terms" },
    ...(sections.length > 0 ? [{ id: "method-panels", label: "Panels" }] : []),
  ];

  return (
    <div>
      <div className="mb-5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 className="text-base font-semibold text-gray-100">Methodology</h3>
          {/* On a phone the subtitle drops under the title row, so "back"
              stays beside the title instead of wrapping onto a line alone. */}
          <span className="text-xs text-gray-500 max-sm:order-last max-sm:w-full">
            Where every number comes from, and what it is not allowed to claim
          </span>
          <button
            type="button"
            onClick={onBack}
            className="ff-inline ff-hit ml-auto text-xs text-indigo-400 hover:text-indigo-300"
          >
            ← Back
          </button>
        </div>
        <nav aria-label="Methodology sections" className="mt-1.5 flex flex-wrap gap-x-3 text-xs">
          {jumps.map((j) => (
            <a
              key={j.id}
              href={`#${j.id}`}
              onClick={(e) => {
                // The dashboard routes on the path; a bare hash would add a
                // history entry for nothing, so scroll by hand.
                e.preventDefault();
                document.getElementById(j.id)?.scrollIntoView({ block: "start", behavior: "smooth" });
              }}
              className="ff-hit text-indigo-400 hover:text-indigo-300"
            >
              {j.label}
            </a>
          ))}
        </nav>
      </div>

      <Group title="Data sources" id="method-sources">
        <div className="grid gap-3 xl:grid-cols-2">
          {SOURCES.map((s) => (
            <SourceCard key={s.name} s={s} />
          ))}
        </div>
      </Group>

      <div className="grid gap-x-8 lg:grid-cols-2">
        <Group title="Standing rules" id="method-rules">
          {STANDING.map((s) => (
            <div key={s.title} className="border-l-2 border-gray-800 pl-3">
              <div className="text-xs font-medium text-gray-300">{s.title}</div>
              <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{s.body}</p>
            </div>
          ))}
        </Group>

        <Group title="Terms" id="method-terms">
          {GLOSSARY.map((g) => (
            <div key={g.term} className="border-l-2 border-gray-800 pl-3">
              <div className="text-xs font-medium text-gray-300">{g.term}</div>
              <p className="mt-0.5 text-xs leading-relaxed text-gray-500">{g.means}</p>
            </div>
          ))}
        </Group>
      </div>

      {sections.length > 0 && (
        <Group title="From the panels you have opened" id="method-panels">
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
    </div>
  );
}

function Group({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h4 id={id} className="mb-2 scroll-mt-4 text-[11px] font-medium uppercase tracking-wide text-gray-500">
        {title}
      </h4>
      <div className="space-y-2.5">{children}</div>
    </section>
  );
}
