# Working on the Fantasy dashboard

Notes for the next session that changes the `/fantasy` page. What each tab shows
and where its data comes from is in [fantasy-football.md](fantasy-football.md);
this is how to change it without tripping over the things that bit us during
the September 2026 overhaul.

## Where things live

| Piece | Location |
|---|---|
| Page shell (header, league picker, tab bar, health badge) | `dashboard/src/pages/FantasyPage.tsx` |
| Tabs | `dashboard/src/pages/fantasy/{Today,Lineup,Moves,Trades,Experts(=Rankings),Reading,Admin}Tab.tsx`, plus `RightNow.tsx`, `TradeIntel.tsx`, `WaiversTab.tsx` (the FAAB market card inside Moves) |
| Player popup | `dashboard/src/pages/fantasy/PlayerDossier.tsx` |
| Shared UI | `viz.tsx` (Card, QuietLine, SubHead, MetaLine, Th/Td, FoldToggle, `usePopover`/`HoverInfo`, NewsPeek, contexts), `NoteLine.tsx` (PlayerName, ClaimsSummary, RankText, MatchupCell, UsageCell), `labels.ts` (label maps, `cap()`, dates), `Select.tsx` (Select, Segmented), `method.tsx` (the Methodology page's `<Note>` registry) |
| API route | `dashboard/server/routes/fantasy.ts` — shells out to `python3 -m ff.cli api <endpoint>` |
| Every number | `fantasy-football-agent/ff/` (`api.py` dispatches; `content/tabs.py`, `content/digest.py`, `content/consensus.py`, `trades.py`, `usage.py`, `scoring.py`) |

**Nothing is computed in TypeScript.** Scoring, FAAB, rankings and the
untrusted-text boundary have one implementation, in Python. If the UI needs a
new number, add it to the payload.

## The edit loop

1. Frontend: edit, then `cd dashboard && npx tsc --noEmit -p .` — only errors in
   `src/pages/fantasy/*` and `FantasyPage.tsx` matter (other pages carry old
   errors). The server file: `npx tsc --noEmit --target es2022 --module nodenext
   --moduleResolution nodenext --esModuleInterop --skipLibCheck --strict
   server/routes/fantasy.ts` (`server/index.ts` has 11 pre-existing errors
   from other routes).
2. **The live page serves `dashboard/dist`**: `npx vite build`, then reload.
   There is no dev server in the loop. The build also writes `.br`/`.gz` copies
   of each asset.
3. Server changes (`server/*`): `launchctl kickstart -k gui/$(id -u)/com.nanoclaw.dashboard`.
   A restart also empties the route cache; it can log open tabs out (a reload
   logs them back in).
4. Python: `cd fantasy-football-agent && python3 -m unittest discover -s tests -q`
   (pytest is not installed). Changes take effect on the next request (one
   process per call) — **but see caches below**.

## Caches, three layers — the usual reason a change "doesn't show up"

1. **`payload_cache` (SQLite)**: Today, Lineup, Moves, Trade intel and Trades
   are precomputed every 15 min by the ff-news job and served while < 20 min
   old. After changing their Python, rebuild: `python3 -m ff.cli digest-cache`
   (~90 s, all leagues) or `python3 -m ff.cli api lineup league=redraft fresh=1`.
2. **The Express route cache** is stale-while-revalidate: an expired entry is
   served instantly (for up to an hour) while it refreshes in the background.
   So the first reload after a change can show the old payload. Force it with
   `?refresh=1`, or restart the service. **When you change a payload's SHAPE**
   (rename or remove a field the UI reads), restart the service, or the UI
   will get the old shape for up to an hour.
3. **The warmer** (`warm()` in `routes/fantasy.ts`) re-runs every tab's default
   view every 10 min, and every 30 the dossier of each player those cached
   views contain (`warmDossiers`, batched through `ff.cli api dossiers`). Its params must
   match exactly what the tab requests by default (cache keys are sorted, so
   order does not matter, values do). If you change a tab's default request
   (a new default filter, limit or scope), update the warm list, or that tab
   loses its instant first load.

## Things that are not what they look like

- **The Telegram agent reads the same payloads** through `ff.cli api`
  (`groups/fantasy-football/CLAUDE.md`, gitignored). Do not drop a payload field
  just because the dashboard stopped showing it; check that file first. The
  dashboard gets trimmed variants where it matters (`slim=1` on today and
  consensus, forced in `FIXED_PARAMS`).
- **Everything is per league.** Scoring differs by league, FantasyCalc values
  come in one format per league (`trades.MARKET_FORMAT`), and the dossier
  takes `league=`. Anything a player name opens should carry the viewed league
  (`LeagueContext` in `viz.tsx`).
- **Rank moves must compare like with like.** Early in the day today's ranking
  snapshot can be missing a site (its list not pulled yet), which moves a plain
  median with nobody moving the player. Use `consensus.rank_delta` (sites
  present in both snapshots).
- **FantasyCalc's `trend30Day` is not a plain difference** of its daily values.
  Use the stored snapshots (`trades.market_values` `trend_7d` / `change_30d`,
  `consensus.market_history`) so rows, hovers and the chart agree.
- **Sleeper box scores**: on a team-defence line `td` is the TEAM's touchdowns
  (offence included) — defensive scores are `def_td` / `def_st_td`. Defence
  lines also carry `fan_pts_allow_{qb,rb,wr,te,k,def}`, which is what
  `consensus.matchup_strength` ranks (this season only, by the user's choice).
  nflverse snap counts lag a game by days; the box score's `off_snp` /
  `tm_off_snp` has them sooner.
- **The claim extractor tags individual defenders (IDP) as D/ST.** Resolve a
  D/ST claim by its name, never its team (`Resolver.team_defense`); IDP claims
  are stored with `player_position = 'IDP'` and no player.
- **The claims job** (`com.nanoclaw.ff-claims`) needs the `claude` CLI; the
  native install lives at `~/.local/bin/claude`, which `scripts/ff-claims.sh`
  and `ff/content/claims.py` look for. If "Sites say" goes stale, check
  `~/.local/share/nanoclaw/logs/ff-claims.error.log` first.
- **Anything O(n²) over notes gets slow fast**: `newsfeed.dedupe_notes` took
  ~7 s on Reading's "everything" until it parsed timestamps once and used
  SequenceMatcher's quick bounds.

## UI conventions the user has asked for

- **Sentence case** for headings, buttons, links, toggle options, dropdown
  labels and values, checkboxes and placeholders; lowercase only for inline
  data chips ("start ×2", "hold") and grey meta lines. Column headers are
  uppercase by CSS. `labels.cap()` turns a prose label into a control label.
- **Concise, no repetition.** Each list lives on one tab; others link to it or
  show a count. Explanations go on the card title as `info` (hover / tap, dotted
  underline), not as a subtitle; `subtitle` is for data ("17 players · market
  40,544"), which sits beside the title on desktop.
- **Detail on hover, never the native `title`** for anything worth reading:
  use `HoverInfo` (instant, works on tap on a phone). The native tooltip was
  missed entirely.
- **Section headings inside a card** use `SubHead`.
- **Colour means something**: one hue in shades for a scale (the news badge is
  indigo, solid / outline / dim); green-to-red for good-to-bad (matchups).
  The user did not want role-change badges or coloured week-over-week deltas.
- **Both viewports, always.** Check every change at ~400px (phone) and desktop,
  in all three leagues (dynasty adds a scope, guillotine adds chopped rosters
  and 22 teams). Phone tables use the two-line `ff-row-head` pattern; a table
  that must stay a table goes in `overflow-x-auto` or gets narrower columns.
- **Keep the page header compact**; the tab bar sits at the same height on
  every tab.

## Verifying in the browser

The user keeps two Chrome tabs in the Claude tab group: one desktop, one with
DevTools device emulation (Pixel 9, 400×582).

**Finding them at the start of a session.** The Chrome tools only see the tab
group *this session* created; a group from an earlier session is invisible, so
`tabs_context_mcp` answers "No tab group exists" even with both tabs open.
Switching browsers does not help. The Basement Laptop is the one to use (listed
as "Browser 2", deviceId `3ec7fe21-…`, usually already selected). Do this, in
order, without trying other browsers first:

1. `tabs_context_mcp` with `createIfEmpty: true`. It opens a new window holding
   one blank tab in a fresh group.
2. Ask the user to drag their two `/fantasy` tabs into that group (emulation
   survives the move). The blank tab disappears or gets reused.
3. `tabs_context_mcp` again, then confirm each tab by measuring
   `innerWidth` (400 on the phone tab, ~1355 on desktop) and whether the
   user agent is a mobile one.

Useful habits:

- Measure instead of eyeballing: `document.documentElement.scrollWidth` against
  the viewport, elements whose right edge passes it, `getBoundingClientRect()`.
- The automation tabs are in the background, so **timers are throttled to
  ~1 s**; time things with a `MutationObserver` or `performance` entries, not
  `setTimeout` gaps. A tab left in the background a while gets Chrome's
  intensive throttling (chained timers about once a minute), so a wait loop
  built on `setTimeout` stalls; yield with a `MessageChannel` tick instead
  (`new Promise(r => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); })`)
  and compare against `performance.now()`. A single JS evaluation times out at
  45 s, so sweep one league per call. `HoverInfo` opens on an Enter keydown on
  its `span[role=button]`, and the popup is the last child of `body`.
- Do not click controls that write (mark read, refresh jobs) while testing.
- After a server restart, wait for the warmer before timing anything: the tabs
  take ~30-60 s, then the dossier sweep (all three leagues) another ~1 min.
  It ends with one line in `dashboard/logs/stdout.log` ("[fantasy] dossier
  sweep: redraft 583/583, … in 52.3 s (28 ms/player)"); a sweep that ran slow
  (a batch over 250 ms a player, or past 4 min) stops itself and says why in
  `logs/stderr.log`. Tens of ms a player is normal; more means a per-player
  query in the dossier regressed (profile `ff.cli api dossiers`).
